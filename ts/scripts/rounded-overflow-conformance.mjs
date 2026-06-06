#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureWindow, conformanceEnv, waitForServicePid, waitForWindow } from "./conformance-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-rounded-overflow-conformance";
const screenshotPath = `${outDir}/rounded-overflow.png`;
const pidPath = `${outDir}/service.pid`;
const expectedWindow = { width: 220, height: 180 };
const frame = { x: 40, y: 30, width: 140, height: 110 };
const rootColor = [0x10, 0x20, 0x30];
const childColor = [0xff, 0x00, 0x33];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("bun", ["examples/rounded-overflow-conformance.tsx"], {
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
const childExit = new Promise((resolveExit) => child.once("exit", resolveExit));

try {
    const pid = await waitForServicePid(pidPath, { timeoutMs: 5000, isFixtureExited: () => exited });
    const window = await waitForRoundedWindow(pid, 5000);
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

async function waitForRoundedWindow(pid, timeoutMs) {
    return waitForWindow(
        (window) =>
            window.pid === pid &&
            window.title === "react-native-gpui" &&
            Math.abs(window.width - expectedWindow.width) <= 80 &&
            Math.abs(window.height - expectedWindow.height) <= 80,
        {
            timeoutMs,
            isFixtureExited: () => {
                if (!exited) return false;
                throw new Error(`fixture exited before window appeared: ${exitLabel}\n${output.trim()}`);
            },
        },
    );
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
