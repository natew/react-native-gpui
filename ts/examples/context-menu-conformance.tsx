import { useEffect, useRef, useState } from "react";
import { render, StyleSheet, Text, View } from "../src/index";

let renderCount = 0;

function App() {
    renderCount++;
    const [status, setStatus] = useState("waiting");
    const targetRef = useRef<{ id: number } | null>(null);

    useEffect(() => {
        const inst = targetRef.current;
        if (!inst || typeof inst.id !== "number") {
            console.log("CONFORMANCE context-menu FAIL no-instance");
            return;
        }
        console.log(`CONFORMANCE context-menu READY id=${inst.id} renders=${renderCount}`);
        const measurable = inst as unknown as {
            measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
        };
        measurable.measureInWindow?.((x, y, w, h) => {
            console.log(`CONFORMANCE context-menu BOX x=${x} y=${y} w=${w} h=${h}`);
        });
    }, []);

    return (
        <View style={s.root}>
            <View style={s.panel}>
                <Text style={s.heading} numberOfLines={1}>
                    context menu conformance
                </Text>
                <View
                    ref={targetRef as never}
                    nativeID="context-target"
                    style={s.target}
                    onContextMenu={(event) => {
                        setStatus("context");
                        console.log(
                            [
                                "CONFORMANCE context-menu FIRED",
                                `button=${event.button}`,
                                `buttons=${event.buttons}`,
                                `nativeButton=${event.nativeEvent.button}`,
                                `nativeButtons=${event.nativeEvent.buttons}`,
                                `pageX=${event.nativeEvent.pageX}`,
                                `pageY=${event.nativeEvent.pageY}`,
                            ].join(" "),
                        );
                    }}
                >
                    <Text style={s.targetText} numberOfLines={1}>
                        right click target
                    </Text>
                </View>
                <Text style={s.value} numberOfLines={1}>
                    status={status}
                </Text>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#f3f6fb", padding: 22 },
    panel: {
        width: 360,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#cad5e6",
        backgroundColor: "#ffffff",
        padding: 16,
        gap: 14,
    },
    heading: { color: "#66758c", fontSize: 12, fontWeight: "800", letterSpacing: 0.8 },
    target: {
        width: 240,
        height: 88,
        borderRadius: 12,
        backgroundColor: "#2f6fed",
        alignItems: "center",
        justifyContent: "center",
    },
    targetText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
    value: { color: "#172033", fontSize: 13, fontFamily: "monospace" },
});

render(<App />, { width: 420, height: 230 });
