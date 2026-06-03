/**
 * Superconductor — the "native shell, web content" hybrid, built entirely with
 * react-native-gpui. The sidebar, header and composer are native GPUI (RN
 * components); the conversation is a WebView (native web scroll + selection).
 * Sending a message re-renders the WebView's HTML from React state.
 *
 *   bun run examples/superconductor.tsx
 */
import { useMemo, useState } from "react";
import {
    AppRegistry,
    View,
    Text,
    TextInput,
    Pressable,
    Svg,
    WebView,
    StyleSheet,
    useWindowDimensions,
} from "../src/index";

const C = {
    bg: "#1e1e2e",
    sidebar: "#181825",
    panel: "#232334",
    card: "#2a2a3c",
    border: "#33334a",
    text: "#e6e6ef",
    sub: "#9a9ab0",
    accent: "#8a5cf6",
    accent2: "#5b5bd6",
    green: "#34c759",
};

type Branch = { id: string; name: string; status: "running" | "idle" | "done" };
const BRANCHES: Branch[] = [
    { id: "main", name: "main", status: "idle" },
    { id: "feat-auth", name: "feat/auth-rework", status: "running" },
    { id: "fix-scroll", name: "fix/scroll-momentum", status: "done" },
    { id: "exp-webview", name: "exp/webview-content", status: "running" },
    { id: "chore-deps", name: "chore/bump-deps", status: "idle" },
];

type Msg = { role: "user" | "agent"; text: string };

function conversationHtml(branch: string, messages: Msg[]): string {
    const bubbles = messages
        .map((m) => {
            const mine = m.role === "user";
            return `<div class="row ${mine ? "me" : "them"}">
        <div class="avatar ${mine ? "av-me" : "av-them"}">${mine ? "you" : "✦"}</div>
        <div class="bubble">${m.text}</div>
      </div>`;
        })
        .join("");
    return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html,body { margin:0; height:100%; }
    body { font-family:-apple-system,system-ui,sans-serif; background:#1e1e2e; color:#e6e6ef; -webkit-font-smoothing:antialiased; }
    .wrap { padding:22px 26px 40px; }
    .day { text-align:center; color:#7a7a90; font-size:12px; margin:6px 0 18px; }
    .row { display:flex; gap:12px; margin:0 0 18px; align-items:flex-start; }
    .row.me { flex-direction:row-reverse; }
    .avatar { width:30px; height:30px; border-radius:9px; flex:0 0 30px; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; }
    .av-them { background:linear-gradient(135deg,#8a5cf6,#5b5bd6); }
    .av-me { background:#33334a; color:#cfcfe0; }
    .bubble { max-width:72%; background:#2a2a3c; border:1px solid #33334a; border-radius:14px; padding:11px 14px; font-size:14px; line-height:21px; }
    .me .bubble { background:#2f2a44; border-color:#473b6e; }
    .bubble code { background:#191926; padding:2px 6px; border-radius:6px; font-family:ui-monospace,SFMono-Regular,monospace; font-size:12.5px; color:#c9b6ff; }
    .bubble pre { background:#15151f; border:1px solid #2a2a3c; border-radius:10px; padding:12px 14px; overflow:auto; margin:10px 0 0; }
    .bubble pre code { background:none; padding:0; color:#d6d6e6; }
    .bubble h4 { margin:2px 0 8px; font-size:14px; }
    .bubble ul { margin:8px 0 0; padding-left:18px; }
    .bubble li { margin:4px 0; }
    </style></head><body><div class="wrap">
      <div class="day">${branch} · today</div>
      ${bubbles}
    </div></body></html>`;
}

function StatusDot({ status }: { status: Branch["status"] }) {
    const color = status === "running" ? C.green : status === "done" ? C.accent : "#5a5a70";
    return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

function App() {
    const { width } = useWindowDimensions();
    const [selected, setSelected] = useState("exp-webview");
    const [draft, setDraft] = useState("");
    const [messages, setMessages] = useState<Msg[]>([
        { role: "agent", text: "Spun up the worktree for <code>exp/webview-content</code>. Want me to wire the shell↔web bridge next?" },
        { role: "user", text: "yes — native sidebar, web content. and make sure scroll feels native." },
        {
            role: "agent",
            text: `On it. Plan:<ul><li>GPUI shell (sidebar, composer)</li><li>WebView content via <code>lb-wry</code></li><li>native WebKit momentum scroll</li></ul><pre><code>cargo run --bin rngpui-service</code></pre>`,
        },
    ]);

    const html = useMemo(() => conversationHtml(selected, messages), [selected, messages]);

    const send = () => {
        const t = draft.trim();
        if (!t) return;
        setMessages((m) => [...m, { role: "user", text: t }]);
        setDraft("");
    };

    return (
        <View style={s.root}>
            {/* sidebar — native */}
            <View style={s.sidebar}>
                <View style={s.brand}>
                    <View style={s.logo}>
                        <Svg name="sparkle.svg" style={{ width: 16, height: 16, color: "#fff" }} />
                    </View>
                    <Text style={s.brandText}>Superconductor</Text>
                </View>
                <Text style={s.sectionLabel}>WORKTREES</Text>
                {BRANCHES.map((b) => {
                    const active = b.id === selected;
                    return (
                        <Pressable key={b.id} style={[s.branch, active && s.branchActive]} onPress={() => setSelected(b.id)}>
                            <Svg name="branch.svg" style={{ width: 15, height: 15, color: active ? C.text : C.sub }} />
                            <Text style={[s.branchName, active && { color: C.text }]} numberOfLines={1}>
                                {b.name}
                            </Text>
                            <StatusDot status={b.status} />
                        </Pressable>
                    );
                })}
            </View>

            {/* main column */}
            <View style={s.main}>
                <View style={s.header}>
                    <View>
                        <Text style={s.headerTitle}>{BRANCHES.find((b) => b.id === selected)?.name}</Text>
                        <Text style={s.headerSub}>agent session · {Math.round(width)}px wide</Text>
                    </View>
                    <View style={s.headerActions}>
                        <View style={s.pill}>
                            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.green }} />
                            <Text style={s.pillText}>live</Text>
                        </View>
                    </View>
                </View>

                {/* conversation — webview content (native web scroll) */}
                <View style={s.content}>
                    <WebView style={{ flex: 1 }} source={{ html }} />
                </View>

                {/* composer — native */}
                <View style={s.composer}>
                    <View style={s.inputWrap}>
                        <TextInput
                            style={s.input}
                            placeholder="Message the agent…"
                            value={draft}
                            onChangeText={setDraft}
                            onSubmitEditing={send}
                        />
                    </View>
                    <Pressable style={({ pressed }) => [s.send, pressed && { opacity: 0.85 }]} onPress={send}>
                        <Svg name="send.svg" style={{ width: 16, height: 16, color: "#fff" }} />
                    </Pressable>
                </View>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, flexDirection: "row", backgroundColor: C.bg },
    // sidebar
    sidebar: { width: 248, backgroundColor: C.sidebar, borderRightWidth: 1, borderColor: C.border, paddingVertical: 14, paddingHorizontal: 12, gap: 4 },
    brand: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 6, paddingBottom: 14 },
    logo: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundImage: "linear-gradient(135deg,#8a5cf6,#5b5bd6)" },
    brandText: { color: C.text, fontSize: 15, fontWeight: "700" },
    sectionLabel: { color: "#6a6a82", fontSize: 11, fontWeight: "600", letterSpacing: 1, paddingHorizontal: 6, paddingVertical: 8 },
    branch: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 8 },
    branchActive: { backgroundColor: C.card },
    branchName: { flex: 1, color: C.sub, fontSize: 13.5 },
    // main
    main: { flex: 1, flexDirection: "column", backgroundColor: C.bg },
    header: {
        height: 60,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 22,
        borderBottomWidth: 1,
        borderColor: C.border,
    },
    headerTitle: { color: C.text, fontSize: 15, fontWeight: "700" },
    headerSub: { color: C.sub, fontSize: 12, marginTop: 2 },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
    pill: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: C.panel, borderRadius: 20, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: C.border },
    pillText: { color: C.sub, fontSize: 12, fontWeight: "600" },
    content: { flex: 1, backgroundColor: C.bg },
    // composer
    composer: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderTopWidth: 1, borderColor: C.border },
    inputWrap: { flex: 1, backgroundColor: C.panel, borderRadius: 12, height: 44, justifyContent: "center", paddingHorizontal: 14, borderWidth: 1, borderColor: C.border },
    input: { color: C.text, fontSize: 14 },
    send: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundImage: "linear-gradient(135deg,#8a5cf6,#5b5bd6)" },
});

AppRegistry.registerComponent("Superconductor", () => App);
AppRegistry.runApplication("Superconductor");
