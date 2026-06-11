// Static opacity pixel probe. Three red boxes on white, varying ONLY opacity (no
// transform, no movement) so a pixel sample isolates whether div `opacity` paints.
//   op-full   opacity 1.0  → pure red rgb(255,0,0)
//   op-half   opacity 0.3  → red over white at 0.3 ≈ rgb(255,179,179)
//   op-shadow opacity 0.3 + a hard black shadow → the shadow must fade too.
import { render, View } from "../src/index";

function App() {
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff", flexDirection: "row", alignItems: "center", justifyContent: "space-around", padding: 60 }}>
      <View nativeID="op-full" style={{ width: 180, height: 180, backgroundColor: "#ff0000", opacity: 1 }} />
      <View nativeID="op-half" style={{ width: 180, height: 180, backgroundColor: "#ff0000", opacity: 0.3 }} />
      <View nativeID="op-shadow" style={{ width: 180, height: 180, backgroundColor: "#ff0000", opacity: 0.3, boxShadow: "0px 0px 30px 8px rgba(0,0,0,1)" }} />
    </View>
  );
}

render(<App />, { width: 900, height: 360 });
