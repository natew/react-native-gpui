/**
 * Runtime conformance for the applyTree DELTA wire (toWireDelta + parse_json_tree ref
 * reuse). Deltas only appear on the 2nd+ commit (the first is always full), so this
 * mounts a ~120-row tree, then changes ONE row to force a re-commit. On that commit the
 * reconciler emits the changed row + ancestors in full and the other ~119 rows as
 * `{ globalId, ref: true }` refs; the host reuses their prior Arcs.
 *
 * Asserts end-to-end (real Hermes + reconciler + rust binary, offscreen):
 *   - the CHANGED row reflects its new width  -> changed node crossed in FULL (not a
 *     stale false-ref)
 *   - an UNCHANGED row still measures with the SAME, valid geometry after the delta ->
 *     its ref'd subtree survived reconstruction (wasn't dropped or shifted)
 *
 * Run with RNGPUI_ANIM_TRACE=1 to also see `applyTree bytes=N` per commit: a large full
 * first commit, then a small delta — the measured win.
 *
 *   bun run scripts/run-hermes-example.mjs examples/delta-conformance.tsx --timeout-ms 8000
 */
import { useEffect, useRef, useState } from "react";
import { findNodeHandle, render, Text, View } from "../src/index";

const ROWS = 120;

// IMPORTANT: stable (module-level) style refs. The delta only shrinks the wire when
// unchanged rows keep referentially-equal props across renders — then the reconciler
// reuses their cached SerializedNode and toWireDelta emits a ref. Inline `style={{...}}`
// objects are new refs every render, so React updates every row and nothing memoizes
// (the whole tree re-serializes full). The real app gets this stability from its
// selection-store / memo work; this fixture mirrors it.
const CONTAINER = { flex: 1, padding: 8, backgroundColor: "#11151c" } as const;
const ROW = { width: 80, height: 20, backgroundColor: "#223344" } as const;
const TEXT = { color: "#cdd6f4" } as const;

type MeasureRef = {
    measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => void;
};
type Rect = { x: number; y: number; width: number; height: number };

function wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
function measure(node: MeasureRef, label: string): Promise<Rect> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timeout`)), 1500);
        node.measureInWindow((x, y, width, height) => {
            clearTimeout(t);
            resolve({ x, y, width, height });
        });
    });
}
function fail(msg: string): never {
    console.error(`CONFORMANCE delta FAIL ${msg}`);
    process.exit(1);
}

function App() {
    const [n, setN] = useState(0);
    const changedRef = useRef<MeasureRef | null>(null);
    const stableRef = useRef<MeasureRef | null>(null);

    useEffect(() => {
        async function run() {
            await wait(60);
            const changed = changedRef.current;
            const stable = stableRef.current;
            if (!changed || !stable) fail("refs missing");
            if (findNodeHandle(changed) == null) fail("changed handle missing");

            const changedBefore = await measure(changed, "changed before");
            const stableBefore = await measure(stable, "stable before");
            if (changedBefore.width <= 0 || stableBefore.width <= 0) {
                fail(`zero geometry before: ${JSON.stringify({ changedBefore, stableBefore })}`);
            }
            if (Math.round(changedBefore.width) !== 100) {
                fail(`changed initial width ${changedBefore.width} != 100`);
            }

            // mutate exactly one row -> forces a re-commit emitted as a DELTA.
            setN(1);
            await wait(80);

            const changedAfter = await measure(changed, "changed after");
            const stableAfter = await measure(stable, "stable after");

            // changed row must reflect its new width -> it crossed in FULL, not a stale ref.
            if (Math.round(changedAfter.width) !== 240) {
                fail(`changed row width ${changedAfter.width} != 240 after delta (stale false-ref?)`);
            }
            // unchanged row must survive the delta with identical, valid geometry.
            if (stableAfter.width <= 0 || stableAfter.height <= 0) {
                fail(`unchanged row vanished after delta: ${JSON.stringify(stableAfter)}`);
            }
            if (
                Math.round(stableAfter.x) !== Math.round(stableBefore.x) ||
                Math.round(stableAfter.y) !== Math.round(stableBefore.y) ||
                Math.round(stableAfter.width) !== Math.round(stableBefore.width)
            ) {
                fail(`unchanged row moved after delta: ${JSON.stringify({ stableBefore, stableAfter })}`);
            }

            console.log(
                `CONFORMANCE delta PASS rows=${ROWS} changed=${changedBefore.width}->${changedAfter.width} ` +
                    `stable=(${Math.round(stableAfter.x)},${Math.round(stableAfter.y)},${Math.round(stableAfter.width)})`,
            );
            process.exit(0);
        }
        run().catch((e) => fail(e instanceof Error ? e.message : String(e)));
    }, []);

    const rows = [];
    for (let i = 0; i < ROWS; i++) {
        // row 0 changes width on update; row 1 is the unchanged probe; rest are filler.
        // unchanged rows reuse the SAME style ref (ROW) so they memoize -> emitted as refs.
        const ref = i === 0 ? changedRef : i === 1 ? stableRef : undefined;
        const style = i === 0 ? { width: 100 + n * 140, height: 20, backgroundColor: "#223344" } : ROW;
        rows.push(
            <View key={i} ref={ref as never} style={style}>
                <Text style={TEXT}>{i === 0 ? `row 0 v${n}` : `row ${i}`}</Text>
            </View>,
        );
    }
    return <View style={CONTAINER}>{rows}</View>;
}

render(<App />, { width: 400, height: 360 });
