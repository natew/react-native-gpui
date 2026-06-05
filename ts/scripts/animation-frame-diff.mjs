#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-animation-conformance";
const holdMs = 1800;
const durationMs = 10000;
const expectedWidth = 404;
const expectedHeight = 180;

const beforePath = `${outDir}/frame-before.png`;
const midPath = `${outDir}/frame-mid.png`;
const afterPath = `${outDir}/frame-after.png`;
const beforeMidDiffPath = `${outDir}/frame-before-mid-diff.png`;
const midAfterDiffPath = `${outDir}/frame-mid-after-diff.png`;
const treeDumpPath = `${outDir}/animation-tree.json`;

const screenCaptureKitSwift = `
import Foundation
import AppKit
import ScreenCaptureKit

let _ = NSApplication.shared
let windowID = CGWindowID(UInt32(CommandLine.arguments[1])!)
let path = CommandLine.arguments[2]

final class CaptureBox: @unchecked Sendable {
    var code = 0
    var done = false
}

func captureImage(contentFilter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
    do {
        return try await SCScreenshotManager.captureImage(
            contentFilter: contentFilter,
            configuration: configuration
        )
    } catch {
        let ns = error as NSError
        if ns.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && ns.code == -3801 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            return try await SCScreenshotManager.captureImage(
                contentFilter: contentFilter,
                configuration: configuration
            )
        }
        throw error
    }
}

let box = CaptureBox()
Task { @MainActor in
    do {
        let content = try await SCShareableContent.current
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw NSError(
                domain: "AnimationFrameDiff",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "window not found"]
            )
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = NSScreen.screens.first(where: { !$0.frame.intersection(window.frame).isNull })?.backingScaleFactor
            ?? NSScreen.main?.backingScaleFactor
            ?? 1
        config.width = max(1, Int(window.frame.width * scale))
        config.height = max(1, Int(window.frame.height * scale))
        config.showsCursor = false
        config.scalesToFit = true
        config.preservesAspectRatio = true
        config.ignoreShadowsSingleWindow = true
        config.ignoreGlobalClipSingleWindow = true

        let image = try await captureImage(contentFilter: filter, configuration: config)
        let rep = NSBitmapImageRep(cgImage: image)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            throw NSError(
                domain: "AnimationFrameDiff",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "png encode failed"]
            )
        }
        try data.write(to: URL(fileURLWithPath: path))
    } catch {
        fputs("capture failed: \\(error)\\n", stderr)
        box.code = 1
    }
    box.done = true
}

let deadline = Date().addingTimeInterval(8)
while !box.done && Date() < deadline {
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
}
if !box.done {
    fputs("capture timed out\\n", stderr)
    box.code = 1
}
exit(Int32(box.code))
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("bun", ["examples/animation-conformance.tsx"], {
    cwd: root,
    env: {
        ...process.env,
        RNGPUI_NO_ACTIVATE: "1",
        RNGPUI_DUMP_TREE: treeDumpPath,
        RNGPUI_ANIMATION_HOLD_MS: String(holdMs),
        RNGPUI_ANIMATION_DURATION_MS: String(durationMs),
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
    const windowId = await waitForAnimationWindow();
    await sleep(220);
    captureWindow(windowId, beforePath);

    const midFrame = await waitForTreeFrame({ minLeft: 90, maxLeft: 140, timeoutMs: 12000 });
    captureWindow(windowId, midPath);

    await waitForOutput("CONFORMANCE animation PASS", 12000);
    await sleep(160);
    captureWindow(windowId, afterPath);

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

async function waitForAnimationWindow() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const windows = listWindows();
        const match = windows.find(
            (window) =>
                window.owner === "rngpui-service" &&
                window.title === "react-native-gpui" &&
                Math.abs(window.width - expectedWidth) <= 60 &&
                Math.abs(window.height - expectedHeight) <= 60,
        );
        if (match) return match.id;
        await sleep(120);
    }
    throw new Error("animation GPUI window was not found");
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
    let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (bounds["Width"] as? NSNumber)?.intValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.intValue ?? 0
    print("\\(number)\\t\\(pid)\\t\\(owner)\\t\\(title)\\t\\(width)\\t\\(height)")
}
`;
    const raw = execFileSync("swift", ["-e", swift], { encoding: "utf8" });
    return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [id, pid, owner, title, width, height] = line.split("\t");
            return {
                id: Number(id),
                pid: Number(pid),
                owner,
                title,
                width: Number(width),
                height: Number(height),
            };
        })
        .filter((window) => Number.isFinite(window.id) && window.id > 0);
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

function captureWindow(windowId, path) {
    execFileSync("swift", ["-e", screenCaptureKitSwift, String(windowId), path], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (!existsSync(path)) throw new Error(`screencapture did not write ${path}`);
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
