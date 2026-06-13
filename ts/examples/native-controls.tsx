/**
 * Spike fixture for the native AppKit controls (<NativeButton> / <NativeTextInput>).
 *
 * Real NSButton + NSTextField are hole-punched through the gpui Metal layer. This fixture
 * proves the full round trip: a press fires onPress (→ counter), an edit fires onChangeText
 * (→ echo). The state Texts are gpui-drawn, so a screenshot taken after a real interaction
 * shows the native event reached React and re-rendered the gpui tree.
 *
 *   # render proof (native controls visible):
 *   bun run cli/bin.ts shot --launch examples/native-controls.tsx --size 560x420 \
 *     --select native-btn --select native-input
 *
 *   # round-trip proof (drive a REAL AppKit click/type, then reshot the gpui state):
 *   see scripts/native-controls-conformance.mjs
 */
import { useState } from "react";
import { AppRegistry, NativeButton, NativeTextInput, Text, View } from "../src/index";

const PAGE_BG = "#cdd5e0";

function App() {
    const [count, setCount] = useState(0);
    const [draft, setDraft] = useState("");

    return (
        <View style={{ flex: 1, backgroundColor: PAGE_BG, padding: 24 }} accessibilityLabel="page-root">
            <Text style={{ fontSize: 18, fontWeight: "700", color: "#101828", marginBottom: 16 }}>
                Native AppKit controls
            </Text>

            <NativeButton
                testID="native-btn"
                title="Click me"
                style={{ position: "absolute", left: 24, top: 64, width: 120, height: 28 }}
                onPress={() => {
                    setCount((c) => c + 1);
                    console.log("[native-controls] NSButton press");
                }}
            />
            <Text testID="press-count" style={{ position: "absolute", left: 160, top: 68, color: "#101828" }}>
                {`presses: ${count}`}
            </Text>

            <NativeTextInput
                testID="native-input"
                placeholder="Type here…"
                value={draft}
                style={{ position: "absolute", left: 24, top: 112, width: 280, height: 24 }}
                onChangeText={(text) => {
                    setDraft(text);
                    console.log(`[native-controls] NSTextField change: ${text}`);
                }}
            />
            <Text testID="input-echo" style={{ position: "absolute", left: 24, top: 152, color: "#475467" }}>
                {`echo: ${draft}`}
            </Text>
        </View>
    );
}

AppRegistry.registerComponent("NativeControls", () => App);
AppRegistry.runApplication("NativeControls", { width: 560, height: 420 });
