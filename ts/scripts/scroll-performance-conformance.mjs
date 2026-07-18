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

function scrollLatencies(log) {
    return [...log.matchAll(/^\[scroll-latency\] ([0-9.]+)ms$/gm)].map((match) => Number(match[1]));
}

function assertReferenceMatch(sample, label, tolerance = 0.75) {
    if (!sample.ok || !Number.isFinite(sample.offsetY) || !Number.isFinite(sample.referenceOffsetY)) {
        throw new Error(`${label} did not return both AppKit offsets: ${JSON.stringify(sample)}`);
    }
    const difference = Math.abs(sample.offsetY - sample.referenceOffsetY);
    if (difference > tolerance) {
        throw new Error(
            `${label} diverged from stock NSScrollView by ${difference.toFixed(2)}px: ${JSON.stringify(sample)}`,
        );
    }
}

const previousService = process.env.RNGPUI_SERVICE;
const previousDrawProbe = process.env.RNGPUI_DRAW_PROBE;
const previousLatencyProbe = process.env.RNGPUI_SCROLL_LATENCY_PROBE;
process.env.RNGPUI_SERVICE = new URL("../../rust/target/release/rngpui-service", import.meta.url).pathname;
process.env.RNGPUI_DRAW_PROBE = "1";
process.env.RNGPUI_SCROLL_LATENCY_PROBE = "1";

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
    const nestedPoint = center(nestedInner);
    const outer = byTestId(beforeTree, "nested-outer");
    if (!outer?.bounds) throw new Error("nested outer scroll bounds were not measured");
    const outerPoint = {
        x: outer.bounds.x + 2,
        y: outer.bounds.y + outer.bounds.height - 2,
    };
    const nestedStats = await host.request({ $cmd: "scrollDriverStats", ...nestedPoint, reset: true });
    if (!nestedStats.ok || !nestedStats.hasVerticalScroller) {
        throw new Error(`default vertical overlay scroller was not enabled: ${JSON.stringify(nestedStats)}`);
    }
    const outerStats = await host.request({ $cmd: "scrollDriverStats", ...outerPoint, reset: true });
    if (!outerStats.ok || outerStats.targetId === nestedStats.targetId) {
        throw new Error(`nested AppKit drivers were not independently addressable: ${JSON.stringify({ nestedStats, outerStats })}`);
    }

    const wheel = (at, dy, phase, momentumPhase = "none") =>
        host.request({ $cmd: "nativeDriverWheel", ...at, dy, phase, momentumPhase });
    const began = await wheel(nestedPoint, 16, "began");
    if (!began.ok || began.hitTargetId !== nestedStats.targetId) {
        throw new Error(`real AppKit begin did not hit the deepest nested driver: ${JSON.stringify(began)}`);
    }
    assertReferenceMatch(began, "nested gesture begin");
    const changedOverOuter = await wheel(outerPoint, 20, "changed");
    if (
        !changedOverOuter.ok ||
        changedOverOuter.hitTargetId !== outerStats.targetId ||
        changedOverOuter.effectiveTargetId !== nestedStats.targetId
    ) {
        throw new Error(`changed phase did not enter through the outer driver: ${JSON.stringify(changedOverOuter)}`);
    }
    assertReferenceMatch(changedOverOuter, "nested pointer crossing");
    const nestedMomentum = await wheel(outerPoint, 20, "none", "changed");
    if (nestedMomentum.effectiveTargetId !== nestedStats.targetId) {
        throw new Error(`momentum escaped the nested gesture owner: ${JSON.stringify(nestedMomentum)}`);
    }
    assertReferenceMatch(nestedMomentum, "nested momentum");
    const nestedMomentumEnd = await wheel(outerPoint, 0, "none", "ended");
    if (nestedMomentumEnd.effectiveTargetId !== nestedStats.targetId) {
        throw new Error(`momentum end escaped the nested gesture owner: ${JSON.stringify(nestedMomentumEnd)}`);
    }
    assertReferenceMatch(nestedMomentumEnd, "nested momentum end");
    await sleep(30);
    const innerAfterLockedGesture = await host.request({ $cmd: "scrollDriverStats", ...nestedPoint });
    const outerAfterLockedGesture = await host.request({ $cmd: "scrollDriverStats", ...outerPoint });
    if (innerAfterLockedGesture.offsetY < 20 || Math.abs(outerAfterLockedGesture.offsetY) > 0.5) {
        throw new Error(
            `nested gesture ownership escaped before momentum ended: ${JSON.stringify({ innerAfterLockedGesture, outerAfterLockedGesture })}`,
        );
    }
    const legacyOuter = await wheel(outerPoint, 18, "none");
    await sleep(20);
    const outerAfterLegacy = await host.request({ $cmd: "scrollDriverStats", ...outerPoint });
    if (!legacyOuter.ok || outerAfterLegacy.offsetY < 10) {
        throw new Error(`phase-none wheel did not use the current AppKit hit: ${JSON.stringify({ legacyOuter, outerAfterLegacy })}`);
    }

    await host.request({ $cmd: "scrollAt", ...nestedPoint, dx: 0, dy: -10000 });
    await sleep(20);
    await wheel(nestedPoint, -120, "began");
    const elastic = await wheel(nestedPoint, -120, "changed");
    await wheel(nestedPoint, 0, "ended");
    if (!elastic.ok || elastic.offsetY >= -0.5) {
        throw new Error(`AppKit rubber-band offset was clamped before paint: ${JSON.stringify(elastic)}`);
    }
    assertReferenceMatch(elastic, "nested elastic edge");
    const initial = await host.request({ $cmd: "scrollDriverStats", ...point, reset: true });
    if (!initial.ok || initial.driver !== "appkit") {
        throw new Error(`expected an AppKit scroll driver, got ${JSON.stringify(initial)}`);
    }
    if (initial.hasVerticalScroller) {
        throw new Error(`showsVerticalScrollIndicator=false still exposed a scroller: ${JSON.stringify(initial)}`);
    }

    // Compare the production subclass against a stock NSScrollView hosted in the
    // same non-activating window. Both receive the identical phased NSEvent stream.
    await host.request({ $cmd: "scrollAt", ...point, dx: 0, dy: 1_000 });
    await sleep(20);
    const decayBaseline = await host.request({ $cmd: "scrollDriverStats", ...point });
    if (!decayBaseline.ok) throw new Error(`distance baseline was unavailable: ${JSON.stringify(decayBaseline)}`);
    const decaySequence = [
        [48, "began", "none"],
        [40, "changed", "none"],
        [0, "ended", "began"],
        [30, "none", "changed"],
        [20, "none", "changed"],
        [12, "none", "changed"],
        [6, "none", "changed"],
        [2, "none", "changed"],
        [0, "none", "ended"],
    ];
    const decayProofs = [];
    for (const [dy, phase, momentumPhase] of decaySequence) {
        const sample = await wheel(point, dy, phase, momentumPhase);
        assertReferenceMatch(sample, `distance/decay ${phase}/${momentumPhase}`);
        decayProofs.push(sample);
    }
    const directDistance = decayProofs[1].offsetY - decayBaseline.offsetY;
    const referenceDirectDistance = decayProofs[1].referenceOffsetY - decayBaseline.offsetY;
    if (directDistance < 60 || referenceDirectDistance < 60) {
        throw new Error(
            `stock-matched direct gesture moved only production=${directDistance.toFixed(2)}px reference=${referenceDirectDistance.toFixed(2)}px`,
        );
    }
    const decaySamples = decayProofs.map((sample) => sample.offsetY);
    const momentumOffsets = decaySamples.slice(2, 8);
    const momentumDistances = momentumOffsets.slice(1).map((offset, index) => offset - momentumOffsets[index]);
    if (momentumDistances[0] < 20 || momentumDistances.some((distance) => distance < -0.5)) {
        throw new Error(`stock-matched momentum distance did not advance: ${JSON.stringify(momentumDistances)}`);
    }
    for (let index = 1; index < momentumDistances.length; index++) {
        if (momentumDistances[index] > momentumDistances[index - 1] + 0.75) {
            throw new Error(`stock-matched momentum did not decay: ${JSON.stringify(momentumDistances)}`);
        }
    }

    const reversalSamples = [];
    for (const [dy, phase] of [[24, "began"], [18, "changed"], [-30, "changed"], [0, "ended"]]) {
        const sample = await wheel(point, dy, phase);
        assertReferenceMatch(sample, `reversal ${phase}`);
        reversalSamples.push(sample.offsetY);
    }
    if (reversalSamples[2] >= reversalSamples[1] - 5) {
        throw new Error(`stock-matched reversal did not change direction: ${JSON.stringify(reversalSamples)}`);
    }

    await host.request({ $cmd: "scrollAt", ...point, dx: 0, dy: -100_000 });
    await sleep(20);
    await wheel(point, -120, "began");
    const referenceEdge = await wheel(point, -120, "changed");
    assertReferenceMatch(referenceEdge, "top-edge elasticity");
    await wheel(point, 0, "ended");
    if (referenceEdge.offsetY >= -0.5) {
        throw new Error(`stock-matched top edge did not remain elastic: ${JSON.stringify(referenceEdge)}`);
    }
    await host.request({ $cmd: "scrollAt", ...point, dx: 0, dy: -100_000 });
    await sleep(20);

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
    const latencies = scrollLatencies(log);
    if (latencies.length < 8) throw new Error(`expected event-to-present latency samples, found ${latencies.length}`);
    const latencyP95 = percentile(latencies, 0.95);
    const latencyBudget = contentionMode ? 1000 / 30 : 1000 / 60;
    if (latencyP95 > latencyBudget) {
        throw new Error(`scroll event-to-present p95 ${latencyP95.toFixed(2)}ms exceeds ${latencyBudget.toFixed(2)}ms`);
    }

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
            `draws=${draws.length} p95=${p95.toFixed(2)}ms latencyP95=${latencyP95.toFixed(2)}ms ` +
            `moved=${visualDelta.toFixed(0)}px`,
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
        if (previousDrawProbe === undefined) delete process.env.RNGPUI_DRAW_PROBE;
        else process.env.RNGPUI_DRAW_PROBE = previousDrawProbe;
        if (previousLatencyProbe === undefined) delete process.env.RNGPUI_SCROLL_LATENCY_PROBE;
        else process.env.RNGPUI_SCROLL_LATENCY_PROBE = previousLatencyProbe;
    }
}
