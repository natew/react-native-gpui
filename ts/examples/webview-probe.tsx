/**
 * Minimal light webview probe: a native gpui shell (header bar) + one WebView
 * filling the rest. The page renders a CSS gradient + live clock — a gradient is
 * something gpui itself can't draw, so if you SEE it, it's genuinely the WKWebView
 * compositing inside the gpui window (not blank, not a gpui fallback).
 *
 *   RNGPUI_WEBVIEW_DEBUG=1 node scripts/run-hermes-example.mjs examples/webview-probe.tsx --interactive
 */
import { AppRegistry, View, Text, WebView } from "../src/index";

const HTML = `<!doctype html><meta charset="utf8">
<body style="margin:0;height:100vh;font-family:-apple-system,system-ui,sans-serif;
  background:linear-gradient(135deg,#6a5cf6 0%,#06b6d4 100%);color:#fff;
  display:flex;align-items:center;justify-content:center">
  <div style="text-align:center">
    <h1 style="margin:0;font-size:44px;letter-spacing:-1px">WebView ✅ not blank</h1>
    <p style="opacity:.9;font-size:16px">WKWebView composited in the gpui window — the gradient proves CSS rendering.</p>
    <p id="t" style="font-variant-numeric:tabular-nums;font-size:22px;opacity:.95"></p>
  </div>
  <script>
    const t = document.getElementById('t');
    const tick = () => { t.textContent = new Date().toLocaleTimeString() + ' · ' + String(Date.now() % 100000); };
    tick();
    setInterval(tick, 100);
  </script>
</body>`;

function App() {
  return (
    <View style={{ flex: 1, backgroundColor: "#f5f5f7" }}>
      <View
        style={{
          height: 46,
          backgroundColor: "#ffffff",
          borderBottomWidth: 1,
          borderColor: "#e2e2e6",
          justifyContent: "center",
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: "700", color: "#111" }}>
          gpui shell · wry content
        </Text>
      </View>
      <WebView style={{ flex: 1 }} source={{ html: HTML }} />
    </View>
  );
}

AppRegistry.registerComponent("WebViewProbe", () => App);
AppRegistry.runApplication("WebViewProbe");
