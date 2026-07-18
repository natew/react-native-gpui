#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowOffscreen, captureWindow, conformanceEnv, waitForServicePid, waitForWindow } from "./conformance-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-webview-render-conformance";
const firstPath = `${outDir}/webview-first.png`;
const secondPath = `${outDir}/webview-second.png`;
const servicePidPath = `${outDir}/service.pid`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/webview-probe.tsx"], {
    cwd: root,
    env: conformanceEnv({
        RNGPUI_SERVICE_PID_FILE: servicePidPath,
        RNGPUI_WEBVIEW_DEBUG: "1",
        RNGPUI_WEBVIEW_EVENT_DEBUG: "1",
    }),
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
child.on("error", (error) => {
    exited = true;
    exitLabel = `spawn error=${error.message}`;
    output += `${exitLabel}\n`;
});
const childExit = new Promise((resolveExit) => child.once("exit", resolveExit));

let probeWindow = null;
let failureMessage = null;

try {
    await waitForOutput("load is_html", 8000);
    const servicePid = await waitForServicePid(servicePidPath, { timeoutMs: 8000, isFixtureExited: probeExited });
    probeWindow = await waitForProbeWindow(servicePid);
    if (!readOutput().includes("offscreen position clamped; showing invisible")) {
        assertWindowOffscreen(probeWindow, "webview render conformance window");
    }
    await sleep(250);
    captureWindow(probeWindow, firstPath);
    waitForReadableImage(firstPath);
    await sleep(450);
    captureWindow(probeWindow, secondPath);
    waitForReadableImage(secondPath);

    console.log(`WEBVIEW_RENDER_CONFORMANCE_PASS window=${probeWindow.id} capture=wkwebview-underlay-not-readable first=${firstPath} second=${secondPath}`);
} catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
} finally {
    await stopFixture();
}
if (failureMessage) fail(failureMessage);

async function waitForProbeWindow(pid) {
    return waitForWindow(
        (window) =>
            window.pid === pid &&
            Math.abs(window.width - 1180) <= 80 &&
            Math.abs(window.height - 760) <= 80,
        {
            timeoutMs: 8000,
            isFixtureExited: () => {
                if (!probeExited()) return false;
                throw new Error(`webview fixture exited before window appeared: ${exitLabel}\n${readOutput().trim()}`);
            },
        },
    );
}

function imageSize(path) {
    const raw = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
    const width = /pixelWidth: (\d+)/.exec(raw)?.[1];
    const height = /pixelHeight: (\d+)/.exec(raw)?.[1];
    if (!width || !height) throw new Error(`could not read image size for ${path}`);
    return { width: Number(width), height: Number(height) };
}

function waitForReadableImage(path) {
    let lastError = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (existsSync(path)) {
            try {
                imageSize(path);
                return;
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
        }
        execFileSync("sleep", ["0.1"]);
    }
    throw new Error(`screenshot was not readable at ${path}${lastError ? `: ${lastError}` : ""}`);
}

async function waitForOutput(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const output = readOutput();
        if (output.includes(needle)) return;
        if (probeExited()) throw new Error(`webview fixture exited before ${needle}\n${output.trim()}`);
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${needle}\n${readOutput().trim()}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
    const output = readOutput();
    if (output.trim()) console.error(output.trim());
    console.error(`WEBVIEW_RENDER_CONFORMANCE_FAIL ${message}`);
    process.exit(1);
}

function readOutput() {
    return output;
}

function probeExited() {
    return exited;
}

async function stopFixture() {
    killExactPids([probeWindow?.pid, readPid(servicePidPath), child.pid]);
    await Promise.race([childExit, sleep(1000)]);
}

function readPid(path) {
    if (!existsSync(path)) return null;
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function killExactPids(values) {
    const pids = [...new Set(values.filter((pid) => Number.isFinite(pid) && pid > 0))];
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {}
    }
    const deadline = Date.now() + 800;
    while (Date.now() < deadline && pids.some(pidAlive)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    for (const pid of pids) {
        if (!pidAlive(pid)) continue;
        try {
            process.kill(pid, "SIGKILL");
        } catch {}
    }
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
