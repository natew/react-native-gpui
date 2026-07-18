import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchHost } from "../cli/host.ts";
import { frontmostProcess, sleep } from "./conformance-utils.mjs";
import { hasContentionFlag, startPerfContention } from "./perf-contention.mjs";

const contentionMode = hasContentionFlag();
const FRAME_BUDGET_MS = contentionMode ? 1000 / 60 : 1000 / 120;
const SCROLL_STEPS = 48;

function flatten(node, out = []) {
    out.push(node);
    for (const child of node.children ?? []) flatten(child, out);
    return out;
}

function byTestId(tree, testID) {
    return flatten(tree).find((node) => node.accessibility?.testID === testID);
}

function percentile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function drawTimes(log) {
    return [...log.matchAll(/^\[draw\] ([0-9.]+)ms reuse=(true|false)$/gm)].map((match) => ({
        ms: Number(match[1]),
        reuse: match[2] === "true",
    }));
}

const previousService = process.env.RNGPUI_SERVICE;
process.env.RNGPUI_SERVICE = new URL("../../rust/target/release/rngpui-service", import.meta.url).pathname;
process.env.RNGPUI_DRAW_PROBE = "1";

const frontmostBefore = frontmostProcess();
let host;
let perfContention;
try {
    perfContention = await startPerfContention(contentionMode);
    host = await launchHost(new URL("../examples/scroll-performance-conformance.tsx", import.meta.url).pathname, {
        size: "900x700",
    });

    const beforeTree = await host.dump();
    const scroll = byTestId(beforeTree, "overview-scroll");
    const nestedInner = byTestId(beforeTree, "nested-inner");
    const anchorBefore = byTestId(beforeTree, "overview-row-020");
    if (!scroll?.bounds || !nestedInner?.bounds || !anchorBefore?.bounds) {
        throw new Error("fixture scroll bounds were not measured");
    }

    const center = (node) => ({
        x: node.bounds.x + node.bounds.width / 2,
        y: node.bounds.y + node.bounds.height / 2,
    });
    const point = center(scroll);
    const nestedStats = await host.request({ $cmd: "scrollDriverStats", ...center(nestedInner) });
    if (!nestedStats.ok || !nestedStats.hasVerticalScroller) {
        throw new Error(`default vertical overlay scroller was not enabled: ${JSON.stringify(nestedStats)}`);
    }
    const initial = await host.request({ $cmd: "scrollDriverStats", ...point, reset: true });
    if (!initial.ok || initial.driver !== "appkit") {
        throw new Error(`expected an AppKit scroll driver, got ${JSON.stringify(initial)}`);
    }
    if (initial.hasVerticalScroller) {
        throw new Error(`showsVerticalScrollIndicator=false still exposed a scroller: ${JSON.stringify(initial)}`);
    }

    const logPath = join(host.sessionDir, "service.log");
    const logStart = readFileSync(logPath, "utf8").length;
    for (let batch = 0; batch < SCROLL_STEPS / 4; batch++) {
        const results = await Promise.all(
            Array.from({ length: 4 }, () => host.request({ $cmd: "scrollAt", ...point, dx: 0, dy: 18 })),
        );
        const failed = results.find((result) => !result.ok);
        if (failed) throw new Error(`scroll batch ${batch} failed: ${JSON.stringify(failed)}`);
        await sleep(12);
    }
    await sleep(300);

    const log = readFileSync(logPath, "utf8").slice(logStart);
    const draws = drawTimes(log);
    if (draws.length < 8) throw new Error(`expected scroll draws, found ${draws.length}`);
    const p95 = percentile(draws.map((draw) => draw.ms), 0.95);
    if (p95 > FRAME_BUDGET_MS) {
        throw new Error(`scroll draw p95 ${p95.toFixed(2)}ms exceeds the 120Hz budget ${FRAME_BUDGET_MS.toFixed(2)}ms`);
    }
    const fullLayoutDraws = draws.filter((draw) => !draw.reuse).length;
    if (fullLayoutDraws !== 0) throw new Error(`${fullLayoutDraws}/${draws.length} scroll draws ran full layout`);

    const afterTree = await host.dump();
    const anchorAfter = byTestId(afterTree, "overview-row-020");
    if (!anchorAfter?.bounds) throw new Error("anchor row lost its measured bounds after scroll");
    const visualDelta = anchorBefore.bounds.y - anchorAfter.bounds.y;
    if (visualDelta < 700) throw new Error(`content moved only ${visualDelta.toFixed(1)}px after native scroll`);

    const stats = await host.request({ $cmd: "scrollDriverStats", ...point });
    if (!stats.ok || stats.notificationCount < SCROLL_STEPS || stats.callbackCount < 8) {
        throw new Error(`native clip-view callbacks did not drive the offsets: ${JSON.stringify(stats)}`);
    }
    if (stats.callbackCount >= stats.notificationCount) {
        throw new Error(`native offset callbacks were not frame-coalesced: ${JSON.stringify(stats)}`);
    }
    if (stats.offsetY < 700) throw new Error(`native offset did not advance: ${JSON.stringify(stats)}`);

    const frontmostAfter = frontmostProcess();
    if (frontmostAfter.pid !== frontmostBefore.pid) {
        throw new Error(`fixture stole focus from pid ${frontmostBefore.pid} to ${frontmostAfter.pid}`);
    }

    console.log(
        `SCROLL_PERFORMANCE_CONFORMANCE_PASS driver=appkit lane=${contentionMode ? "contention" : "idle"} ` +
            `budget=${FRAME_BUDGET_MS.toFixed(2)}ms burners=${perfContention.burnerCount} ` +
            `load=${JSON.stringify(perfContention.snapshot())} notifications=${stats.notificationCount} ` +
            `callbacks=${stats.callbackCount} ` +
            `draws=${draws.length} p95=${p95.toFixed(2)}ms moved=${visualDelta.toFixed(0)}px`,
    );
} catch (error) {
    console.error(`SCROLL_PERFORMANCE_CONFORMANCE_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    try {
        host?.close();
    } finally {
        await perfContention?.stop();
        if (previousService === undefined) delete process.env.RNGPUI_SERVICE;
        else process.env.RNGPUI_SERVICE = previousService;
    }
}
