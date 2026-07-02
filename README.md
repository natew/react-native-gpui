# react-native-gpui

Write React Native components — render them natively with
[GPUI](https://www.gpui.rs/), Zed's GPU-accelerated Rust UI framework. No
browser, no Electron: a real `react-reconciler` drives a GPUI window on Metal,
with a typed component surface mirroring React Native (`View`, `Text`,
`Pressable`, `ScrollView`, `TextInput`, `Svg`, `WebView`, `StyleSheet`).

The package and full documentation live in [`ts/`](ts/README.md). The Rust
renderer service is in [`rust/`](rust/).

```sh
npm install react-native-gpui
```

Currently macOS arm64 only (GPUI/Metal). MIT licensed.
