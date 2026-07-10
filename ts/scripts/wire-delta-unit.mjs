#!/usr/bin/env bun
/**
 * pure-js unit test for the delta wire (toWireDelta). no gpui capture — runs in
 * milliseconds, sandbox-safe. mirrors the reconciler's serialization memoization:
 * an unchanged subtree re-emits the SAME SerializedNode object; any change produces a
 * NEW object for that node AND its ancestors (markSerializeDirty). toWireDelta must
 * therefore emit `{ globalId, ref: true }` for objects the host already holds and full
 * nodes for new (changed) ones — never a false ref for a changed node.
 */

const { toWireDelta } = await import("../src/wire-delta.ts");

let failed = false;
function check(name, ok, detail = "") {
    console.log(`UNIT_${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
    if (!ok) failed = true;
}
const isRef = (n) => n && n.ref === true && n.type === undefined;
const isFull = (n) => n && n.ref === undefined && typeof n.type === "string";

// stable "cached" leaf objects (re-used across commits unless changed).
const leaf1 = { globalId: 1, type: "div" };
const leaf2 = { globalId: 2, type: "text", text: "a" };
const parent = { globalId: 3, type: "div", children: [leaf2] };

const sent = new WeakSet();

// --- commit 1: first send → everything full, no refs --------------------------
{
    const root = { globalId: 0, type: "div", children: [leaf1, parent] };
    const wire = toWireDelta(root, sent);
    check("c1 root full", isFull(wire));
    check("c1 leaf1 full", isFull(wire.children[0]));
    check("c1 parent full", isFull(wire.children[1]));
    check("c1 nested leaf2 full", isFull(wire.children[1].children[0]));
    check("c1 no input mutation", root.children[0] === leaf1 && parent.children[0] === leaf2);
}

// --- commit 2: leaf2 changes → its parent + root get NEW objects; leaf1 unchanged
{
    const leaf2b = { globalId: 2, type: "text", text: "b" };
    const parentB = { globalId: 3, type: "div", children: [leaf2b] };
    const root = { globalId: 0, type: "div", children: [leaf1, parentB] };
    const wire = toWireDelta(root, sent);
    check("c2 root full (always)", isFull(wire));
    check("c2 unchanged leaf1 → ref", isRef(wire.children[0]) && wire.children[0].globalId === 1);
    check("c2 changed parent → full", isFull(wire.children[1]) && wire.children[1].globalId === 3);
    // the actually-changed leaf must be FULL (a false ref here = stale render bug).
    check(
        "c2 changed leaf2 → full (no false ref)",
        isFull(wire.children[1].children[0]) && wire.children[1].children[0].text === "b",
    );
}

// --- commit 3: nothing changed (same child objects, new root) → all children refs
{
    // parentB from c2 is now in `sent`; reuse the exact objects to model a no-op-ish
    // re-commit (e.g. an unrelated root-level rerender).
    const leaf2b = { globalId: 2, type: "text", text: "b" };
    const parentB = { globalId: 3, type: "div", children: [leaf2b] };
    // first register parentB/leaf2b by sending them once...
    toWireDelta({ globalId: 99, type: "div", children: [parentB] }, sent);
    // ...then a fresh root carrying the now-known leaf1 + parentB → both refs.
    const root = { globalId: 0, type: "div", children: [leaf1, parentB] };
    const wire = toWireDelta(root, sent);
    check("c3 all unchanged children → refs", isRef(wire.children[0]) && isRef(wire.children[1]));
}

// --- refs are minimal (globalId + ref only; no payload re-crossed) -------------
{
    const s = new WeakSet();
    const node = { globalId: 7, type: "div", style: { x: 1 }, events: ["press"] };
    toWireDelta(node, s); // first send (full)
    const ref = toWireDelta(node, s); // second send (ref)
    check("ref carries only globalId+ref", isRef(ref) && Object.keys(ref).sort().join(",") === "globalId,ref");
}

// --- authored source locations are interned once across repeated nodes ----------
{
    const s = new WeakSet();
    const source = "/workspace/src/RepeatedRow.tsx:42:9";
    const root = {
        globalId: 100,
        type: "div",
        children: [
            { globalId: 101, type: "div", source },
            { globalId: 102, type: "div", source },
        ],
    };
    const wire = toWireDelta(root, s);
    const encoded = JSON.stringify(wire);
    check(
        "repeated source file is defined once",
        Object.values(wire.sources ?? {}).filter((value) => value === "/workspace/src/RepeatedRow.tsx").length === 1 &&
            encoded.split("/workspace/src/RepeatedRow.tsx").length - 1 === 1,
    );
    check(
        "repeated nodes carry the same compact source id",
        wire.children[0].source === undefined &&
            JSON.stringify(wire.children[0].sourceId) === JSON.stringify(wire.children[1].sourceId) &&
            Array.isArray(wire.children[0].sourceId),
    );

    const next = toWireDelta({ globalId: 103, type: "div", source }, s);
    check("known source is not announced again", next.sources === undefined && next.source === undefined);
}

console.log(failed ? "WIRE_DELTA_UNIT_FAIL" : "WIRE_DELTA_UNIT_OK");
process.exit(failed ? 1 : 0);
