/**
 * Fixture for persistent `rngpui do` + `get` conformance. A tap changes the
 * rendered color/text; the test reuses the same CLI session and samples pixels.
 */
import { useState } from "react";
import { AppRegistry, Pressable, Text, TextInput, View } from "../src/index";

const OFF = "#d92d20";
const ON = "#12b76a";

function App() {
    const [on, setOn] = useState(false);
    const [draft, setDraft] = useState("");
    return (
        <View style={{ flex: 1, backgroundColor: "#eef2f7" }} testID="drive-root">
            <Pressable
                testID="toggle-button"
                accessibilityLabel="toggle-button"
                onPress={() => setOn((value) => !value)}
                style={{
                    position: "absolute",
                    left: 80,
                    top: 80,
                    width: 240,
                    height: 128,
                    backgroundColor: on ? ON : OFF,
                    alignItems: "center",
                    justifyContent: "center",
                }}
            >
                <Text testID="toggle-label" style={{ color: "#ffffff", fontSize: 22, fontWeight: "700" }}>
                    {on ? "on" : "off"}
                </Text>
            </Pressable>
            <TextInput
                testID="drive-input"
                accessibilityLabel="drive-input"
                value={draft}
                onChangeText={setDraft}
                placeholder="drive input"
                style={{
                    position: "absolute",
                    left: 80,
                    top: 240,
                    width: 260,
                    height: 44,
                    backgroundColor: "#ffffff",
                    borderWidth: 1,
                    borderColor: "#94a3b8",
                    borderRadius: 8,
                    color: "#111827",
                    fontSize: 16,
                    paddingHorizontal: 12,
                }}
            />
        </View>
    );
}

AppRegistry.registerComponent("DriveFixture", () => App);
AppRegistry.runApplication("DriveFixture", { width: 520, height: 360 });
