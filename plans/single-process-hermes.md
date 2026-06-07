# Single-process Hermes renderer (no Bun, no second process, no NDJSON)

Goal: collapse the two-process model (Bun JS ⇄ NDJSON pipe ⇄ Rust GPUI service) into
**one process**: the Rust binary is the host, owns the macOS main thread for
GPUI/Metal/AppKit, and embeds **Hermes** on a spawned JS thread running React from
**precompiled bytecode** (mmap, no launch-time bundling). Target: **cold start < 200 ms**
to a painted window.

## Why this shape

- macOS AppKit/Metal run loop *must* own the main thread → the native binary is the
  host and the JS engine is the guest (the React Native model). "Bun loads GPUI" is the
  wrong polarity (Bun wants main too).
- Hermes precompiles to bytecode → zero JS parse at launch, low memory. We don't use any
  Bun runtime APIs, so dropping Bun-the-runtime costs nothing (Bun stays the dev bundler).
- The bridge stops being an OS pipe with full-tree JSON re-serialization and becomes
  in-process host-function calls. (Incremental deltas — sootsim's wire-delta — come later;
  see `## Later`.)

## The seam (what changes vs. what stays)

The JSON tree protocol and the entire event protocol are **kept identical** — only the
transport changes from OS pipes to in-process Hermes calls.

KEEP unchanged:
- `rust/src/elements/*`, `rust/src/style.rs` — the whole GPUI render layer.
- `rust/src/service.rs` `parse_json_tree`, `parse_incoming`, `fill_root`, the `flume`
  channel, and the foreground GPUI applier task.
- `ts/src/reconciler.ts` (Fiber host config + `serializeContainer` + `dispatchEvent`),
  `ts/src/render.ts` (commit sink + event routing). `render.ts` calls `startBridge` and
  is untouched.

REPLACE:
- `ts/src/runtime.ts` `startBridge`: instead of `spawn`+stdio, call host fns
  `globalThis.__rngpui_applyTree(json)` and receive events via `globalThis.__rngpui_onHostEvent(json)`.
- `rust/src/bridge.rs` `emit_line`: instead of writing JSON to stdout, push the event JSON
  onto a queue the JS thread drains and dispatches into Hermes.
- `rust/src/service.rs` `main()`: instead of a stdin-reader thread, spawn the Hermes JS
  thread; its `__rngpui_applyTree` host fn parses the tree and sends `Incoming` on the same
  `flume` channel the foreground applier already drains.

NEW:
- `rust/hermes_shim/hermes_shim.{h,cpp}` — thin C ABI over Hermes JSI.
- `rust/build.rs` — compile the shim (cc), link the Hermes libs, set rpath.
- `rust/src/hermes.rs` — safe Rust wrapper + the JS thread + JS event loop (timers / rAF /
  posted events / microtask drain).
- `ts/src/hermes-preamble.js` — the host environment (console, timers, rAF, performance,
  fetch, WebSocket) defined in terms of host fns; evaluated before the app bundle.
- Build: `bun build` (single bundle) → `hermesc` → `app.hbc`; the host mmaps `app.hbc`.

## Host-call ABI (Hermes ⇄ Rust, all on the JS thread)

JS → Rust host fns installed on `global` before the bundle runs:
- `__rngpui_applyTree(json: string): void` — parse tree/command, send `Incoming` on flume.
- `__rngpui_log(json: string): void` — console.* sink.
- `__rngpui_now(): number` — monotonic ms (performance.now).
- `__rngpui_setTimer(json /*[id,ms,repeat]*/): void`, `__rngpui_clearTimer(json /*[id]*/): void`.
- `__rngpui_close(): void` — quit.
- `__rngpui_fetch(json)`, `__rngpui_ws*(json)` — IO (Later).

Rust → JS globals (called on the JS thread by the loop):
- `__rngpui_onHostEvent(json): void` — native event → `dispatchEvent` (render.ts handleEvent).
- `__rngpui_fireTimer(id): void`, `__rngpui_fireFrame(tsMs): void`.

## main() restructure

1. spawn JS thread → installs host fns → evals preamble → evals `app.hbc`. React's first
   (synchronous, LegacyRoot) commit calls `__rngpui_applyTree(firstTree)` during eval →
   sends `Incoming::Tree` on flume.
2. main thread blocks on `tree_rx.recv()` for the first tree → window size.
3. create GPUI Application, open window, `ServiceApp.root = firstTree`.
4. `bridge::ready(w,h)` → posts to JS event queue.
5. spawn foreground task draining subsequent `Incoming` from flume (unchanged applier).
6. `app.run()` (main thread cocoa loop). `bridge::emit_*` posts events to the JS queue;
   the JS loop drains + dispatches.

## JS event loop (on the JS thread, Rust-driven; Hermes has no loop)

```
loop {
  // 1. process queued native events / commands → __rngpui_onHostEvent(json)
  // 2. fire due timers → __rngpui_fireTimer(id)
  // 3. on frame signal → __rngpui_fireFrame(ts)  (rAF; driven by UI thread / vsync)
  // 4. drainMicrotasks()
  // 5. block until next event OR next timer deadline (recv_timeout)
}
```

## Startup budget (< 200 ms)

Removed vs. today (~1.2–1.4 s): the ~0.7 s launch Bun.build (bytecode is prebuilt + mmap'd)
and the second-process spawn + IPC handshake. Remaining = process+dylib load + Hermes init +
eval bytecode + first React render + GPUI/Metal/window/first paint. The irreducible chunk is
GPUI/Metal/window init; optimize (defer liquid-glass, lean first frame, warm) to land < 200 ms.

## Status / checklist

- [x] Toolchain: cmake/clang/ninja; Hermes built from source (`~/github/hermes/build`):
      `tools/hermesc` ✓, `lib/libhermesvm.dylib` ✓ (exports `makeHermesRuntime`).
- [x] C++ JSI shim (`hermes_shim.{h,cpp}`) — **validated standalone** (`shim_selftest.cpp`:
      create/eval/void+num host fns/JS↔C calls/microtask drain all pass). Link: compile
      `hermes_shim.cpp` + `API/jsi/jsi/jsi.cpp`, `-lhermesvm`, rpath `build/lib`.
- [x] `build.rs` compiles shim + links Hermes + rpath (`@executable_path`/`@loader_path` +
      hermes lib dir; dylibs staged next to the binary).
- [x] `hermes.rs` wrapper + JS thread + event loop (timers/rAF/microtasks/events).
- [x] Rewire `service.rs main()` (load bundle, spawn JS thread) + `bridge.rs emit_line` → JS queue.
- [x] Rewrite `ts/src/runtime.ts startBridge` (host bridge) + drop node-builtin imports
      (`colors.ts` dark-mode spawn → native appearance event; `apis.ts` file picker → host-fn stub).
- [x] `hermes-preamble.js` host env (console/timers/rAF/performance/process).
- [x] **First paint of a real React tree, single process — VALIDATED with pixels**
      (`examples/hermes-smoke.tsx`: "Hello from Hermes", timer-driven `tick N` re-renders flowing
      through the in-process bridge; `/tmp/hermes-smoke.png`). Hermes evals a 669 KB React+lib bundle.
- [x] Bundle → hermesc → `app.hbc` (`scripts/bundle-hermes.mjs --bytecode`); host mmaps + evals
      it (Hermes auto-detects HBC). hermesc accepts the Bun-bundled JS as-is. dev watcher: TODO.
- [x] **Scale to full Tamagui ControlRoom — RENDERS, single process** (`bundle-app-hermes.mjs`,
      1.8 MB js / 1.37 MB hbc). Fixed `import.meta` (Hermes can't parse it → `define` strips it).
      Pixels: full sidebar/stage/panels/status bar/SVG icons/theming (`/tmp/agentbus-app2.png`).
- [x] **Startup < 200 ms — MET for the REAL app: ~135 ms cold** (127–141 ms wall, bytecode).
      Breakdown (RNGPUI_STARTUP_TIMING): bundle mmap 0.2 ms · JS eval+first render ~60 ms ·
      GPUI/Metal/window ~120 ms. **Key optimization: overlap** — moved the first-tree wait from
      before `Application::new()` to inside `app.run` just before `open_window`, so the
      tree-independent GPUI init (~85 ms) runs concurrently with the JS eval (~60 ms). Tree is
      already available when the window opens (no wait, no size flash). Saved ~75 ms (210→135).
      smoke: ~139 ms; both well under 200.
- [x] **Fully working — LIVE DATA against a real daemon.** fetch (ureq) + WebSocket (tungstenite)
      host fns + a unified host→JS call queue (`hermes::post`). Polyfilled the web globals Hermes
      lacks that the app/RN need: **Headers** (the connection blocker — `new Headers()` per request),
      TextEncoder/TextDecoder, btoa/atob, localStorage (in-memory), navigator, URLSearchParams.
      Result: status bar "● live", real sessions in the sidebar, real git changes in the panel
      (`/tmp/agentbus-live2.png`). WS delivers live updates; fetch loads REST data.

## STATUS: COMPLETE ✅
Single-process desktop renderer working end-to-end: the agentbus ControlRoom runs in ONE process
(Rust host on the main thread + embedded Hermes on a JS thread + in-memory bridge), **no Bun, no
second process, no NDJSON pipe**, connected to a live daemon, **cold start ~135–140 ms** (target
was < 200). Branch `single-process-hermes` (worktree ~/rng-hermes); gui bundler
`agentbus/gui/native-shell/scripts/bundle-app-hermes.mjs`.

Launch: `RNGPUI_BUNDLE=/path/app.hbc rngpui-service` (bytecode mmap'd; build via
`bundle-app-hermes.mjs --bytecode` → hermesc). Measure: `ts/scripts/measure-hermes-startup.mjs`.

### still open (follow-ups, not blockers)
- Dev watcher (`bun build --watch` → hermesc → reload) so there's no build step in the hot path.
- Port remaining native host fns: file picker (NSOpenPanel), binary-WS framing → ArrayBuffer.
- Persisted localStorage (host-fn-backed) if connection config must survive relaunch.
- URL/Blob polyfills (lazy paths: terminal-lens, attachments) — add when those features are exercised.
- Wire the rngpui dev CLI's control channel (RNGPUI_CONTROL_*) natively into the one process.
- Merge path: point the gui at a released react-native-gpui instead of the worktree; delete the
  old two-process launch (run-gpui.ts stdio, open-gpui bun child) once cut over.
- [ ] Delete the old NDJSON/two-process path (runtime.ts stdio, stdin thread, open-gpui bun child).

### remaining host fns (ported from node spawns)
- native file picker (`apis.ts` runFilePickerScript) → Rust NSOpenPanel host fn.
- fetch / WebSocket → Rust IO host fns + JS-thread completion callbacks (for live agentbus data).

## Later (runtime perf, after it's working)

- Incremental wire-delta + subtree-revision dirty bits (sootsim #1/#2): `__rngpui_applyDelta`
  with `{full, upserts, removed}` instead of full-tree; Rust applies in place to an id→node map.
- Send-side flood guard (sootsim #3) on the JS→Rust path.
- Cached-rect synchronous `measureInWindow` (sootsim #4 interim): UI pushes computed rects into
  a JS-side id→rect map so measure reads sync without a round-trip.
