/**
 * Exercises the WebView messaging layer end-to-end, both directions:
 *   frame → host: page calls window.ReactNativeWebView.postMessage(...) → onMessage
 *   host → frame: ref.injectJavaScript(js) runs JS in the page; ref.postMessage(d)
 *                 delivers a 'message' event the page listens for
 *
 *   RNGPUI_WEBVIEW_DEBUG=1 node scripts/run-hermes-example.mjs examples/webview-messaging.tsx --interactive
 *
 * Watch the log: you should see a full round-trip — onLoad → injectJavaScript runs
 * setTitle() in the page → the page posts back → onMessage logs it.
 */
import { useRef } from "react";
import { AppRegistry, View, Text, WebView, type WebViewHandle } from "../src/index";

const HTML = `<!doctype html><meta charset="utf8">
<body style="margin:0;height:100vh;font-family:-apple-system,system-ui,sans-serif;
  background:linear-gradient(135deg,#0b1020,#1b2550);color:#e7e9ff;
  display:flex;align-items:center;justify-content:center">
  <div style="text-align:center">
    <h1 id="t" style="font-size:34px;margin:0 0 16px">messaging probe</h1>
    <button onclick="window.ReactNativeWebView.postMessage('button-click')"
      style="font-size:16px;padding:10px 18px;border-radius:10px;border:0;cursor:pointer">post to host</button>
  </div>
  <script>
    const t = document.getElementById('t');
    // frame → host: announce we rendered
    window.addEventListener('DOMContentLoaded', () =>
      window.ReactNativeWebView.postMessage('dom-ready len=' + document.body.innerText.length));
    // host → frame: injectJavaScript calls this; we echo back to prove the round-trip
    function setTitle(s) { t.textContent = s; window.ReactNativeWebView.postMessage('title-set: ' + s); }
    // host → frame: ref.postMessage delivers a 'message' event
    window.addEventListener('message', (e) => {
      t.textContent = 'got: ' + e.data;
      window.ReactNativeWebView.postMessage('got-message: ' + e.data);
    });
  </script>
</body>`;

function App() {
  const ref = useRef<WebViewHandle>(null);
  return (
    <View style={{ flex: 1, backgroundColor: "#f5f5f7" }}>
      <View
        style={{
          height: 46,
          backgroundColor: "#fff",
          borderBottomWidth: 1,
          borderColor: "#e2e2e6",
          justifyContent: "center",
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: "700", color: "#111" }}>WebView messaging probe</Text>
      </View>
      <WebView
        ref={ref}
        style={{ flex: 1 }}
        source={{ html: HTML }}
        onLoad={() => {
          console.log("[host] onLoad");
          // host → frame: run JS in the page
          ref.current?.injectJavaScript("setTitle('injected from host \\u2713')");
          // host → frame: deliver a message the page listens for
          setTimeout(() => ref.current?.postMessage("hello from host"), 400);
        }}
        onMessage={(e) => console.log("[host] onMessage:", e.nativeEvent.data)}
      />
    </View>
  );
}

AppRegistry.registerComponent("WebViewMessaging", () => App);
AppRegistry.runApplication("WebViewMessaging");
