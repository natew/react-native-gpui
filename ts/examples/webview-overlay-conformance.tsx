import { render, Text, View, WebView } from "../src/index";

const HTML = `<!doctype html><meta charset="utf8">
<body style="margin:0;min-height:760px;background:#00f6ff;color:#06252b;font-family:-apple-system,system-ui,sans-serif">
  <div style="height:150px;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800">
    webview underlay
  </div>
  <div style="height:520px;display:flex;align-items:center;justify-content:center;background:#2ef27d;font-size:24px;font-weight:800">
    scrolled content
  </div>
  <div style="height:90px;background:#1f2937;color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800">
    end
  </div>
  <script>
    function scroller() { return document.scrollingElement || document.documentElement || document.body; }
    function post(kind) {
      var s = scroller();
      window.ReactNativeWebView.postMessage(kind + ':' + Math.round(s ? s.scrollTop : -1));
    }
    window.addEventListener('scroll', function() { post('scroll'); });
    window.addEventListener('load', function() { setTimeout(function() { post('ready'); }, 0); });
    setTimeout(function() { post('ready'); }, 50);
  </script>
</body>`;

function App() {
  return (
    <View
      style={{
        width: 720,
        height: 520,
        position: "relative",
        backgroundColor: "transparent",
      }}
    >
      <WebView
        accessibilityLabel="overlay conformance webview"
        source={{ html: HTML }}
        onLoad={() => console.log("WEBVIEW_OVERLAY_PAGE_LOAD")}
        onMessage={(event) => console.log("WEBVIEW_OVERLAY_MESSAGE", event.nativeEvent.data)}
        style={{
          position: "absolute",
          left: 40,
          top: 40,
          width: 640,
          height: 420,
          backgroundColor: "#00f6ff",
          borderBottomLeftRadius: 34,
          borderBottomRightRadius: 34,
          overflow: "hidden",
        }}
      />
      <View
        accessibilityLabel="overlay conformance chip"
        style={{
          position: "absolute",
          left: 160,
          top: 300,
          width: 400,
          height: 96,
          zIndex: 10,
          borderRadius: 12,
          backgroundColor: "#ff007a",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "800" }}>
          gpui overlay
        </Text>
      </View>
    </View>
  );
}

render(<App />, { width: 720, height: 520 });
