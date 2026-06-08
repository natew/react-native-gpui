/**
 * Load an arbitrary HTML file in a native WebView. Useful for isolating page
 * payload issues from app layout issues:
 *
 *   RNGPUI_HTML_FILE=/tmp/page.html RNGPUI_WEBVIEW_DEBUG=1 node scripts/run-hermes-example.mjs examples/webview-file-probe.tsx --interactive
 */
import { readFileSync } from "node:fs";
import { AppRegistry, Text, View, WebView } from "../src/index";

const file = process.env.RNGPUI_HTML_FILE;
if (!file) throw new Error("RNGPUI_HTML_FILE is required");

const HTML = readFileSync(file, "utf8");

function App() {
  return (
    <View style={{ flex: 1, backgroundColor: "#f5f5f7" }}>
      <View
        style={{
          height: 42,
          backgroundColor: "#ffffff",
          borderBottomWidth: 1,
          borderColor: "#e2e2e6",
          justifyContent: "center",
          paddingHorizontal: 14,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "700", color: "#111827" }}>
          webview file probe · {file}
        </Text>
      </View>
      <WebView style={{ flex: 1, backgroundColor: "#ffffff" }} source={{ html: HTML }} />
    </View>
  );
}

AppRegistry.registerComponent("WebViewFileProbe", () => App);
AppRegistry.runApplication("WebViewFileProbe");
