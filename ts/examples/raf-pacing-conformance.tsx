/**
 * runtime conformance for host-driven requestAnimationFrame pacing.
 *
 * proves rAF rides the host's real vsync (CVDisplayLink via frame_clock.rs)
 * rather than the setTimeout(16) fallback shim.
 *
 * expected:
 *   - the host-driven path is active: globalThis.__rngpui_fireFrame is a
 *     function (raf.ts only installs that global on the host path; the
 *     setTimeout fallback never does)
 *   - chaining rAF for ~1.2s produces >= 45 ticks/sec
 *   - median inter-tick interval <= 18ms (i.e. it tracks a >=55Hz display,
 *     not the 16ms+overhead of a free-running timer that drifts under load)
 *
 * the printed numbers expose the real display rate (~60 or ~120) so a human
 * can eyeball it.
 */
import { useEffect } from "react";
import { render, StyleSheet, Text, View } from "../src/index";

const DURATION_MS = 1200;
const MIN_TICKS_PER_SEC = 45;
const MAX_MEDIAN_MS = 18;

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index];
}

function App() {
    useEffect(() => {
        const root = globalThis as typeof globalThis & {
            __rngpui_fireFrame?: () => void;
            requestAnimationFrame: (cb: (t: number) => void) => number;
        };

        const stamps: number[] = [];
        const start = performance.now();

        function tick(timestamp: number) {
            stamps.push(timestamp);
            if (timestamp - start < DURATION_MS) {
                root.requestAnimationFrame(tick);
                return;
            }
            finish();
        }

        function finish() {
            const hostDriven = typeof root.__rngpui_fireFrame === "function";

            const intervals: number[] = [];
            for (let i = 1; i < stamps.length; i++) {
                intervals.push(stamps[i] - stamps[i - 1]);
            }
            intervals.sort((a, b) => a - b);
            const elapsed = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
            const ticksPerSec = elapsed > 0 ? ((stamps.length - 1) / elapsed) * 1000 : 0;
            const median = percentile(intervals, 50);
            const p95 = percentile(intervals, 95);

            const numbers = `ticks=${stamps.length} ticksPerSec=${ticksPerSec.toFixed(1)} median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms hostDriven=${hostDriven}`;

            const ok =
                hostDriven && ticksPerSec >= MIN_TICKS_PER_SEC && median <= MAX_MEDIAN_MS;

            if (ok) {
                console.log(`RAF_PACING_CONFORMANCE_PASS ${numbers}`);
                process.exit(0);
            } else {
                console.error(`RAF_PACING_CONFORMANCE_FAIL ${numbers}`);
                process.exit(1);
            }
        }

        root.requestAnimationFrame(tick);
    }, []);

    return (
        <View style={s.root}>
            <Text style={s.text} numberOfLines={1}>
                raf pacing conformance
            </Text>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: "#f3f6fb",
        alignItems: "center",
        justifyContent: "center",
    },
    text: {
        color: "#142033",
        fontSize: 14,
        fontWeight: "800",
    },
});

render(<App />, { width: 360, height: 140 });
