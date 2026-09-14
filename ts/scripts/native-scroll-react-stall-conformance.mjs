import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchHost } from "../cli/host.ts";
import { frontmostProcess, sleep } from "./conformance-utils.mjs";

const SCROLL_STEPS = 100;
const STALL_MS = 2_000; // the fixture's React busy-wait
// the stall is a wall-clock busy loop, so it covers STALL_MS from its own STALL_START
// whatever the machine is doing. What varies with load is how many of the sequence's
// frame-paced steps land inside it, so the gate measures progress made DURING the stall
// instead of demanding the whole 101-step sequence (plus three control round trips) fit
// inside it: that was a machine-load claim wearing an engine property's name, and it
// reported "the React stall ended before the scroll proof completed" whenever frames
// stretched. Progress is sampled at 40% into the stall, which is 800ms of headroom
// against the loop's own deadline.
const MID_STALL_FRACTION = 0.4;
const MIN_OFFSET_MID_STALL = 200; // px, i.e. 20 of the sequence's 101 ten-px dispatches
const STALL_END = "native-scroll-react-stall STALL_END";
const SEQUENCE_TIMEOUT_MS = 20_000;
const service = new URL("../../rust/target/release/rngpui-service", import.meta.url).pathname;
const previousService = process.env.RNGPUI_SERVICE;
process.env.RNGPUI_SERVICE = service;
process.env.RNGPUI_DRAW_PROBE = "1";
process.env.RNGPUI_SCROLL_LATENCY_PROBE = "1";

const flatten = (node, out = []) => {
    out.push(node);
    for (const child of node.children ?? []) flatten(child, out);
    return out;
};
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const frontmostBefore = frontmostProcess();
let host;
try {
    if (!existsSync(service)) throw new Error(`rngpui-service not found: ${service}`);
    host = await launchHost(
        new URL("../examples/native-scroll-react-stall-conformance.tsx", import.meta.url).pathname,
        { size: "480x620" },
    );
    const tree = await host.dump();
    const scroll = flatten(tree).find((node) => node.accessibility?.testID === "stall-scroll");
    if (!scroll?.bounds) throw new Error("stall scroll bounds were not measured");
    const point = {
        x: scroll.bounds.x + scroll.bounds.width / 2,
        y: scroll.bounds.y + scroll.bounds.height / 2,
    };
    const logPath = join(host.sessionDir, "service.log");
    await waitForLog(logPath, "native-scroll-react-stall STALL_START", 4_000);
    const stallStart = Date.now();

    const reset = await host.request({ $cmd: "scrollDriverStats", ...point, reset: true });
    if (!reset.ok) throw new Error(`no native scroll driver to reset at the fixture's point: ${JSON.stringify(reset)}`);
    await host.request({ $cmd: "presentTraceStart" });
    await host.request({ $cmd: "traceStart", maxMs: 3_000 });
    // fired without awaiting: the reply only lands once every frame-paced step has
    // dispatched, so awaiting here is what made this gate race the fixture's fixed stall.
    const sequencePending = host.request({
        $cmd: "nativeDriverSequence",
        ...point,
        dy: 10,
        steps: SCROLL_STEPS,
    });

    // sample the AppKit driver well inside the stall, reading the log on both sides of
    // the round trip so "while React was blocked" is a checked fact: the log lags a
    // little at worst, and under one 10px step of post-stall scrolling could otherwise
    // leak into the sample.
    await sleep(Math.max(0, Math.round(STALL_MS * MID_STALL_FRACTION) - (Date.now() - stallStart)));
    const beforeSample = readFileSync(logPath, "utf8");
    const midStall = await host.request({ $cmd: "scrollDriverStats", ...point });
    const afterSample = readFileSync(logPath, "utf8");
    if (beforeSample.includes(STALL_END) || afterSample.includes(STALL_END)) {
        throw new Error(
            `the fixture's ${STALL_MS}ms React stall ended before the mid-stall sample landed (${Math.round(STALL_MS * MID_STALL_FRACTION)}ms in)`,
        );
    }
    if (!midStall.ok) throw new Error(`no native scroll driver mid-stall: ${JSON.stringify(midStall)}`);
    if (midStall.offsetY < MIN_OFFSET_MID_STALL) {
        throw new Error(
            `native scroll stalled with React — offsetY=${Number(midStall.offsetY).toFixed(0)}px at ` +
                `${Math.round(STALL_MS * MID_STALL_FRACTION)}ms into the React stall (floor ${MIN_OFFSET_MID_STALL}px)`,
        );
    }

    await waitForLog(logPath, STALL_END, STALL_MS * 4);
    const atStallEnd = await host.request({ $cmd: "scrollDriverStats", ...point });

    // the fixture's stall ending first is no longer a failure (frames are allowed to lag
    // under load); the sequence must still dispatch every step and land its full offset.
    const deadline = new Promise((_, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`nativeDriverSequence did not report within ${SEQUENCE_TIMEOUT_MS}ms`)),
            SEQUENCE_TIMEOUT_MS,
        );
        timer.unref?.();
    });
    const sequence = await Promise.race([sequencePending, deadline]);
    const presentation = await host.request({ $cmd: "presentTraceStop" });
    const trace = await host.request({ $cmd: "traceStop" });
    const stats = await host.request({ $cmd: "scrollDriverStats", ...point });

    if (!sequence.ok || sequence.dispatched !== SCROLL_STEPS + 1) {
        throw new Error(`native scroll sequence failed during the React stall: ${JSON.stringify(sequence)}`);
    }
    if (!trace.ok || trace.framesPainted < 90) {
        throw new Error(`only ${trace.framesPainted ?? 0} scroll frames painted during the React stall`);
    }
    const times = (presentation.frames ?? [])
        .map((frame) => Number(frame.presentedTime))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    const uniqueTimes = times.filter((time, index) => index === 0 || time - times[index - 1] > 0.001);
    const gaps = uniqueTimes.slice(1).map((time, index) => (time - uniqueTimes[index]) * 1_000);
    if (gaps.length < 90) throw new Error(`only ${gaps.length + 1} Metal frames presented during the React stall`);
    const p95 = percentile(gaps, 0.95);
    const longGaps = gaps.filter((gap) => gap > 12.5).length;
    if (p95 > 10 || longGaps > 4) {
        throw new Error(`Metal cadence regressed during the React stall: p95=${p95.toFixed(2)}ms over12.5=${longGaps}`);
    }
    if (!stats.ok || stats.offsetY < 800) {
        throw new Error(`native offset did not advance during the React stall: ${JSON.stringify(stats)}`);
    }
    const frontmostAfter = frontmostProcess();
    if (frontmostAfter.pid !== frontmostBefore.pid) {
        throw new Error(`fixture stole focus from pid ${frontmostBefore.pid} to ${frontmostAfter.pid}`);
    }
    console.log(
        `NATIVE_SCROLL_REACT_STALL_CONFORMANCE PASS frames=${uniqueTimes.length} ` +
            `p95=${p95.toFixed(2)}ms over12.5=${longGaps} offset=${Number(stats.offsetY).toFixed(0)} ` +
            `midStallOffset=${Number(midStall.offsetY).toFixed(0)}px at=${Math.round(STALL_MS * MID_STALL_FRACTION)}ms`,
    );
} catch (error) {
    console.error(
        `NATIVE_SCROLL_REACT_STALL_CONFORMANCE FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
} finally {
    host?.close();
    if (previousService === undefined) delete process.env.RNGPUI_SERVICE;
    else process.env.RNGPUI_SERVICE = previousService;
}

async function waitForLog(path, needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path) && readFileSync(path, "utf8").includes(needle)) return;
        await sleep(10);
    }
    throw new Error(`timed out waiting for ${needle}`);
}
