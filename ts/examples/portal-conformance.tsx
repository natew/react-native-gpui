/**
 * Visual conformance fixture for RN-GPUI portals.
 *
 * Run:
 *   bun run conformance:portal
 *
 * Expected:
 *   - the blue underlay stays behind the portal overlay
 *   - the dialog is painted by the root PortalHost, not inline
 *   - the TextInput inside the portal accepts typing
 */
import { useRef, useState } from "react";
import {
    Portal,
    PortalProvider,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
    render,
} from "../src/index";

const C = {
    bg: "#edf1f7",
    underlay: "#d8e7ff",
    underlayText: "#22538f",
    scrim: "rgba(13, 18, 28, 0.26)",
    card: "#ffffff",
    border: "#c9d4e6",
    text: "#172033",
    sub: "#647188",
    accent: "#2f6fed",
};

function App() {
    const [draft, setDraft] = useState("");
    const [changes, setChanges] = useState(0);
    const valueRef = useRef("");

    function updateDraft(value: string) {
        valueRef.current = value;
        setDraft(value);
        setChanges((count) => count + 1);
        console.log(`CONFORMANCE portal input value=${JSON.stringify(value)}`);
    }

    return (
        <PortalProvider>
            <View style={s.root}>
                <View style={s.underlay}>
                    <Text style={s.underlayTitle} numberOfLines={1}>
                        underlay content
                    </Text>
                    <Text style={s.underlayBody} numberOfLines={3}>
                        This content should stay visually behind the portal overlay. The portal dialog should not
                        consume layout space in this blue panel.
                    </Text>
                </View>
            </View>
            <Portal hostName="root">
                <View style={s.overlay} pointerEvents="box-none">
                    <View style={s.dialog}>
                        <Text style={s.heading} numberOfLines={1}>
                            portal conformance
                        </Text>
                        <TextInput
                            accessibilityLabel="Portal input"
                            value={draft}
                            onChangeText={updateDraft}
                            placeholder="Portal input"
                            placeholderTextColor="#97a4b8"
                            style={s.input}
                        />
                        <View style={s.footer}>
                            <Text style={s.metric}>changes={changes}</Text>
                            <Pressable style={s.button} onPress={() => updateDraft("")}>
                                <Text style={s.buttonText}>Clear</Text>
                            </Pressable>
                        </View>
                        <Text style={s.value} numberOfLines={2}>
                            draft={JSON.stringify(valueRef.current)}
                        </Text>
                    </View>
                </View>
            </Portal>
        </PortalProvider>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: C.bg,
        padding: 22,
    },
    underlay: {
        width: 520,
        height: 220,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#b9cef0",
        backgroundColor: C.underlay,
        padding: 18,
        gap: 12,
    },
    underlayTitle: {
        color: C.underlayText,
        fontSize: 22,
        fontWeight: "800",
    },
    underlayBody: {
        color: C.underlayText,
        fontSize: 14,
        lineHeight: 21,
        maxWidth: 420,
    },
    overlay: {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.scrim,
        zIndex: 20,
    },
    dialog: {
        width: 360,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.card,
        padding: 16,
        gap: 12,
        boxShadow: "0px 18px 44px rgba(15,23,42,0.24)",
    },
    heading: {
        color: C.sub,
        fontSize: 12,
        fontWeight: "800",
        textTransform: "uppercase",
        letterSpacing: 0.8,
    },
    input: {
        height: 38,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: "#f8fafc",
        color: C.text,
        fontSize: 14,
        paddingHorizontal: 10,
    },
    footer: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
    },
    metric: {
        color: C.sub,
        fontSize: 12,
        fontFamily: "monospace",
    },
    button: {
        width: 68,
        height: 32,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.accent,
    },
    buttonText: {
        color: "#ffffff",
        fontSize: 13,
        fontWeight: "800",
    },
    value: {
        color: C.text,
        fontSize: 12,
        lineHeight: 18,
        fontFamily: "monospace",
    },
});

render(<App />, { width: 564, height: 300 });
