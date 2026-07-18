#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHost } from "../cli/host.ts";
import { hasContentionFlag, startPerfContention } from "./perf-contention.mjs";

const tsRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workdir = mkdtempSync(join(tmpdir(), "rngpui-legend-100k-"));
const listBundleJs = join(workdir, "list.js");
const listBundleHbc = join(workdir, "list.hbc");
const contentionMode = hasContentionFlag();
const modeSuffix = contentionMode ? "-contention" : "";
const screenshotPath = `/tmp/rngpui-legend-100k${modeSuffix}.png`;
const reportPath = `/tmp/rngpui-legend-100k${modeSuffix}-report.json`;
const failureLogPath = `/tmp/rngpui-legend-100k${modeSuffix}-service.log`;
let host;
let emptyHost;
let perfContention;

rmSync(screenshotPath, { force: true });
rmSync(reportPath, { force: true });
rmSync(failureLogPath, { force: true });

try {
    process.env.RNGPUI_STARTUP_TIMING = "1";
    process.env.RNGPUI_FRAME_TRACE = "1";
    process.env.RNGPUI_DRAW_PROBE = "1";
    process.env.RNGPUI_SERIALIZE_TRACE = "1";
    process.env.RNGPUI_SHOT_SETTLE_MS = "1";
    process.env.RNGPUI_WIRE_TRACE = "1";
    ensureReanimatedRuntime();
    bundleFixture("examples/legend-list-100k.tsx", listBundleJs);

    perfContention = await startPerfContention(contentionMode);
    process.env.RNGPUI_LEGEND_EMPTY_REFERENCE = "1";
    emptyHost = await launchHost("", { bundle: listBundleHbc, size: "900x700" });
    await waitForHostTree(
        emptyHost,
        (tree) => {
            const marker = findNativeId(tree, "legend-empty-ready");
            return intersectsWindow(marker?.bounds) && textContent(marker).includes("loaded:");
        },
        "painted empty LegendList reference",
    );
    const referenceMemory = processMemory(emptyHost.servicePid);
    emptyHost.close();
    emptyHost = undefined;
    delete process.env.RNGPUI_LEGEND_EMPTY_REFERENCE;

    const launchStartedAt = performance.now();
    host = await launchHost("", { bundle: listBundleHbc, size: "900x700" });

    const initialTree = await waitForTree(
        (tree) =>
            textForNativeId(tree, "legend-load-status")?.includes("loaded:") &&
            intersectsWindow(findNativeId(tree, "legend-item-0")?.bounds),
        "painted LegendList onLoad state",
    );
    const launchToUsableMs = performance.now() - launchStartedAt;
    const initial = treeMetrics(initialTree);
    const initialRow = findNativeId(initialTree, "legend-item-0");
    assert(initialRow && textContent(initialRow).includes("summary"), "initial summary row 0 is mounted");
    validateTree(initial, "initial");
    const memoryAfterLoad = processMemory(host.servicePid);

    const middleJump = await tapAndWait("jump-middle", 50_000);
    const middleTree = middleJump.tree;
    const middle = treeMetrics(middleTree);
    validateTree(middle, "middle");

    const endJump = await tapAndWait("jump-end", 99_999);
    const endTree = endJump.tree;
    const end = treeMetrics(endTree);
    validateTree(end, "end");

    const startJump = await tapAndWait("jump-start", 0);
    const startTree = startJump.tree;
    const start = treeMetrics(startTree);
    validateTree(start, "returned start");

    const stressTargets = [99_999, 0, 50_000, 99_999, 0, 50_000, 99_999, 0, 50_000];
    let maxStressNodes = 0;
    let maxStressRows = 0;
    for (const target of stressTargets) {
        const buttonId = target === 0 ? "jump-start" : target === 50_000 ? "jump-middle" : "jump-end";
        const { tree } = await tapAndWait(buttonId, target);
        const metrics = treeMetrics(tree);
        validateTree(metrics, `stress jump ${target}`);
        maxStressNodes = Math.max(maxStressNodes, metrics.nodes);
        maxStressRows = Math.max(maxStressRows, metrics.rowNodes);
    }
    const memoryAfterFarJumps = processMemory(host.servicePid);

    const logPath = join(host.sessionDir, "service.log");
    const scrollLogStart = statSync(logPath).size;
    const traceStart = await host.request({ $cmd: "traceStart", maxMs: 5_000 });
    assert(traceStart.ok, "native frame trace started");
    const pending = [];
    for (let index = 0; index < 120; index += 1) {
        const sentAt = performance.now();
        pending.push(
            host
                .request({ $cmd: "scrollAt", x: 450, y: 350, dx: 0, dy: 96 })
                .then((reply) => ({ latencyMs: performance.now() - sentAt, reply })),
        );
        await sleep(8);
    }
    const scrollResults = await Promise.all(pending);
    assert(scrollResults.every(({ reply }) => reply.ok), "paced scroll commands reached the LegendList scroller");
    await sleep(100);
    const trace = await host.request({ $cmd: "traceStop" });
    assert(trace.ok, "native frame trace stopped");
    await host.request({ $cmd: "scrollAt", x: 450, y: 350, dx: 0, dy: 1 });
    await sleep(50);

    const finalTree = await host.dump();
    const final = treeMetrics(finalTree);
    validateTree(final, "post-scroll");
    assert(!findNativeId(finalTree, "legend-item-50000"), "scrolling recycled the former middle row");
    const memoryAfterScroll = processMemory(host.servicePid);

    host.capture(screenshotPath);
    const log = readFileSync(logPath, "utf8");
    const scrollLog = log.slice(scrollLogStart);
    const startup = startupMetrics(log, launchToUsableMs);
    const nativeFrameSamples = [
        ...scrollLog.matchAll(
            /\[frame\]\s+(COMMIT|idle)\s+total~([\d.]+)ms = create ([\d.]+) \+ layout ([\d.]+) \+ prepaint ([\d.]+) \+ paint ([\d.]+) \| nodes rebuilt=(\d+)/g,
        ),
    ].map((match) => ({
        kind: match[1],
        totalMs: Number(match[2]),
        createMs: Number(match[3]),
        layoutMs: Number(match[4]),
        prepaintMs: Number(match[5]),
        paintMs: Number(match[6]),
        nodesRebuilt: Number(match[7]),
    }));
    const nativeFrameTotals = nativeFrameSamples.map(({ totalMs }) => totalMs);
    const drawSamples = [...scrollLog.matchAll(/^\[draw\] ([\d.]+)ms reuse=(true|false)$/gm)].map(
        (match) => ({ totalMs: Number(match[1]), reusedLayout: match[2] === "true" }),
    );
    const drawTotals = drawSamples.map(({ totalMs }) => totalMs);
    const wireSamples = [...scrollLog.matchAll(/\[wire\] refs=(\d+) full=(\d+)/g)].map((match) => ({
        refs: Number(match[1]),
        full: Number(match[2]),
    }));
    const serializerSamples = [
        ...scrollLog.matchAll(/\[ser\] updates=(\d+) creates=(\d+) miss=(\d+) hit=(\d+)/g),
    ].map((match) => ({
        updates: Number(match[1]),
        creates: Number(match[2]),
        miss: Number(match[3]),
        hit: Number(match[4]),
    }));
    const paintGaps = Array.isArray(trace.paintGapsMs) ? trace.paintGapsMs.filter(Number.isFinite) : [];
    const scrollCommandLatencies = scrollResults.map(({ latencyMs }) => latencyMs);
    const maxNativeNodes = Math.max(initial.nodes, middle.nodes, end.nodes, start.nodes, final.nodes, maxStressNodes);
    const maxMountedRows = Math.max(initial.rowNodes, middle.rowNodes, end.rowNodes, start.rowNodes, final.rowNodes, maxStressRows);
    const maxPhysicalFootprintMb = Math.max(
        memoryAfterLoad.physicalFootprintMb,
        memoryAfterFarJumps.physicalFootprintMb,
        memoryAfterScroll.physicalFootprintMb,
    );
    const nativeFrameP95BudgetMs = contentionMode ? 16.67 : 8.33;
    const report = {
        itemCount: 100_000,
        contention: {
            mode: contentionMode ? "contention" : "idle",
            burnerCount: perfContention.burnerCount,
            burnerPids: perfContention.burnerPids,
            burnerNiceValues: perfContention.burnerNiceValues,
            cpuCount: perfContention.cpuCount,
            niceIncrement: perfContention.niceIncrement,
            maxBurnerDurationMs: perfContention.maxDurationMs,
            loadAverageBefore: perfContention.loadAverageBefore,
            loadAverageAfterWarmup: perfContention.loadAverageAfterWarmup,
            loadAverageAfterBenchmark: perfContention.snapshot(),
            nativeFrameP95BudgetMs,
        },
        initial,
        middle,
        end,
        start,
        final,
        startup,
        memory: {
            reference: referenceMemory,
            afterLoad: memoryAfterLoad,
            afterFarJumps: memoryAfterFarJumps,
            afterScroll: memoryAfterScroll,
            physicalFootprintSettledDeltaMb: Number(
                (memoryAfterLoad.physicalFootprintMb - referenceMemory.physicalFootprintMb).toFixed(1),
            ),
            physicalFootprintMaxDeltaMb: Number(
                (maxPhysicalFootprintMb - referenceMemory.physicalFootprintMb).toFixed(1),
            ),
            rssFarJumpGrowthMb: Number((memoryAfterFarJumps.rssMb - memoryAfterLoad.rssMb).toFixed(1)),
            rssTotalGrowthMb: Number((memoryAfterScroll.rssMb - memoryAfterLoad.rssMb).toFixed(1)),
        },
        recycling: {
            farJumps: stressTargets.length + 3,
            tapToPaintedSettledMs: {
                top: startJump.elapsedMs,
                middle: middleJump.elapsedMs,
                end: endJump.elapsedMs,
            },
            maxMountedRows,
            maxNativeNodes,
            maxStressNodes,
            maxStressRows,
        },
        rendererDelta: {
            wireCommits: wireSamples.length,
            wireRefsP50: percentile(
                wireSamples.map(({ refs }) => refs),
                0.5,
            ),
            wireRefsP95: percentile(
                wireSamples.map(({ refs }) => refs),
                0.95,
            ),
            wireFullP50: percentile(
                wireSamples.map(({ full }) => full),
                0.5,
            ),
            wireFullP95: percentile(
                wireSamples.map(({ full }) => full),
                0.95,
            ),
            serializerCommits: serializerSamples.length,
            serializerHitsP50: percentile(
                serializerSamples.map(({ hit }) => hit),
                0.5,
            ),
            serializerMissesP95: percentile(
                serializerSamples.map(({ miss }) => miss),
                0.95,
            ),
            hostUpdatesP95: percentile(
                serializerSamples.map(({ updates }) => updates),
                0.95,
            ),
        },
        scroll: {
            commands: scrollResults.length,
            commandRoundTripP50Ms: percentile(scrollCommandLatencies, 0.5),
            commandRoundTripP95Ms: percentile(scrollCommandLatencies, 0.95),
            framesPainted: trace.framesPainted,
            nativeFramesMeasured: nativeFrameTotals.length,
            nativeFrameP50Ms: percentile(nativeFrameTotals, 0.5),
            nativeFrameP95Ms: percentile(nativeFrameTotals, 0.95),
            drawSamples: drawSamples.length,
            drawP50Ms: percentile(drawTotals, 0.5),
            drawP95Ms: percentile(drawTotals, 0.95),
            drawFullLayoutFrames: drawSamples.filter(({ reusedLayout }) => !reusedLayout).length,
            nativeCreateP95Ms: percentile(
                nativeFrameSamples.map(({ createMs }) => createMs),
                0.95,
            ),
            nativeLayoutP95Ms: percentile(
                nativeFrameSamples.map(({ layoutMs }) => layoutMs),
                0.95,
            ),
            nativePrepaintP95Ms: percentile(
                nativeFrameSamples.map(({ prepaintMs }) => prepaintMs),
                0.95,
            ),
            nativePaintP95Ms: percentile(
                nativeFrameSamples.map(({ paintMs }) => paintMs),
                0.95,
            ),
            nativeNodesRebuiltP95: percentile(
                nativeFrameSamples.map(({ nodesRebuilt }) => nodesRebuilt),
                0.95,
            ),
            paintGapP50Ms: percentile(paintGaps, 0.5),
            paintGapP95Ms: percentile(paintGaps, 0.95),
        },
        screenshot: screenshotPath,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    assert(maxNativeNodes < 250, `native nodes stay below 250, saw ${maxNativeNodes}`);
    assert(maxMountedRows < 80, `mounted rows stay below 80, saw ${maxMountedRows}`);
    for (const [target, elapsedMs] of Object.entries(report.recycling.tapToPaintedSettledMs)) {
        assert(elapsedMs <= 100, `${target} tap-to-painted-settled <=100ms, saw ${elapsedMs}ms`);
    }
    assert(
        report.memory.physicalFootprintSettledDeltaMb <= 30,
        `settled 100k physical-footprint delta <=30MB, saw ${report.memory.physicalFootprintSettledDeltaMb}MB`,
    );
    assert(
        report.memory.physicalFootprintMaxDeltaMb <= 30,
        `max 100k physical-footprint delta <=30MB, saw ${report.memory.physicalFootprintMaxDeltaMb}MB`,
    );
    assert(wireSamples.length >= 20, `captured enough delta-wire commits, saw ${wireSamples.length}`);
    assert(startup.nativeFirstRenderMs !== null, "captured native first-render timing");
    assert(startup.legendAppMs !== null, "captured LegendList onLoad timing");
    assert(startup.launchToUsableMs <= 200, `launch-to-usable list <=200ms, saw ${startup.launchToUsableMs}ms`);
    assert(
        report.scroll.drawP95Ms !== null && report.scroll.drawP95Ms <= nativeFrameP95BudgetMs,
        `whole-draw scroll p95 <=${nativeFrameP95BudgetMs}ms in ${report.contention.mode} mode, saw ${report.scroll.drawP95Ms}ms`,
    );
    assert(
        report.scroll.commandRoundTripP95Ms !== null && report.scroll.commandRoundTripP95Ms <= 8.33,
        `scroll command round-trip p95 <=8.33ms, saw ${report.scroll.commandRoundTripP95Ms}ms`,
    );
    assert(nativeFrameTotals.length >= 20, `captured enough native scroll frames, saw ${nativeFrameTotals.length}`);
    assert(drawTotals.length >= 20, `captured enough whole-draw scroll frames, saw ${drawTotals.length}`);

    console.log(`LEGEND_100K_METRICS ${JSON.stringify(report)}`);
    console.log(`LEGEND_100K_REPORT ${reportPath}`);
    console.log("LEGEND_100K_CONFORMANCE_PASS");
} catch (error) {
    const serviceLog = host && join(host.sessionDir, "service.log");
    if (serviceLog && existsSync(serviceLog)) copyFileSync(serviceLog, failureLogPath);
    console.error(`LEGEND_100K_CONFORMANCE_FAIL ${error instanceof Error ? error.stack : String(error)}`);
    if (existsSync(failureLogPath)) console.error(`LEGEND_100K_FAILURE_LOG ${failureLogPath}`);
    process.exitCode = 1;
} finally {
    try {
        host?.close();
        emptyHost?.close();
    } finally {
        delete process.env.RNGPUI_LEGEND_EMPTY_REFERENCE;
        try {
            await perfContention?.stop();
        } finally {
            rmSync(workdir, { recursive: true, force: true });
        }
    }
}

function ensureReanimatedRuntime() {
    const prebuilt = resolve(tsRoot, ".reanimated-prebuilt", "react-native-reanimated.mjs");
    if (existsSync(prebuilt)) return;
    run("bun", ["scripts/prebuild-reanimated.mjs"], "prebuild Reanimated runtime");
}

function bundleFixture(entry, output) {
    run(
        "bun",
        ["scripts/bundle-hermes.mjs", entry, output, "--bytecode"],
        `bundle ${entry}`,
        { NODE_ENV: "production" },
    );
    assert(existsSync(output.replace(/\.js$/, ".hbc")), `Hermes bytecode was emitted for ${entry}`);
}

function run(command, args, label, env = {}) {
    const result = spawnSync(command, args, {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
        throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`);
    }
}

async function tapAndWait(buttonId, index) {
    const tree = await host.dump();
    const button = findNativeId(tree, buttonId);
    assert(button?.bounds, `${buttonId} has runtime bounds`);
    const { x, y, width, height } = button.bounds;
    const startedAt = performance.now();
    const reply = await host.request({ $cmd: "tap", x: x + width / 2, y: y + height / 2 });
    assert(reply.ok, `${buttonId} accepted a real bridge tap`);
    const rowId = `legend-item-${index}`;
    const expectedKind = index % 20 === 0 ? "summary" : "compact";
    const settledTree = await waitForTree(
        (next) => {
            const row = findNativeId(next, rowId);
            return (
                intersectsWindow(row?.bounds) &&
                textContent(row).includes(expectedKind) &&
                textForNativeId(next, "legend-load-status")?.includes(`settled:${index}`)
            );
        },
        `${rowId} and completed imperative scroll`,
    );
    return {
        tree: settledTree,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    };
}

async function waitForTree(predicate, label) {
    return waitForHostTree(host, predicate, label);
}

async function waitForHostTree(targetHost, predicate, label) {
    const deadline = performance.now() + 3_000;
    let latest;
    while (performance.now() < deadline) {
        latest = await targetHost.dump();
        if (predicate(latest)) return latest;
        await sleep(20);
    }
    throw new Error(`timed out waiting for ${label}; state=${JSON.stringify(treeDebugState(latest))}`);
}

function findNativeId(node, nativeId) {
    if (node?.accessibility?.nativeID === nativeId) return node;
    for (const child of node?.children ?? []) {
        const match = findNativeId(child, nativeId);
        if (match) return match;
    }
    return null;
}

function textForNativeId(tree, nativeId) {
    const node = findNativeId(tree, nativeId);
    if (!node) return null;
    return textContent(node);
}

function textContent(node) {
    return [node.text, ...(node.children ?? []).map(textContent)].filter(Boolean).join("");
}

function treeDebugState(tree) {
    const rows = [];
    walk(tree, (node) => {
        const nativeId = node.accessibility?.nativeID;
        if (nativeId?.startsWith("legend-item-")) rows.push({ nativeId, bounds: node.bounds });
    });
    return {
        metrics: treeMetrics(tree),
        status: textForNativeId(tree, "legend-load-status"),
        rows,
    };
}

function treeMetrics(tree) {
    let nodes = 0;
    let visibleNodes = 0;
    let rowNodes = 0;
    let visibleRows = 0;
    let maxDepth = 0;
    const globalIds = new Set();
    let duplicateGlobalIds = 0;
    const types = {};
    walk(tree, (node, depth) => {
        nodes += 1;
        maxDepth = Math.max(maxDepth, depth);
        if (globalIds.has(node.globalId)) duplicateGlobalIds += 1;
        globalIds.add(node.globalId);
        types[node.type] = (types[node.type] ?? 0) + 1;
        if (intersectsWindow(node.bounds)) visibleNodes += 1;
        if (node.accessibility?.nativeID?.startsWith("legend-item-")) {
            rowNodes += 1;
            if (intersectsWindow(node.bounds)) visibleRows += 1;
        }
    });
    return { nodes, visibleNodes, rowNodes, visibleRows, maxDepth, duplicateGlobalIds, types };
}

function walk(node, visit, depth = 0) {
    if (!node) return;
    visit(node, depth);
    for (const child of node.children ?? []) walk(child, visit, depth + 1);
}

function validateTree(metrics, label) {
    assert(metrics.rowNodes > 0, `${label} has mounted rows`);
    assert(metrics.visibleRows > 0, `${label} has visible rows`);
    assert(metrics.duplicateGlobalIds === 0, `${label} has unique native globalIds`);
}

function intersectsWindow(bounds) {
    return !!bounds && bounds.width > 0 && bounds.height > 0 && bounds.x < 900 && bounds.y < 700 && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
}

function startupMetrics(log, launchToUsableMs) {
    const firstRender = /\[startup\] first render \+([\d.]+)ms/.exec(log);
    const legend = /LEGEND_100K_LOAD loaded:([\d.]+)ms app:([\d.]+)ms/.exec(log);
    return {
        nativeFirstRenderMs: firstRender ? Number(firstRender[1]) : null,
        legendLoadMs: legend ? Number(legend[1]) : null,
        legendAppMs: legend ? Number(legend[2]) : null,
        launchToUsableMs: Number(launchToUsableMs.toFixed(1)),
    };
}

function residentMemoryMb(pid) {
    const rssKb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return Number((rssKb / 1024).toFixed(1));
}

function processMemory(pid) {
    return {
        physicalFootprintMb: physicalFootprintMb(pid),
        rssMb: residentMemoryMb(pid),
    };
}

function physicalFootprintMb(pid) {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/footprint")) {
        throw new Error("physical-footprint acceptance requires macOS /usr/bin/footprint");
    }
    let output;
    try {
        output = execFileSync(
            "/usr/bin/footprint",
            ["--pid", String(pid), "--format", "formatted", "--noCategories"],
            { encoding: "utf8" },
        );
    } catch (error) {
        const detail = error?.stderr?.toString().trim() || error?.message || String(error);
        throw new Error(`failed to capture phys_footprint for owned service pid ${pid}: ${detail}`);
    }
    const match = /^\s*phys_footprint:\s+([\d.]+)\s+([KMGT]?B)\s*$/im.exec(output);
    if (!match) {
        throw new Error(`footprint output for owned service pid ${pid} did not contain phys_footprint with units`);
    }
    const unitBytes = {
        B: 1,
        KB: 1024,
        MB: 1024 ** 2,
        GB: 1024 ** 3,
        TB: 1024 ** 4,
    }[match[2]];
    assert(unitBytes, `recognized footprint unit ${match[2]}`);
    return Number(((Number(match[1]) * unitBytes) / 1024 ** 2).toFixed(1));
}

function percentile(values, ratio) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil((sorted.length - 1) * ratio)];
}

function assert(value, message) {
    if (!value) throw new Error(message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
