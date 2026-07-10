// regression unit for React host updates whose authored props are new objects but
// whose native output is unchanged. inline styles and callbacks are common in real
// component trees; they must refresh event handlers without re-crossing identical
// visual nodes through the Hermes -> GPUI bridge.
import assert from "node:assert";
import { useEffect, useState } from "react";

const applied: string[] = [];
(globalThis as unknown as { __rngpui_applyTree: (json: string) => void }).__rngpui_applyTree = (
    json: string,
) => {
    applied.push(json);
};

const { render } = await import("../src/render.ts");
const { dispatchEvent } = await import("../src/reconciler.ts");
const { Text, View } = await import("../src/components.tsx");

let bump: () => void = () => {};
let pressedVersion = -1;

function App() {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        bump = () => setVersion((value) => value + 1);
    }, []);

    return (
        <View style={{ width: 400, height: 400 }}>
            {Array.from({ length: 80 }, (_, index) => (
                <View
                    key={index}
                    testID={`row-${index}`}
                    onPress={() => {
                        pressedVersion = version;
                    }}
                    style={{
                        width: index === 0 ? 100 + version : 100,
                        height: 4,
                        backgroundColor: "#123456",
                    }}
                >
                    <Text style={{ color: "#ffffff" }}>{`row ${index}`}</Text>
                </View>
            ))}
        </View>
    );
}

type WireNode = {
    globalId: number;
    ref?: boolean;
    accessibility?: { testID?: string };
    children?: WireNode[];
};

function walk(node: WireNode, visit: (node: WireNode) => void) {
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
}

function rowIds(node: WireNode): Map<number, number> {
    const out = new Map<number, number>();
    walk(node, (candidate) => {
        const match = candidate.accessibility?.testID?.match(/^row-(\d+)$/);
        if (match) out.set(Number(match[1]), candidate.globalId);
    });
    return out;
}

function findById(node: WireNode, id: number): WireNode | undefined {
    if (node.globalId === id) return node;
    for (const child of node.children ?? []) {
        const found = findById(child, id);
        if (found) return found;
    }
    return undefined;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

render(<App />, { width: 400, height: 400 });
await wait(50);
const first = JSON.parse(applied.at(-1)!) as WireNode;
const ids = rowIds(first);
assert.equal(ids.size, 80, "initial tree contains every row");

const before = applied.length;
bump();
await wait(50);
assert.ok(applied.length > before, "the changed first row crosses a second commit");
const second = JSON.parse(applied.at(-1)!) as WireNode;

for (let index = 1; index < 80; index++) {
    const row = findById(second, ids.get(index)!);
    assert.equal(row?.ref, true, `visually unchanged row ${index} crosses as a ref`);
}

dispatchEvent(ids.get(1)!, "press", {});
assert.equal(pressedVersion, 1, "reused visual node still installs its newest event handler");

console.log("SEMANTIC_SERIALIZE_UNIT_PASS identical host output reuses cached wire nodes");
process.exit(0);
