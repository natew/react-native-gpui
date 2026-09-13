# react-native-gpui

Write **React Native** components — render them **natively** with [GPUI](https://www.gpui.rs/) (Zed's GPU-accelerated Rust UI framework). No browser, no Electron, no mobile host. Your React tree is reconciled into a GPUI window on Metal, with a real `react-reconciler` (so hooks, state, and effects all work) and a typed component surface that mirrors React Native.

It also supports the **"native shell, web content"** hybrid: embed a native `WebView` (WKWebView via `wry`) anywhere in the tree for web-grade content with native scroll + selection, while the rest of the UI stays native GPUI.

```tsx
import { AppRegistry, View, Text, Pressable, StyleSheet } from "react-native-gpui";
import { useState } from "react";

function App() {
  const [n, setN] = useState(0);
  return (
    <View style={s.root}>
      <Text style={s.h1}>Hello from GPUI 👋</Text>
      <Pressable style={s.btn} onPress={() => setN((c) => c + 1)}>
        <Text style={s.btnText}>tapped {n}×</Text>
      </Pressable>
    </View>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#1e1e2e", gap: 16 },
  h1: { color: "#e6e6ef", fontSize: 24, fontWeight: "700" },
  btn: { backgroundColor: "#8a5cf6", paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10 },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});

AppRegistry.registerComponent("App", () => App);
AppRegistry.runApplication("App");
```

```sh
bun run scripts/bundle-app.mjs app.tsx /tmp/app.js
RNGPUI_BUNDLE=/tmp/app.js native/rngpui-service
```

## How it works

```
React tree ──► react-reconciler ──► serialized node tree ──► __rngpui_applyTree()
                                                                    │
                                                              rngpui-service
                                                     Rust + GPUI + JavaScriptCore
                                                                    │
   onPress / onChangeText / onLayout / resize  ◄──── __rngpui_onHostEvent()
```

The TypeScript side is bundled to a self-contained JS file and evaluated inside the native
service via system JavaScriptCore. React reconciles your components into a flat node tree; host globals pass
commits and UI events in memory between JavaScriptCore and GPUI. Stable element ids keep
native state (text-input contents, scroll offsets, web views) alive across
re-renders.

## Components

| Layout / display | Input / touch | Lists | Native content |
| --- | --- | --- | --- |
| `View` `Text` `ScrollView` `SafeAreaView` `KeyboardAvoidingView` | `TextInput` `Pressable` `TouchableOpacity` `TouchableHighlight` `TouchableWithoutFeedback` `Button` `Switch` | `FlatList` `SectionList` | `Image` `Svg` `WebView` |

APIs: `StyleSheet`, `Dimensions`, `useWindowDimensions`, `Platform`, `PixelRatio`, `useColorScheme`, `AppRegistry`, `createRoot` / `render`.

- **Real text input** (`TextInput`) is backed by [gpui-component](https://github.com/longbridge/gpui-component)'s editor: selection, IME, copy/paste, word motion, multiline. Resolved `style.color` and `placeholderTextColor` paint through the native editor. `onChange.nativeEvent` includes `isComposing` and `eventCount`, so controlled inputs can preserve native marked text while React commits catch up.
- **Text truncation** follows React Native's `numberOfLines`: one-line labels truncate with ellipsis, and multi-line labels are line-clamped.
- **Native portals** (`PortalProvider`, `Portal`, `PortalHost`) render overlay content at the matching host during GPUI serialization, so Tamagui Dialog/Popover/Sheet can avoid extra state-driven portal fallbacks.
- **RN-style measurement** (`measure`, `measureInWindow`, `measureLayout`) is exposed on host refs. Floating overlay libraries such as Tamagui's Popover/Select can measure trigger and content nodes without app-specific adapters.
- **RN Animated** runs JS-frame animations through React commits; animated styles resolve to plain GPUI styles each frame.
- **Native layout overrides** (`nativeLayoutKey`, `nativeResize`, `NativeLayout`) let narrow chrome interactions such as pane resizing mutate GPUI layout in the native service without a React commit per pointer frame.
- **Styling** matches RN: flexbox (Yoga semantics — `flex:1`, `%`, `auto`), `backgroundColor`, gradients via `backgroundImage`, `boxShadow` / iOS `shadow*` / `elevation`, `borderRadius`, `overflow: scroll`, `opacity`.
- **`Svg`** renders a monochrome icon tinted by `style.color`.

## Native surfaces

For app chrome that needs native glass or GPUI shader-backed effects, use the
surface components instead of baking app-specific behavior into the renderer:

```tsx
import {
  LiquidGlassBackground,
  SmokeEffectSurface,
  View,
} from "react-native-gpui";

export function Shell({ children }) {
  return (
    <View style={{ flex: 1, borderRadius: 32, overflow: "hidden" }}>
      <LiquidGlassBackground
        radius={32}
        material="underWindowBackground"
        glassVariant="controlCenter"
      />
      <SmokeEffectSurface
        pointerEvents="none"
        radius={32}
        alpha={0.9}
        reach={0.28}
        topClear={0.06}
      />
      {children}
    </View>
  );
}
```

`LiquidGlassBackground` / `LiquidGlassView` wrap native `SystemView` glass.
`EffectSurface` / `SmokeEffectSurface` are ordinary React components that set
`backgroundImage` to renderer effects such as `smoke(...)`. Apps can tune these
from React props while the renderer owns only the generic native primitive.

## Dev loop

`rngpui dev --launch` launches one development renderer, watches every local
module in its dependency graph, and applies edits through React Fast Refresh.
Compatible component state, the native window, focus, scroll position, and
renderer-owned state stay in place. A transform or evaluation error is printed
without killing the running app, so the next valid edit can recover it.

```sh
rngpui dev --launch app/index.tsx --root app --root packages/ui
```

An owned external instance can use the same Fast Refresh path by providing its
control socket, build command, output bundle, and watched roots:

```sh
rngpui dev \
  --socket /tmp/my-app.control.sock \
  --bundle native-shell/.gpui/hot-update.js \
  --build "NODE_ENV=development bun native-shell/scripts/bundle-app-gpui.mjs native-shell/app.tsx native-shell/.gpui/hot-update.js" \
  --root app --root interface --root native-shell
```

There is one development reload contract. RNGPUI does not fall back to process
signals or remount the application when a Fast Refresh update fails.

## Native diff

`Diff` parses and virtualizes a unified patch in the renderer. Large patches do
not create one React node per line.

```tsx
<Diff
  patch={unifiedPatch}
  wordDiff
  scroll
  maxLines={20_000}
  collapsedPaths={["generated/output.ts"]}
  onToggleFile={({ nativeEvent }) => toggle(nativeEvent.value)}
  onShowMore={() => setExpanded(true)}
  onLineClick={({ nativeEvent }) => {
    openLine(nativeEvent.value, nativeEvent.oldLine, nativeEvent.newLine)
  }}
  style={{ height: 520, fontFamily: "Menlo", fontSize: 12 }}
/>
```

Use `PerformanceHUD.setEnabled(true)` or `rngpui do hud on` for the native
frame/layout/paint overlay. `Renderer.getProvenance()` and
`rngpui get provenance` report the exact renderer, service, GPUI, JavaScriptCore, and
bundle identity.

## Native inspector

Enable the GPUI node inspector for any root:

```tsx
render(<App />, { devtools: { inspector: true } })
```

or set `RNGPUI_INSPECTOR=1` before launching. Hold Option while the window is
focused to highlight the native node under the pointer. Option-click copies a
compact snapshot with node id/type, bounds, event names, accessibility metadata,
text/value snippets, style facts, and the ancestor chain.

## The WebView hybrid

```tsx
<View style={{ flex: 1 }}>
  {/* native shell: sidebar, header, composer … */}
  <WebView style={{ flex: 1 }} source={{ html: myMarkdownHtml }} />
  {/* …or source={{ uri: "https://…" }} */}
</View>
```

The `WebView` is a real native web view composited inside the GPUI window — you get web-grade rendering and **native scroll momentum + selection** for the content area while the shell stays native. Re-render it from React state like any other component.

### Messaging (two-way)

`source` re-renders the whole document, so for live content drive it with messages instead:

```tsx
const ref = useRef<WebViewHandle>(null)

<WebView
  ref={ref}
  source={{ html }}
  onLoad={() => ref.current?.injectJavaScript("startStreaming()")}
  onMessage={(e) => handle(e.nativeEvent.data)}  // page → host
/>

// host → frame:
ref.current?.injectJavaScript("appendToken('…')")  // run JS in the page (no reload)
ref.current?.postMessage("payload")                // → a 'message' event in the page
ref.current?.reload()
```

Inside the page, talk back to the host with the React-Native bridge global (injected automatically):

```js
window.ReactNativeWebView.postMessage("hello from the page")   // → onMessage
window.addEventListener("message", (e) => { /* host postMessage */ })
```

## Building from source

This package ships a prebuilt `rngpui-service` binary in `native/`. To build it
yourself you need a Rust toolchain; macOS supplies the JavaScriptCore framework:

```sh
npm run build        # builds the Rust service, copies it into native/, then tsc → dist/
npm run build:rust   # just the native binary
npm run typecheck
```

Point the runtime at a specific binary with `RNGPUI_SERVICE=/path/to/rngpui-service`.
Set `RNGPUI_INSPECTOR=1` to force-enable the native inspector for any app.

## Examples

```sh
bun run kitchen                      # the full component surface + self-validating layout
bun run conformance:animation        # Animated frame progression fixture
bun run conformance:animation:diff   # deterministic Animated PNG frame diff
bun run conformance:input            # TextInput typing, Return submit, Shift+Return newline
bun run conformance:input-runtime    # nonactivating focus, tab, IME, controlled state, latency
bun run conformance:portal           # Portal overlay and TextInput-in-portal behavior
bun run conformance:native-layout    # native layout override without React width state
bun run conformance:text-lines       # visual fixture for Text numberOfLines
bun run superconductor               # native shell + WebView content hybrid
```

Visual regressions can use the built-in PNG comparator:

```sh
bun run pixel-diff before.png after.png --crop 0,0,540,300 --diff-out /tmp/rngpui-diff.png
```

## Status & platform

macOS (Metal) is the validated target. GPUI builds here with the `runtime_shaders` feature. The architecture (TS reconciler ↔ native service) is portable to GPUI's other backends.

## License

MIT
