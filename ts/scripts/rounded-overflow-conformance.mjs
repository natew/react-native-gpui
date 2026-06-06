#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-rounded-overflow-conformance";
const screenshotPath = `${outDir}/rounded-overflow.png`;
const expectedWindow = { width: 220, height: 180 };
const frame = { x: 40, y: 30, width: 140, height: 110 };
const rootColor = [0x10, 0x20, 0x30];
const childColor = [0xff, 0x00, 0x33];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("bun", ["examples/rounded-overflow-conformance.tsx"], {
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
const childExit = new Promise((resolveExit) => child.once("exit", resolveExit));

try {
    const window = await waitForWindow(8000);
    captureWindow(window, screenshotPath);
    const imageSize = readImageSize(screenshotPath);
    const scaleX = imageSize.width / window.width;
    const scaleY = imageSize.height / window.height;
    const corner = samplePixel(
        screenshotPath,
        Math.round((frame.x + 2) * scaleX),
        Math.round((frame.y + 2) * scaleY),
    );
    const center = samplePixel(
        screenshotPath,
        Math.round((frame.x + frame.width / 2) * scaleX),
        Math.round((frame.y + frame.height / 2) * scaleY),
    );

    if (!nearColor(corner, rootColor, 18)) {
        throw new Error(`rounded corner leaked child color: corner=${corner.join(",")} expected=${rootColor.join(",")}`);
    }
    if (!isRedContent(center)) {
        throw new Error(`child content did not render in clipped frame: center=${center.join(",")} expected=${childColor.join(",")}`);
    }

    console.log(
        `ROUNDED_OVERFLOW_CONFORMANCE_PASS window=${window.id} screenshot=${screenshotPath} corner=${corner.join(",")} center=${center.join(",")}`,
    );
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
} finally {
    await stop();
}

async function waitForWindow(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const match = listWindows().find(
            (window) =>
                window.owner === "rngpui-service" &&
                window.title === "react-native-gpui" &&
                Math.abs(window.width - expectedWindow.width) <= 80 &&
                Math.abs(window.height - expectedWindow.height) <= 80,
        );
        if (match) return match;
        if (exited) throw new Error(`fixture exited before window appeared: ${exitLabel}\n${output.trim()}`);
        await sleep(100);
    }
    throw new Error("rounded overflow GPUI window was not found");
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
    let id = (window[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (bounds["Width"] as? NSNumber)?.intValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.intValue ?? 0
    print("\\(id)\\t\\(pid)\\t\\(owner)\\t\\(title)\\t\\(width)\\t\\(height)")
}
`;
    return execFileSync("swift", ["-e", swift], { encoding: "utf8", stdio: "pipe" })
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
        .filter((window) => Number.isFinite(window.id) && window.id > 0 && Number.isFinite(window.pid) && window.pid > 0);
}

function captureWindow(window, path) {
    execFileSync(
        "cua-driver",
        [
            "call",
            "get_window_state",
            JSON.stringify({
                pid: window.pid,
                window_id: window.id,
                capture_mode: "vision",
                screenshot_out_file: path,
            }),
        ],
        { stdio: "pipe" },
    );
    if (!existsSync(path)) throw new Error(`screenshot was not written at ${path}`);
}

function readImageSize(path) {
    const raw = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
    const width = /pixelWidth: (\d+)/.exec(raw)?.[1];
    const height = /pixelHeight: (\d+)/.exec(raw)?.[1];
    if (!width || !height) throw new Error(`could not read screenshot size for ${path}`);
    return { width: Number(width), height: Number(height) };
}

function samplePixel(path, x, y) {
    const swift = `
import AppKit
let env = ProcessInfo.processInfo.environment
let path = env["RNGPUI_PIXEL_PATH"]!
let x = Int(env["RNGPUI_PIXEL_X"]!)!
let y = Int(env["RNGPUI_PIXEL_Y"]!)!
guard let image = NSImage(contentsOfFile: path), let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let color = bitmap.colorAt(x: x, y: y) else {
    fatalError("pixel sample failed")
}
let converted = color.usingColorSpace(.deviceRGB) ?? color
print("\\(Int(round(converted.redComponent * 255)))\\t\\(Int(round(converted.greenComponent * 255)))\\t\\(Int(round(converted.blueComponent * 255)))")
`;
    const raw = execFileSync("swift", ["-e", swift], {
        encoding: "utf8",
        env: {
            ...process.env,
            RNGPUI_PIXEL_PATH: path,
            RNGPUI_PIXEL_X: String(x),
            RNGPUI_PIXEL_Y: String(y),
        },
        stdio: "pipe",
    });
    return raw.trim().split("\t").map((part) => Number(part));
}

function nearColor(actual, expected, tolerance) {
    return actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

function isRedContent(actual) {
    return actual[0] >= 180 && actual[1] <= 130 && actual[2] <= 130;
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
    console.error(`ROUNDED_OVERFLOW_CONFORMANCE_FAIL ${message}`);
    process.exit(1);
}
