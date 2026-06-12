// Static transform pixel probe. Boxes on white whose painted position/size must move
// when `transform` actually applies at paint (the P0.1 regression: parsed, never
// painted). Layout boxes stay put — only the GPU transform moves pixels.
//
//   tx-translate  translateY(60): red paints 60px below its layout slot
//   tx-scale      scale(0.5): blue shrinks to half around its center
//   tx-marker     untransformed green control
import { render, View } from "../src/index";

function App() {
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff", flexDirection: "row", padding: 60, gap: 80 }}>
      <View
        nativeID="tx-translate"
        style={{ width: 120, height: 120, backgroundColor: "#e00000", transform: [{ translateY: 60 }] }}
      />
      <View
        nativeID="tx-scale"
        style={{ width: 120, height: 120, backgroundColor: "#0040e0", transform: [{ scale: 0.5 }] }}
      />
      <View nativeID="tx-marker" style={{ width: 120, height: 120, backgroundColor: "#00a040" }} />
    </View>
  );
}

render(<App />, { width: 700, height: 360 });
