// Native <Text selectable> drag-selection fixture (driven by
// scripts/text-selection-conformance.mjs).
//
// Three text sites, one per case the app actually writes:
//   sel-plain   a selectable Text, the simple case
//   sel-nested  a selectable Text whose text lives in a NESTED Text — the pattern Team
//               Machine uses at ~36 desktop sites (an outer selectable SizableText
//               wrapping an inner styled run). The engine flattens nested runs into the
//               parent's own string and layout (ts/src/reconciler.ts gatherRuns), so the
//               outer's hitbox and per-character test must cover the inner run's glyphs.
//   sel-none    a plain Text, NOT selectable — the negative control. A drag across it
//               must select nothing, or the assertion above proves nothing.
//
// Every word is unique so the selection readout names which site answered.
import { View, Text } from "react-native";
import { render } from "../src/render";

const T = { fontSize: 14, lineHeight: 22, color: "#101010" };

function App() {
    return (
        <View style={{ width: 640, height: 320, backgroundColor: "#ffffff", padding: 24, gap: 18 }}>
            <Text testID="sel-plain" selectable style={T}>
                alphaplain one two three
            </Text>
            <Text testID="sel-nested" selectable style={T}>
                betalead: <Text style={{ ...T, fontWeight: "700" }}>betanestedfourfive six</Text>
            </Text>
            <Text testID="sel-none" style={T}>
                gammanone seven eight nine
            </Text>
        </View>
    );
}

render(<App />, { width: 640, height: 320 });
