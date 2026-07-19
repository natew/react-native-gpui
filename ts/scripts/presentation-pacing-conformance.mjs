#!/usr/bin/env bun
// correlate changing native or React content with the final Metal drawable timestamp.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const workdir = mkdtempSync("/tmp/rngpui-presentation-");
const socketPath = join(workdir, "control.sock");
const pidPath = join(workdir, "service.pid");
const require120Hz = process.argv.includes("--require-120hz");
const smokeMode = !process.argv.includes("--react");
let output = "";

const child = spawn(
    "node",
    ["scripts/run-hermes-example.mjs", "examples/presentation-pacing-conformance.tsx", "--timeout-ms", "15000"],
    {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
            ...process.env,
            RNGPUI_APP_NAME: `rngpui-presentation-${process.pid}`,
            RNGPUI_CONTROL_SOCKET: socketPath,
            RNGPUI_SERVICE_PID_FILE: pidPath,
            RNGPUI_NO_ACTIVATE: "1",
            RNGPUI_TEST_MODE: "1",
            RNGPUI_CAPTURE_ONSCREEN: "1",
            RNGPUI_CAPTURE_ALPHA: "0.02",
            RNGPUI_WINDOW_SIZE: "456,120",
            RNGPUI_PRESENTATION_MODE: smokeMode ? "smoke" : "react",
        },
        stdio: ["ignore", "pipe", "pipe"],
    },
);
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

try {
    const readyMarker = smokeMode ? "PRESENTATION_SMOKE_READY" : "PRESENTATION_PROBE_READY";
    await waitFor(() => existsSync(socketPath) && output.includes(readyMarker), 8000);
    if (smokeMode) await waitForPresentationFlow();
    else await sleep(500);
    await request({ $cmd: "presentTraceStart" });
    await request({ $cmd: "traceStart", maxMs: 5000 });
    if (smokeMode) {
        await sleep(1500);
    } else {
        await request({ $cmd: "evalJs", code: "globalThis.__startPresentationProbe()" });
        await waitFor(() => output.includes("PRESENTATION_PROBE_DONE"), 5000);
    }
    await sleep(40);
    const presentation = await request({ $cmd: "presentTraceStop" });
    const paint = await request({ $cmd: "traceStop" });

    const tickMatch = /PRESENTATION_PROBE_DONE ticks=(\d+) p50=([\d.]+)ms p95=([\d.]+)ms/.exec(output);
    if (!smokeMode && !tickMatch) fail("fixture did not report its rAF cadence");
    const ticks = tickMatch ? Number(tickMatch[1]) : 0;
    const frames = (presentation.frames || [])
        .map((frame) => ({ time: Number(frame.presentedTime), contentId: Number(frame.contentId) }))
        .filter((frame) => Number.isFinite(frame.time))
        .sort((a, b) => a.time - b.time);
    const visualFrames = [];
    for (const frame of frames) {
        const previous = visualFrames[visualFrames.length - 1];
        if (previous && frame.time - previous.time <= 0.001) visualFrames[visualFrames.length - 1] = frame;
        else visualFrames.push(frame);
    }
    const gaps = visualFrames.slice(1).map((frame, index) => (frame.time - visualFrames[index].time) * 1000);
    const contentChanges = visualFrames.filter(
        (frame, index) => frame.contentId > 0 && (index === 0 || frame.contentId !== visualFrames[index - 1].contentId),
    ).length;
    const p50 = percentile(gaps, 0.5);
    const p95 = percentile(gaps, 0.95);
    const paintGaps = paint.paintGapsMs || [];
    const paintP50 = percentile(paintGaps, 0.5);
    const paintP95 = percentile(paintGaps, 0.95);
    const result =
        `mode=${smokeMode ? "native-smoke" : "react"} ticks=${ticks} ` +
        `tickP50=${tickMatch?.[2] ?? "n/a"}ms tickP95=${tickMatch?.[3] ?? "n/a"}ms ` +
        `paints=${paint.framesPainted} paintP50=${paintP50.toFixed(2)}ms paintP95=${paintP95.toFixed(2)}ms ` +
        `drawables=${frames.length} visualFrames=${visualFrames.length} contentChanges=${contentChanges} ` +
        `presentP50=${p50.toFixed(2)}ms presentP95=${p95.toFixed(2)}ms ` +
        `presentOver12.5=${gaps.filter((gap) => gap > 12.5).length}`;
    const failures = [];
    if (!presentation.ok || !paint.ok || !gaps.length) failures.push("presentation samples were missing");
    if (!smokeMode && paint.framesPainted < ticks * 0.9) failures.push(`only ${paint.framesPainted}/${ticks} rAF ticks painted`);
    if (!smokeMode && contentChanges < ticks * 0.85) failures.push(`only ${contentChanges}/${ticks} rAF ticks reached distinct visual frames`);
    if (smokeMode && contentChanges < (require120Hz ? 160 : 150)) failures.push(`only ${contentChanges} native visual changes reached the display`);
    if (p50 > (require120Hz ? 10 : 18)) failures.push(`presentation median ${p50.toFixed(2)}ms missed ${require120Hz ? "120" : "60"}Hz`);
    if (require120Hz && p95 > 10) failures.push(`presentation p95 ${p95.toFixed(2)}ms missed 120Hz`);
    if (require120Hz && gaps.filter((gap) => gap > 12.5).length > 5) failures.push("more than five display intervals were missed");
    if (failures.length) fail(`${result}\n  ${failures.join("\n  ")}`);
    console.log(`PRESENTATION_PACING_PASS ${result}`);
} finally {
    if (child.exitCode == null) child.kill("SIGTERM");
    rmSync(workdir, { recursive: true, force: true });
}

function request(body, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let data = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`${body.$cmd} timed out`));
        }, timeoutMs);
        socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
        socket.on("data", (chunk) => {
            data += chunk;
            if (!data.includes("\n")) return;
            clearTimeout(timer);
            socket.destroy();
            resolve(JSON.parse(data.trim()));
        });
        socket.on("error", reject);
    });
}

function percentile(values, fraction) {
    if (!values.length) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        if (child.exitCode != null) fail(`fixture exited early\n${output}`);
        await sleep(25);
    }
    fail(`timed out\n${output}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPresentationFlow() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await request({ $cmd: "presentTraceStart" });
        await sleep(200);
        const probe = await request({ $cmd: "presentTraceStop" });
        const times = new Set((probe.frames || []).map((frame) => Number(frame.presentedTime).toFixed(4)));
        if (times.size >= 12) return;
    }
    fail(`composited window never reached steady presentation\n${output}`);
}

function fail(message) {
    if (output.trim()) console.error(output.trim());
    console.error(`PRESENTATION_PACING_FAIL ${message}`);
    process.exit(1);
}
