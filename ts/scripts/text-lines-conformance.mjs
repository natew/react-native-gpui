#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-text-lines-conformance";
const screenshotPath = `${outDir}/text-lines.png`;
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
    env: {
        ...process.env,
        RNGPUI_NO_ACTIVATE: "1",
    },
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
    const window = await waitForTextWindow(5000);
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

async function waitForTextWindow(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const match = listWindows().find(
            (window) =>
                window.app_name === "rngpui-service" &&
                window.title === "react-native-gpui" &&
                window.is_on_screen &&
                Math.abs(window.bounds.width - expectedWidth) <= 80 &&
                Math.abs(window.bounds.height - expectedHeight) <= 80,
        );
        if (match) return match;
        await sleep(100);
    }
    throw new Error("text-lines GPUI window was not found");
}

function listWindows() {
    const swift = `
import Foundation
import CoreGraphics
let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
for window in list {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let title = window[kCGWindowName as String] as? String ?? ""
    let id = (window[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (bounds["Width"] as? NSNumber)?.intValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.intValue ?? 0
    print("\\(id)\\t\\(pid)\\t\\(owner)\\t\\(title)\\t\\(width)\\t\\(height)")
}
`;
    const raw = execFileSync("swift", ["-e", swift], {
        encoding: "utf8",
        stdio: "pipe",
    });
    return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [window_id, pid, app_name, title, width, height] = line.split("\t");
            return {
                window_id: Number(window_id),
                pid: Number(pid),
                app_name,
                title,
                is_on_screen: Number(width) > 0 && Number(height) > 0,
                bounds: {
                    width: Number(width),
                    height: Number(height),
                },
            };
        })
        .filter((window) => Number.isFinite(window.window_id) && window.window_id > 0);
}

function captureWindow(window, path) {
    execFileSync(
        "cua-driver",
        [
            "call",
            "get_window_state",
            JSON.stringify({
                pid: window.pid,
                window_id: window.window_id,
                capture_mode: "vision",
                screenshot_out_file: path,
            }),
        ],
        { encoding: "utf8", stdio: "pipe" },
    );
    if (!existsSync(path)) throw new Error(`screenshot was not written at ${path}`);
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
