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

**The fast loop — `shot` / `dev` / `reshot` / `diff`:**

`shot` is the one-command iteration primitive: launch a bundle/entry offscreen, wait
for a stable frame, write a PNG + tree dump, and print the PNG path plus the bounds +
sampled color of every `--select`'d node — no second command, no flag archaeology.

```sh
# one shot: realistic size, forced theme, measured nodes (cold ≈ 2s on the agentbus app)
rngpui shot --bundle native-shell/.gpui-hermes/app.hbc --size 1360x880 --fixture \
  --appearance dark --select stage --select trees-pane
#   png: /tmp/rngpui-shot.png (2720x1760) appearance=dark
#   measurements:
#     "stage" → div stage-mode-bar #454 [259,43 792x34]  dominant=#282828 (48%) avg=#1b1b21

# persistent instance: keep one alive, re-capture in ~1s after a state/data change
rngpui dev --bundle native-shell/.gpui-hermes/app.hbc --fixture     # → prints the session dir
rngpui reshot --session <dir> --select composer                     # sub-second, no relaunch
rngpui close --session <dir>

# pixel diff two captures: changed ratio + changed-region bounding box (+ highlight png)
rngpui diff /tmp/before.png /tmp/rngpui-shot.png --out /tmp/diff.png
```

- `--appearance light|dark` forces the app theme via `RNGPUI_FORCE_APPEARANCE` (flows
  through the native bridge so tamagui re-themes; no system toggle, no system mutation).
- `--size WxH` is honored end-to-end — the capture PNG comes back at that logical size ×
  the backing scale (1360x880 → 2720x1760). (The old LaunchServices `.app` capture path
  produced a wrongly-clamped ~784x507; the CLI direct-spawn path used by `shot` is correct.)
- `--fixture` loads deterministic demo data (`AGENTBUS_FIXTURE_ONLY=1`); without it the
  agentbus app paints an empty "connecting…" shell when no daemon is reachable.
- `--select <selector>` is repeatable; `--json` for machine output; `--out` to place the PNG.
- `reshot` only re-reads the **current** frame of a kept session — it does not re-bundle
  or change the theme. After editing JS, re-`shot` (re-launches against the rebuilt `.hbc`).

**`get` (read-only introspection):**

- `get tree` — full annotated node tree (type, ids, computed bounds).
- `get stats [selector]` — aggregate node counts, visible/hidden counts,
  interactive count, max depth, duplicate `globalId`s, type counts, native list
  group counts, and WebView totals. Use this first when checking leaks or drift:
  repeated interactions should not make `nodes` or duplicate IDs climb.
- `get webviews` — WebView inventory with inline/html source size, bounds,
  `visible`, and `display`; use this to verify hidden kept-mounted WebViews are
  retained but not painted.
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
- `--attach` — target a running rngpui window (the largest, driveable-first). This
  **includes** the user's `agentbus-gpui-user` window — it is not skipped. `get *`
  is read-only and safe against it (CGWindowList capture + a read-only tree dump, no
  focus theft, no input). **Never** run `do`/`flow` with `--attach`: those inject
  synthetic taps/keys and would drive the user's window. To drive, `--launch`/`--bundle`
  your own offscreen instance.

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

## Animation forensics: `rngpui trace` + `get frames` (2026-06-11)

`rngpui trace <selector ...|--all> [--keys k,k] [--ms n] [--action "tap <sel>"]` records
every off-thread reanimated style write (`anim_overlay::apply_ops`) and NativeLayout
tween tick under the matched subtrees, with timestamps + the painted-frame counter, then
reports per-key curves: sparkline, endpoints, min/max, sample cadence, dropped-frame
gaps, and spring-overshoot count — values-level animation proof with NO screenshots.
`rngpui get frames` returns the always-on painted-frame counter + fps + frame-gap stats
(`{"$cmd":"frameStats"}`). Rust side: `rust/src/anim_trace.rs`; the three commands are
answered inline in `debug_control.rs` (no main-loop round-trip). `examples/trace-fixture.tsx`
is the interactive fixture (tap `go-button` → reanimated card spring + NativeLayout pane
tween at once).

Landed alongside (see plans/production-ready.md P0.1): the element-transform stack in
the vendored gpui — `transform` now actually paints (translate/scale/rotate about the
element center; quads, shadows, glyphs, images, svg) with fragment SDF/gradient math
inverse-mapped into local space; and CSS-correct shadow occlusion (outer box-shadows cut
the casting element's own rect out, so opacity fades never reveal a "shadow underneath").
Pixel gates: `conformance:transform`, the shadow-under guard inside `conformance:opacity`.
`rngpui do key enter` now emits gpui-component's `PressEnter` so `onSubmitEditing` fires
like a real keystroke.

## Native AppKit controls: `<NativeButton>` / `<NativeTextInput>` (2026-06-13, spike)

Real `NSButton` / `NSTextField` (`NSSecureTextField` when `secureTextEntry`) hole-punched
through the gpui Metal layer — the macOS-native counterpart to the gpui-drawn `<Button>` /
`<TextInput>`. `rust/src/elements/native_control.rs` is the whole implementation; TS surface
is `NativeButton` / `NativeTextInput` in `ts/src/components.tsx` → host types
`nativebutton` / `nativeinput` (reconciler switch) → `create_element` in `elements/mod.rs`.
Props reuse existing wire fields: button title rides `text`; input uses
`value`/`placeholder`/`editable`/`secureTextEntry`. Events come back through the normal
bridge (`event(id,"press")`, `change_text`/`change`, `submit`, `focus`/`blur`) via a single
shared target/delegate object that routes by the control's `tag` (= node id).

Non-obvious facts (these cost real debugging — don't relearn them):

- **Native controls sit ABOVE the Metal layer** (`positioned: NSWindowAbove relativeTo:
  gpui_view`), unlike `<WebView>`/`<SystemView>` which sit BELOW it. Interactive chrome must
  paint over app content (so its bezel/field isn't occluded by an opaque app background) and
  takes the real click/keystroke directly — no `hit_passthrough` needed for routing (the
  control is topmost). The tradeoff: gpui overlays can't paint over a native control, and
  there's no gpui clip/transform/animation on it (same as WebView). Use for chrome/forms,
  not dense scroll lists.
- **The offscreen `rngpui shot` capture does NOT composite native AppKit controls** — their
  region comes back fully transparent (CGWindowList in-service capture only sees gpui's Metal
  output + WKWebView, not sibling NSViews). Visual validation MUST be an on-screen
  `screencapture` of a real launched window. Don't be fooled: the stale packaged
  `ts/native/rngpui-service` renders an unknown `nativebutton` type as an empty div, so a
  shot can look like a positioned box with the page-bg color — that's NOT the native control.
  Force the fresh binary with `RNGPUI_SERVICE=…/target/release/rngpui-service`.
- **Validate the event round trip with `do tap <native-selector>`**: the `DebugTap` handler
  routes a tapped native control to `native_control::perform_native_click` (real
  `performClick:` → target/action → bridge → JS) instead of a gpui synth-tap. Proven via
  `examples/native-controls.tsx`: each tap bumps a gpui `presses:` counter (which DOES
  capture), so `do tap native-btn` then `get tree` shows the count climb.

Known gaps (spike follow-ups): appearance is hardcoded Aqua (`set_aqua_appearance`) instead
of following the app theme; native controls aren't in the AX tree because gpui's
`RNGPUIAccessibilityView.accessibilityChildren` returns only synthetic children (so VoiceOver
/ cua-driver can't see them); no gpui-layout measurement of the AppKit intrinsic size, so
native controls need explicit `style` sizing; Windows/Linux backends are unimplemented (the
TS API is platform-agnostic; only the per-OS Rust element backend differs).
