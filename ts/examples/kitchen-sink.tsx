/**
 * Kitchen sink — exercises the full react-native-gpui surface and self-validates
 * layout. Each measured box logs `LAYOUT <name> expected=WxH got=WxH PASS/FAIL`
 * to stdout via onLayout, so dimensions/sizing can be verified without a screenshot.
 *
 *   bun run examples/kitchen-sink.tsx
 */
import { useState } from "react";
import {
    AppRegistry,
    View,
    Text,
    TextInput,
    ScrollView,
    Pressable,
    Button,
    Switch,
    Svg,
    Image,
    WebView,
    FlatList,
    StyleSheet,
    useWindowDimensions,
    type LayoutChangeEvent,
} from "../src/index";

const C = {
    bg: "#1e1e2e",
    card: "#2a2a3c",
    card2: "#33334a",
    text: "#e6e6ef",
    sub: "#a0a0b8",
    accent: "#8a5cf6",
    green: "#34c759",
    border: "#3a3a52",
};

function measured(name: string, ew: number, eh: number) {
    return (e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        const pass = Math.abs(width - ew) < 1.5 && Math.abs(height - eh) < 1.5;
        console.log(
            `LAYOUT ${name} expected=${ew}x${eh} got=${width.toFixed(1)}x${height.toFixed(1)} ${pass ? "PASS" : "FAIL"}`,
        );
    };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <View style={s.section}>
            <Text style={s.h2}>{title}</Text>
            {children}
        </View>
    );
}

function App() {
    const { width, height } = useWindowDimensions();
    const [count, setCount] = useState(0);
    const [text, setText] = useState("");
    const [on, setOn] = useState(true);

    return (
        <ScrollView style={s.root} contentContainerStyle={s.content}>
            <Text style={s.h1}>react-native-gpui · kitchen sink</Text>
            <Text style={s.sub}>
                window {Math.round(width)}×{Math.round(height)} — resize me, this updates live
            </Text>

            <Section title="State + onPress">
                <View style={s.row}>
                    <Button title="Increment" onPress={() => setCount((c) => c + 1)} />
                    <Pressable style={s.chip} onPress={() => setCount(0)}>
                        <Text style={s.chipText}>reset</Text>
                    </Pressable>
                    <Text style={s.count}>count: {count}</Text>
                </View>
            </Section>

            <Section title="TextInput + onChangeText">
                <View style={s.inputWrap}>
                    <TextInput
                        style={s.input}
                        placeholder="type here…"
                        value={text}
                        onChangeText={setText}
                    />
                </View>
                <Text style={s.echo}>echo: {text || "—"}</Text>
            </Section>

            <Section title="Switch">
                <View style={s.row}>
                    <Switch value={on} onValueChange={setOn} />
                    <Text style={s.sub}>{on ? "on" : "off"}</Text>
                </View>
            </Section>

            <Section title="Sizing (validated via onLayout)">
                <View style={s.box200} onLayout={measured("fixed-200x80", 200, 80)}>
                    <Text style={s.boxText}>fixed 200×80</Text>
                </View>
                <View style={s.parent400}>
                    <View style={s.half} onLayout={measured("pct-50%-of-400", 200, 40)}>
                        <Text style={s.boxText}>50% → 200</Text>
                    </View>
                </View>
                <View style={s.flexRow}>
                    <View style={[s.flexCell, { backgroundColor: C.accent }]} onLayout={measured("flex-1-of-300", 150, 40)}>
                        <Text style={s.boxText}>flex 1</Text>
                    </View>
                    <View style={[s.flexCell, { backgroundColor: C.card2 }]}>
                        <Text style={s.boxText}>flex 1</Text>
                    </View>
                </View>
            </Section>

            <Section title="Icons (Svg) + Image">
                <View style={s.row}>
                    <Svg name="branch.svg" style={{ width: 22, height: 22, color: C.accent }} />
                    <Svg name="search.svg" style={{ width: 22, height: 22, color: C.green }} />
                    <Svg name="sparkle.svg" style={{ width: 22, height: 22, color: "#f0c674" }} />
                    <Image
                        source={{ uri: new URL("./assets/avatar.png", import.meta.url).pathname }}
                        style={{ width: 32, height: 32, borderRadius: 16 }}
                    />
                </View>
            </Section>

            <Section title="FlatList">
                <FlatList
                    data={["worktrees", "terminals", "diffs", "chat"]}
                    keyExtractor={(item) => item}
                    renderItem={({ item, index }) => (
                        <View style={s.listItem}>
                            <Text style={s.listIndex}>{index + 1}</Text>
                            <Text style={s.listText}>{item}</Text>
                        </View>
                    )}
                />
            </Section>

            <Section title="WebView (native web scroll)">
                <View style={s.webWrap}>
                    <WebView
                        style={{ flex: 1 }}
                        source={{
                            html: `<!doctype html><meta charset=utf8><body style="margin:0;font-family:-apple-system,sans-serif;background:#fff;color:#222;padding:16px"><h3 style=margin:0>WebView content ✅</h3><p style="color:#666">This is a real WKWebView composited inside the GPUI window — with native scroll and selection.</p></body>`,
                        }}
                    />
                </View>
            </Section>

            <View style={{ height: 30 }} />
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    content: { padding: 22, gap: 18 },
    h1: { color: C.text, fontSize: 22, fontWeight: "700" },
    h2: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 10 },
    sub: { color: C.sub, fontSize: 13 },
    section: { backgroundColor: C.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: C.border },
    row: { flexDirection: "row", alignItems: "center", gap: 12 },
    chip: { backgroundColor: C.card2, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
    chipText: { color: C.text, fontSize: 14 },
    count: { color: C.accent, fontSize: 15, fontWeight: "600" },
    inputWrap: {
        backgroundColor: C.card2,
        borderRadius: 8,
        paddingHorizontal: 12,
        height: 40,
        justifyContent: "center",
        borderWidth: 1,
        borderColor: C.border,
    },
    input: { color: C.text, fontSize: 15 },
    echo: { color: C.sub, fontSize: 13, marginTop: 8 },
    box200: {
        width: 200,
        height: 80,
        backgroundColor: C.accent,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
    },
    parent400: { width: 400, marginTop: 12, backgroundColor: C.card2, borderRadius: 8 },
    half: { width: "50%", height: 40, backgroundColor: C.green, borderRadius: 6, alignItems: "center", justifyContent: "center" },
    flexRow: { flexDirection: "row", width: 300, marginTop: 12, gap: 0 },
    flexCell: { flex: 1, height: 40, alignItems: "center", justifyContent: "center" },
    boxText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
    listItem: {
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderColor: C.border,
    },
    listIndex: { color: C.sub, fontSize: 13, width: 18 },
    listText: { color: C.text, fontSize: 14 },
    webWrap: { height: 200, borderRadius: 10, overflow: "hidden", backgroundColor: "#fff" },
});

AppRegistry.registerComponent("KitchenSink", () => App);
AppRegistry.runApplication("KitchenSink");
