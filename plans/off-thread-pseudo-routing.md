# Off-thread pseudo routing — hover/press trigger off the React thread

> Status: DESIGN (2026-06-14). Implements the "far future" step named in
> `tamagui-pseudo-hook.md` ("route the pseudo signal straight to the worklet
> runtime ... Blocked on UI-side style resolution for pseudo merges"). The
> blocker is now broken down to a concrete seam. Not yet built.

## The problem this solves (measured)

The hover *animation* is already off-thread and correct: a sidebar row hover
sweep produces native hitbox flips → coalesced `pseudo` events → Tamagui
`avoidReRenders` emitter → reanimated drives the style on the UI runtime. Measured
on the agentbus gui (offscreen, `measure-frame-cost.mjs --perf-trace`): ~146 hover
flips → ~168 off-thread `setNodeStyle` crossings, **0 React commits from the rows
themselves.** Good.

But the hover *trigger* still rides the **main React Hermes runtime**:
`bridge::pseudo` → `hermes::post(...)` (the MAIN `JS_CALLS` queue) → `render.ts`
`dispatchPseudo` → Tamagui `setStateShallow` → `updateStyleListener` → `getSplitStyles`
re-split → `useStyleEmitter`. All of that is main-thread; only the spring *driving*
afterward is on the UI runtime.

So when the main thread is free, hover is ~1ms. Under load it is NOT: a fast sweep
overlaps big React commits (measured `sessions-list:170` nodes re-serialized in one
commit, from poll/data churn), and the pseudo trigger has to wait out the in-flight
commit on the single thread. `perf(hermes) 6ea7de5` (dispatch pseudo ahead of async
completions) helps queue ordering but cannot preempt an in-flight commit. The only
way to make hover immune to main-thread load is to take the trigger off the main
thread — exactly the "far future."

## The architecture is 95% in place

- **Two Hermes runtimes** (`hermes.rs`): React (`start`) + UI/worklet (`start_ui`,
  thread `hermes-ui`). `post` → React queue, `post_ui` → UI queue.
- **Zero-copy shared slots**: one `rng_hermes_shared_buffer_create` allocation
  installed as `__rngpui_svSlots` in BOTH runtimes (`hermes.rs:151-178`, `:875`,
  `:948`). Float64 layout: `[0]=magic 0x504e9a01, [1]=capacity, [2..3] reserved,
  slots from 4`; even slot ids = react-allocated, odd = ui-allocated. A write to
  `floats[id]` in one runtime is immediately readable from the peer's `readSlot(id)`.
- **UI runtime drives reanimated mappers** (`worklet-runtime.ts`): a
  `useAnimatedStyle` mapper re-runs when one of its input shared values fires its
  listener; the mapper calls `global._updateProps` → `seam.ts` `engineUpdateProps`
  coalesces per-rAF → ONE `__rngpui_setNodeStyle(ops)` host call.
- **setNodeStyle → paint, no React**: `host_set_node_style` (`hermes.rs:286-334`)
  → `Incoming::SetNodeStyle` → `anim_overlay::apply_ops` merges per-key into the
  per-node overlay; the div builder merges `overlay_for(id)` at paint with
  `cx.notify()`. No `applyTree`, no React commit.
- **Tamagui reanimated driver already has the materials**: `getSplitStyles` resolves
  `pseudos` (hoverStyle/pressStyle/focusStyle as concrete ViewStyles) and passes them
  into `useAnimations` (`createComponent.tsx:1096`); the driver currently ignores
  `pseudos` and re-splits on each main-thread flip instead.

## THE SHARP BLOCKER

The UI runtime does **not** poll slot cells and does **not** re-run mappers every
frame at rest. A mapper re-runs only when an input shared value's listener is fired
via `fireLocal`. The only Rust-reachable path to `fireLocal` is an inbound
`svUpdate`/`svUpdateBatch` into `onMessage` (`worklet-runtime.ts:533-563`), delivered
by `post_ui("__rngpui_peerRecv", json)`. **Writing the shared cell from Rust is not,
by itself, enough** — the cell is the source of truth for reads, but the re-run is
gated on the listener wakeup. `fireLocalIfChanged` reads `this.floats[svId]` (not the
message payload), so the correct order is: Rust writes the cell, THEN posts the
wakeup; a flip that nets to no change in a turn correctly no-ops.

## The seam (concrete)

### Piece 1 — rngpui Rust: a `globalId → slotId` registry + slot-wakeup
- New state: `PSEUDO_SLOTS: HashMap<u64 globalId, (u32 hoverSlot, u32 pressSlot)>`.
- New host fn `__rngpui_registerPseudoSlots(globalId, hoverSlot, pressSlot)` called
  from JS at mount (the JS side owns slot allocation). Stores the map.
- In the hitbox flip handler (where `bridge::pseudo` is emitted today), if the
  globalId has registered slots: write `floats[hoverSlot]=0/1` (and press) in
  `__rngpui_svSlots`, then `post_ui("__rngpui_peerRecv", <svUpdate {id:hoverSlot,
  value}>)` to wake the UI mapper. Keep emitting the main-thread `pseudo` event ONLY
  for nodes WITHOUT registered slots (or for user `onHoverIn` handlers) — so the
  off-thread lane fully replaces the main-thread lane for driver-managed pseudo.

### Piece 2 — rngpui TS: allocate slots, register, expose to the driver
- Extend `platform-driver.ts`: when a node subscribes pseudo AND the active driver is
  reanimated (avoidReRenders), allocate two bool shared-value slots (react side, even
  ids) and call `__rngpui_registerPseudoSlots(globalId, hoverSlot, pressSlot)`.
- Hand the driver the two shared values so its worklet can read them.

### Piece 3 — Tamagui reanimated driver: in-worklet pseudo merge
- In `animations-reanimated/createAnimations.tsx` `useAnimations`, when the platform
  driver advertises off-thread pseudo: destructure the already-passed `pseudos`,
  pre-resolve base + hover + press to plain (token-resolved, transform-expanded)
  style snapshots at setup (the driver already pre-resolves dynamic theme values per
  key — extend that), store them as shared values, and branch inside the existing
  `useAnimatedStyle` worklet: `hovered.value ? merge(base, hover) : base` (and press).
  The per-key spring stays inside the worklet, so transitions still animate.
- The pseudo bools are the slots from Piece 2; Rust writes them on flip; the worklet
  re-runs on the UI runtime → emits the merged style → overlay → paint. The main
  React thread is never touched on a flip.

## Validation
- `measure-frame-cost.mjs --perf-trace`: a hover sweep must show `setNodeStyle`
  crossings but **zero `pseudo` events on the main runtime** for driver-managed nodes
  (today there are ~146). And still 0 `[ser]` commits.
- `conformance:gpui:hover-active` for correctness (hover must not beat active; the
  active-omits-hoverStyle pattern in the rows still holds).
- The off-thread-stall proof (a React busy-loop) should now also leave HOVER
  unaffected, not just an already-running spring.

## Hazards
- Worklet-safe merge: pseudo resolution in `getSplitStyles` is importance-ranked
  against `usedKeys` and resolves theme tokens — NOT worklet-safe. The hover/press
  snapshots must be fully pre-resolved at setup; the worklet only picks/merges.
- `fireLocalIfChanged` dedups on `lastSlotListenerValue` — a flip must change the cell
  value to re-fire.
- This is the off-thread analog of web CSS `:hover`. It does NOT revive the deleted
  host `.hover()` paint-swap lane (`d2942d8`) — Tamagui stays the single style
  applier; the renderer only delivers the trigger to the worklet.
