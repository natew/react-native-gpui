#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureWindow, conformanceEnv, waitForServicePid, waitForWindow } from "./conformance-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-animation-conformance";
const holdMs = 500;
const durationMs = 2800;
const expectedWidth = 404;
const expectedHeight = 180;

const beforePath = `${outDir}/frame-before.png`;
const midPath = `${outDir}/frame-mid.png`;
const afterPath = `${outDir}/frame-after.png`;
const beforeMidDiffPath = `${outDir}/frame-before-mid-diff.png`;
const midAfterDiffPath = `${outDir}/frame-mid-after-diff.png`;
const treeDumpPath = `${outDir}/animation-tree.json`;
const pidPath = `${outDir}/service.pid`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/animation-conformance.tsx"], {
    cwd: root,
    env: conformanceEnv({
        RNGPUI_DUMP_TREE: treeDumpPath,
        RNGPUI_SERVICE_PID_FILE: pidPath,
        RNGPUI_ANIMATION_HOLD_MS: String(holdMs),
        RNGPUI_ANIMATION_DURATION_MS: String(durationMs),
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
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
    const pid = await waitForServicePid(pidPath, { timeoutMs: 5000, isFixtureExited: () => exited });
    const window = await waitForAnimationWindow(pid);
    await sleep(80);
    captureWindow(window, beforePath);

    const midFrame = await waitForTreeFrame({ minLeft: 90, maxLeft: 170, timeoutMs: 6500 });
    captureWindow(window, midPath);

    await waitForOutput("CONFORMANCE animation PASS", 6500);
    await sleep(60);
    captureWindow(window, afterPath);

    await stopChild();

    const beforeMid = pixelDiff(beforePath, midPath, beforeMidDiffPath);
    const midAfter = pixelDiff(midPath, afterPath, midAfterDiffPath);
    console.log(
        [
            "ANIMATION_FRAME_DIFF",
            `before=${beforePath}`,
            `mid=${midPath}`,
            `after=${afterPath}`,
            `beforeMidDiff=${beforeMidDiffPath}`,
            `midAfterDiff=${midAfterDiffPath}`,
            `beforeMidRatio=${beforeMid.ratio}`,
            `midAfterRatio=${midAfter.ratio}`,
            `midLeft=${midFrame.left.toFixed(1)}`,
        ].join(" "),
    );
} catch (error) {
    await stopChild();
    fail(error instanceof Error ? error.message : String(error));
}

async function waitForAnimationWindow(pid) {
    return waitForWindow(
        (window) =>
            window.pid === pid &&
            window.title === "react-native-gpui" &&
            Math.abs(window.width - expectedWidth) <= 60 &&
            Math.abs(window.height - expectedHeight) <= 60,
        { timeoutMs: 5000, isFixtureExited: () => exited },
    );
}

async function waitForTreeFrame({ minLeft, maxLeft, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(treeDumpPath)) {
            const text = readFileSync(treeDumpPath, "utf8");
            const match = /left=([0-9.]+).*phase=running/.exec(text);
            if (match) {
                const left = Number(match[1]);
                if (left >= minLeft && left <= maxLeft) return { left };
            }
        }
        if (exited) throw new Error(`animation fixture exited before mid frame: ${exitLabel}\n${output.trim()}`);
        await sleep(20);
    }
    throw new Error(`timed out waiting for intermediate tree frame in [${minLeft}, ${maxLeft}]\n${output.trim()}`);
}

async function waitForOutput(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (output.includes(needle)) return;
        if (exited) throw new Error(`animation fixture exited before ${needle}: ${exitLabel}\n${output.trim()}`);
        await sleep(40);
    }
    throw new Error(`timed out waiting for ${needle}\n${output.trim()}`);
}

function pixelDiff(before, after, diffOut) {
    const raw = execFileSync(
        "bun",
        [
            "scripts/pixel-diff.mjs",
            before,
            after,
            "--threshold",
            "18",
            "--min-diff-ratio",
            "0.004",
            "--diff-out",
            diffOut,
        ],
        { cwd: root, encoding: "utf8" },
    );
    process.stdout.write(raw);
    const match = /ratio=([0-9.]+)/.exec(raw);
    if (!match) throw new Error(`pixel diff did not report a ratio\n${raw.trim()}`);
    return { ratio: match[1] };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild() {
    if (!child.killed) child.kill("SIGTERM");
    await Promise.race([childExit, sleep(1000)]);
}

function fail(message) {
    if (output.trim()) console.error(output.trim());
    console.error(`ANIMATION_FRAME_DIFF_FAIL ${message}`);
    process.exit(1);
}
