#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-webview-render-conformance";
const firstPath = `${outDir}/webview-first.png`;
const secondPath = `${outDir}/webview-second.png`;
const diffPath = `${outDir}/webview-clock-diff.png`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("bun", ["examples/webview-probe.tsx"], {
    cwd: root,
    env: {
        ...process.env,
        RNGPUI_NO_ACTIVATE: "1",
        RNGPUI_WEBVIEW_DEBUG: "1",
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

try {
    await waitForOutput("page-load finished", 8000);
    const windowId = await waitForProbeWindow();
    await sleep(500);
    captureWindow(windowId, firstPath);
    await sleep(1250);
    captureWindow(windowId, secondPath);

    const crop = clockCrop(firstPath);
    const raw = execFileSync(
        "bun",
        [
            "scripts/pixel-diff.mjs",
            firstPath,
            secondPath,
            "--crop",
            crop,
            "--threshold",
            "12",
            "--min-diff-ratio",
            "0.001",
            "--diff-out",
            diffPath,
        ],
        { cwd: root, encoding: "utf8" },
    );
    process.stdout.write(raw);
    console.log(`WEBVIEW_RENDER_CONFORMANCE_PASS window=${windowId} crop=${crop} first=${firstPath} second=${secondPath}`);
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
} finally {
    if (!child.killed) child.kill("SIGTERM");
}

async function waitForProbeWindow() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const match = listWindows().find(
            (window) =>
                window.owner === "rngpui-service" &&
                window.title === "react-native-gpui" &&
                Math.abs(window.width - 1180) <= 80 &&
                Math.abs(window.height - 760) <= 80,
        );
        if (match) return match.id;
        await sleep(100);
    }
    throw new Error("webview probe window was not found");
}

function listWindows() {
    const swift = `
import Foundation
import CoreGraphics
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
for window in list {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let title = window[kCGWindowName as String] as? String ?? ""
    let number = (window[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (bounds["Width"] as? NSNumber)?.intValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.intValue ?? 0
    print("\\(number)\\t\\(owner)\\t\\(title)\\t\\(width)\\t\\(height)")
}
`;
    return execFileSync("swift", ["-e", swift], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [id, owner, title, width, height] = line.split("\t");
            return {
                id: Number(id),
                owner,
                title,
                width: Number(width),
                height: Number(height),
            };
        })
        .filter((window) => Number.isFinite(window.id) && window.id > 0);
}

function captureWindow(windowId, path) {
    execFileSync("screencapture", ["-x", "-l", String(windowId), path], { stdio: "pipe" });
    if (!existsSync(path)) throw new Error(`screencapture did not write ${path}`);
}

function clockCrop(path) {
    const { width, height } = imageSize(path);
    const cropWidth = Math.min(760, width);
    const cropHeight = Math.min(220, height);
    const x = Math.max(0, Math.round(width / 2 - cropWidth / 2));
    const y = Math.max(0, Math.round(height * 0.55));
    return `${x},${y},${cropWidth},${cropHeight}`;
}

function imageSize(path) {
    const raw = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
    const width = /pixelWidth: (\d+)/.exec(raw)?.[1];
    const height = /pixelHeight: (\d+)/.exec(raw)?.[1];
    if (!width || !height) throw new Error(`could not read image size for ${path}`);
    return { width: Number(width), height: Number(height) };
}

async function waitForOutput(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (output.includes(needle)) return;
        if (exited) throw new Error(`webview fixture exited before ${needle}: ${exitLabel}\n${output.trim()}`);
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${needle}\n${output.trim()}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
    if (output.trim()) console.error(output.trim());
    console.error(`WEBVIEW_RENDER_CONFORMANCE_FAIL ${message}`);
    process.exit(1);
}
