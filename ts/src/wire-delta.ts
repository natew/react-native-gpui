import type { SerializedNode } from "./runtime";

// Delta wire. The reconciler memoizes serialization — an unchanged subtree re-emits the
// SAME SerializedNode object, and any change dirties the node AND its ancestors
// (markSerializeDirty). So a node whose object the host already holds means its whole
// subtree is unchanged: emit a tiny `{ globalId, ref: true }` ref instead of re-crossing
// it. The host (parse_json_tree) reuses the prior Arc for refs (structural sharing). This
// turns a one-session change from re-stringifying/parsing ~all nodes into the changed
// path + cheap refs. `sent` is a WeakSet of the exact objects the host currently holds
// (per root); membership tests the CURRENT cached object, so a changed node (new object)
// is never a false ref. The root is always a fresh object, so it's always sent in full.
export function toWireDelta(node: SerializedNode, sent: WeakSet<SerializedNode>): SerializedNode {
    if (sent.has(node)) return { globalId: node.globalId, ref: true };
    sent.add(node);
    const kids = node.children;
    if (!kids || kids.length === 0) return node;
    return { ...node, children: kids.map((k) => toWireDelta(k, sent)) };
}
