// Selector resolution for the `rngpui` CLI, modeled on sootsim's tap-id / tap-text
// ergonomics. A selector is one of:
//   #<globalId>      exact node id
//   <substring>      case-insensitive substring match on testID / accessibility
//                    identifier / nativeID / label / text / type (in that priority)
//   <x>,<y>          a literal window-coordinate point (handled by the caller)
//
// Resolution prefers the SMALLEST visible matching node (the most specific target),
// matching how a human reads "the composer input" as the input itself, not its
// container.

import type { DumpNode } from "./host";

export type ResolvedNode = {
    node: DumpNode;
    matchedField: string;
    matchedValue: string;
};

export function parsePoint(selector: string): { x: number; y: number } | null {
    const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(selector.trim());
    if (!m) return null;
    return { x: Number(m[1]), y: Number(m[2]) };
}

export function isVisible(node: DumpNode): boolean {
    const b = node.bounds;
    return !!b && b.width > 0.5 && b.height > 0.5;
}

function fieldsOf(node: DumpNode): Array<{ field: string; value: string }> {
    const out: Array<{ field: string; value: string }> = [];
    const a = node.accessibility ?? {};
    if (a.testID) out.push({ field: "testID", value: a.testID });
    if (a.identifier) out.push({ field: "identifier", value: a.identifier });
    if (a.nativeID) out.push({ field: "nativeID", value: a.nativeID });
    if (a.label) out.push({ field: "label", value: a.label });
    if (typeof node.text === "string" && node.text.trim()) out.push({ field: "text", value: node.text });
    if (typeof node.value === "string" && node.value.trim()) out.push({ field: "value", value: node.value });
    out.push({ field: "type", value: node.type });
    return out;
}

function area(node: DumpNode): number {
    const b = node.bounds;
    return b ? b.width * b.height : Infinity;
}

export function* walk(root: DumpNode): Generator<DumpNode> {
    yield root;
    for (const child of root.children ?? []) yield* walk(child);
}

export function findById(root: DumpNode, id: number): DumpNode | null {
    for (const node of walk(root)) if (node.globalId === id) return node;
    return null;
}

// Resolve a selector to the best-matching node. Ranks by field priority (testID >
// identifier > nativeID > label > text > value > type), then prefers visible nodes,
// then the smallest area (most specific). Returns all candidates for diagnostics.
export function resolve(root: DumpNode, selector: string): { best: ResolvedNode | null; candidates: ResolvedNode[] } {
    if (selector.startsWith("#")) {
        const id = Number(selector.slice(1));
        const node = Number.isFinite(id) ? findById(root, id) : null;
        const best = node ? { node, matchedField: "globalId", matchedValue: String(id) } : null;
        return { best, candidates: best ? [best] : [] };
    }

    const needle = selector.toLowerCase();
    const fieldRank: Record<string, number> = {
        testID: 0,
        identifier: 1,
        nativeID: 2,
        label: 3,
        text: 4,
        value: 5,
        type: 6,
    };

    const candidates: Array<ResolvedNode & { rank: number; exact: boolean }> = [];
    for (const node of walk(root)) {
        for (const { field, value } of fieldsOf(node)) {
            const v = value.toLowerCase();
            if (v.includes(needle)) {
                candidates.push({
                    node,
                    matchedField: field,
                    matchedValue: value,
                    rank: fieldRank[field] ?? 9,
                    exact: v === needle,
                });
                break; // one match per node, highest-priority field
            }
        }
    }

    candidates.sort((a, b) => {
        // exact match beats substring
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        // higher-priority field
        if (a.rank !== b.rank) return a.rank - b.rank;
        // visible beats not
        const av = isVisible(a.node) ? 0 : 1;
        const bv = isVisible(b.node) ? 0 : 1;
        if (av !== bv) return av - bv;
        // smallest area (most specific)
        return area(a.node) - area(b.node);
    });

    const best = candidates[0] ? { node: candidates[0].node, matchedField: candidates[0].matchedField, matchedValue: candidates[0].matchedValue } : null;
    return { best, candidates: candidates.map((c) => ({ node: c.node, matchedField: c.matchedField, matchedValue: c.matchedValue })) };
}

// Topmost node at a window point: the deepest visible node whose bounds contain the
// point, breaking ties by paint order (later child = on top) and z-index. Mirrors the
// native inspector hit-test the `do tap` driver uses on the Rust side.
export function nodeAtPoint(root: DumpNode, x: number, y: number): DumpNode | null {
    let best: { node: DumpNode; depth: number; z: number } | null = null;
    const visit = (node: DumpNode, depth: number) => {
        if (!isVisible(node)) {
            // still descend — a zero-area wrapper can hold visible children
        } else {
            const b = node.bounds!;
            if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
                const z = Number((node.style?.zIndex as number) ?? 0);
                if (!best || depth > best.depth || (depth === best.depth && z >= best.z)) {
                    best = { node, depth, z };
                }
            }
        }
        for (const child of node.children ?? []) visit(child, depth + 1);
    };
    visit(root, 0);
    return best ? (best as { node: DumpNode }).node : null;
}

export function centerOf(node: DumpNode): { x: number; y: number } | null {
    const b = node.bounds;
    if (!b) return null;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
