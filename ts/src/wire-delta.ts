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

export function toWireDelta(
    node: SerializedNode,
    sent: WeakSet<SerializedNode>,
    stats?: WireDeltaStats,
): SerializedNode {
    const sources: Record<string, string> = {};
    const wire = toWireDeltaInner(node, sent, sources, stats);
    return Object.keys(sources).length > 0 ? { ...wire, sources } : wire;
}

function toWireDeltaInner(
    node: SerializedNode,
    sent: WeakSet<SerializedNode>,
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
        ? { ...node, children: kids.map((kid) => toWireDeltaInner(kid, sent, sources, stats)) }
        : node;
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
