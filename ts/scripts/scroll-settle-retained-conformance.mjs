// Conformance gate for the post-scroll hover-settler frame.
//
// `div::suppress_pseudo_hover_during_native_scroll` schedules a refresh 80ms after the
// last native scroll to reconcile pseudo hover against the final painted offset. That
// refresh repaints the tree the scroll already committed, so it has to reach the
// retained-layout gate as paint-only. Unarmed, it arrives with nothing dirty, fails
// `want_reuse` in service.rs, and pays a full taffy solve — measured at 23-38ms against
// ~2.5ms for a reuse frame, once per native scroll, at exactly the moment a fling ends.
//
// The settle frame usually coalesces into a frame that is already pending, which hides
// the cost. This gate isolates it: quiesce, run one wheel step, wait out the settle, and
// require that every frame the gesture produced reused the prior layout.
//
// Asserting only on reuse would let a regression hide behind a stale-but-valid layout, so
// the failure path prints the `[retained]` state line that produced each offending frame.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchHost } from "../cli/host.ts";
import { frontmostProcess, sleep } from "./conformance-utils.mjs";

const service =
    process.env.RNGPUI_SERVICE ?? new URL("../../rust/target/release/rngpui-service", import.meta.url).pathname;
const previousService = process.env.RNGPUI_SERVICE;
process.env.RNGPUI_SERVICE = service;
process.env.RNGPUI_DRAW_PROBE = "1";
process.env.RNGPUI_RETAINED_TRACE = "1";

const QUERY = /^\[(draw|retained)\]/;

const flatten = (node, out = []) => {
    out.push(node);
    for (const child of node.children ?? []) flatten(child, out);
    return out;
};

const frames = (log) => log.split("\n").filter((line) => QUERY.test(line));

// the settle fires 80ms after the last scroll; a longer silence than that means every
// frame the gesture caused (and the settle it triggered) has already been painted.
async function waitForQuiet(path, quietMs = 400, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    let seen = frames(readFileSync(path, "utf8")).length;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
        await sleep(15);
        const now = frames(readFileSync(path, "utf8")).length;
        if (now !== seen) {
            seen = now;
            quietSince = Date.now();
        } else if (Date.now() - quietSince >= quietMs) {
            return;
        }
    }
    throw new Error(`fixture never went quiet within ${timeoutMs}ms`);
}

const frontmostBefore = frontmostProcess();
let host;
try {
    if (!existsSync(service)) throw new Error(`rngpui-service not found: ${service}`);
    host = await launchHost(
        new URL("../examples/scroll-performance-conformance.tsx", import.meta.url).pathname,
        { size: "900x700" },
    );
    const tree = await host.dump();
    const scroll = flatten(tree).find((node) => node.accessibility?.testID === "overview-scroll");
    if (!scroll?.bounds) throw new Error("overview scroll bounds were not measured");
    const point = {
        x: scroll.bounds.x + scroll.bounds.width / 2,
        y: scroll.bounds.y + scroll.bounds.height / 2,
    };
    const logPath = join(host.sessionDir, "service.log");

    await waitForQuiet(logPath);
    const mark = readFileSync(logPath, "utf8").length;

    await host.request({
        $cmd: "nativeDriverWheel",
        ...point,
        dy: 18,
        phase: "began",
        momentumPhase: "none",
    });
    await waitForQuiet(logPath);
    await host.request({ $cmd: "nativeDriverWheel", ...point, dy: 0, phase: "ended", momentumPhase: "none" });
    await waitForQuiet(logPath);

    const produced = frames(readFileSync(logPath, "utf8").slice(mark));
    const drew = produced.filter((line) => line.startsWith("[draw]"));
    if (drew.length === 0) throw new Error("the native scroll gesture produced no frame at all");
    if (!produced.some((line) => line.includes("reuse=true"))) {
        throw new Error(`the scroll gesture reused no layout at all:\n${produced.join("\n")}`);
    }
    const full = produced.filter((line) => line.startsWith("[draw]") && line.includes("reuse=false"));
    if (full.length > 0) {
        // print the frames interleaved with the gate state that produced them: an
        // unarmed frame shows up as paint_only=false with every dirty flag false.
        throw new Error(
            `${full.length}/${drew.length} frames after one native scroll ran a full layout:\n` +
                produced.join("\n"),
        );
    }

    const frontmostAfter = frontmostProcess();
    if (frontmostAfter.pid !== frontmostBefore.pid) {
        throw new Error(`fixture stole focus from pid ${frontmostBefore.pid} to ${frontmostAfter.pid}`);
    }
    console.log(
        `SCROLL_SETTLE_RETAINED_CONFORMANCE PASS frames=${drew.length} ` +
            `reused=${drew.length - full.length} fullLayout=${full.length}`,
    );
} catch (error) {
    console.error(
        `SCROLL_SETTLE_RETAINED_CONFORMANCE FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
} finally {
    host?.close();
    if (previousService === undefined) delete process.env.RNGPUI_SERVICE;
    else process.env.RNGPUI_SERVICE = previousService;
}
