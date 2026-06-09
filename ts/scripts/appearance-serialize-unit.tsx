// Regression unit for the appearance → serialization-cache interaction (the
// "divider stays dark after macOS reports light" bug). DynamicColorIOS resolves
// against the CURRENT scheme at serialize time, so a scheme change must
// invalidate every memoized SerializedNode — including nodes whose props never
// change (React.memo + module-constant styles) and which therefore never dirty
// through the normal commit path.
//
// Drives the REAL createRoot → reconciler → serialize → delta-wire path headlessly
// (bun, no window): __rngpui_applyTree is stubbed to capture every wire payload.
import assert from "node:assert";
import { memo, useEffect, useState } from "react";

const applied: string[] = [];
(globalThis as unknown as { __rngpui_applyTree: (json: string) => void }).__rngpui_applyTree = (
    json: string,
) => {
    applied.push(json);
};

const { render } = await import("../src/render.ts");
const { DynamicColorIOS, applyNativeColorScheme } = await import("../src/colors.ts");
const { View } = await import("../src/components.tsx");

const CHROME = {
    width: 8,
    height: 100,
    backgroundColor: DynamicColorIOS({ light: "#eeeeff", dark: "#111122" }),
};

// memoized + constant props: never re-renders, never dirties — the bug shape.
const Divider = memo(function Divider() {
    return <View testID="divider" style={CHROME} />;
});

let bumpCounter: () => void = () => {};
function App() {
    const [n, setN] = useState(0);
    useEffect(() => {
        bumpCounter = () => setN((v) => v + 1);
    }, []);
    return (
        <View style={{ width: 200, height: 200 }} testID={`root-${n}`}>
            <Divider />
        </View>
    );
}

type WireNode = {
    globalId: number;
    ref?: boolean;
    style?: Record<string, unknown>;
    children?: WireNode[];
    testID?: string;
};

// testID only crosses the wire under inspector mode, so locate the divider by its
// resolved tint instead (unique in this fixture).
function findByBackground(node: WireNode, color: string): WireNode | null {
    if (node.style?.backgroundColor === color) return node;
    for (const child of node.children ?? []) {
        const hit = findByBackground(child, color);
        if (hit) return hit;
    }
    return null;
}

function findById(node: WireNode, globalId: number): WireNode | null {
    if (node.globalId === globalId) return node;
    for (const child of node.children ?? []) {
        const hit = findById(child, globalId);
        if (hit) return hit;
    }
    return null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

render(<App />, { width: 200, height: 200 });
await wait(50);

// 1. boot default is dark (no host-injected scheme here) → dark-resolved tint.
assert.ok(applied.length >= 1, "initial commit crossed the wire");
const first = JSON.parse(applied[applied.length - 1]) as WireNode;
const divider = findByBackground(first, "#111122");
assert.ok(divider, "boot scheme (dark) resolved the dark tint on the divider");
const dividerId = divider!.globalId;

// 2. an unrelated parent commit leaves the memoized divider untouched: it must
//    cross as a delta ref (proves it is cache-stable, i.e. the bug's precondition).
const beforeBump = applied.length;
bumpCounter();
await wait(50);
assert.ok(applied.length > beforeBump, "parent state change committed");
const bumped = JSON.parse(applied[applied.length - 1]) as WireNode;
const bumpedDivider = findById(bumped, dividerId);
assert.ok(bumpedDivider, "divider present in delta");
assert.equal(bumpedDivider!.ref, true, "unchanged memoized divider crossed as a ref");

// 3. THE BUG: the scheme flips to light. The divider's props never changed, but its
//    cached serialization holds the dark-resolved color — the appearance sink must
//    invalidate caches so it re-crosses IN FULL with the light-resolved color.
const beforeScheme = applied.length;
applyNativeColorScheme("light");
await wait(50);
assert.ok(applied.length > beforeScheme, "appearance change re-committed the tree");
const light = JSON.parse(applied[applied.length - 1]) as WireNode;
const lightDivider = findById(light, dividerId);
assert.ok(lightDivider, "divider present after scheme change");
assert.notEqual(lightDivider!.ref, true, "scheme change must invalidate the divider's cache (no stale ref)");
assert.equal(
    lightDivider!.style?.backgroundColor,
    "#eeeeff",
    "scheme change re-resolved the divider's DynamicColor to light",
);

// 4. and the memo still works afterwards: another unrelated commit refs the divider again.
const beforeBump2 = applied.length;
bumpCounter();
await wait(50);
assert.ok(applied.length > beforeBump2, "post-scheme parent state change committed");
const bumped2 = JSON.parse(applied[applied.length - 1]) as WireNode;
const bumpedDivider2 = findById(bumped2, dividerId);
assert.ok(bumpedDivider2, "divider present in post-scheme delta");
assert.equal(bumpedDivider2!.ref, true, "memo resumes (ref) after the one-shot invalidation");

console.log("APPEARANCE_SERIALIZE_UNIT_PASS scheme change invalidates serialize caches; memo + delta intact");
process.exit(0);
