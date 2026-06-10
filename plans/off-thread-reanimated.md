# Real off-thread reanimated — second Hermes worklet runtime

Status: LANDED (see §Landed below; this doc remains the contract between the rust and ts sides).

## Why

Until now rngpui ran ONE Hermes runtime masquerading as reanimated's UI runtime
(`__RUNTIME_KIND = 2`): worklets executed inline on the React thread. "Off-thread"
meant only "no React re-commit" — a long React render stalled every running spring.
This lands the real architecture (ported from sootsim, the proven implementation in
~/soot): a second Hermes runtime on its own OS thread acts as reanimated's UI
runtime. Spring driving, `useAnimatedStyle` mappers, and `_updateProps` all execute
there, isolated from React-thread stalls. Tamagui's reanimated driver needs zero
changes: its mapper worklets and shared-value writes route automatically.

## Architecture

```
┌──────────────────────────┐      ┌───────────────────────────┐
│ hermes-js thread          │      │ hermes-ui thread           │
│ (React runtime)           │      │ (worklet/UI runtime)       │
│ app bundle (RNGPUI_BUNDLE)│      │ ui bundle (RNGPUI_UI_BUNDLE│
│ React + upstream          │      │  or <bundle dir>/          │
│ reanimated hooks layer    │      │  ui-runtime.js)            │
│ worklets.ts (stub) ───────┼─────►│ worklet-runtime.ts ('ui')  │
│ worklet-runtime.ts        │◄─────┼─ runOnJS / sv notify       │
│  ('react' role)           │      │ upstream reanimated core   │
│                           │      │ (valueSetter, mappers,     │
│ __rngpui_svSlots ════════ shared ArrayBuffer ════ __rngpui_svSlots
│                           │      │ animation factories)       │
│                           │      │ _updateProps → setNodeStyle│
└──────────┬────────────────┘      └──────────┬────────────────┘
           │ Incoming::Tree                   │ Incoming::SetNodeStyle
           ▼                                  ▼
      GPUI render thread (anim_overlay merges per paint; frame_clock
      = CVDisplayLink drives both runtimes' requestAnimationFrame)
```

## Crossings (all strings through rust; FIFO per direction)

- React→UI: JS calls `__rngpui_uiPost(json)` (host fn on React runtime) → rust
  posts `JsCall{ "__rngpui_peerRecv", json }` onto the UI runtime's queue.
- UI→React: JS calls `__rngpui_jsPost(json)` (host fn on UI runtime) → rust posts
  `__rngpui_peerRecv(json)` onto the React queue.
- Message payloads are the sootsim `WorkletMessage` union, JSON-encoded:
  `runWorklet` / `workletReply` / `workletDone` / `runJSCallback` / `svUpdate` /
  `svUpdateBatch` / `svAlloc` / `svObjectAlloc` / `svFree`.
- Shared-value primitives live in `__rngpui_svSlots`: ONE shared memory region
  created by rust (`rng_hermes_shared_buffer_create`) and installed in BOTH
  runtimes as a zero-copy ArrayBuffer global. Layout (must match both sides +
  rust init): Float64Array; [0]=magic `0x504e9a01`, [1]=capacity (total float
  count incl. 4-float header), [2..3] reserved, slots from index 4. Capacity:
  262144 floats (2MB). React runtime allocates EVEN slot ids, UI runtime ODD
  (stride 2) — sootsim's collision-free two-lane allocator. Aligned 8-byte
  loads/stores are tear-free on arm64; ordering rides the message channel
  (same contract as web SAB+postMessage).
- Both runtimes share one `performance.now()` epoch (rust global EPOCH) so
  timestamps are comparable across runtimes.
- rAF on both runtimes rides frame_clock (CVDisplayLink): React arms bit 0,
  UI arms bit 1.

## Who runs what (sootsim-faithful)

- React runtime keeps `__RUNTIME_KIND = 2` (upstream's eager mode — unchanged
  from today) and runs upstream reanimated's hook/component layer.
- `worklets.ts` (the react-native-worklets replacement the bundler redirects to)
  routes every workletized `runOnUI` / `scheduleOnUI` / `runOnUIAsync` to the UI
  runtime via `dispatchWorklet` (code string + closure spec + args). Upstream's
  own `startMapper` rides `runOnUI`, so mappers register and tick UI-side.
- The UI runtime evaluates `ui-runtime.js`: the seam (KIND=2 globals,
  `_updateProps` → coalesced `__rngpui_setNodeStyle`), upstream reanimated core
  (prebuilt — provides valueSetter animation driving + `withSpring`/`withTiming`
  factories for the worklet builtin registry), and worklet-runtime in 'ui' role.
- `sv.value = withSpring(x)` inside a dispatched worklet drives entirely on the
  UI thread; per-frame style deltas cross UI→render as `Incoming::SetNodeStyle`
  (never touching the React thread).
- `runOnJS(fn)` registers fn React-side; UI-side invocations post `runJSCallback`.
- Without the host bridge (bun unit tests): every primitive degrades to local
  inline execution — the pre-existing single-runtime behavior, preserved by
  sootsim's own hasPeer checks.

## Faithfulness rules (sootsim lessons — do not "improve")

1. Closure materialization caches by (workletHash, closureId); mappers mutate
   their materialized closure across frames — re-deserializing breaks spring
   continuity.
2. `shareableRef` specs resolve to the SAME UI-side object on every re-ship
   (upstream serializableMappingCache contract).
3. Inbound sv updates read the CURRENT shared-slot cell, never the queued
   payload (stale-payload slow-motion bug).
4. Boolean slots tracked in a Set; reads restore true/false (upstream `=== false`
   checks).
5. One SharedValue proxy per slot id per runtime (valueSetter cancels running
   animations via `_animation` on the proxy identity).
6. UI-side sv writes from worklets do NOT bounce a peer notification per frame
   (skipNotify) — peers read the shared cell; only listener wakeups cross, and
   they are microtask-batched (`svUpdateBatch`).

## File map

rust (main session owns):
- `rust/src/hermes.rs` — `start_ui()`, UI_CALLS/post_ui, host fns
  (`__rngpui_uiPost` on React; `__rngpui_jsPost`, `__rngpui_setNodeStyle`,
  timers/log/now/`__rngpui_requestFrame`→UI bit on UI), shared EPOCH, shared
  slots create+install+header init.
- `rust/src/service.rs` — load ui bundle (RNGPUI_UI_BUNDLE || `ui-runtime.js`
  next to the executable — it versions with the BINARY, not the app; hard error
  if missing), call start_ui.
- `rust/src/frame_clock.rs` — already multi-runtime (bit 1 = UI).

ts (port agent owns):
- `ts/src/reanimated/worklet-runtime.ts` — NEW: vendored port of
  ~/soot/packages/sootsim-engine/src/render-worker/worklet-runtime.ts.
- `ts/src/reanimated/worklet-channel.ts` — NEW: channel adapter over the host
  fns above.
- `ts/src/reanimated/worklets.ts` — REWRITE: port of
  ~/soot/packages/compat/src/stubs/react-native-worklets-pkg/index.ts onto the
  existing export surface.

integration (main session owns):
- `ts/src/reanimated/ui-entry.ts` — UI bundle entry.
- `ts/scripts/*` bundling: build `dist/ui-runtime.js`; launchers place it next
  to the app bundle.
- seam.ts adjustments + conformance gates (incl. the react-thread-stall gate:
  a spring must keep producing setNodeStyle frames while the React thread is
  blocked in a busy loop — THE off-thread proof).

## Landed — integration findings (2026-06-09)

The port + rust runtime landed; gates: reanimated (spring ramp, 2-runtime),
offthread-stall (96 setNodeStyle crossings during an 800ms React-thread
busy-loop — THE proof), dialog-reanimated (color animations + bg), raf-pacing
(120Hz vsync), sustained, worklet-runtime-unit (JSON-faithful loopback).

What the integration debugging actually taught (each was a silent failure):

1. **Hermes has no `structuredClone`.** The vendored serializer's
   `structuredCloneSafe` silently returned undefined for every plain closure
   value (bun has structuredClone, so unit tests passed — the loopback now JSON
   round-trips to match the real channel). Fix: JSON-round-trip semantics,
   one path in both environments.
2. **`fn.toString()` is garbage in bytecode bundles.** Synthetic worklets
   (markSyntheticWorklet) whose code crosses MUST carry an explicit source
   string — `{ [bytecode] }` evals to a ReferenceError on the peer.
3. **rngpui's shadowNodeWrapper is a bare number.** The reconciler's
   `__internalInstanceHandle.stateNode.node` IS the globalId; the serializer's
   viewTag walk must accept numerics, not just object shapes.
4. **Live animation objects must never cross.** A `withSpring(...)` result in a
   shipped closure/shareable carries runtime-created onFrame/onStart closures
   that degrade to async jsCallbacks (the dialog-bg regression).
   reanimated-host.ts stamps factory results with {type,args}; the serializer
   ships `{kind:'animation'}` and the receiving runtime re-creates from its own
   factory table. upstream's internal `valueSetter` is surfaced from the
   prebuilt chunk (as `__rngpuiValueSetter`) to drive proxy writes UI-side.
5. **Any plain (non-workletized) fn captured by an upstream worklet must be a
   registered builtin.** colors-processor-shim's processColorsInProps was
   captured by upstream's updateProps worklet and shipped as a dead jsCallback
   → every color key crossed as undefined. The shim now brands + registers its
   exports (the prebuilt chunk can't import worklet-runtime, so it replicates
   the Symbol.for brand + global registry keys).

Diagnostics added along the way (all env-gated, keep): RNGPUI_BRIDGE_TRACE
(=1 truncated / =full payload dump of every crossing), RNGPUI_ANIM_TRACE=2
(per-op id + source thread + style keys at the host), the seam's
undefined-value drop warning under RNGPUI_SEAM_DEBUG, and
examples/worklet-dispatch-probe.tsx (minimal generic-dispatch probe).
