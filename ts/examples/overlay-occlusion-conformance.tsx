// Overlay occlusion: does a covering view stop input reaching what it covers?
//
// Distinct from hit-test-conformance, which asks which single node a press RESOLVES to.
// This asks whether the covered node hears anything at all — the down-side and hover-side
// handlers resolve separately from the press, so a covered node used to receive pressIn /
// mouseDown / mouseEnter while the overlay legitimately won the press.
//
// The covered node reports every event it receives. A correct renderer reports none of
// them for a point under the overlay.
import { useEffect, useRef } from "react";
import { render, StyleSheet, Text, View } from "../src/index";

function saw(who: string, event: string) {
    console.log(`CONFORMANCE occlusion SAW ${who} ${event}`);
}

function App() {
    const boxRef = useRef<{ id: number } | null>(null);

    useEffect(() => {
        const measurable = boxRef.current as unknown as {
            measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
        };
        if (!measurable?.measureInWindow) {
            console.log("CONFORMANCE occlusion FAIL no-instance");
            return;
        }
        measurable.measureInWindow((x, y, w, h) => {
            console.log(`CONFORMANCE occlusion BOX x=${x} y=${y} w=${w} h=${h}`);
        });
        console.log("CONFORMANCE occlusion READY");
    }, []);

    return (
        <View style={s.root}>
            <View style={s.stack}>
                <View
                    style={s.covered}
                    onPressIn={() => saw("covered", "pressIn")}
                    onPressOut={() => saw("covered", "pressOut")}
                    onPress={() => saw("covered", "press")}
                    onMouseDown={() => saw("covered", "mouseDown")}
                    onMouseEnter={() => saw("covered", "mouseEnter")}
                >
                    <Text style={s.label}>covered</Text>
                </View>
                <View
                    ref={boxRef as never}
                    style={s.overlay}
                    onPressIn={() => saw("overlay", "pressIn")}
                    onPress={() => saw("overlay", "press")}
                    onMouseEnter={() => saw("overlay", "mouseEnter")}
                >
                    <Text style={s.label}>overlay</Text>
                </View>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#101725", padding: 20 },
    stack: { width: 240, height: 60 },
    covered: {
        position: "absolute",
        left: 0,
        top: 0,
        width: 240,
        height: 60,
        borderRadius: 10,
        backgroundColor: "#3a4a68",
        alignItems: "center",
        justifyContent: "center",
    },
    overlay: {
        position: "absolute",
        left: 0,
        top: 0,
        width: 240,
        height: 60,
        borderRadius: 10,
        backgroundColor: "#2f6fed",
        alignItems: "center",
        justifyContent: "center",
    },
    label: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
});

render(<App />, { width: 300, height: 120 });
