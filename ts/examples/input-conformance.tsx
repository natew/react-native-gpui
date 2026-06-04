/**
 * Visual conformance fixture for RN TextInput editing and submit behavior.
 *
 * Run:
 *   bun run conformance:input
 *
 * Drive with accessibility or keyboard input:
 *   1. focus "Message conformance"
 *   2. type text
 *   3. press Return
 *
 * Expected:
 *   - text appears while typing
 *   - plain Return submits exactly once, strips the submit newline, and clears the draft
 *   - Shift+Return inserts a newline and does not submit
 *   - onKeyPress observes Enter but does not perform the submit
 */
import { useRef, useState } from "react";
import {
    render,
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
} from "../src/index";

const C = {
    bg: "#f3f5f8",
    panel: "#ffffff",
    border: "#d5dce8",
    field: "#f8fafc",
    text: "#151b26",
    sub: "#657084",
    muted: "#93a0b4",
    accent: "#2f6fed",
    pass: "#15803d",
};

function App() {
    const [draft, setDraft] = useState("");
    const [changeCount, setChangeCount] = useState(0);
    const [enterKeyCount, setEnterKeyCount] = useState(0);
    const [submitCount, setSubmitCount] = useState(0);
    const [submitted, setSubmitted] = useState("");
    const draftRef = useRef("");

    function updateDraft(text: string) {
        draftRef.current = text;
        setDraft(text);
        setChangeCount((count) => count + 1);
        console.log(`CONFORMANCE input change value=${JSON.stringify(text)}`);
    }

    function submit(source: string) {
        const text = draftRef.current;
        if (!text.trim()) return;
        setSubmitted(`${source}:${text}`);
        setSubmitCount((count) => count + 1);
        updateDraft("");
        console.log(`CONFORMANCE input enter-submit PASS source=${source} text=${JSON.stringify(text)}`);
    }

    function onKeyPress(event: unknown) {
        const typed = event as {
            preventDefault?: () => void;
            nativeEvent?: { key?: string; shiftKey?: boolean; isComposing?: boolean };
        };
        const key = typed.nativeEvent?.key;
        if (key !== "Enter" || typed.nativeEvent?.isComposing) return;
        setEnterKeyCount((count) => count + 1);
    }

    return (
        <View style={s.root}>
            <View style={s.panel}>
                <Text style={s.heading} numberOfLines={1}>
                    input conformance
                </Text>
                <View style={s.field}>
                    <TextInput
                        value={draft}
                        onChangeText={updateDraft}
                        onKeyPress={onKeyPress}
                        onSubmitEditing={() => submit("submitEditing")}
                        multiline
                        returnKeyType="send"
                        placeholder="Message conformance"
                        placeholderTextColor={C.muted}
                        style={s.input}
                    />
                    <Pressable style={s.button} onPress={() => submit("button")}>
                        <Text style={s.buttonText}>Send</Text>
                    </Pressable>
                </View>
                <View style={s.metrics}>
                    <Metric label="changes" value={changeCount} />
                    <Metric label="enterKeys" value={enterKeyCount} />
                    <Metric label="submits" value={submitCount} />
                </View>
                <Text style={s.value} numberOfLines={3}>
                    draft={JSON.stringify(draft)}
                </Text>
                <Text style={s.submitted} numberOfLines={3}>
                    submitted={JSON.stringify(submitted)}
                </Text>
            </View>
        </View>
    );
}

function Metric({ label, value }: { label: string; value: number }) {
    return (
        <View style={s.metric}>
            <Text style={s.metricLabel}>{label}</Text>
            <Text style={s.metricValue}>{String(value)}</Text>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: C.bg,
        padding: 22,
    },
    panel: {
        width: 520,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel,
        padding: 16,
        gap: 12,
    },
    heading: {
        color: C.sub,
        fontSize: 12,
        fontWeight: "800",
        letterSpacing: 0.8,
        textTransform: "uppercase",
    },
    field: {
        minHeight: 78,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.field,
        padding: 10,
    },
    input: {
        flex: 1,
        minHeight: 56,
        color: C.text,
        fontSize: 14,
        lineHeight: 20,
        padding: 0,
        margin: 0,
        borderWidth: 0,
        backgroundColor: "transparent",
        textAlignVertical: "top",
    },
    button: {
        width: 68,
        height: 34,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.accent,
        flexShrink: 0,
    },
    buttonText: {
        color: "#ffffff",
        fontSize: 13,
        fontWeight: "800",
    },
    metrics: {
        flexDirection: "row",
        gap: 8,
    },
    metric: {
        flex: 1,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: "#f8fafc",
        padding: 8,
        gap: 4,
    },
    metricLabel: {
        color: C.sub,
        fontSize: 11,
        fontWeight: "700",
    },
    metricValue: {
        color: C.pass,
        fontSize: 18,
        fontWeight: "800",
    },
    value: {
        color: C.sub,
        fontSize: 12,
        lineHeight: 18,
        fontFamily: "monospace",
    },
    submitted: {
        color: C.text,
        fontSize: 13,
        lineHeight: 19,
        fontFamily: "monospace",
    },
});

render(<App />, { width: 564, height: 300 });
