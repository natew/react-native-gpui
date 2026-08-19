/**
 * Runtime conformance fixture for negative margins inside a content-sized row.
 *
 * Run:
 *   bun run conformance:negative-margin
 *
 * Expected:
 *   - a content-sized flex row is as wide as its children, with a negative
 *     margin subtracting exactly its own pixels — the same as web and RN
 *   - that holds whether the children are flexShrink 0 (React Native's default)
 *     or flexShrink 1 (the web default)
 *
 * The bug this guards: taffy divides an item's max-content flex fraction by
 * `max(1, shrink * basis)` and multiplies it back by `max(1, shrink) * basis`.
 * Those agree only when `shrink * basis >= 1`, so with RN's `flexShrink: 0` the
 * factor became the item's whole basis and a `marginLeft: -1` child contributed
 * `-width` instead of `width - 1`. A pill holding a bleeding chip then laid out
 * 29px narrower than its own contents and clipped everything after them.
 */
import { useEffect, useRef } from "react";
import { render, StyleSheet, Text, View } from "../src/index";

type MeasureRef = {
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
};

function measure(node: MeasureRef): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
        node.measureInWindow((_x, _y, width, height) => resolve({ width, height }));
    });
}

function App() {
    const plain = useRef<MeasureRef | null>(null);
    const bleedRigid = useRef<MeasureRef | null>(null);
    const bleedFlexible = useRef<MeasureRef | null>(null);
    const positive = useRef<MeasureRef | null>(null);

    useEffect(() => {
        async function run() {
            await new Promise((resolve) => setTimeout(resolve, 60));
            // padding 2 + 3, gap 2, children 15 + 46 => 68 with no margin.
            const cases: [string, MeasureRef | null, number][] = [
                ["no margin", plain.current, 68],
                ["marginLeft -4, flexShrink 0", bleedRigid.current, 64],
                ["marginLeft -4, flexShrink 1", bleedFlexible.current, 64],
                ["marginLeft +4", positive.current, 72],
            ];
            let failed = false;
            for (const [label, node, want] of cases) {
                if (!node) throw new Error(`${label}: ref missing`);
                const { width } = await measure(node);
                if (Math.round(width) === want) {
                    console.log(`CONFORMANCE negative-margin ${label} PASS width=${Math.round(width)}`);
                } else {
                    failed = true;
                    console.error(
                        `CONFORMANCE negative-margin ${label} FAIL width=${width} want=${want}`,
                    );
                }
            }
            if (failed) process.exit(1);
            console.log("CONFORMANCE negative-margin all PASS");
            process.exit(0);
        }
        run().catch((error) => {
            console.error(`CONFORMANCE negative-margin FAIL ${String(error)}`);
            process.exit(1);
        });
    }, []);

    // each row is wider than its pill so the pill is sized by its content, which
    // is the only place the broken factor is used.
    return (
        <View style={styles.root}>
            <View style={styles.row}>
                <Text style={styles.title}>title</Text>
                <View ref={plain as never} testID="plain" style={styles.pill}>
                    <View style={styles.chip} />
                    <View style={styles.segment} />
                </View>
            </View>
            <View style={styles.row}>
                <Text style={styles.title}>title</Text>
                <View ref={bleedRigid as never} testID="bleed-rigid" style={styles.pill}>
                    <View style={[styles.chip, styles.bleed]} />
                    <View style={styles.segment} />
                </View>
            </View>
            <View style={styles.row}>
                <Text style={styles.title}>title</Text>
                <View ref={bleedFlexible as never} testID="bleed-flexible" style={styles.pill}>
                    <View style={[styles.chip, styles.bleed, styles.flexible]} />
                    <View style={[styles.segment, styles.flexible]} />
                </View>
            </View>
            <View style={styles.row}>
                <Text style={styles.title}>title</Text>
                <View ref={positive as never} testID="positive" style={styles.pill}>
                    <View style={[styles.chip, styles.inset]} />
                    <View style={styles.segment} />
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#101014", padding: 10, gap: 6 },
    row: { width: 214, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#222233" },
    title: { color: "#eeeeee", fontSize: 13, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    pill: {
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        gap: 2,
        height: 18,
        paddingLeft: 2,
        paddingRight: 3,
        paddingTop: 2,
        paddingBottom: 2,
        overflow: "hidden",
        backgroundColor: "#445555",
    },
    chip: { width: 15, height: 14, backgroundColor: "#667777" },
    segment: { width: 46, height: 14, backgroundColor: "#778888" },
    bleed: { marginLeft: -4 },
    inset: { marginLeft: 4 },
    flexible: { flexShrink: 1 },
});

render(<App />, { width: 320, height: 220 });
