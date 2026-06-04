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
