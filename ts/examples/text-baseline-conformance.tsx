// Glyph vertical-centering conformance fixture (driven by
// scripts/text-baseline-conformance.mjs). Two identical 200x40 centered boxes —
// plain text and fontWeight text (the StyledText/runs path) — with an explicit
// lineHeight. The script captures the window and asserts both rows' ink centers
// sit within 1px of the box center, matching headless Chrome for the same spec
// (measured 2026-06-09: web 20.25, gpui 20.75). Pins the regression class where
// a stale baseline shim shifted ALL line-height'd text ~2px low while hiding
// inside the pixel-parity AA floor.
import { View, Text } from "react-native";
import { render } from "../src/render";

const BOX = {
    width: 200,
    height: 40,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "#ffffff",
};
const T = { fontSize: 12, lineHeight: 18, color: "#000000" };

function App() {
    return (
        <View style={{ width: 200, height: 80, backgroundColor: "#ffffff" }}>
            <View style={BOX}>
                <Text style={T}>Changes</Text>
            </View>
            <View style={BOX}>
                <Text style={{ ...T, fontWeight: "600" }}>Changes</Text>
            </View>
        </View>
    );
}

render(<App />, { width: 200, height: 80 });
