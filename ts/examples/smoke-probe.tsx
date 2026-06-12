// Smoke background probe: a full-bleed `backgroundImage: smoke(dense, faded)` panel.
// Validates (1) the runtime-compiled metal shader, (2) wisps actually paint, and
// (3) the self-sustained repaint animates — two captures a second apart must differ
// inside the panel. The bright tint is for pixel assertions; real apps go subtle.
import { render, View } from "../src/index";

function App() {
  return (
    <View style={{ flex: 1, backgroundColor: "#04060a" }}>
      <View
        nativeID="smoke"
        style={{
          flex: 1,
          backgroundImage: "smoke(rgba(120,130,170,0.55), rgba(30,34,52,0.0))",
        }}
      />
    </View>
  );
}

render(<App />, { width: 560, height: 420 });
