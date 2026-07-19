import type { SerializedNode } from "./runtime";

const sourceFileIds = new Map<string, number>();
const announcedSourceFileIds = new Set<number>();
let nextSourceId = 1;

// Delta wire. The reconciler memoizes serialization — an unchanged subtree re-emits the
// SAME SerializedNode object, and any change dirties the node AND its ancestors
// (markSerializeDirty). So a node whose object the host already holds means its whole
// subtree is unchanged: emit a tiny `{ globalId, ref: true }` ref instead of re-crossing
// it. The host (parse_json_tree) reuses the prior Arc for refs (structural sharing). This
// turns a one-session change from re-stringifying/parsing ~all nodes into the changed
// path + cheap refs. `sent` is a WeakSet of the exact objects the host currently holds
// (per root); membership tests the CURRENT cached object, so a changed node (new object)
// is never a false ref. The root is always a fresh object, so it's always sent in full.
export type WireDeltaStats = { refs: number; full: number };

// Big-field interning. A node whose OBJECT changed (a new SerializedNode) can't ride the
// node-level ref above, so it re-crosses in full — including large static fields that did
// NOT change. The felt case: a timeline WebView carries its ~45KB shell html in `text`;
// switching tabs flips only its focus nativeID, so the node is a new object but its 45KB
// text is byte-identical, and the full node (text included) re-crosses every switch. So we
// intern the big `text`/`src` per globalId: when a changed node's big field equals what the
// host already holds, omit it and mark `textRef`/`srcRef`; the host reuses its prior value
// via the SAME PRIOR_TREE_INDEX the node-level ref uses. Only genuinely large fields
// participate — small text/placeholder/name always cross full (cheap, zero risk). Correct
// by construction: we only ref a value we previously SENT for that id (so the host holds
// it); an LRU miss just re-sends it once. A bounded LRU keeps a long session's retired
// webview ids from accumulating their 45KB strings.
const BIG_FIELD_MIN = 1024;
const BIG_FIELD_LRU = 128;
type BigFields = { text?: string; src?: string };
export type BigFieldCache = Map<number, BigFields>;

function rememberBig(cache: BigFieldCache, id: number, fields: BigFields) {
    // move-to-front on write so the LRU evicts the least-recently-sent id.
    cache.delete(id);
    cache.set(id, fields);
    if (cache.size > BIG_FIELD_LRU) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
}

export function toWireDelta(
    node: SerializedNode,
    sent: WeakSet<SerializedNode>,
    big: BigFieldCache,
    stats?: WireDeltaStats,
): SerializedNode {
    const sources: Record<string, string> = {};
    const wire = toWireDeltaInner(node, sent, big, sources, stats);
    return Object.keys(sources).length > 0 ? { ...wire, sources } : wire;
}

function toWireDeltaInner(
    node: SerializedNode,
    sent: WeakSet<SerializedNode>,
    big: BigFieldCache,
    sources: Record<string, string>,
    stats?: WireDeltaStats,
): SerializedNode {
    if (sent.has(node)) {
        if (stats) stats.refs++;
        return { globalId: node.globalId, ref: true };
    }
    if (stats) stats.full++;
    sent.add(node);
    const source = node.source;
    const kids = node.children;
    let wire = kids?.length
        ? { ...node, children: kids.map((kid) => toWireDeltaInner(kid, sent, big, sources, stats)) }
        : node;
    wire = internBigFields(node, wire, big);
    if (source) {
        const match = /^(.*):(\d+):(\d+)$/.exec(source);
        if (!match) throw new Error(`invalid rngsSource location: ${source}`);
        const [, file, line, column] = match;
        let sourceFileId = sourceFileIds.get(file);
        if (sourceFileId === undefined) {
            sourceFileId = nextSourceId++;
            sourceFileIds.set(file, sourceFileId);
        }
        if (!announcedSourceFileIds.has(sourceFileId)) {
            announcedSourceFileIds.add(sourceFileId);
            sources[String(sourceFileId)] = file;
        }
        const { source: _source, ...withoutSource } = wire;
        wire = { ...withoutSource, sourceId: [sourceFileId, Number(line), Number(column)] };
    }
    return wire;
}

// Omit a changed node's large `text`/`src` when it equals what the host already holds for
// this id, marking it `textRef`/`srcRef` so the host reuses its prior value. `wire` may be
// `node` itself (leaf, no clone) — always shallow-copy before deleting a field so the
// memoized source node is never mutated.
function internBigFields(node: SerializedNode, wire: SerializedNode, big: BigFieldCache): SerializedNode {
    const text = typeof node.text === "string" && node.text.length >= BIG_FIELD_MIN ? node.text : undefined;
    const src = typeof node.src === "string" && node.src.length >= BIG_FIELD_MIN ? node.src : undefined;
    if (text === undefined && src === undefined) {
        // no big fields on this node — stop tracking it (it may have dropped a big field,
        // e.g. a webview switching from html to a small uri) so a later value never false-refs.
        if (big.has(node.globalId)) big.delete(node.globalId);
        return wire;
    }
    const prior = big.get(node.globalId);
    let out = wire;
    // next = exactly what the host will hold for this id after this commit, so the JS cache
    // mirrors host state: a ref'd field keeps its prior value, a sent field takes the new one.
    const next: BigFields = {};
    if (text !== undefined) {
        if (prior?.text === text) {
            if (out === node) out = { ...node };
            delete out.text;
            out.textRef = true;
        }
        next.text = text;
    }
    if (src !== undefined) {
        if (prior?.src === src) {
            if (out === node) out = { ...node };
            delete out.src;
            out.srcRef = true;
        }
        next.src = src;
    }
    rememberBig(big, node.globalId, next);
    return out;
}
