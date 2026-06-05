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
bun run app.tsx     # or: node --loader tsx app.tsx
```

## How it works

```
React tree ──► react-reconciler ──► serialized node tree ──► (stdin, JSON lines)
                                                                    │
                                                              rngpui-service  (Rust + GPUI)
                                                                    │
   onPress / onChangeText / onLayout / resize  ◄──── events (stdout, JSON lines)
```

The TypeScript side reconciles your components into a flat node tree and streams it to a small native binary (`rngpui-service`) which renders it with GPUI and streams UI events back. Stable element ids keep native state (text-input contents, scroll offsets, web views) alive across re-renders.

## Components

| Layout / display | Input / touch | Lists | Native content |
| --- | --- | --- | --- |
| `View` `Text` `ScrollView` `SafeAreaView` `KeyboardAvoidingView` | `TextInput` `Pressable` `TouchableOpacity` `TouchableHighlight` `TouchableWithoutFeedback` `Button` `Switch` | `FlatList` `SectionList` | `Image` `Svg` `WebView` |

APIs: `StyleSheet`, `Dimensions`, `useWindowDimensions`, `Platform`, `PixelRatio`, `useColorScheme`, `AppRegistry`, `createRoot` / `render`.

- **Real text input** (`TextInput`) is backed by [gpui-component](https://github.com/longbridge/gpui-component)'s editor: selection, IME, copy/paste, word motion, multiline.
- **Text truncation** follows React Native's `numberOfLines`: one-line labels truncate with ellipsis, and multi-line labels are line-clamped.
- **Native portals** (`PortalProvider`, `Portal`, `PortalHost`) render overlay content at the matching host during GPUI serialization, so Tamagui Dialog/Popover/Sheet can avoid legacy state-driven portal fallbacks.
- **RN-style measurement** (`measure`, `measureInWindow`, `measureLayout`) is exposed on host refs. Floating overlay libraries such as Tamagui's Popover/Select can measure trigger and content nodes without app-specific adapters.
- **RN Animated** runs JS-frame animations through React commits; animated styles resolve to plain GPUI styles each frame.
- **Native layout overrides** (`nativeLayoutKey`, `nativeResize`, `NativeLayout`) let narrow chrome interactions such as pane resizing mutate GPUI layout in the native service without a React commit per pointer frame.
- **Styling** matches RN: flexbox (Yoga semantics — `flex:1`, `%`, `auto`), `backgroundColor`, gradients via `backgroundImage`, `boxShadow` / iOS `shadow*` / `elevation`, `borderRadius`, `overflow: scroll`, `opacity`.
- **`Svg`** renders a monochrome icon tinted by `style.color`.

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

This package ships a prebuilt `rngpui-service` binary in `native/`. To build it yourself you need a Rust toolchain:

```sh
npm run build        # builds the Rust service, copies it into native/, then tsc → dist/
npm run build:rust   # just the native binary
npm run typecheck
```

Point the runtime at a specific binary with `RNGPUI_SERVICE=/path/to/rngpui-service`.
Set `RNGPUI_DUMP_TREE=/tmp/tree.json` to write the latest serialized native tree
for conformance debugging.

## Examples

```sh
bun run examples/kitchen-sink.tsx     # the full component surface + self-validating layout
bun run conformance:animation        # Animated frame progression fixture
bun run conformance:animation:diff   # deterministic Animated PNG frame diff
bun run conformance:input            # TextInput typing, Return submit, Shift+Return newline
bun run conformance:portal           # Portal overlay and TextInput-in-portal behavior
bun run conformance:native-layout    # native layout override without React width state
bun run conformance:text-lines        # visual fixture for Text numberOfLines
bun run examples/superconductor.tsx   # native shell + WebView content hybrid
```

Visual regressions can use the built-in PNG comparator:

```sh
bun run pixel-diff before.png after.png --crop 0,0,540,300 --diff-out /tmp/rngpui-diff.png
```

## Status & platform

macOS (Metal) is the validated target. GPUI builds here with the `runtime_shaders` feature. The architecture (TS reconciler ↔ native service) is portable to GPUI's other backends.

## License

MIT
