# applyTree delta protocol — handoff (where I left off)

Author session: `ab-mq6vh937-16164`. Date: 2026-06-09.

## What this is

Item 1 of the gui-perf remaining-wins: kill the **per-commit full-tree crossing jank**.
Today every non-no-op React commit does `JSON.stringify(fullTree)` (~150KB / ~285 nodes)
→ `__rngpui_applyTree` → `parse_json_tree` rebuilding all Arcs. ~30ms input freeze per data
commit (the JS thread does the stringify AND the parse — `host_apply_tree` runs on the JS
thread). This implements the "incremental crossing": a structural **delta** wire so a small
change crosses only the changed nodes + tiny refs for everything unchanged.

(Item 2 — pulse over-paint / cmd+tab freeze — was investigated and **dropped**: gpui 0.2.2
already stops the display link when occluded and `window.refresh()` only marks dirty (never
draws occluded), so the handoff's "visibility bridge" was redundant. See agentbus mail #6.)

## Where the code is

- Worktree: `~/.worktrees/rngpui-delta`, branch **`perf/applytree-delta`**.
- Based on **OLD** main `6a42e45` (BEFORE the render-agent's cliff fix `4897d25`).
- The work is **committed on the branch** (to preserve it across worktree cleanup), NOT on
  main, NOT pushed. `ts/node_modules` is a symlink to the main checkout (gitignored, not
  committed) — recreate with `ln -s ~/react-native-gpui/ts/node_modules
  ~/.worktrees/rngpui-delta/ts/node_modules` if missing.

## The design (how the delta works)

The reconciler already memoizes serialization: an unchanged subtree re-emits the SAME
`SerializedNode` object, and any change dirties the node AND its ancestors
(`markSerializeDirty`). So **a node whose object the host already holds ⟺ its whole subtree
is unchanged** → emit a tiny `{globalId, ref:true}` instead of re-crossing it. Rust keeps a
`globalId → Arc<ReactElement>` index from the prior commit and reuses the Arc for a ref
(structural sharing). globalIds are monotonic (`genId = ()=>nextId++`, never recycled), so a
ref can never alias a different node.

## Exact changes (all committed on the branch)

### Rust
- `rust/src/service.rs`
  - `use std::cell::RefCell;`
  - `thread_local! PRIOR_TREE_INDEX: RefCell<HashMap<u64, Arc<ReactElement>>>` + `fn
    index_tree(el, out)` (walks reconstructed tree → index for next commit's refs),
    just above `parse_json_tree`.
  - `parse_json_tree(value, prior: &HashMap<u64, Arc<ReactElement>>)`: new `prior` param;
    a `{globalId, ref:true}` node returns `prior.get(&id).cloned()`. children recursion
    passes `prior`.
  - `parse_incoming` tree path: removed `clear_sources()`; resolves refs via
    `PRIOR_TREE_INDEX` then rebuilds the index with `index_tree`.
  - `Incoming::Tree` pump handler: added `crate::inspector::retain_sources(&node_ids);`
    next to `pseudo_style::retain` (present-set prune).
  - tests: `delta_ref_reconstructs_full_tree_with_structural_sharing` + `tree_of` helper +
    `use std::sync::Arc;`.
- `rust/src/inspector.rs`
  - Removed dead `clear_sources()`; added `retain_sources(present: &HashSet<u64>)` (prunes
    SOURCE_TABLE by present-set, mirroring `pseudo_style::retain`). The source table now
    follows the same retain-by-present discipline as pseudo_style instead of clear-all,
    because ref'd nodes never re-enter `parse_json_tree`.
  - 2 test call sites switched `clear_sources()` → `retain_sources(&empty)`; added test
    `retain_sources_keeps_present_prunes_absent`.
- `rust/src/elements/system.rs` — **STOPGAP, not part of the delta**: added `style_json:
  None,` to the `test_element` helper. Main's `cargo test --bin` does NOT compile at
  `6a42e45` (the `style_json` field was added to ReactElement but this test initializer
  wasn't updated; the real fix is in the system.rs WIP owner's uncommitted changes). This
  one line just makes the test build compile in the worktree. **Drop/reconcile it when the
  WIP owner lands their fix.**

### TS
- `ts/src/wire-delta.ts` — NEW. `export function toWireDelta(node, sent: WeakSet)`: the
  delta transform (refs for already-sent objects, full otherwise).
- `ts/src/render.ts` — import `toWireDelta`; per-root `sentNodes = new WeakSet`; `pushTree`
  transforms via `toWireDelta` before `startBridge`/`bridge.update`. `sameTree` no-op skip
  and `lastTree` stay on the MEMOIZED tree (unchanged).
- `ts/src/runtime.ts` — `SerializedNode`: added `ref?: boolean`; made `type?: string`
  optional (wire ref nodes omit `type`; rust already treats type as optional).
- `ts/scripts/wire-delta-unit.mjs` — NEW unit test (registered in `test-suite.mjs`).
- `ts/scripts/test-suite.mjs` — registered the `wire-delta` task.
- `ts/examples/delta-conformance.tsx` — NEW offscreen e2e (see open issue below).

## Validation done (all green)

- Rust unit tests (worktree): `cd rust && cargo test --bin rngpui-service -- \
  delta_ref_reconstructs retain_sources_keeps_present summary_reads_source` → 3 passed.
  Proves: delta reconstruction == full apply (dump compare) + Arc structural sharing
  (`Arc::ptr_eq` on the ref'd subtree) + source-table retain semantics.
- TS unit test: `cd ts && bun run scripts/wire-delta-unit.mjs` → WIRE_DELTA_UNIT_OK.
  Proves: refs only for unchanged objects, full for changed (no false refs), minimal refs.
- E2E offscreen: `cd ts && RNGPUI_ANIM_TRACE=1 bun run scripts/run-hermes-example.mjs \
  examples/delta-conformance.tsx --timeout-ms 9000` →
  `CONFORMANCE delta PASS rows=120 changed=100->240 stable=(8,28,80)`.
  Correctness end-to-end (real Hermes + reconciler + rust binary). Bytes: full mount
  `25823`, resize deltas `3654`/`3653` (~7× smaller). The release binary is built at
  `rust/target/release/rngpui-service`.

## ⚠️ THE OPEN ISSUE (most important — read this)

In the e2e, a **React component state change** (`setN(1)`) produced a **FULL** commit
(`25863` bytes), NOT a small delta — even after I switched the fixture to stable
module-level style refs. The **resize** re-commits (which do NOT re-run the `App`
component) correctly produced deltas (`3654`). So:

- Refs definitively work (resize proves it end-to-end).
- BUT a component re-render currently re-dirties its **entire** subtree, so the delta gives
  no benefit for a change that flows through a component re-render.

**This is the crux for the real-world win and is UNRESOLVED.** Next step is to find WHY a
re-render with referentially-stable props still dirties every descendant:
- Is `commitUpdate` firing on the unchanged rows (e.g. Tamagui re-resolving/!== style props,
  or some prop the reconciler always treats as changed)? Instrument `markSerializeDirty`
  (count calls per commit) or `commitUpdate`/`commitTextUpdate` in `reconciler.ts`.
- Does the memo (`Instance.cached` + dirty flag) actually short-circuit on a clean re-render,
  or does React reconciliation touch every child enough to dirty it?
- **Decisive test still owed:** run the REAL gui ControlRoom (~285 nodes) offscreen, trigger
  ONE session's data update, and measure `applyTree bytes` (ANIM_TRACE). If a single-session
  update there is a small delta → the win is real (the app's selection-store/memo work gives
  the isolation). If it's a full commit → the delta needs to be paired with making
  component re-renders not re-dirty stable descendants (reconciler memo fix), which is the
  actual lever. Prior sessions' "selectionStore/referential-stability" work suggests the
  real app IS isolated — but THIS HAS NOT BEEN CONFIRMED.

The gui ControlRoom e2e was NOT run. To run it: build the worktree library
(`cd ts && bun install || true; bun run build`), then in `~/agentbus/gui`:
`RNGPUI_LOCAL=~/.worktrees/rngpui-delta/ts bun run sync:gpui && bun run dev:gpui:bundle`,
then drive a data change against the fixture/daemon and read ANIM_TRACE (or
`gui/native-shell/scripts/perf-profile.ts`).

## Remaining work to land

1. **Resolve the open issue above** — confirm (or fix) that a real single-session update
   produces a delta, not a full commit. This decides whether the delta is a win as-is.
2. **Rebase onto new main `4897d25`** (render-agent's cliff fix). My regions are disjoint
   from `render()`/`create_element`, BUT `parse_json_tree` calls
   `style.build_gpui_style(None)` — if their refactor changed that signature (they removed a
   `parent_style` param from builders), fix it up. `create_element` is now 2-arg
   `create_element(element, window_id)` — I don't call it. Re-run rust tests + e2e after.
   (Do NOT rebase with uncommitted changes — work is committed, so it's safe; never rebase
   main itself / shared checkout.)
3. **Full `cargo test --bin rngpui-service`** (needs the system.rs `style_json` line; the
   WIP owner should land the real fix).
4. **Inspector verify by `ab-mq68uksu-84171`** — they own the 20 inspector tests +
   source-coverage probe. They verified the render-agent's refactor, NOT my
   `clear_sources → retain_sources` change. Ping them with a synced build before landing to
   confirm option+click / source coverage still work under delta source-table pruning.
5. **Coordinate landing sequence** with the render-agent (relayed via `ab-mq63zmad-34391`):
   shared `service.rs`, disjoint regions, explicit-file commits.

## Coordination state (agentbus)

- Me: `ab-mq6vh937-16164`. Item 1 (this) is mine.
- `ab-mq63zmad-34391` — coordinator; its render-agent landed the per-FRAME cliff fix
  (`4897d25`: removed per-child ElementStyle clone; p95 7.81→5.6ms @ 1111 nodes). pseudo_style
  untouched. Mails exchanged: #6–#9.
- `ab-mq68uksu-84171` — owns inspector tests + source coverage; ping at landing.
- Per-frame (render-agent) and per-commit (this delta) are orthogonal axes; they compose.
