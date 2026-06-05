/**
 * Visual conformance fixture for RN Animated on GPUI.
 *
 * Run:
 *   bun run conformance:animation
 *
 * Capture one frame while `phase=holding` and another after `phase=done`. Expected:
 *   - the marker moves horizontally across frames
 *   - opacity changes across frames
 *   - final state logs a PASS line
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View, render } from "../src/index";

const C = {
    bg: "#f3f6fb",
    panel: "#ffffff",
    border: "#cad5e6",
    rail: "#d9e5f6",
    marker: "#2f6fed",
    markerEnd: "#20a267",
    text: "#172033",
    sub: "#66758c",
};

const holdMs = numberEnv("RNGPUI_ANIMATION_HOLD_MS", 5000);
const durationMs = numberEnv("RNGPUI_ANIMATION_DURATION_MS", 900);

function App() {
    const left = useRef(new Animated.Value(18)).current;
    const opacity = useRef(new Animated.Value(0.28)).current;
    const [done, setDone] = useState(false);
    const [phase, setPhase] = useState("holding");
    const [currentLeft, setCurrentLeft] = useState(18);

    useEffect(() => {
        const sub = left.addListener(({ value }) => setCurrentLeft(value));
        const timer = setTimeout(() => {
            setPhase("running");
            console.log("CONFORMANCE animation RUNNING");
            Animated.parallel([
                Animated.timing(left, {
                    toValue: 244,
                    duration: durationMs,
                    easing: Easing.inOut(Easing.cubic),
                    useNativeDriver: false,
                } as never),
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: durationMs,
                    easing: Easing.inOut(Easing.cubic),
                    useNativeDriver: false,
                } as never),
            ]).start(({ finished }) => {
                setDone(finished);
                setPhase("done");
                console.log(`CONFORMANCE animation ${finished ? "PASS" : "FAIL"} left=${left.__getValue().toFixed(1)}`);
            });
        }, holdMs);
        return () => {
            clearTimeout(timer);
            left.removeListener(sub);
        };
    }, [left, opacity]);

    return (
        <View style={s.root}>
            <View style={s.panel}>
                <Text style={s.heading} numberOfLines={1}>
                    animation conformance
                </Text>
                <View style={s.rail}>
                    <Animated.View
                        style={[
                            s.marker,
                            {
                                left,
                                opacity,
                                backgroundColor: done ? C.markerEnd : C.marker,
                            },
                        ]}
                    />
                </View>
                <Text style={s.value} numberOfLines={1}>
                    left={currentLeft.toFixed(1)} · phase={phase} · done={String(done)}
                </Text>
            </View>
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
        width: 360,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel,
        padding: 16,
        gap: 14,
    },
    heading: {
        color: C.sub,
        fontSize: 12,
        fontWeight: "800",
        textTransform: "uppercase",
        letterSpacing: 0.8,
    },
    rail: {
        position: "relative",
        width: 312,
        height: 52,
        borderRadius: 26,
        backgroundColor: C.rail,
        overflow: "hidden",
    },
    marker: {
        position: "absolute",
        top: 8,
        width: 52,
        height: 36,
        borderRadius: 18,
    },
    value: {
        color: C.text,
        fontSize: 13,
        fontFamily: "monospace",
    },
});

render(<App />, { width: 404, height: 180 });

function numberEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}
