#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureWindow, conformanceEnv, waitForServicePid, waitForWindow } from "./conformance-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-text-lines-conformance";
const screenshotPath = `${outDir}/text-lines.png`;
const pidPath = `${outDir}/service.pid`;
const expectedWidth = 540;
const expectedHeight = 300;
const expectedPasses = [
    "clamped-active-row",
    "reference-row",
    "clamped-active-title",
    "reference-title",
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("bun", ["examples/number-of-lines-conformance.tsx"], {
    cwd: root,
    env: conformanceEnv({ RNGPUI_SERVICE_PID_FILE: pidPath }),
    stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
let exited = false;
let exitLabel = "";

child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
});
child.on("exit", (code, signal) => {
    exited = true;
    exitLabel = `code=${code ?? "null"} signal=${signal ?? "null"}`;
});
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
    await waitForPasses(5000);
    const pid = await waitForServicePid(pidPath, { timeoutMs: 5000, isFixtureExited: () => exited });
    const window = await waitForTextWindow(pid, 5000);
    captureWindow(window, screenshotPath);
    console.log(
        `TEXT_LINES_CONFORMANCE_PASS checks=${expectedPasses.length} window=${window.window_id} screenshot=${screenshotPath}`,
    );
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
} finally {
    await stop();
}

async function waitForPasses(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (/\bFAIL\b/.test(output)) {
            throw new Error(`fixture reported FAIL\n${output.trim()}`);
        }
        const missing = expectedPasses.filter((name) => !linePassed(name));
        if (missing.length === 0) return;
        if (exited) throw new Error(`fixture exited before checks passed: ${exitLabel}\n${output.trim()}`);
        await sleep(50);
    }
    throw new Error(`timed out waiting for checks: ${expectedPasses.join(", ")}\n${output.trim()}`);
}

function linePassed(name) {
    return output
        .split("\n")
        .some((line) => line.includes(`CONFORMANCE numberOfLines ${name}`) && /\bPASS\b/.test(line));
}

async function waitForTextWindow(pid, timeoutMs) {
    return waitForWindow(
        (window) =>
            window.pid === pid &&
            window.title === "react-native-gpui" &&
            Math.abs(window.bounds.width - expectedWidth) <= 80 &&
            Math.abs(window.bounds.height - expectedHeight) <= 80,
        { timeoutMs, isFixtureExited: () => exited },
    );
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stop() {
    if (!child.killed) child.kill("SIGTERM");
    await Promise.race([childExit, sleep(1000)]);
}

function fail(message) {
    if (output.trim()) console.error(output.trim());
    console.error(`TEXT_LINES_CONFORMANCE_FAIL ${message}`);
    process.exit(1);
}
