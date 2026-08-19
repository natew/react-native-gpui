// Inline-run styling conformance fixture (driven by
// scripts/inline-run-style-conformance.mjs). A nested <Text> inside a <Text> is
// flattened into a shaped text RUN, so every style it carries has to survive that
// flattening. Three things regressed markdown rendering in Team Machine and are
// pinned here:
//
//   row A  an inline code span must paint its backgroundColor plate behind the
//          glyphs, in its own font family (mono), not just recolor the text.
//   row B  fontStyle italic on a NESTED <Text> must actually slant. Geist ships
//          no italic face, so this only holds if the renderer synthesizes oblique
//          the way a browser does for a family with no italic.
//   row D  fontStyle italic on a PLAIN <Text> (no nesting) must slant too — that
//          path never went through the run pipeline at all.
//
// Row C is the upright control every italic row is compared against: if a slant
// is not applied the row is pixel-identical to it.
//
// The fixture needs Geist registered (RNGPUI_FONT_DIR), because the macOS system
// UI font DOES have a real italic face and would hide the synthesis question.
import { View, Text } from "react-native";
import { render } from "../src/render";

const W = 460;
const ROW = 40;

const BASE = { fontSize: 15, lineHeight: 20, color: "#111111", fontFamily: "Geist" };
const ROW_BOX = {
    width: W,
    height: ROW,
    justifyContent: "center" as const,
    paddingLeft: 12,
    backgroundColor: "#ffffff",
};

// the inline-code shape MarkdownBody.tsx actually emits for `code`
const CODE = {
    backgroundColor: "#e6e0ff",
    color: "#5b3fd9",
    borderRadius: 5,
    paddingTop: 1.5,
    paddingBottom: 1.5,
    paddingLeft: 5,
    paddingRight: 5,
    fontFamily: "Geist Mono",
};

function App() {
    return (
        <View style={{ width: W, height: ROW * 4, backgroundColor: "#ffffff" }}>
            <View style={ROW_BOX}>
                <Text style={BASE}>
                    run <Text style={CODE}>tm share</Text> now
                </Text>
            </View>
            <View style={ROW_BOX}>
                <Text style={BASE}>
                    <Text style={{ fontStyle: "italic" }}>Emphasis</Text>
                </Text>
            </View>
            <View style={ROW_BOX}>
                <Text style={BASE}>
                    <Text>Emphasis</Text>
                </Text>
            </View>
            <View style={ROW_BOX}>
                <Text style={{ ...BASE, fontStyle: "italic" }}>Emphasis</Text>
            </View>
        </View>
    );
}

render(<App />, { width: W, height: ROW * 4 });
