// `rngpui shot` / `reshot` / `diff` — the fast one-shot iteration loop.
//
// shot: launch a bundle/fixture offscreen, wait for a stable frame, write png + tree,
//       then print the png path + key measurements (bounds + sampled color of every
//       --select'd node) in ONE command. No flag archaeology — the output tells you
//       what to look at next.
// reshot: re-capture an already-running kept session (`rngpui dev` keeps one alive)
//       in sub-second time — no relaunch, no re-bundle.
// diff: compare two pngs, print the changed-pixel ratio + the bounding box of the
//       change, and (optionally) write a magenta-on-gray highlight png.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { DumpNode, Host, LaunchedHost } from "../host";
import { attachSession, launchHost } from "../host";
import { isVisible, resolve as resolveSelector, walk } from "../selectors";
import { averageColor, dominantColor } from "../../scripts/pixel.mjs";
import { decodePng, encodePng, readPng } from "../../scripts/png.mjs";

export type ShotFlags = {
    json: boolean;
    size?: string;
    appearance?: string;
    out?: string;
    select: string[];
    crop?: string;
    fixture: boolean;
    session?: string;
    bundle?: string;
    launch?: string;
    keep: boolean;
};

// the agentbus app paints an empty "connecting…" shell without data; the fixture
// env loads deterministic demo sessions so an offscreen shot shows the real layout.
// honored by both the agentbus bundle and rngpui examples (which simply ignore it).
function shotEnv(flags: ShotFlags): Record<string, string> {
    const env: Record<string, string> = {};
    if (flags.fixture) env.AGENTBUS_FIXTURE_ONLY = "1";
    if (flags.appearance === "light" || flags.appearance === "dark") {
        // native bridge theme (flips tamagui via the appearance event) AND the JS-side
        // capture entries — covers the agentbus bundle and the parity/capture fixtures.
        env.RNGPUI_FORCE_APPEARANCE = flags.appearance;
        env.AGENTBUS_CAPTURE_APPEARANCE = flags.appearance;
    }
    return env;
}

function nodeLabel(node: DumpNode): string {
    const a = node.accessibility ?? {};
    return a.testID ?? a.identifier ?? a.nativeID ?? a.label ?? (node.text ? `"${node.text.slice(0, 24)}"` : `#${node.globalId}`);
}

function boundsStr(b: DumpNode["bounds"]): string {
    return b ? `${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)}` : "—";
}

function matchNodes(dump: DumpNode, selector: string): DumpNode[] {
    const { best, candidates } = resolveSelector(dump, selector);
    if (!best) return [];
    return candidates.filter((c) => c.matchedValue === best.matchedValue).map((c) => c.node);
}

type Measurement = {
    selector: string;
    matched: number;
    globalId: number | null;
    type: string | null;
    label: string | null;
    bounds: DumpNode["bounds"] | null;
    visible: boolean;
    dominant: string | null;
    average: string | null;
    coverage: number | null;
};

// sample a node's color out of the just-captured png (scaled from logical → pixel).
function sampleNodeFromPng(img: { width: number; height: number }, host: Host, node: DumpNode) {
    const b = node.bounds;
    if (!b || b.width < 1 || b.height < 1) return null;
    const scaleX = img.width / host.window.width;
    const scaleY = img.height / host.window.height;
    const rect = {
        x: Math.round(b.x * scaleX),
        y: Math.round(b.y * scaleY),
        width: Math.max(1, Math.round(b.width * scaleX)),
        height: Math.max(1, Math.round(b.height * scaleY)),
    };
    const dom = dominantColor(img as never, rect);
    const avg = averageColor(img as never, rect);
    return { dominant: dom.hex, average: avg.hex, coverage: dom.coverage };
}

function measureSelectors(host: Host, dump: DumpNode, png: string, selectors: string[]): Measurement[] {
    if (selectors.length === 0) return [];
    const img = existsSync(png) && statSync(png).size > 0 ? readPng(png) : null;
    return selectors.map((selector) => {
        const nodes = matchNodes(dump, selector);
        const node = nodes[0];
        if (!node) {
            return { selector, matched: 0, globalId: null, type: null, label: null, bounds: null, visible: false, dominant: null, average: null, coverage: null };
        }
        const color = img && isVisible(node) ? sampleNodeFromPng(img, host, node) : null;
        return {
            selector,
            matched: nodes.length,
            globalId: node.globalId,
            type: node.type,
            label: nodeLabel(node),
            bounds: node.bounds ?? null,
            visible: isVisible(node),
            dominant: color?.dominant ?? null,
            average: color?.average ?? null,
            coverage: color?.coverage ?? null,
        };
    });
}

// the whole point of shot: one block of output that tells a designer/agent exactly
// what they have and what to look at next — no second command, no flag hunting.
function printShot(result: ShotResult, json: boolean) {
    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(`  png: ${result.png}  (${result.pngSize})${result.appearance ? `  appearance=${result.appearance}` : ""}`);
    console.log(`  tree: ${result.tree}`);
    console.log(`  nodes=${result.nodes} visible=${result.visible} webviews=${result.webviews} window=${result.window}`);
    if (result.session) console.log(`  session: ${result.session}  (reshot with: rngpui reshot --session ${result.session})`);
    if (result.measurements.length) {
        console.log("  measurements:");
        for (const m of result.measurements) {
            if (m.matched === 0) {
                console.log(`    ${JSON.stringify(m.selector)} — no match`);
                continue;
            }
            const color = m.dominant ? `  dominant=${m.dominant} (${((m.coverage ?? 0) * 100).toFixed(0)}%) avg=${m.average}` : m.visible ? "" : "  [not painted]";
            const more = m.matched > 1 ? ` (+${m.matched - 1} more)` : "";
            console.log(`    ${JSON.stringify(m.selector)} → ${m.type} ${m.label} #${m.globalId} [${boundsStr(m.bounds)}]${color}${more}`);
        }
    }
}

type ShotResult = {
    png: string;
    pngSize: string;
    tree: string;
    nodes: number;
    visible: number;
    webviews: number;
    window: string;
    appearance: string | null;
    session: string | null;
    measurements: Measurement[];
};

// produce the png + tree + measurements for an already-attached/launched host.
function captureShot(host: Host, flags: ShotFlags, dump: DumpNode, session: string | null): ShotResult {
    const outPng = resolvePath(flags.out ?? "/tmp/rngpui-shot.png");
    const outTree = outPng.replace(/\.png$/i, ".tree.json");
    mkdirSync(dirname(outPng), { recursive: true });
    host.capture(outPng);
    writeFileSync(outTree, JSON.stringify(dump));
    const img = existsSync(outPng) ? readPng(outPng) : { width: 0, height: 0 };
    let nodes = 0;
    let visible = 0;
    let webviews = 0;
    for (const node of walk(dump)) {
        nodes += 1;
        if (isVisible(node)) visible += 1;
        if (node.type === "webview") webviews += 1;
    }
    return {
        png: outPng,
        pngSize: `${img.width}x${img.height}`,
        tree: outTree,
        nodes,
        visible,
        webviews,
        window: `${host.window.width}x${host.window.height}`,
        appearance: flags.appearance === "light" || flags.appearance === "dark" ? flags.appearance : null,
        session,
        measurements: measureSelectors(host, dump, outPng, flags.select),
    };
}

export async function runShot(flags: ShotFlags): Promise<number> {
    // reshot path: a kept session is already alive — re-capture in sub-second time.
    if (flags.session) {
        const host = await attachSession(flags.session);
        try {
            const dump = await host.dump();
            printShot(captureShot(host, flags, dump, flags.session), flags.json);
            return 0;
        } finally {
            host.close(); // keepOnClose: true for attached sessions, so this is a no-op for the process
        }
    }

    const target = flags.bundle ?? flags.launch;
    if (!target) {
        console.error("  shot needs --bundle <app.hbc>, --launch <entry.tsx>, or --session <dir>");
        return 1;
    }
    const env = shotEnv(flags);
    const prevEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        prevEnv[key] = process.env[key];
        process.env[key] = value;
    }
    let host: LaunchedHost | null = null;
    try {
        host = await launchHost(flags.launch ?? "", {
            bundle: flags.bundle,
            size: flags.size,
            keep: flags.keep,
        });
        const dump = await host.dump();
        const session = flags.keep ? host.sessionDir : null;
        printShot(captureShot(host, flags, dump, session), flags.json);
        return 0;
    } finally {
        host?.close();
        for (const [key, value] of Object.entries(prevEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

// ---- diff ----

type DiffResult = {
    before: string;
    after: string;
    width: number;
    height: number;
    changed: number;
    total: number;
    ratio: number;
    maxDelta: number;
    box: { x: number; y: number; width: number; height: number } | null;
    out: string | null;
};

export async function runDiff(positional: string[], flags: { json: boolean; out?: string; threshold?: number }): Promise<number> {
    const [beforePath, afterPath] = positional;
    if (!beforePath || !afterPath) {
        console.error("  usage: rngpui diff <before.png> <after.png> [--out highlight.png] [--threshold n]");
        return 1;
    }
    const before = decodePng(readFileSync(beforePath));
    const after = decodePng(readFileSync(afterPath));
    const width = Math.min(before.width, after.width);
    const height = Math.min(before.height, after.height);
    const threshold = flags.threshold ?? 24;
    const diff = Buffer.alloc(width * height * 4);
    let changed = 0;
    let maxDelta = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const bi = (y * before.width + x) * 4;
            const ai = (y * after.width + x) * 4;
            const oi = (y * width + x) * 4;
            const dr = Math.abs(before.rgba[bi] - after.rgba[ai]);
            const dg = Math.abs(before.rgba[bi + 1] - after.rgba[ai + 1]);
            const db = Math.abs(before.rgba[bi + 2] - after.rgba[ai + 2]);
            const da = Math.abs(before.rgba[bi + 3] - after.rgba[ai + 3]);
            const md = Math.max(dr, dg, db, da);
            if (md > maxDelta) maxDelta = md;
            if (md > threshold) {
                changed += 1;
                diff[oi] = 255;
                diff[oi + 1] = 0;
                diff[oi + 2] = 180;
                diff[oi + 3] = 255;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            } else {
                const gray = (after.rgba[ai] * 0.299 + after.rgba[ai + 1] * 0.587 + after.rgba[ai + 2] * 0.114) | 0;
                diff[oi] = gray;
                diff[oi + 1] = gray;
                diff[oi + 2] = gray;
                diff[oi + 3] = 255;
            }
        }
    }
    const total = width * height;
    const out = flags.out ? resolvePath(flags.out) : null;
    if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, encodePng(width, height, diff));
    }
    const box = maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
    const result: DiffResult = { before: beforePath, after: afterPath, width, height, changed, total, ratio: changed / total, maxDelta, box, out };
    if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(`  ${changed}/${total} px changed (${(result.ratio * 100).toFixed(3)}%)  maxDelta=${maxDelta}  threshold=${threshold}`);
        console.log(`  changed region: ${box ? `${box.x},${box.y} ${box.width}x${box.height}` : "(no change above threshold)"}`);
        if (out) console.log(`  highlight: ${out}  (magenta = changed, gray = unchanged)`);
    }
    return 0;
}
