/** A continuously changing visual used to correlate React paints with Metal presents. */
import { useEffect, useState } from "react";
import { StyleSheet, View, render } from "../src/index";

const DURATION_MS = 1500;
const COLORS = ["#ef4444", "#22c55e", "#3b82f6", "#eab308"];
const smokeMode = process.env.RNGPUI_PRESENTATION_MODE === "smoke";

function App() {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        const root = globalThis as typeof globalThis & {
            __startPresentationProbe?: () => void;
            requestAnimationFrame: (callback: (timestamp: number) => void) => number;
        };
        root.__startPresentationProbe = () => {
            const stamps: number[] = [];
            let nextFrame = 0;
            const tick = (timestamp: number) => {
                stamps.push(timestamp);
                nextFrame += 1;
                setFrame(nextFrame);
                if (timestamp - stamps[0] < DURATION_MS) {
                    root.requestAnimationFrame(tick);
                    return;
                }
                const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
                intervals.sort((a, b) => a - b);
                const p50 = intervals[Math.floor(intervals.length * 0.5)] ?? 0;
                const p95 = intervals[Math.floor(intervals.length * 0.95)] ?? 0;
                console.log(
                    `PRESENTATION_PROBE_DONE ticks=${stamps.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`,
                );
            };
            root.requestAnimationFrame(tick);
        };
        console.log("PRESENTATION_PROBE_READY");
        return () => {
            delete root.__startPresentationProbe;
        };
    }, []);

    return (
        <View style={styles.root}>
            <View style={styles.rail}>
                <View
                    testID="presentation-marker"
                    style={[
                        styles.marker,
                        {
                            backgroundColor: COLORS[frame % COLORS.length],
                            transform: [{ translateX: frame % 360 }],
                        },
                    ]}
                />
            </View>
        </View>
    );
}

function SmokeApp() {
    useEffect(() => {
        console.log("PRESENTATION_SMOKE_READY");
    }, []);
    return (
        <View style={styles.root}>
            <View style={styles.smoke} />
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        padding: 24,
        justifyContent: "center",
        backgroundColor: "#0f172a",
    },
    rail: {
        height: 72,
        borderRadius: 16,
        overflow: "hidden",
        backgroundColor: "#1e293b",
    },
    marker: {
        width: 48,
        height: 72,
    },
    smoke: {
        height: 72,
        borderRadius: 16,
        backgroundImage: "smoke(rgba(239,68,68,0.9), rgba(59,130,246,0.15))",
    },
});

render(smokeMode ? <SmokeApp /> : <App />, { width: 456, height: 120 });
