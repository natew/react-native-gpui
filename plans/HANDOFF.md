# HANDOFF — finish merging single-process Hermes + re-integrate the describe-CLI

You are taking over a nearly-complete piece of work. The hard part (a single-process Hermes
desktop renderer) is **DONE, validated, and committed**. What remains is a **git merge with a
known semantic gotcha**, plus a **follow-up re-integration** of another agent's CLI feature.
Read §1–§3 first; they're enough to land the merge. §4+ is depth.

---

## 1. What is already done (do NOT redo)

A complete rewrite of the agentbus desktop app to run in **ONE process** — no Bun, no second
process, no NDJSON pipe:

- The Rust GPUI binary (`rngpui-service`) embeds **Hermes** on a dedicated JS thread and runs
  React from precompiled bytecode (mmap, no launch-time bundling).
- The JSON element-tree protocol and the entire native-event protocol are **unchanged**; only
  the transport moved from OS pipes to in-process host calls via a thin JSI C ABI shim.
- **Validated with real pixels**: the full Tamagui ControlRoom renders, connects to a live
  `agentbus serve` daemon (real sessions + git changes), fetch + WebSocket both work.
- **Cold start ~135 ms** for the full app (target was <200). Measured, repeatable.
- **Resize-freeze fixed** (event coalescing + batched React updates) and **user-confirmed**.

It lives on branch **`single-process-hermes`** (tip **`158e0c0`**) in worktree
**`~/rng-hermes`** (a worktree of `~/react-native-gpui`). Full design + status:
`~/rng-hermes/plans/single-process-hermes.md` (read it).

---

## 2. Exact repo state right now

```
~/react-native-gpui   (main checkout)   HEAD = f0cc843  [main]   — CLEAN
~/rng-hermes          (worktree)        HEAD = 158e0c0  [single-process-hermes]   — CLEAN, BUILDS, 0 warnings
```

- **`main` f0cc843** = the CLI agent's committed work + a commit I made (`f0cc843`) preserving
  their *in-flight* "rngpui describe-CLI" (dump tree / control-fifo / synthetic input). main is
  3 commits ahead of my branch's base `9fe50e9` (their CLI/describe commits, none of which touch
  my files) **plus** `f0cc843`.
- **`single-process-hermes` 158e0c0** = the rewrite (commit `2e97b7d`) + a launcher commit
  (`158e0c0`). Based on `9fe50e9`.

**HARD external dependency (not in any repo):** Hermes is built from source at
**`~/github/hermes/build`** — `lib/libhermesvm.dylib` (linked) + `bin/hermesc` (bytecode
compiler). `rust/build.rs` finds it via `HERMES_ROOT` (default `/Users/n8/github/hermes`). If
that dir is gone, rebuild: `git clone --depth 1 https://github.com/facebook/hermes && cmake -S
hermes -B hermes/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build hermes/build
--target hermesc libhermesvm`. (ninja required: `brew install ninja`.)

**Also uncommitted, in `~/agentbus` (separate repo):** the gui-side bundler
`gui/native-shell/scripts/bundle-app-hermes.mjs` (new) + minor edits. Commit those too (§6).
NOTE `~/agentbus` and `~/react-native-gpui` both host *other* live agent sessions — stage by
explicit file list, never `git add -A`.

---

## 3. Remaining Task A — land the merge on `main` (the main ask)

Goal: `react-native-gpui/main` should become the single-process rewrite, while **preserving the
CLI agent's describe-CLI files in history** (already safe in `f0cc843`).

### THE CRITICAL GOTCHA
`git merge single-process-hermes` **auto-merges `service.rs` and `bridge.rs` textually** (their
control-fifo edits touch different *lines* than my rewrite) — but that result is **semantically
broken**: it keeps their old-transport (`stdin`/`stdout`) control-fifo glue *next to* my
rewrite that **deleted** that transport. It will not compile / will not work. You MUST force
**my** version of the three transport files, not trust git's auto-merge.

### Recommended steps (fast, clean: park the describe-CLI, re-integrate later)
```sh
cd ~/react-native-gpui
git merge --no-commit --no-ff single-process-hermes      # conflicts on ts/src/runtime.ts; auto-"merges" the rest
# FORCE my (single-process) version of every transport/JS file the rewrite owns:
git checkout single-process-hermes -- \
  rust/src/service.rs rust/src/bridge.rs rust/src/hermes.rs rust/src/hermes_preamble.js \
  rust/build.rs rust/Cargo.toml rust/Cargo.lock rust/hermes_shim \
  ts/src/runtime.ts ts/src/render.ts ts/src/apis.ts ts/src/colors.ts
git add -- rust/src/service.rs rust/src/bridge.rs rust/src/hermes.rs rust/src/hermes_preamble.js \
  rust/build.rs rust/Cargo.toml rust/Cargo.lock rust/hermes_shim \
  ts/src/runtime.ts ts/src/render.ts ts/src/apis.ts ts/src/colors.ts
git commit --no-edit
cd rust && HERMES_ROOT=~/github/hermes cargo build --release --bin rngpui-service
```
The build will then fail where the **describe-CLI references symbols my rewrite removed**
(their `bridge::dump_ready` caller, a `mod dump`, control-fifo hooks in their old `service.rs`,
their `elements/div.rs`+`inspector.rs` describe additions that may call removed things). For the
**fast clean result**, park the describe-CLI: revert the describe-coupled files to my base and
drop the now-orphaned glue, so main compiles as pure single-process —
```sh
# only the ones that actually break the build; let cargo tell you:
git checkout 9fe50e9 -- rust/src/elements/div.rs rust/src/elements/mod.rs rust/src/inspector.rs
git rm -q rust/src/dump.rs        # if it's an orphan module that won't compile
git commit --amend --no-edit
```
The describe-CLI stays fully recoverable in `f0cc843` for Task B. (Alternative: do Task B now and
keep it functional — more work.)

### Then VALIDATE (don't skip — "renders" != "works"):
```sh
cd ~/agentbus/gui && RNGPUI_LOCAL=~/react-native-gpui/ts \
  bun native-shell/scripts/bundle-app-hermes.mjs /tmp/agentbus-app.js --bytecode
# point the launcher at main now (not the worktree):
AGENTBUS_GUI=~/agentbus/gui  ~/rng-hermes/run-hermes-app.sh   # or copy run-hermes-app.sh + adjust RNG
```
Expect: window opens, status bar "live · 127.0.0.1:7777" (start `agentbus serve` first),
real sessions in the sidebar, ~135 ms cold start (`RNGPUI_STARTUP_TIMING=1` prints
`[startup] first render +Xms`). Resize the window on the Terminal tab → must stay smooth.

> Do NOT push to `main` without the user's explicit OK. Commit locally; the user pushes.
> Other agents share these checkouts — never `git add -A`, never rebase/stash across their files.

---

## 4. Remaining Task B — re-integrate the describe-CLI (follow-up, coordinate w/ CLI agent)

The CLI agent (`ab-mq4am6nr-63944`, mailed twice already) built a "drive + inspect" dev CLI:
`get: tree/describe/layout/style/color`, `do: tap/type/key/scroll`, via an `RNGPUI_CONTROL_FIFO`
the old two-process service read, plus a tree `dump` and `synthetic input`. All of it is on the
**removed** transport. Re-wiring onto single-process is straightforward conceptually:
- **Control fifo -> JS:** spawn a thread in `rngpui-service` that reads the fifo and turns
  commands into native events via `bridge::*` -> `hermes::post("__rngpui_onHostEvent", …)` (same
  path real input uses). Synthetic tap/type/scroll = post the same event JSON the OS path emits.
- **Tree dump:** the serialized tree is the exact JSON the JS hands to `__rngpui_applyTree`
  (`rust/src/hermes.rs` `host_apply_tree`). Capture it there (or keep a copy in `ServiceApp`)
  and write it on a `dump` command. `bridge::dump_ready` can stay (it's additive over my
  `emit_value`). NOTE: in one process you may not even need a fifo — a unix socket or a CLI
  subcommand that talks to a running instance may be cleaner. Their committed CLI also has
  `--launch-cmd`/`--cwd` to drive any rngpui app; the new launch entry is
  `RNGPUI_BUNDLE=<app.hbc> rngpui-service` (no Bun/run-gpui.ts). Coordinate the design with them.

---

## 5. Architecture you're merging (so resolution is informed)

Two threads, one process. `rust/src/service.rs` `main()` is the Rust entry; GPUI/Metal own the
**main thread**; Hermes runs on a **JS thread** (`rust/src/hermes.rs`).

- **JS->native:** the bundle's reconciler calls `globalThis.__rngpui_applyTree(json)` each commit
  -> `host_apply_tree` parses it (reuses the unchanged `parse_incoming`/`parse_json_tree`) and
  sends an `Incoming` on the existing `flume` channel the GPUI applier already drained.
- **native->JS:** anything that must call JS (`bridge::emit_*` events, fetch/ws results) calls
  `hermes::post(fn, arg)` -> a unified **JsCall queue** -> the JS thread's loop invokes the global.
  The loop also runs timers/rAF/microtasks. Events are **coalesced** (resize/layout/scroll/move ->
  latest-per-node) and **batched** (`__rngpui_onHostEventBatch` wraps dispatch in React
  `batchedUpdates` -> one render per frame) — this is the resize-freeze fix.
- **The bridge** is a thin C ABI over Hermes JSI: `rust/hermes_shim/hermes_shim.{h,cpp}`, built
  by `rust/build.rs` alongside vendored `jsi.cpp`, linked to `libhermesvm`. Validated standalone
  by `rust/hermes_shim/shim_selftest.cpp`.
- **Host env** (`rust/src/hermes_preamble.js`, `include_str!`'d into the binary): console,
  timers, rAF, performance, **fetch** (ureq, `host_fetch`), **WebSocket** (tungstenite,
  `host_ws_*`), and the web globals Hermes lacks: `Headers` (this was THE connect blocker —
  `api.ts` does `new Headers()` per request), `TextEncoder/TextDecoder`, `btoa/atob`,
  `localStorage` (in-memory), `navigator`, `URLSearchParams`.
- **JS lib changes** (in `single-process-hermes`): `ts/src/runtime.ts` `startBridge` is now the
  host bridge (+ batched dispatch + `setEventBatcher`); `ts/src/render.ts` wires
  `Reconciler.batchedUpdates`; `ts/src/colors.ts` drops the `defaults read` spawn (native
  appearance event already drives it); `ts/src/apis.ts` drops the `osascript` file-picker spawn
  (stubbed — a native NSOpenPanel host fn is a TODO).
- **Startup optimization (don't regress):** `main()` does NOT block for the first tree before
  GPUI init — it `hermes::start`s, then awaits the first tree **inside `app.run` just before
  `open_window`**, so the ~85 ms tree-independent GPUI/Metal init overlaps the ~60 ms JS eval.
  That overlap is the difference between ~210 ms and ~135 ms. Keep it.

Key files: `rust/src/{service.rs,bridge.rs,hermes.rs,hermes_preamble.js}`, `rust/build.rs`,
`rust/hermes_shim/*`, `ts/src/{runtime.ts,render.ts,colors.ts,apis.ts}`,
`gui/native-shell/scripts/bundle-app-hermes.mjs` (in ~/agentbus).

---

## 6. Build / bundle / run / measure (exact)

```sh
# binary
cd ~/rng-hermes/rust && HERMES_ROOT=~/github/hermes cargo build --release --bin rngpui-service
#   build.rs auto-adds rpaths; for a runnable binary the dylibs must sit next to it:
GH=$(find target/release/build -path '*ghostty-install/lib' -type d | head -1)
cp "$GH"/libghostty-vt*.dylib ~/github/hermes/build/lib/libhermesvm.dylib target/release/

# bundle (Bun is only the dev bundler; output runs under Hermes)
cd ~/agentbus/gui && RNGPUI_LOCAL=~/rng-hermes/ts \
  bun native-shell/scripts/bundle-app-hermes.mjs /tmp/agentbus-app.js --bytecode

# run a real window (no Bun, single process). EVERYTHING is one binary:
RNGPUI_BUNDLE=/tmp/agentbus-app.hbc AGENTBUS_URL=http://127.0.0.1:7777 \
  ~/rng-hermes/rust/target/release/rngpui-service
#   ...or just:  ~/rng-hermes/run-hermes-app.sh   (does all of the above + an .app wrapper)

# measure cold start
node ~/rng-hermes/ts/scripts/measure-hermes-startup.mjs \
  ~/rng-hermes/rust/target/release/rngpui-service /tmp/agentbus-app.hbc 8
```

Commit the ~/agentbus gui side (explicit files only):
```sh
cd ~/agentbus && git add gui/native-shell/scripts/bundle-app-hermes.mjs \
  gui/native-shell/scripts/measure-startup.mjs gui/native-shell/startup-measure.tsx \
  gui/native-shell/scripts/open-gpui.mjs gui/package.json gui/native-shell/README.md && git commit -m "..."
```

---

## 7. Driving + visually verifying the app (you cannot run foreground GUI tests blindly)

HARD RULE (see `~/agentbus/CLAUDE.md`): no foreground/focus-stealing GUI runs except when the
user asks. The app's macOS accessibility tree is **empty** (`get_window_state` -> element_count
0), so AX-by-index doesn't work — drive by **pixel** with **cua-driver** (it posts input to
backgrounded windows via CGEvent.postToPid, no focus theft):
```sh
cua-driver call list_windows '{}'                              # find window_id (title "react-native-gpui")
cua-driver call get_window_state '{"pid":PID,"window_id":WID}' # has screenshot_png_b64 -> decode + view
cua-driver call click '{"pid":PID,"window_id":WID,"x":972,"y":65}'   # ~Terminal tab (screenshot pixels)
cua-driver call drag  '{"pid":PID,"window_id":WID,"from_x":...,"to_x":...,"duration_ms":150}'  # resize corner
```
For offscreen/no-focus pixel capture during dev use `RNGPUI_CAPTURE_ONSCREEN=1 RNGPUI_OPAQUE_WINDOW=1
RNGPUI_CAPTURE_PNG=/tmp/x.png RNGPUI_CAPTURE_ALPHA=0.02` (invisible on-screen window that still paints).
`RNGPUI_TEST_MODE=1` = hidden/offscreen (won't paint). `RNGPUI_STARTUP_TIMING=1` prints the
first-paint marker. `RNGPUI_DEBUG_QUEUE=1` logs coalesced event batches >16.

---

## 8. Known gaps / follow-ups (not blockers)
- Native **file picker** (`apis.ts` runFilePickerScript) -> needs an NSOpenPanel host fn (stubbed).
- **WebSocket binary frames** delivered base64; if the app needs ArrayBuffer, decode in the preamble.
- **localStorage** is in-memory (connection config won't persist across launches) — host-fn-back it if needed.
- **URL / Blob** not polyfilled (lazy paths: terminal-lens, attachments) — add when exercised.
- **Dev watcher**: no `bun build --watch -> hermesc -> reload` yet, so dev still rebuilds manually.
- The bundler points `RNGPUI_LOCAL` at the worktree; after the merge, repoint it at
  `~/react-native-gpui/ts` (or release the lib normally).

## 9. Coordination
The CLI agent `ab-mq4am6nr-63944` has been mailed twice (the new launch model + the merge
takeover). After you land the merge, mail them the final state + the describe-CLI re-integration
plan (§4) so their parked work resumes on the right base.

## 10. Gotchas that cost time (save yourself the hours)
- `git merge` auto-merges `service.rs`/`bridge.rs` but it's **semantically wrong** — force my version (§3).
- Hermes can't parse `import.meta` — the bundler strips it via `define` (already handled in bundle-app-hermes.mjs).
- The connect-blocker was `new Headers()`, not fetch — Hermes lacks many web globals; the preamble polyfills the set.
- libhermesvm + libghostty dylibs must sit **next to the binary** (`@executable_path` rpath) or it won't launch.
- zsh does NOT word-split unquoted vars (`env $VARS cmd` fails) — inline env assignments.
- Recursive force-deletes with shell globs are guarded in this environment — use `trash` or explicit paths.
- Keep the JS-eval / GPUI-init **overlap** in `main()` (§5) — it's the <200 ms win.
