# react-native-gpui — production-ready roadmap

Goal: make the engine **fast, conformant, stable, higher-quality, and easy to debug/profile.**
Built from a 5-dimension audit (performance, web-parity, stability, code-quality,
debuggability) on 2026-06-11. Every item carries a `file:line` anchor, severity, and
effort (S/M/L).

## The systemic theme (read this first)

The engine parses style props into `ElementStyle`, serializes them into the tree dump,
and merges them into animation overlays — but **several props are never applied at
paint**, and **almost every visual/animation conformance asserts on the tree-dump VALUE
(or "any pixel moved"), never on actual pixels.** So a dead paint passes green.

- **`opacity`** was the first instance — set on the gpui style, dumped, asserted, but
  never pushed onto gpui's element-opacity stack → every dialog/sheet fade rendered at
  full opacity and drop shadows never faded. **FIXED** 2026-06-11 (commit on `main`):
  `with_element_opacity` made `pub` in the vendored gpui, div paint wrapped in it, plus
  `check-opacity-conformance.mjs` (real composited pixels) in the suite.
- **`transform` is the same bug, still live** (see P0.1). Several text/gradient/border
  props too (P1).
- The fix pattern is two-part every time: **apply the prop at paint**, AND **add a
  pixel-level conformance** so it can't silently die again.

The other cross-cutting theme: the **offscreen test window doesn't composite**
(`service.rs:1999`, parked at -10000,-10000), so JS-driven animation ticks at a perfect
idle 60fps and tree-dump tests pass while the real on-screen window drops frames. The
offscreen oracle is a false positive for an entire bug class. Fixing the test
infrastructure (P2) is as important as fixing the bugs.

---

## Done (2026-06-11 session — all validated, regression-checked vs base binary)

- ✅ **`opacity` paints** (div subtree incl. shadow) — `div.rs` paint wrap + gpui
  `with_element_opacity` pub patch. Pixel conformance `check-opacity-conformance.mjs`.
- ✅ **`opacity` on top-level `<Text>`/`<Image>`/`<Svg>`** (P0.3) — `text/image/svg.rs`
  paint wraps.
- ✅ **Pixel animation-ramp conformance** (P0.2, partial) — `check-opacity-ramp-conformance.mjs`
  samples the real composited frame over time and asserts opacity interpolates in PIXELS
  (the systemic guard). Transform variant still TODO once transform paints (P0.1).
- ✅ **Pseudo-style global-lock gated** (P3.1) — superseded 2026-06-11: the host
  pseudo-style paint lane (`pseudo_style.rs`/`has_pseudo_style`) was deleted; only the
  opt-in `pseudo_events` renderer→JS lane remains, so the lock is gated on that alone.
- ✅ **Overlay mutex skipped on static frames** via an `AtomicUsize` mirror (P3.2) —
  `merged_gpui_style`/`has_overlay` no longer lock when nothing is animated.
- ✅ **Per-`SetNodeStyle` all-windows refresh removed** (P3.3) — the pump refreshed every
  window in the process per spring frame; now one targeted refresh. Validated animation
  still paints per-frame.
- ✅ **Frame-clock fires rAF sinks outside the SINKS lock** (P4.2) — was a poison/deadlock
  hazard on the display-link thread; also recovers a poisoned lock.

Remaining below. Suite is green except two PRE-EXISTING environmental failures (confirmed
identical on the base binary): `rounded-overflow` (capture corner-AA) and `window-mode`
(macOS clamps the −10000 offscreen origin on a multi-display layout).

---

## P0 — finish the animation parity story (the user's reported bug)

### P0.1 `transform` is parsed but NEVER applied — CRITICAL
- `style.rs:144,259` (parsed to `Option<String>`), `build_gpui_style` never reads it;
  `anim_overlay.rs:108` lists `transform` paint-only; `div.rs` paint never applies it;
  `dump.rs` doesn't even emit it. gpui 0.2.2 has `TransformationMatrix` (`scene.rs:519`)
  but only wires it into SVG/image sprites — **quads/text/shadows have no transform**, and
  there is no element-transform stack like the opacity one.
- Impact: every dialog/sheet/AnimatePresence enter/exit uses `scale`+`translateY` (the
  standard Tamagui driver). With opacity fixed they now *fade* but do **not** scale or
  slide. All reanimated `transform` springs are no-ops app-wide.
- **translate** (`translateX/Y`) is reachable via the existing `pub with_element_offset`
  (`window.rs:2438`, prepaint-phase) — wrap the div's prepaint so the subtree + hitboxes
  shift. **scale/rotate** need a real element-transform stack added to the vendored gpui
  (push a matrix; `paint_quad`/`paint_shadows`/`paint_text` multiply bounds by it, like
  they already do for `element_opacity`) — a deeper patch, possibly shader-touching.
- Plan: (a) parse the RN/CSS transform list into translate/scale/rotate about the element
  center (RN transform-origin = center); (b) land translate via `with_element_offset`
  first (covers the dialog slide); (c) add the gpui element-transform stack for
  scale/rotate; (d) emit `transform` in `dump.rs`. Effort: **M** (translate) + **L**
  (scale/rotate stack).
- Pair with **P0.2** so the new test goes green meaningfully.

### P0.2 Pixel-level animation RAMP conformance — CRITICAL (prevents the next dead-prop)
- Today `dialog-reanimated-conformance.mjs:219`, `reanimated-conformance.mjs`,
  `anim-overlay-conformance.mjs`, `sustained-reanimated-conformance.mjs` all assert on
  `tree.json` opacity VALUES; `animation-frame-diff.mjs:104,126` selects frames by a
  *moving* box and passes on any pixel delta — a live transform masks a dead opacity.
- Build `animation-ramp-conformance`: a **stationary** fixture (no layout movement) that
  springs `opacity 0→1` and a second that springs `transform scale/translateY`, captured
  across N frames via `shot --launch` + `RNGPUI_CAPTURE_ONSCREEN` (the composited
  in-service readback `check-opacity-conformance.mjs` already uses) — assert the
  card-center pixel interpolates (opacity) and the painted bounding box grows/moves
  (transform), on PIXELS. This single test catches both the shipped opacity bug and the
  live transform bug. Effort: **M**. Needs P2.2/P2.4 (burst capture + frame counter) to
  be clean.

### P0.3 `opacity` on top-level `<Image>`/`<Svg>`/`<Text>` — HIGH, trivial
- `image.rs:111`, `svg.rs:104`, `text.rs:230` paint children directly with no
  `with_element_opacity` wrap; the div fix only covers `ReactDivElement`. A faded
  avatar/icon/label paints full-strength. Mirror the div wrap. Effort: **S**.

---

## P1 — render correctness / web parity (web is the oracle)

- **`letterSpacing`** parsed+dumped, never applied (`style.rs:135,241`; `text.rs`,
  `div.rs:1394`) → text width/wrap drifts from web. Apply gpui tracking or strip from dump
  so it stops lying. **S/M**.
- **`textAlign`** parsed+dumped, never applied (`style.rs:134,257`; only noted unused in
  `input.rs:70`) → centered/right text renders left. Map to gpui `.text_center()`. **S**.
- **Linear gradients collapse to 2 stops; radial/conic unsupported** (`style.rs:641`) →
  multi-stop brand gradients flatten; radial renders as nothing. Detect+fallback, then
  N-stop. **M**.
- **Inset box-shadow silently becomes an outer shadow** (`style.rs:683`, strips `inset`)
  → inner shading renders as outer glow. Drop the layer or support it. **S**.
- **Borders flatten to one color + dashed/dotted lost** (`style.rs:268`; gpui paints one
  `border_color`; `borderStyle` parsed never mapped). Map `borderStyle`; per-side color is
  a gpui limitation to document. **S** / **L**.
- **`<Image>` ignores per-corner radius, border, shadow, `resizeMode`** (`image.rs:44`).
  Apply the four radii + object-fit. **M**.
- **`overflowX/overflowY`** ignored (`style.rs:533`, both axes set together). **S**.
- Add pixel conformances for: gradients, multi-shadow alpha, per-corner radius,
  letterSpacing/textAlign, image, transform. Promote a shared
  `assertNodeColor(selector, hex, tol)` harness helper on `shot --select`'s sampled color
  (`shot.ts:89`), and lint conformances that assert a visual prop without a pixel sample. **M**.

---

## P2 — debuggability & profiling (this cost the most time during the bug hunt)

- **P2.1 Composited-test default + `status` command** — make `RNGPUI_CAPTURE_ONSCREEN`
  the default for any paint/animation-asserting conformance and refuse to run them against
  a -10000 window; add `{"$cmd":"status"}` returning
  `{composited, onScreen, windowOrigin, captureMode, tracesEnabled, frameClock}`
  (`service.rs:1999`, `debug_control.rs`). Kills the false-positive offscreen oracle. **M**.
- **P2.2 Painted-frame counter / FPS over the socket** — `AtomicU64` incremented in the
  paint pass + ring of present timestamps + `{"$cmd":"frameStats"}` →
  `{paintedTotal, fpsLast1s, lastFrameMs, droppedEstimate}` (`frame_clock.rs`,
  `service.rs`). There is currently NO way to ask "are frames dropping" — the exact
  question the bug hunt needed. **S**.
- **P2.3 Real `capture` socket command** (not the 250ms file-poll timer) —
  `{"$cmd":"capture",path}` runs `capture_layer_to_png` synchronously for the current
  frame and replies (`debug_control.rs`, `service.rs:2285`). Removes the settle race. **S**.
- **P2.4 `captureBurst` + `rngpui record`** — N frames at T-ms intervals during an
  interaction → `frame-NNN.png` + per-frame paint timestamps; pairwise `diff` proves
  motion. Underpins P0.2. **M**.
- **P2.5 `rngpui interact <selector> --tap --frames N`** — resolve → real-dispatch →
  wait-for-paint-settle (P2.2 going quiet, not a fixed sleep) → burst-capture → diff →
  JSON. Collapses the multi-day repro into one command. **M**.
- **P2.6 Dump bounds honesty** — `dump.rs:96` omits `bounds` when `cached_layout` is None
  (culled / display:none / not-yet-painted / dumped-before-paint). Emit
  `bounds:null + boundsReason`, and defer `write_debug_dump` to after the paint pass so
  `LAST_FRAME` reflects the dumped frame. **M**.
- **P2.7 Structured frame trace** — back `frame_trace` with a ring buffer +
  `{"$cmd":"frameTrace",n}` JSON and an `RNGPUI_FRAME_TRACE=csv` p50/p95/p99 summary so a
  conformance can gate "p95 idle frame < 4ms". Migrate the stderr-regex harnesses
  (`animation-frame-diff.mjs:104`) onto it. **M**.
- **P2.8 Chrome-trace export** — `RNGPUI_TRACE_JSON=path` emitting per-node spans from the
  existing RAII guards (`frame_trace.rs`) → Perfetto. **M**.
- **P2.9 WebView-inclusive capture** — `capture_png.rs` can't read the WKWebView underlay
  (separate window → transparent). Enumerate its `windowNumber` and composite both grabs.
  **M**.

---

## P3 — performance (the per-frame tax behind on-screen frame drops)

Cluster #1–#4 + #6 scale with tree size and frames-in-flight — exactly what differs
between the loaded on-screen window (drops frames) and the idle offscreen one (60fps).

- **P3.1 (done)** pseudo-style lock gate — `div.rs:1577,2155`.
- **P3.2 Overlay/Merged mutex per node per pass even with zero animations** —
  `anim_overlay.rs:263,287,301` lock `OVERLAY`+`MERGED` unconditionally. Add an
  `AtomicUsize OVERLAY_COUNT`, short-circuit when zero (the common case); collapse the two
  maps into one lock; consider `arc-swap` (reads dominate). **S** (gate) / **M** (map).
- **P3.3 Triple window refresh per `SetNodeStyle`** — `service.rs:2979-2990`: targeted
  `window.refresh()` PLUS a blanket `cx.refresh_windows()` (all windows) per spring frame.
  Drop the blanket refresh (redundant for a single-window app); collapse the duplicate
  `notify()`. Prime frame-drop suspect. **S.** ⚠ validate on the composited path (P2) that
  `window.refresh()` alone still repaints animation frames before shipping.
- **P3.4 `report_layout`→`remember_layout` global lock per node per paint** —
  `div.rs:2245`→`bridge.rs:238`. Buffer into a thread-local `Vec`, flush once under one
  lock; or only for nodes that `listens("layout")`. **M**.
- **P3.5 `merged_gpui_style` deep-clones the committed style JSON + reparses per animated
  node per frame** — `anim_overlay.rs:278`; the per-frame cache is defeated by design (rev
  bumps every frame). Merge at the typed `ElementStyle` level; pre-parse changed overlay
  keys once in `apply_ops`. Biggest single avoidable per-frame allocation. **L**.
- **P3.6 `host_set_node_style` reparses ops into a throwaway `Value` tree + clones each
  style every frame** — `hermes.rs:243`. Cheap: `from_str::<Vec<(u64,Map)>>`. Structural:
  route numeric springs through the existing `__rngpui_svSlots` shared ArrayBuffer
  (`hermes.rs:108`). **S** / **L**.
- **P3.7 Per-frame uncached env reads in `render()`** (one allocs a String) —
  `service.rs:571,1010,1014,1029,1041`. Hoist to `OnceLock` (pattern already at
  `service.rs:73`). **S**.
- **P3.8 Text nodes clone the string + re-lowercase font-family every frame** —
  `div.rs:1394,1414`; `style.rs:584`. Store text/font-family as `SharedString` on
  `ReactElement`. **M**.
- **P3.9 Pump doesn't coalesce queued `SetNodeStyle` under back-pressure** —
  `service.rs:2314`. Drain-and-fold into one `apply_ops` + one refresh per batch. Directly
  targets loaded-window frame drops. **M**.
- **P3.10 AX `update_frame` global lock per element per paint with no AT-attached gate** —
  `ax.rs:171`; `div.rs:1451`. Gate the AX shadow-tree build on "is an AT client attached".
  **M**.
- Smaller: double `gpui::Style` clone per node (`div.rs:1429` + `mod.rs:242`, → `Arc`),
  duplicate tree-collection walks per commit (`service.rs:2741` vs `1278`), event `Vec`
  clones per Pressable per frame (`div.rs:1721`, → `Arc<[String]>`), background the debug
  dump serialize+write (`service.rs:690`), timer min-heap (`hermes.rs:161`),
  `stacked_child_indices` triple scan (`div.rs:1098`).

---

## P4 — stability / crash-safety / concurrency

- **P4.1 Poison-on-panic across process-global mutexes** — hundreds of `.lock().unwrap()`
  on maps shared between main/paint/worker threads (`anim_overlay.rs`, `div.rs`,
  `bridge.rs`, `ax.rs`, `audio.rs`, `hermes.rs` ws_registry, `frame_clock.rs`). One panic
  in any critical section poisons the mutex → the next lock aborts the whole app, far from
  the fault. Use `parking_lot::Mutex` (no poisoning) or `unwrap_or_else(|e| e.into_inner())`
  for the tolerant UI maps. **M.** Highest expected-value crash fix.
- **P4.2 `frame_clock::tick()` fires sinks while holding the `SINKS` mutex** —
  `frame_clock.rs:74`. A panicking sink poisons `SINKS` → every `register`/`tick`/`request`
  aborts. Snapshot the sinks (`Arc` clones) and fire after dropping the guard. **S**.
- **P4.3 Pump `update().is_err() → break` silently wedges the UI** — `service.rs:2315`+:
  on a transient window-handle error the pump dies but JS keeps enqueueing trees forever
  (unbounded `flume` growth, dead UI). Only break on real quit; else drain-and-drop. **M**.
- **P4.4 CVDisplayLink stop/start vs in-flight `tick()` race** — `frame_clock.rs:65,201`;
  single atomic state machine for the transitions. **M**.
- **P4.5 `capture_png` row slice can panic when `bytes_per_row < width*4`** —
  `capture_png.rs:178,245`; validate up front. Capture path only. **S**.
- **P4.6 Unbounded fetch/ws worker threads, no cap/backpressure** — `hermes.rs:443,580`;
  a JS bundle opening many sockets/fetches spawns unbounded OS threads. Pool/cap. **M**.
- **P4.7 `hit_passthrough` mutates a live ObjC class in the first draw** —
  `hit_passthrough.rs:169`; install at startup before the window opens. **S**.
- Lower: `host_reloadApp`/`host_exit` shell+exec/process::exit from JS
  (`hermes.rs:340,345`) → route through `Incoming::Quit`; per-frame NSColor without an
  autorelease pool (`webview.rs`, `liquid_glass.rs`); `style.rs:166` `as_object().unwrap()`
  on JS-controlled style; webview backing-view map keyed by raw pointer (`webview.rs:70`);
  `anim_overlay` `base_ptr` identity cache (add a generation counter).
- Healthy (don't touch): unsafe is contained to 4 files; no `static mut`/`Box::from_raw`;
  the worklet runtime never touches gpui directly (everything funnels through the
  main-thread pump); no reachable UTF-8 boundary panic in text/terminal.

---

## P5 — code quality / architecture (the codebase is clean; debt is concentrated)

No TODO/FIXME/HACK anywhere; only 6 narrow `#[allow]`; no dead `_old`/commented code.

- **P5.1 Implementation-switching env forks violate "one path"** —
  `RNGPUI_DISABLE_RENDER_GATE`, `RNGPUI_DISABLE_RETAINED_LAYOUT`, `RNGPUI_FORCE_RETAINED_LAYOUT`
  (`service.rs:70,1010`) switch which layout algorithm runs at runtime; one's own comment
  says "Never set in production." Pick the production path as the only path; move A/B into
  the conformance harness. **M, careful.**
- **God-files / monster functions** (do *after* the function extractions, not before):
  `fn main()` 1098 lines (`service.rs:1947`), `fn render()` 485 lines (`service.rs:917`),
  the ~600-line debug-command match (`service.rs:2316`, lots of copy-pasted
  `window.update→pump.update→reply.send`), `parse_json_tree` 231 lines (`service.rs:141`),
  `serialize()` 154-line 9-arm switch (`reconciler.ts:871`, hot — keep alloc-free),
  `render_menu` 170 lines (`inspector.rs:572`). Then split `service.rs` (3340) into
  `tree_parsing`/`tree_collection`/`appearance`/`debug_commands`/`window_setup` and clarify
  the 4-file reanimated layer (`ts/src/reanimated/*`). **M→L.**
- **Quick safe cleanups:** dedupe the `Symbol.for('rngpui.reanimated…Descriptor')` declared
  3× with 2 names (`worklets.ts:210`, `reanimated-host.ts:28`, `worklet-runtime.ts:2032`)
  into one constants module; `Animated.add/multiply/...` are silent no-op stubs that return
  wrong answers (`Animated.ts:309`) — implement or throw; dedupe appearance→scheme mapping
  (`service.rs:864`); cache `RNGPUI_WEBVIEW_GEOMETRY_DEBUG` (`webview.rs`, read 6× uncached);
  `commitTextUpdate` ignores `_old` and always dirties (`reconciler.ts:1212`); empty
  `catch {}` masking a throwing getter (`worklets.ts:719`). **S each.**

---

## Suggested execution order

1. **P0** — finish the animation (transform + the pixel ramp test + Image/Svg/Text
   opacity). This is the user's reported bug and the headline.
2. **P2.1/P2.2/P2.3** — composited-test default + frame counter + real capture command.
   Cheap, on the control socket, and a prerequisite for trustworthy animation tests.
3. **P3.3/P3.7/P3.2-gate + P4.1/P4.2** — the safe per-frame-tax wins + the poison-on-panic
   crash multiplier. Validate P3.3 on the composited path first.
4. **P1** — the remaining dead/wrong visual props, each with a pixel test.
5. **P3.5/P3.6/P3.9** — the deeper animation-allocation/coalescing work.
6. **P5.1** then the god-file splits, last.
