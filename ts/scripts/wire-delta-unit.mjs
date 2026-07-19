#!/usr/bin/env bun
/**
 * pure-js unit test for the delta wire (toWireDelta). no gpui capture — runs in
 * milliseconds, sandbox-safe. mirrors the reconciler's serialization memoization:
 * an unchanged subtree re-emits the SAME SerializedNode object; any change produces a
 * NEW object for that node AND its ancestors (markSerializeDirty). toWireDelta must
 * therefore emit `{ globalId, ref: true }` for objects the host already holds and full
 * nodes for new (changed) ones — never a false ref for a changed node.
 *
 * Also covers big-field interning: a CHANGED node (new object) whose large `text`/`src`
 * is byte-identical to what the host already holds must omit that field and mark
 * `textRef`/`srcRef` so the host reuses its prior value (the webview-shell re-cross fix).
 */

const { toWireDelta } = await import("../src/wire-delta.ts");

let failed = false;
function check(name, ok, detail = "") {
    console.log(`UNIT_${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
    if (!ok) failed = true;
}
const isRef = (n) => n && n.ref === true && n.type === undefined;
const isFull = (n) => n && n.ref === undefined && typeof n.type === "string";
const newBig = () => new Map();

// stable "cached" leaf objects (re-used across commits unless changed).
const leaf1 = { globalId: 1, type: "div" };
const leaf2 = { globalId: 2, type: "text", text: "a" };
const parent = { globalId: 3, type: "div", children: [leaf2] };

const sent = new WeakSet();
const bigCache = newBig();

// --- commit 1: first send → everything full, no refs --------------------------
{
    const root = { globalId: 0, type: "div", children: [leaf1, parent] };
    const wire = toWireDelta(root, sent, bigCache);
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
    const wire = toWireDelta(root, sent, bigCache);
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
    toWireDelta({ globalId: 99, type: "div", children: [parentB] }, sent, bigCache);
    // ...then a fresh root carrying the now-known leaf1 + parentB → both refs.
    const root = { globalId: 0, type: "div", children: [leaf1, parentB] };
    const wire = toWireDelta(root, sent, bigCache);
    check("c3 all unchanged children → refs", isRef(wire.children[0]) && isRef(wire.children[1]));
}

// --- refs are minimal (globalId + ref only; no payload re-crossed) -------------
{
    const s = new WeakSet();
    const big = newBig();
    const node = { globalId: 7, type: "div", style: { x: 1 }, events: ["press"] };
    toWireDelta(node, s, big); // first send (full)
    const ref = toWireDelta(node, s, big); // second send (ref)
    check("ref carries only globalId+ref", isRef(ref) && Object.keys(ref).sort().join(",") === "globalId,ref");
}

// --- big-field interning: a webview's ~45KB shell text on a node that CHANGED for an
//     unrelated reason (its focus nativeID flipped) must not re-cross ------------------
{
    const s = new WeakSet();
    const big = newBig();
    const BIG = "x".repeat(45784); // like the 45.7KB timeline shell html
    const BIG2 = "y".repeat(45784);

    // first send: big text crosses in full, no ref marker.
    const wv1 = { globalId: 5, type: "webview", text: BIG, accessibility: { nativeID: "stage-webview" } };
    const w1 = toWireDelta({ globalId: 4, type: "div", children: [wv1] }, s, big);
    check("intern first send → text full, no textRef", w1.children[0].text === BIG && w1.children[0].textRef === undefined);

    // the tab-switch case: node is a NEW object (nativeID flipped) but text is identical →
    // omit text, mark textRef; the ONE changed field still crosses.
    const wv2 = { globalId: 5, type: "webview", text: BIG, accessibility: { nativeID: "stage-webview:tab:1" } };
    const w2 = toWireDelta({ globalId: 4, type: "div", children: [wv2] }, s, big);
    const c2 = w2.children[0];
    check("intern unchanged big text on changed node → textRef", c2.textRef === true && c2.text === undefined);
    check("intern still crosses the changed field", c2.accessibility?.nativeID === "stage-webview:tab:1");
    check("intern shrinks the wire", JSON.stringify(c2).length < 2000);
    check("intern does not mutate the source node", wv2.text === BIG && wv2.textRef === undefined);

    // genuine text change → full text again, no textRef.
    const wv3 = { globalId: 5, type: "webview", text: BIG2, accessibility: { nativeID: "stage-webview" } };
    const w3 = toWireDelta({ globalId: 4, type: "div", children: [wv3] }, s, big);
    check("intern changed big text → full (no false textRef)", w3.children[0].text === BIG2 && w3.children[0].textRef === undefined);

    // same (new) text again → textRef, proving the cache re-primed on the change.
    const wv4 = { globalId: 5, type: "webview", text: BIG2, accessibility: { nativeID: "z" } };
    const w4 = toWireDelta({ globalId: 4, type: "div", children: [wv4] }, s, big);
    check("intern re-primes after a change → textRef again", w4.children[0].textRef === true);

    // big → small transition: a webview swapping html for a tiny uri sends the small text
    // full (never a stale textRef); a later big value is then full, not a false ref.
    const wv5 = { globalId: 5, type: "webview", text: "small", accessibility: { nativeID: "z" } };
    const w5 = toWireDelta({ globalId: 4, type: "div", children: [wv5] }, s, big);
    check("intern big→small → small text crosses full", w5.children[0].text === "small" && w5.children[0].textRef === undefined);
    const wv6 = { globalId: 5, type: "webview", text: BIG, accessibility: { nativeID: "z2" } };
    const w6 = toWireDelta({ globalId: 4, type: "div", children: [wv6] }, s, big);
    check("intern small→big → full (no stale ref after a drop)", w6.children[0].text === BIG && w6.children[0].textRef === undefined);
}

// --- src interning (image/webview uri) mirrors text ----------------------------------
{
    const s = new WeakSet();
    const big = newBig();
    const SRC = "data:image/png;base64," + "A".repeat(4096);
    const img1 = { globalId: 8, type: "image", src: SRC, style: { opacity: 1 } };
    toWireDelta({ globalId: 6, type: "div", children: [img1] }, s, big);
    const img2 = { globalId: 8, type: "image", src: SRC, style: { opacity: 0.5 } }; // style changed, src same
    const w = toWireDelta({ globalId: 6, type: "div", children: [img2] }, s, big);
    check("intern unchanged src on changed node → srcRef", w.children[0].srcRef === true && w.children[0].src === undefined);
}

// --- LRU eviction is SAFE: an evicted id re-sends full (never a wrong ref), a still-
//     cached id refs. bound is 128; drive 130 distinct big-text ids then re-touch --------
{
    const s = new WeakSet();
    const big = newBig();
    const BIG = "b".repeat(2048);
    // send ids 1000..1129 (130 > LRU cap 128) so ids 1000,1001 fall out of the cache.
    for (let i = 0; i < 130; i++) {
        toWireDelta({ globalId: 2000 + i, type: "webview", text: BIG }, s, big);
    }
    // id 2000 was evicted from the JS cache → a changed re-send must be FULL (safe), not a
    // textRef the host couldn't resolve.
    const evicted = toWireDelta({ globalId: 2000, type: "webview", text: BIG, accessibility: { nativeID: "a" } }, s, big);
    check("LRU evicted id → full (safe, no unresolved textRef)", evicted.text === BIG && evicted.textRef === undefined);
    // id 2129 is still cached → a changed re-send refs its text.
    const cached = toWireDelta({ globalId: 2129, type: "webview", text: BIG, accessibility: { nativeID: "a" } }, s, big);
    check("LRU still-cached id → textRef", cached.textRef === true && cached.text === undefined);
}

// --- authored source locations are interned once across repeated nodes ----------
{
    const s = new WeakSet();
    const big = newBig();
    const source = "/workspace/src/RepeatedRow.tsx:42:9";
    const root = {
        globalId: 100,
        type: "div",
        children: [
            { globalId: 101, type: "div", source },
            { globalId: 102, type: "div", source },
        ],
    };
    const wire = toWireDelta(root, s, big);
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

    const next = toWireDelta({ globalId: 103, type: "div", source }, s, big);
    check("known source is not announced again", next.sources === undefined && next.source === undefined);
}

console.log(failed ? "WIRE_DELTA_UNIT_FAIL" : "WIRE_DELTA_UNIT_OK");
process.exit(failed ? 1 : 0);
