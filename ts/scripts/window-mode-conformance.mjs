#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    captureWindow,
    conformanceEnv,
    frontmostProcess,
    screenFrames,
    waitForServicePid,
    waitForWindow,
    sleep,
} from "./conformance-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-window-mode-conformance";
const pidPath = `${outDir}/service.pid`;
const screenshotPath = `${outDir}/offscreen-window.png`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const frontBefore = frontmostProcess();
const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/rounded-overflow-conformance.tsx"], {
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
    const pid = await waitForServicePid(pidPath, {
        timeoutMs: 5000,
        isFixtureExited: () => exited,
    });
    const window = await waitForWindow(
        (candidate) =>
            candidate.pid === pid &&
            candidate.title === "react-native-gpui" &&
            Math.abs(candidate.width - 220) <= 80 &&
            Math.abs(candidate.height - 180) <= 80,
        {
            timeoutMs: 5000,
            isFixtureExited: () => {
                if (!exited) return false;
                throw new Error(`fixture exited before window appeared: ${exitLabel}\n${output.trim()}`);
            },
        },
    );

    await sleep(100);
    const frontDuring = frontmostProcess();
    captureWindow(window, screenshotPath);
    const frontAfterCapture = frontmostProcess();

    if (frontDuring.pid === pid || frontAfterCapture.pid === pid) {
        throw new Error(
            `fixture became frontmost before=${JSON.stringify(frontBefore)} during=${JSON.stringify(frontDuring)} afterCapture=${JSON.stringify(frontAfterCapture)}`,
        );
    }
    const visibleRatio = windowVisibleRatio(window);
    if (visibleRatio > 0.05) {
        throw new Error(
            `window was not mostly offscreen: x=${window.x} y=${window.y} width=${window.width} height=${window.height} visibleRatio=${visibleRatio.toFixed(4)}`,
        );
    }

    console.log(
        `WINDOW_MODE_CONFORMANCE_PASS frontmost=${JSON.stringify(frontBefore)} window=${window.id} x=${window.x} y=${window.y} visibleRatio=${visibleRatio.toFixed(4)} screenshot=${screenshotPath}`,
    );
} catch (error) {
    if (output.trim()) console.error(output.trim());
    console.error(`WINDOW_MODE_CONFORMANCE_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    if (!child.killed) child.kill("SIGTERM");
    await Promise.race([childExit, sleep(1000)]);
}

function windowVisibleRatio(window) {
    const totalArea = window.width * window.height;
    if (totalArea <= 0) return 1;
    let visible = 0;
    for (const screen of screenFrames()) {
        const left = Math.max(window.x, screen.x);
        const top = Math.max(window.y, screen.y);
        const right = Math.min(window.x + window.width, screen.x + screen.width);
        const bottom = Math.min(window.y + window.height, screen.y + screen.height);
        if (right > left && bottom > top) visible += (right - left) * (bottom - top);
    }
    return visible / totalArea;
}
