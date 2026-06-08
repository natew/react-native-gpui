# react-native-gpui

## Build & test

- Typecheck the TypeScript package from `ts/`: `npm run typecheck`.
- Build the shipped package from `ts/`: `npm run build`. This builds the release
  `rngpui-service`, copies it into `ts/native/`, emits declaration files, and
  bundles `dist/index.js`.
- For runtime validation, compile an example to Hermes bytecode and launch the
  single-process host. The app runtime is always `rngpui-service`; Bun is only
  the dev bundler:

```sh
cd ts
bun run scripts/bundle-hermes.mjs examples/kitchen-sink.tsx /tmp/kitchen.js --bytecode
RNGPUI_BUNDLE=/tmp/kitchen.hbc RNGPUI_NO_ACTIVATE=1 ../rust/target/release/rngpui-service
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
app **without screenshots** — modeled on soot's `sootsim` CLI. It uses the
single-process Hermes host only: `--launch` compiles an entry to bytecode, starts
`rngpui-service`, and talks to its native debug socket. Run it from `ts/`:

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

- `--launch <entry.tsx>` — compile the entry to Hermes bytecode, spawn
  `rngpui-service` offscreen + non-activating, and own its debug socket.
- `--bundle <app.hbc>` — spawn `rngpui-service` against an existing Hermes bytecode
  bundle, useful for apps with their own bundler such as agentbus.
- `--keep` — leave the launched service running and print a session directory on stderr.
- `--session <dir>` or `RNGPUI_SESSION=<dir>` — reuse a kept driveable session for
  do-then-get workflows.
- `close --session <dir>` — terminate the owned service and remove its session dir.
- `--attach` — capture/describe a running window read-only (skips `agentbus-gpui-user`).

**Selectors:** `#42` (globalId), substring match on testID/identifier/nativeID/label/text/type,
or `200,300` (literal window point).

**How it works:** native `dump::dump_tree` (rust/src/dump.rs) emits authored facts +
post-layout bounds; an on-demand dump is requested over `RNGPUI_CONTROL_SOCKET`
(`Incoming::DebugDump`); `do *` inject synthetic input
(`Incoming::DebugTap/DebugScrollAt/DebugTypeText/DebugKeyPress` →
`inspector::tap_target_at` + `elements::synth_tap`); colors come from the in-service
full-opacity CGWindowList capture (rust/src/capture_png.rs) sampled via
`scripts/pixel.mjs`. **Always offscreen + non-activating** — never bring a window to
front. Owned sessions write `RNGPUI_SERVICE_PID_FILE`; `close()` kills exactly that
pid and removes the session dir.

**Validation:** `node scripts/describe-conformance.mjs` (also `npm run conformance:describe`)
launches `examples/describe-fixture.tsx` and asserts computed bounds + sampled colors
for known boxes. `node scripts/drive-conformance.mjs` (also `npm run conformance:drive`)
keeps one session alive, taps a stateful fixture, re-describes it through `--session`,
and asserts the sampled color changed. Keep both green.
