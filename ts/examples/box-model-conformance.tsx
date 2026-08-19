/**
 * Runtime conformance fixture for the box model.
 *
 * Run:
 *   bun run conformance:box-model
 *
 * Expected:
 *   - a declared width/height is the OUTER size, padding and border included,
 *     the same as React Native and web
 *   - maxWidth/minWidth cap the outer size the same way
 *
 * This regressed once: the style parser subtracted padding+border from every
 * fixed size on the belief that taffy was content-box. taffy 0.9 defaults to
 * BoxSizing::BorderBox, so the subtraction ran twice and every padded box laid
 * out 2*padding narrower than it asked for — `width: 200` with `padding: 16`
 * measured 168, and a 768pt centred column with 16pt gutters measured 736.
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
    const padded = useRef<MeasureRef | null>(null);
    const maxPadded = useRef<MeasureRef | null>(null);
    const maxBordered = useRef<MeasureRef | null>(null);
    const asymmetric = useRef<MeasureRef | null>(null);

    useEffect(() => {
        async function run() {
            await new Promise((resolve) => setTimeout(resolve, 60));
            const cases: [string, MeasureRef | null, number, number][] = [
                // label, node, expected outer width, expected outer height
                ["plain 200x40", plain.current, 200, 40],
                ["200x40 padding 16", padded.current, 200, 40],
                ["maxWidth 300 padding 16", maxPadded.current, 300, -1],
                ["maxWidth 300 border 4", maxBordered.current, 300, -1],
                ["maxWidth 300 pl 10 pr 30", asymmetric.current, 300, -1],
            ];
            let failed = false;
            for (const [label, node, wantWidth, wantHeight] of cases) {
                if (!node) throw new Error(`${label}: ref missing`);
                const { width, height } = await measure(node);
                const widthOk = Math.round(width) === wantWidth;
                const heightOk = wantHeight < 0 || Math.round(height) === wantHeight;
                if (widthOk && heightOk) {
                    console.log(`CONFORMANCE box-model ${label} PASS width=${Math.round(width)}`);
                } else {
                    failed = true;
                    console.error(
                        `CONFORMANCE box-model ${label} FAIL width=${width} want=${wantWidth} height=${height} want=${wantHeight}`,
                    );
                }
            }
            if (failed) process.exit(1);
            console.log("CONFORMANCE box-model all PASS");
            process.exit(0);
        }
        run().catch((error) => {
            console.error(`CONFORMANCE box-model FAIL ${String(error)}`);
            process.exit(1);
        });
    }, []);

    return (
        <View style={styles.root}>
            <View ref={plain as never} testID="plain" style={styles.plain} />
            <View ref={padded as never} testID="padded" style={styles.padded}>
                <View style={styles.fill} />
            </View>
            <View ref={maxPadded as never} testID="max-padded" style={styles.maxPadded}>
                <Text style={styles.label}>maxWidth 300, padding 16</Text>
            </View>
            <View ref={maxBordered as never} testID="max-bordered" style={styles.maxBordered}>
                <Text style={styles.label}>maxWidth 300, border 4</Text>
            </View>
            <View ref={asymmetric as never} testID="asymmetric" style={styles.asymmetric}>
                <Text style={styles.label}>maxWidth 300, pl 10 pr 30</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#101014", padding: 20, gap: 8 },
    plain: { width: 200, height: 40, backgroundColor: "#334455" },
    padded: { width: 200, height: 40, padding: 16, backgroundColor: "#445566" },
    fill: { flex: 1, backgroundColor: "#8899aa" },
    maxPadded: { width: "100%", maxWidth: 300, padding: 16, backgroundColor: "#556677" },
    maxBordered: {
        width: "100%",
        maxWidth: 300,
        borderWidth: 4,
        borderColor: "#ee4444",
        backgroundColor: "#667788",
    },
    asymmetric: {
        width: "100%",
        maxWidth: 300,
        paddingLeft: 10,
        paddingRight: 30,
        backgroundColor: "#778899",
    },
    label: { color: "#e5e5e5", fontSize: 13 },
});

render(<App />, { width: 520, height: 320 });
