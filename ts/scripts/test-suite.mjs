#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conformanceEnv, frontmostProcess } from "./conformance-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const concurrency = Number(process.env.RNGPUI_TEST_CONCURRENCY ?? 8);
const frontBefore = frontmostProcess();
const frontBeforeKey = frontKey(frontBefore);
const focusMonitor = startFocusMonitor();
const suiteStart = performance.now();

const tasks = [
    { name: "typecheck", command: "npm", args: ["run", "typecheck"], cwd: root, timeoutMs: 20_000 },
    { name: "animated-driver", command: "bun", args: ["run", "scripts/animated-driver-unit.mjs"], cwd: root, timeoutMs: 10_000 },
    { name: "wire-delta", command: "bun", args: ["run", "scripts/wire-delta-unit.mjs"], cwd: root, timeoutMs: 10_000 },
    { name: "worklet-runtime", command: "bun", args: ["run", "scripts/worklet-runtime-unit.mjs"], cwd: root, timeoutMs: 10_000 },
    { name: "appearance-serialize", command: "bun", args: ["run", "scripts/appearance-serialize-unit.tsx"], cwd: root, timeoutMs: 15_000 },
    { name: "text-baseline", command: "bun", args: ["run", "scripts/text-baseline-conformance.mjs"], cwd: root, timeoutMs: 60_000 },
    { name: "input-visual", command: "node", args: ["scripts/input-visual-conformance.mjs"], cwd: root, timeoutMs: 60_000 },
    { name: "cargo-test", command: "cargo", args: ["test"], cwd: `${repo}/rust`, timeoutMs: 25_000 },
    { name: "appearance", command: "bun", args: ["run", "scripts/appearance-conformance.ts"], cwd: root, timeoutMs: 10_000 },
    { name: "file-picker", command: "bun", args: ["run", "scripts/file-picker-conformance.ts"], cwd: root },
    { name: "display-none", command: "bun", args: ["run", "scripts/display-none-conformance.ts"], cwd: root },
    { name: "diagnostics", command: "node", args: ["scripts/diagnostics-conformance.mjs"], cwd: root, timeoutMs: 15_000 },
    { name: "measure", command: "node", args: ["scripts/run-hermes-example.mjs", "examples/measure-conformance.tsx", "--timeout-ms", "8000"], cwd: root, env: conformanceEnv() },
    { name: "native-layout", command: "node", args: ["scripts/run-hermes-example.mjs", "examples/native-layout-conformance.tsx", "--timeout-ms", "8000"], cwd: root, env: conformanceEnv() },
    {
        name: "native-layout-animation",
        command: "node",
        args: ["scripts/run-hermes-example.mjs", "examples/native-layout-animation-conformance.tsx", "--timeout-ms", "8000"],
        cwd: root,
        env: conformanceEnv(),
    },
    {
        name: "raf-pacing",
        command: "node",
        args: ["scripts/run-hermes-example.mjs", "examples/raf-pacing-conformance.tsx", "--timeout-ms", "15000"],
        cwd: root,
        env: conformanceEnv(),
    },
    { name: "input", command: "node", args: ["scripts/input-conformance-driver.mjs"], cwd: root, timeoutMs: 12_000 },
    { name: "list-group", command: "node", args: ["scripts/list-group-conformance-driver.mjs"], cwd: root, timeoutMs: 20_000 },
    { name: "inspector", command: "node", args: ["scripts/inspector-conformance.mjs"], cwd: root, timeoutMs: 12_000 },
    { name: "reload", command: "node", args: ["scripts/reload-conformance.mjs"], cwd: root, timeoutMs: 18_000 },
    { name: "text-lines", command: "bun", args: ["run", "scripts/text-lines-conformance.mjs"], cwd: root },
    { name: "rounded-overflow", command: "bun", args: ["run", "scripts/rounded-overflow-conformance.mjs"], cwd: root },
    { name: "animation-diff", command: "bun", args: ["run", "scripts/animation-frame-diff.mjs"], cwd: root },
    { name: "offthread-stall", command: "node", args: ["scripts/offthread-stall-conformance.mjs"], cwd: root, timeoutMs: 25_000 },
    { name: "webview-render", command: "bun", args: ["run", "scripts/webview-render-conformance.mjs"], cwd: root, timeoutMs: 12_000 },
    { name: "window-mode", command: "bun", args: ["run", "scripts/window-mode-conformance.mjs"], cwd: root },
    { name: "pseudo-driver", command: "node", args: ["scripts/pseudo-driver-conformance.mjs"], cwd: root, timeoutMs: 20_000 },
];

const results = [];
let next = 0;
let failed = false;

async function worker() {
    while (next < tasks.length) {
        const task = tasks[next++];
        const result = await runTask(task);
        results.push(result);
        const status = result.ok ? "PASS" : "FAIL";
        console.log(`TEST_TASK_${status} ${task.name} seconds=${result.seconds.toFixed(3)}`);
        if (!result.ok) {
            failed = true;
            if (result.output.trim()) {
                console.error(`--- ${task.name} output ---`);
                console.error(result.output.trim());
                console.error(`--- end ${task.name} output ---`);
            }
        }
    }
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

const frontAfter = frontmostProcess();
focusMonitor.stop();
const suiteSeconds = (performance.now() - suiteStart) / 1000;
const unexpectedFocus = [...focusMonitor.samples].filter(
    (sample) => isTestGpuiProcess(sample) && sample.key !== frontBeforeKey,
);
if (unexpectedFocus.length > 0) {
    failed = true;
    console.error(`TEST_SUITE_FOCUS_SAMPLE_FAIL before=${JSON.stringify(frontBefore)} saw=${JSON.stringify(unexpectedFocus)}`);
}

results.sort((a, b) => a.name.localeCompare(b.name));
console.log(`TEST_SUITE_TOTAL seconds=${suiteSeconds.toFixed(3)} frontmost=${JSON.stringify(frontAfter)} tasks=${results.length}`);

if (failed) process.exit(1);
console.log("TEST_SUITE_PASS");

function runTask(task) {
    return new Promise((resolve) => {
        const started = performance.now();
        let output = "";
        const child = spawn(task.command, task.args, {
            cwd: task.cwd,
            env: task.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const timeout = setTimeout(() => {
            output += `\n${task.name} timed out after ${task.timeoutMs ?? 8000}ms\n`;
            child.kill("SIGTERM");
        }, task.timeoutMs ?? 8000);
        child.stdout?.on("data", (chunk) => {
            output += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            output += chunk.toString();
        });
        child.on("exit", (code, signal) => {
            clearTimeout(timeout);
            const seconds = (performance.now() - started) / 1000;
            resolve({
                name: task.name,
                ok: code === 0 && signal == null,
                seconds,
                output,
            });
        });
    });
}

function startFocusMonitor() {
    const samplesByKey = new Map();
    let buffer = "";
    const script = `
import AppKit
import Foundation
while true {
    let app = NSWorkspace.shared.frontmostApplication
    print("\\(app?.processIdentifier ?? 0)\\t\\(app?.localizedName ?? "")")
    fflush(stdout)
    Thread.sleep(forTimeInterval: 0.10)
}
`;
    const child = spawn("swift", ["-e", script], {
        stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) recordSample(samplesByKey, line);
    });
    return {
        get samples() {
            return samplesByKey.values();
        },
        stop() {
            child.kill("SIGTERM");
            if (buffer.trim()) recordSample(samplesByKey, buffer);
        },
    };
}

function recordSample(samplesByKey, line) {
    if (!line.trim()) return;
    const sample = parseFrontmostLine(line);
    if (Number.isFinite(sample.pid) && sample.pid > 0 && sample.key) {
        samplesByKey.set(sample.key, sample);
    }
}

function parseFrontmostLine(line) {
    const [pid, ...nameParts] = line.trim().split("\t");
    const process = { pid: Number(pid), name: nameParts.join("\t") };
    return { ...process, key: frontKey(process) };
}

function frontKey(process) {
    return `${process.pid}\t${process.name}`;
}

function isTestGpuiProcess(process) {
    return process.name === "rngpui-service";
}
