# react-native-gpui

## Build & test

- Typecheck the TypeScript package from `ts/`: `npm run typecheck`.
- Build the shipped package from `ts/`: `npm run build`. This builds the release
  `rngpui-service`, copies it into `ts/native/`, emits declaration files, and
  bundles `dist/index.js`.
- For runtime validation, launch a real example with the package binary, then
  inspect the GPUI window with macOS AX tooling:

```sh
cd ts
RNGPUI_NO_ACTIVATE=1 RNGPUI_SERVICE="$PWD/native/rngpui-service" bun run examples/kitchen-sink.tsx
```

## Releasing into agentbus

`~/agentbus/gui` consumes this package locally, but it is not symlinked. The
agentbus native shell deliberately copies this package into
`~/agentbus/gui/node_modules/react-native-gpui` as a real directory so the app and
renderer share one React instance.

Do not manually copy this repo into agentbus. Use the agentbus-side release script:

```sh
cd ~/agentbus/gui
bun run release:gpui
```

That script:

- bumps this repo's root, `ts/`, and Rust crate versions;
- builds the package and native `rngpui-service`;
- copies `dist/`, `native/`, `package.json`, and `README.md` into agentbus;
- writes `~/agentbus/gui/native-shell/react-native-gpui-release.json`;
- commits the version bump in this repo;
- commits the version marker in `~/agentbus`.

Use `bun run sync:gpui` in `~/agentbus/gui` only for quick local iteration. It
refreshes the copied package but does not create a version-history marker.

## Developer CLI: `rngpui` (inspect + drive a GPUI app)

`rngpui` is the in-repo devtool for inspecting and driving a running react-native-gpui
app **without screenshots** — modeled on soot's `sootsim` CLI. Run it from `ts/`:

```sh
bun run cli/bin.ts <get|do> <subcommand> [selector] [target] [--json]
# or, after build, the `rngpui` bin / `npm run rngpui`
```

It is the answer to "is this element actually visible / what color is it really /
where is it" — questions the static React tree dump alone can't answer. Every value
is **measured at runtime**: computed window-coordinate bounds (from the paint pass)
and the **actual sampled pixel color** within those bounds.

**`get` (read-only introspection):**

- `get tree` — full annotated node tree (type, ids, computed bounds).
- `get describe [selector]` — per node: path, ids, **computed bounds**, resolved
  style, and **sampled dominant/average color** inside the bounds (+ `visible`).
- `get layout [selector]` — computed bounds per node.
- `get style <selector>` — resolved style (incl. background/border/color).
- `get color <selector|x,y>` — sampled color in a node region or at a point.
- `get point <x,y>` — topmost node + pixel color at a window point.

**`do` (drive — needs an owned/launched instance):**

- `do tap <selector|x,y>`, `do type <text>`, `do key <key>`, `do scroll <sel|x,y> <dx,dy>`.

**Targeting:**

- `--launch <entry.tsx>` — spawn a rngpui example offscreen + non-activating and own
  its control channel.
- `--launch-cmd "<cmd>" --cwd <dir>` — drive **any** rngpui app via its own
  bundler/launcher (e.g. the agentbus desktop app: `--launch-cmd "node
  native-shell/scripts/open-gpui.mjs <entry>" --cwd ~/agentbus/gui`). Works because
  the shared runtime (`ts/src/runtime.ts`) reads `RNGPUI_CONTROL_FIFO` /
  `RNGPUI_CONTROL_EVENTS` / `RNGPUI_SERVICE_PID_FILE`; agentbus's `open-gpui` forwards
  those env vars.
- `--attach` — capture/describe a running window read-only (skips `agentbus-gpui-user`).

**Selectors:** `#42` (globalId), substring match on testID/identifier/nativeID/label/text/type,
or `200,300` (literal window point).

**How it works:** native `dump::dump_tree` (rust/src/dump.rs) emits authored facts +
post-layout bounds; an on-demand dump is requested over a control fifo
(`Incoming::Dump`); `do *` inject synthetic input (`Incoming::Tap/ScrollAt/TypeText/KeyPress`
→ `inspector::tap_target_at` + `elements::synth_tap`); colors come from the in-service
full-opacity CGWindowList capture (rust/src/capture_png.rs) sampled via
`scripts/pixel.mjs`. **Always offscreen + non-activating** — never bring a window to
front. `close()` kills the spawned `rngpui-service` by pid (orphaned services
otherwise pile up into a focus-stealing window storm).

**Validation:** `node scripts/describe-conformance.mjs` (also `npm run conformance:describe`)
launches `examples/describe-fixture.tsx` and asserts computed bounds + sampled colors
for known boxes. Keep it green.

**Known limitation / next:** one command per invocation (each `--launch` spawns and
then `close()`s a fresh instance), so you can't yet `do tap` then `get describe` the
*effect* in one session. A persistent/sequenced session (`--keep` + attach-by-workdir,
or `do … then get …`) is the top enhancement to match sootsim's drive-then-inspect
loop, and is what makes `do` fully verifiable.
