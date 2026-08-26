# Paint-patch frames

Status: implemented and measured, pending assigned review.

## What was wrong

An animation held the entire window at a full redraw for as long as it ran.

gpui is immediate mode: the element arena and the taffy tree are cleared and rebuilt every
draw, so a draw costs O(every node in the window) no matter how little changed. The tween
driver in `rust/src/service.rs` ticked the overlay and then called `cx.notify()` +
`window.refresh()`, which is a whole-window invalidation. So one `_gpuiLoop` node — six 2.5px
dots on one sidebar row — put the window on a full rebuild, re-layout, prepaint and paint
every 33ms, forever.

Measured in Team Machine's desktop app against a frozen fixture with no daemon, no agents and
zero input (session a3483, `~/team-machine/docs/desktop-interaction-latency.md`): one working
session on screen cost 19.8 draws/s and 53% of a thread; the same 385-node tree with the
`_gpuiLoop` key renamed so the renderer did not recognise it cost 0.1 draws/s and 1.0%.

Two things about that cost are worth stating plainly, because they shape the fix:

- **One spinner costs the same as twenty.** The invalidation is whole-window, so the price is
  the tree, not the animation.
- **The obvious lever was already pulled.** The retained-layout fast path was engaged on
  310 of 313 spinner-tick frames, and `RNGPUI_FORCE_RETAINED_LAYOUT=1` recovered nothing.
  Skipping the taffy solve does not help when the remaining cost is the per-node walk itself
  (~22µs/node, with no single hot sub-stage: the named stages together were ~17% of the draw).

## Why not a CA layer

The obvious fix is to give an animated node its own compositing layer so animating it does not
touch the rest of the window. That would have re-solved a problem the renderer had already
solved. `platform/mac/metal_renderer.rs` already carries a damage compositor: `retained_plan`
diffs the new scene against a snapshot of the last presented one (`Scene::damage_since`,
operation by operation) and picks `record-full`, `record-damage <rect>`, `replay`, or
`scroll-blit`. A small visual delta already becomes a scissored partial repaint.

So the GPU half of "only repaint what moved" exists. What was missing is the CPU half: a way to
produce the next scene without walking the tree.

## The mechanism

A scene is a `Vec<PaintOperation>`. On a draw, a node that is currently animating its opacity
brackets its own paint, and the frame records the span of operations it produced along with the
opacity those operations were built with. On a tick where the only thing that moved is opacity,
the driver does **not** call `refresh()`: it rewrites those recorded operations from their
originals at the new opacity, re-derives the primitive lanes, and asks for a present. The
compositor's damage pass then reduces the frame to a scissor around the pixels that changed.

Cost per tick becomes O(animating nodes) plus one O(scene) lane rebuild, instead of O(tree)
element construction, layout, prepaint and paint.

- `Scene::patch_ops_opacity` / `rebuild_lanes` / `Primitive::with_element_opacity` (`scene.rs`)
  do the rewrite. Each arm of `with_element_opacity` mirrors the matching `Window::paint_*`
  entry point, which is the invariant that keeps a patched frame identical to a drawn one.
- `Window::{begin,end}_paint_patch` and `patch_paint_opacities` (`window.rs`) hold the
  recordings and apply them.
- `anim_overlay::take_paint_patch_batch` decides whether a tick qualifies, off the same
  changed-key bookkeeping that already drives the paint-only flag.

It is general by construction: it keys on the overlay, not on any component, so `_gpuiLoop`,
tamagui's hover and press flips, and reanimated opacity springs all ride the same path. Nothing
moves out of the React/Tamagui tree; the animation is still declared in JS and still merged
through the overlay. Transform, colour and every other key keep the existing full-draw path.

## Why a patch cannot write the right value onto the wrong element

A recording only means anything against the scene that produced it. If a full draw happened in
between, or the tree changed shape, the recorded indices address whatever has since moved into
them. Three things enforce that, and all of them fail toward a real draw:

1. **Recordings live on `Frame`, not on `Window`.** They swap into `rendered_frame` with the
   scene they describe and `Frame::clear()` wipes them when the next draw starts. Nothing
   carries a recording across a draw.
2. **`patch_ops_opacity` re-checks the shape** of every operation it is about to write, and
   changes nothing if the kinds no longer line up.
3. **A node with no recording refuses**, unless the animating-node set is provably the same one
   the scene was painted against (`opacity_ids_epoch`). Only then does "no recording" reliably
   mean "this node was not painted" — culled out of a scroll list, or `display: none` — which
   has no pixels to update. That epoch check is what stops one spinner scrolled off the end of
   a list from putting the window straight back on a full redraw per tick.

Two cases record nothing but must not be read as "not painted", so they are blocked explicitly:
a node painted at zero alpha (where every fade-in starts, and whose primitives carry no colour
to scale back up), and the outer of two nested animating nodes (whose inner node's originals
already have the outer's opacity folded in, so patching both would compose them wrongly).

## The gate

`RNGPUI_PAINT_PATCH_VERIFY=1` makes every patched frame fall through to a real draw as well,
and the draw compares itself against the patch it just replaced, operation by operation. A
patched frame has to be indistinguishable from the frame a full draw would have built from the
same animation values; anything else prints `[paint-patch-verify] MISMATCH` with the damage
region.

Comparing scenes rather than screenshots makes the check exact and removes the alignment
problem: a free-running animation cannot be phase-matched between two runs, but a scene can be
compared against itself within one frame. It also means the check runs across state changes by
construction, since the animation is moving on every frame it verifies.

`RNGPUI_PAINT_PATCH_TRACE=1` reports each tick's decision, and
`RNGPUI_DISABLE_PAINT_PATCH=1` forces every tick back through the full draw for A/B
measurement, mirroring `RNGPUI_DISABLE_RETAINED_LAYOUT`.

## What the gate caught

It caught a real wrong-pixel bug on its first run, which is the reason to state plainly that
the gate is not ceremony.

`Hsla::opacity` and `Background::opacity` clamp their **factor** to `[0,1]`. That is correct for
the element-opacity stack they were written for, where nesting only ever multiplies opacity
down. A patch factor is a different quantity: it is the ratio between the new animation value
and the one the operations were painted with, so it exceeds 1 on every tick where the animation
brightens. Clamping it to 1 silently left the old alpha in place, so a patched spinner held
still for the rising half of every cycle — the exact failure that looks fine in a still capture
and is invisible in a frame-rate number.

Verify reported it as 326 mismatches in 359 frames with `drawn.a=0.99178267
patched.a=0.5473831 delta=4.44e-1`, and the per-node trace showed `requested=0.99178267
painted=0.5473831 scale=1.811862` — the scale was computed correctly and then discarded. The
fix clamps the **result** rather than the factor (`Primitive::with_element_opacity`, plus
`Background::set_alphas`, which exists because `Path.color` is a `Background` carrying three
alphas rather than an `Hsla`).

The gate compares with a 1e-6 alpha tolerance rather than exact equality. A draw computes
`base * V` while a patch computes `(base * V_prev) * (V / V_prev)`, and those differ in the last
float bit (~1.5e-8). The tolerance is four thousand times finer than one level of an 8-bit
channel, so it cannot hide a visible error: the clamp bug above was off by 4.4e-1.

## Measured

Team Machine's desktop tree against a frozen fixture (`TM_FIXTURE_ONLY=1`), 385 nodes,
8 armed spinners, offscreen and non-activating, no daemon and no input.

**Correctness.** Steady state: 316 patched frames, `ok=316 MISMATCH=0`, max alpha delta
1.49e-8. Across a state change, with a hover sweep flipping row colours through the off-thread
style path while the spinners ran: 583 ok, 0 MISMATCH, max delta 5.96e-8, with 11 off-thread
style writes inside the window confirming the flips really interleaved.

**The win.** Arms interleaved patched/baseline/patched/baseline, 12s windows, because this
machine's load moves during the night and a back-to-back pair cannot separate the change from
the load.

| arm | draws | presents | draw cost | service CPU |
|---|---|---|---|---|
| patched-1 | **0** (0.0/s) | 289 (24.0/s) | none | **2.8%** of one core |
| baseline-1 | 282 (23.5/s) | 280 (23.3/s) | p50 4.46ms, 11.2% of one thread | 13.4% |
| patched-2 | **0** (0.0/s) | 261 (21.7/s) | none | **3.7%** of one core |
| baseline-2 | 249 (20.7/s) | 247 (20.5/s) | p50 13.44ms, 46.2% of one thread | 19.9% |

Full draws go to zero while presents hold the same rate, so the animation still runs at the
same speed with no tree walk behind it.

Read baseline-2's draw cost as load, not as signal: its p95 was 76ms and its max 387ms, which is
external contention on a shared box, and it is exactly why the arms are interleaved. The patched
arm on either side of it was unaffected, which is itself the point — an arm that does no draws
has nothing for load to inflate.
