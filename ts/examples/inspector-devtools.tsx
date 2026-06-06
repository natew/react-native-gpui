/**
 * native inspector fixture.
 *
 *   bun run examples/inspector-devtools.tsx
 *
 * hold Option over the window to highlight nodes. Option-click copies a snapshot.
 */
import { AppRegistry, View, Text, Pressable, TextInput, WebView, StyleSheet } from "../src/index";
import { useState } from "react";

function App() {
    const [count, setCount] = useState(0);
    const [text, setText] = useState("");
    const skipWebView = process.env.RNGPUI_INSPECTOR_NO_WEBVIEW === "1";

    return (
        <View style={s.root}>
            <View style={s.sidebar} accessibilityLabel="Inspector sidebar">
                <Text testID="inspector-title" style={s.title}>
                    Inspector
                </Text>
                <Pressable style={s.button} onPress={() => setCount((value) => value + 1)}>
                    <Text style={s.buttonText}>Increment {count}</Text>
                </Pressable>
                <TextInput
                    accessibilityLabel="Inspector note input"
                    style={s.input}
                    value={text}
                    onChangeText={setText}
                    placeholder="type here"
                />
            </View>
            <View style={s.main}>
                <Text style={s.heading}>Native GPUI tree</Text>
                <Text style={s.body}>
                    Hold Option and move over the rows, input, and WebView region.
                </Text>
                <View style={s.row}>
                    <Text style={s.rowLabel}>selected</Text>
                    <Text style={s.rowValue}>{text || "none"}</Text>
                </View>
                {!skipWebView && (
                    <WebView
                        style={s.webview}
                        source={{
                            html: "<!doctype html><body style='margin:0;font-family:-apple-system,sans-serif;padding:18px'><strong>WebView region</strong><p>This is still reported as the host webview node.</p></body>",
                        }}
                    />
                )}
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, flexDirection: "row", backgroundColor: "#111318" },
    sidebar: {
        width: 260,
        padding: 18,
        gap: 14,
        backgroundColor: "#191d25",
        borderRightWidth: 1,
        borderRightColor: "#2b313d",
    },
    title: { color: "#f4f7fb", fontSize: 22, fontWeight: "700" },
    button: { backgroundColor: "#2f7df6", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
    buttonText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
    input: {
        color: "#f4f7fb",
        backgroundColor: "#10131a",
        borderWidth: 1,
        borderColor: "#343b49",
        borderRadius: 8,
        paddingHorizontal: 12,
        height: 38,
    },
    main: { flex: 1, padding: 22, gap: 14 },
    heading: { color: "#f4f7fb", fontSize: 18, fontWeight: "700" },
    body: { color: "#aeb7c6", fontSize: 14 },
    row: {
        flexDirection: "row",
        justifyContent: "space-between",
        backgroundColor: "#1d2430",
        borderRadius: 8,
        padding: 14,
    },
    rowLabel: { color: "#8793a6", fontSize: 13 },
    rowValue: { color: "#f4f7fb", fontSize: 13, fontWeight: "600" },
    webview: { flex: 1, minHeight: 180, borderRadius: 8, overflow: "hidden" },
});

AppRegistry.registerComponent("InspectorDevtools", () => App);
AppRegistry.runApplication("InspectorDevtools", { width: 860, height: 520, devtools: { inspector: true } });
