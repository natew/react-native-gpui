// Hit-test conformance: which node a press RESOLVES to when things overlap.
//
// Deliberately not a painting test. Every case below paints correctly even when hit
// resolution is broken, which is how an overlay that was dead to input stayed green
// under the picker-occlusion gate. Each case reports the id of whatever handler fires,
// and the driver asserts the covering node won and the covered node stayed silent.
//
// Three stacks, each a pressable covered by another pressable:
//   plain    — overlay later in document order (the ordinary dropdown-over-content case)
//   deep     — covered content nested far deeper than the overlay, which is the exact
//              shape that used to lose: resolution ranked nesting depth over paint order
//   zlift    — overlay EARLIER in document order but lifted with zIndex, so paint order
//              and document order disagree and only paint order is correct
import { useEffect, useRef } from "react";
import { render, StyleSheet, Text, View } from "../src/index";

function fired(name: string) {
    console.log(`CONFORMANCE hit-test FIRED ${name}`);
}

function App() {
    const plainRef = useRef<{ id: number } | null>(null);
    const deepRef = useRef<{ id: number } | null>(null);
    const zliftRef = useRef<{ id: number } | null>(null);

    useEffect(() => {
        const report = (name: string, inst: { id: number } | null) => {
            const measurable = inst as unknown as {
                measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
            };
            if (!measurable?.measureInWindow) {
                console.log(`CONFORMANCE hit-test FAIL no-instance ${name}`);
                return;
            }
            measurable.measureInWindow((x, y, w, h) => {
                console.log(`CONFORMANCE hit-test BOX ${name} x=${x} y=${y} w=${w} h=${h}`);
            });
        };
        report("plain", plainRef.current);
        report("deep", deepRef.current);
        report("zlift", zliftRef.current);
        console.log("CONFORMANCE hit-test READY");
    }, []);

    return (
        <View style={s.root}>
            {/* plain: overlay simply comes later in document order */}
            <View style={s.stack}>
                <View style={s.covered} onPress={() => fired("plain-covered")}>
                    <Text style={s.label}>covered</Text>
                </View>
                <View ref={plainRef as never} style={s.overlay} onPress={() => fired("plain-overlay")}>
                    <Text style={s.label}>overlay</Text>
                </View>
            </View>

            {/* deep: the covered pressable is buried under four extra wrappers */}
            <View style={s.stack}>
                <View style={s.fill}>
                    <View style={s.fill}>
                        <View style={s.fill}>
                            <View style={s.fill}>
                                <View style={s.covered} onPress={() => fired("deep-covered")}>
                                    <Text style={s.label}>covered</Text>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>
                <View ref={deepRef as never} style={s.overlay} onPress={() => fired("deep-overlay")}>
                    <Text style={s.label}>overlay</Text>
                </View>
            </View>

            {/* zlift: overlay is declared FIRST and wins only because of zIndex */}
            <View style={s.stack}>
                <View
                    ref={zliftRef as never}
                    style={[s.overlay, s.lifted]}
                    onPress={() => fired("zlift-overlay")}
                >
                    <Text style={s.label}>overlay</Text>
                </View>
                <View style={s.covered} onPress={() => fired("zlift-covered")}>
                    <Text style={s.label}>covered</Text>
                </View>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#101725", padding: 20, gap: 20 },
    stack: { width: 240, height: 60 },
    fill: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 },
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
    lifted: { zIndex: 10 },
    label: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
});

render(<App />, { width: 300, height: 280 });
