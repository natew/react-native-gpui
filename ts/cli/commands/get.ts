// `rngpui get …` — introspection commands. Everything here is read-only and reports
// what the node tree + a fresh pixel capture actually say, never a guess.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachedHost, DumpNode, LaunchedHost } from "../host";
import { isVisible, nodeAtPoint, parsePoint, resolve, walk } from "../selectors";
import { averageColor, dominantColor, pixelAt } from "../../scripts/pixel.mjs";
import { readPng } from "../../scripts/png.mjs";

type Host = LaunchedHost | AttachedHost;

function out(json: boolean, human: () => void, data: unknown) {
    if (json) console.log(JSON.stringify(data, null, 2));
    else human();
}

function shortId(node: DumpNode): string {
    const a = node.accessibility ?? {};
    return a.testID ?? a.identifier ?? a.nativeID ?? a.label ?? (node.text ? `"${node.text.slice(0, 24)}"` : `#${node.globalId}`);
}

function boundsStr(node: DumpNode): string {
    const b = node.bounds;
    return b ? `${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)}` : "—";
}

// Sample dominant + average color within a node's bounds from a fresh capture. The
// capture is the WindowServer composite (full-opacity), so this is the ACTUAL rendered
// color, including occlusion by native child windows (WebView) — the whole point.
function sampleNode(host: Host, node: DumpNode): { dominant: string; average: string; coverage: number } | null {
    const b = node.bounds;
    if (!b || b.width < 1 || b.height < 1) return null;
    const dir = mkdtempSync(join(tmpdir(), "rngpui-sample-"));
    const png = join(dir, "shot.png");
    try {
        host.capture(png);
        const img = readPng(png);
        const scaleX = img.width / host.window.width;
        const scaleY = img.height / host.window.height;
        const rect = {
            x: Math.round(b.x * scaleX),
            y: Math.round(b.y * scaleY),
            width: Math.max(1, Math.round(b.width * scaleX)),
            height: Math.max(1, Math.round(b.height * scaleY)),
        };
        const dom = dominantColor(img, rect);
        const avg = averageColor(img, rect);
        return { dominant: dom.hex, average: avg.hex, coverage: dom.coverage };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function renderTree(node: DumpNode, depth: number, lines: string[], filter?: (n: DumpNode) => boolean) {
    const indent = "  ".repeat(depth);
    const id = shortId(node);
    const ev = node.events?.length ? ` (${node.events.includes("press") || node.events.includes("click") ? "tap" : node.events[0]})` : "";
    const vis = isVisible(node) ? "" : " [hidden]";
    if (!filter || filter(node)) {
        lines.push(`${indent}${node.type} ${id !== `#${node.globalId}` ? id + " " : ""}#${node.globalId} [${boundsStr(node)}]${ev}${vis}`);
    }
    for (const child of node.children ?? []) renderTree(child, depth + 1, lines, filter);
}

export async function runGet(host: Host, sub: string, args: string[], json: boolean): Promise<number> {
    if (host.mode === "attach") {
        if (sub === "color") {
            const pt = parsePoint(args[0] ?? "");
            if (!pt) {
                console.error("  attached color sampling only supports a literal point: rngpui get color <x,y> --attach");
                return 1;
            }
            return getColorAtPoint(host, pt.x, pt.y, json);
        }
        if (sub === "point") {
            const pt = parsePoint(args[0] ?? "");
            if (!pt) {
                console.error("  usage: rngpui get point <x,y>");
                return 1;
            }
            const color = getColorSampleAtPoint(host, pt.x, pt.y);
            out(json, () => console.log(`  topmost: (attach has no tree)\n  pixel: ${color ?? "(unavailable)"}`), {
                point: pt,
                topmost: null,
                pixel: color,
            });
            return color ? 0 : 1;
        }
        console.error("  attached processes expose pixel capture only; use --launch, --bundle, or --session for tree introspection");
        return 1;
    }

    const dump = await host.dump();
    if (!dump) {
        console.error("  no tree available (attached process exposes no dump; use --launch <entry.tsx> for full introspection)");
        return 1;
    }

    switch (sub) {
        case "tree": {
            if (json) {
                console.log(JSON.stringify(dump, null, 2));
            } else {
                const lines: string[] = [];
                renderTree(dump, 0, lines);
                console.log(lines.join("\n"));
            }
            return 0;
        }

        case "describe": {
            const selector = args[0];
            const nodes: DumpNode[] = selector ? matchNodes(dump, selector) : [dump];
            if (nodes.length === 0) {
                console.error(`  no node matched "${selector}"`);
                return 1;
            }
            const results = nodes.slice(0, 8).map((node) => {
                const color = isVisible(node) ? sampleNode(host, node) : null;
                return {
                    globalId: node.globalId,
                    type: node.type,
                    testID: node.accessibility?.testID ?? null,
                    identifier: node.accessibility?.identifier ?? null,
                    nativeID: node.accessibility?.nativeID ?? null,
                    label: node.accessibility?.label ?? null,
                    text: node.text ?? null,
                    value: node.value ?? null,
                    events: node.events ?? [],
                    bounds: node.bounds ?? null,
                    visible: isVisible(node),
                    style: node.style ?? {},
                    sampledColor: color,
                };
            });
            out(
                json,
                () => {
                    for (const r of results) {
                        console.log(`  ${r.type} #${r.globalId}${r.testID ? ` testID=${r.testID}` : ""}${r.identifier ? ` id=${r.identifier}` : ""}${r.label ? ` label=${JSON.stringify(r.label)}` : ""}`);
                        if (r.text) console.log(`    text: ${JSON.stringify(r.text)}`);
                        console.log(`    bounds: ${r.bounds ? `${r.bounds.x.toFixed(0)},${r.bounds.y.toFixed(0)} ${r.bounds.width.toFixed(0)}x${r.bounds.height.toFixed(0)}` : "(not painted)"}  visible=${r.visible}`);
                        if (r.events.length) console.log(`    events: ${r.events.join(", ")}`);
                        const styleKeys = Object.keys(r.style);
                        if (styleKeys.length) console.log(`    style: ${styleKeys.map((k) => `${k}=${(r.style as Record<string, unknown>)[k]}`).join(" ")}`);
                        if (r.sampledColor) console.log(`    sampled: dominant=${r.sampledColor.dominant} (${(r.sampledColor.coverage * 100).toFixed(0)}%) average=${r.sampledColor.average}`);
                    }
                },
                results.length === 1 ? results[0] : results,
            );
            return 0;
        }

        case "layout": {
            const selector = args[0];
            const nodes = selector ? matchNodes(dump, selector) : [...walk(dump)].filter(isVisible);
            const rows = nodes.slice(0, 50).map((n) => ({ globalId: n.globalId, type: n.type, id: shortId(n), bounds: n.bounds ?? null, visible: isVisible(n) }));
            out(json, () => rows.forEach((r) => console.log(`  ${r.type} ${r.id} #${r.globalId} [${r.bounds ? `${r.bounds.x.toFixed(0)},${r.bounds.y.toFixed(0)} ${r.bounds.width.toFixed(0)}x${r.bounds.height.toFixed(0)}` : "—"}]`)), rows.length === 1 ? rows[0] : rows);
            return 0;
        }

        case "style": {
            const selector = args[0];
            if (!selector) {
                console.error("  usage: rngpui get style <selector>");
                return 1;
            }
            const nodes = matchNodes(dump, selector);
            if (nodes.length === 0) {
                console.error(`  no node matched "${selector}"`);
                return 1;
            }
            const rows = nodes.slice(0, 8).map((n) => ({ globalId: n.globalId, type: n.type, style: n.style ?? {} }));
            out(json, () => rows.forEach((r) => console.log(`  ${r.type} #${r.globalId}: ${JSON.stringify(r.style)}`)), rows.length === 1 ? rows[0] : rows);
            return 0;
        }

        case "color": {
            const selector = args[0];
            if (!selector) {
                console.error("  usage: rngpui get color <selector|x,y>");
                return 1;
            }
            const pt = parsePoint(selector);
            if (pt) return getColorAtPoint(host, pt.x, pt.y, json);
            const nodes = matchNodes(dump, selector);
            const node = nodes[0];
            if (!node) {
                console.error(`  no node matched "${selector}"`);
                return 1;
            }
            const color = sampleNode(host, node);
            if (!color) {
                console.error(`  node ${shortId(node)} #${node.globalId} is not painted (no bounds) — nothing to sample`);
                return 1;
            }
            out(json, () => console.log(`  ${shortId(node)} #${node.globalId} [${boundsStr(node)}]  dominant=${color.dominant} (${(color.coverage * 100).toFixed(0)}%) average=${color.average}`), { globalId: node.globalId, bounds: node.bounds, ...color });
            return 0;
        }

        case "point": {
            const pt = parsePoint(args[0] ?? "");
            if (!pt) {
                console.error("  usage: rngpui get point <x,y>");
                return 1;
            }
            const node = nodeAtPoint(dump, pt.x, pt.y);
            const color = getColorSampleAtPoint(host, pt.x, pt.y);
            out(
                json,
                () => {
                    if (node) console.log(`  topmost: ${node.type} ${shortId(node)} #${node.globalId} [${boundsStr(node)}]${node.events?.length ? ` (${node.events.join(",")})` : ""}`);
                    else console.log("  topmost: (no node at point)");
                    if (color) console.log(`  pixel: ${color}`);
                },
                {
                    point: pt,
                    topmost: node ? { globalId: node.globalId, type: node.type, id: shortId(node), bounds: node.bounds, events: node.events ?? [] } : null,
                    pixel: color,
                },
            );
            return 0;
        }

        default:
            console.error(`  unknown get subcommand: ${sub}`);
            console.error("  available: tree, describe, layout, style, color, point");
            return 1;
    }
}

function matchNodes(dump: DumpNode, selector: string): DumpNode[] {
    const { best, candidates } = resolve(dump, selector);
    if (!best) return [];
    // return the best plus any equally-named siblings (same matchedValue) for context.
    return candidates.filter((c) => c.matchedValue === best.matchedValue).map((c) => c.node);
}

function getColorSampleAtPoint(host: Host, x: number, y: number): string | null {
    const dir = mkdtempSync(join(tmpdir(), "rngpui-px-"));
    const png = join(dir, "shot.png");
    try {
        host.capture(png);
        const img = readPng(png);
        const scaleX = img.width / host.window.width;
        const scaleY = img.height / host.window.height;
        return pixelAt(img, Math.round(x * scaleX), Math.round(y * scaleY)).hex;
    } catch {
        return null;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function getColorAtPoint(host: Host, x: number, y: number, json: boolean): number {
    const hex = getColorSampleAtPoint(host, x, y);
    if (!hex) {
        console.error(`  could not sample pixel at ${x},${y}`);
        return 1;
    }
    out(json, () => console.log(`  ${x},${y}: ${hex}`), { x, y, hex });
    return 0;
}
