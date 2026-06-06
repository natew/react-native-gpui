#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    captureWindow,
    assertWindowOffscreen,
    conformanceEnv,
    frontmostProcess,
    waitForServicePid,
    waitForWindow,
} from "./conformance-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-webview-overlay-conformance";
const screenshotPath = `${outDir}/webview-overlay.png`;
const scrolledScreenshotPath = `${outDir}/webview-overlay-scrolled.png`;
const servicePidPath = `${outDir}/service.pid`;
const expectedWindow = { width: 720, height: 520 };
const webviewFrame = { x: 40, y: 40, width: 640, height: 420 };
const overlayFrame = { x: 160, y: 300, width: 400, height: 96 };
const webviewColor = [0x00, 0xf6, 0xff];
const overlayColor = [0xff, 0x00, 0x7a];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const child = spawn("bun", ["examples/webview-overlay-conformance.tsx"], {
    cwd: root,
    env: conformanceEnv({ RNGPUI_SERVICE_PID_FILE: servicePidPath }),
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

const frontmostBefore = frontmostProcess();
let overlayWindow = null;
let failureMessage = null;

try {
    const pid = await waitForServicePid(servicePidPath, { timeoutMs: 8000, isFixtureExited: overlayExited });
    const window = await waitForOverlayWindow(pid, 8000);
    assertWindowOffscreen(window, "webview overlay conformance window");
    overlayWindow = window;
    await waitForOutputMatch(/WEBVIEW_OVERLAY_MESSAGE ready:(\d+)/, 5000);
    await sleep(2500);
    captureWindow(window, screenshotPath);

    const imageSize = readImageSize(screenshotPath);
    const scaleX = imageSize.width / window.width;
    const scaleY = imageSize.height / window.height;
    const webviewCenter = sampleWindowPixel(
        Math.round(webviewFrame.x + webviewFrame.width / 2),
        Math.round(webviewFrame.y + 54),
    );
    const overlayCenter = sampleWindowPixel(
        Math.round(overlayFrame.x + 48),
        Math.round(overlayFrame.y + overlayFrame.height / 2),
    );
    const clippedCorner = sampleWindowPixel(webviewFrame.x + 2, webviewFrame.y + webviewFrame.height - 2);
    const backing = sampleWindowPixel(8, 8);

    const webviewPainted = nearColor(webviewCenter, webviewColor, 26);
    if (!nearColor(overlayCenter, overlayColor, 26)) {
        throw new Error(`gpui overlay is not above webview: overlay=${overlayCenter.join(",")} expected=${overlayColor.join(",")}`);
    }
    if (webviewPainted && nearColor(clippedCorner, webviewColor, 26)) {
        throw new Error(`webview bottom corner was not clipped: corner=${clippedCorner.join(",")}`);
    }
    if (nearColor(backing, webviewColor, 26) || nearColor(backing, overlayColor, 26) || backing.every((value) => value < 8)) {
        throw new Error(`native backing did not render behind transparent gpui root: backing=${backing.join(",")}`);
    }

    postWheelToPid({
        pid,
        x: window.x + webviewFrame.x + Math.round(webviewFrame.width / 2),
        y: window.y + webviewFrame.y + 54,
        deltaY: -190,
    });
    const scrollTop = await waitForPositiveScrollTop(5000);
    captureWindow(window, scrolledScreenshotPath);

    const frontmostAfter = frontmostProcess();
    if (frontmostBefore.pid !== frontmostAfter.pid) {
        throw new Error(
            `fixture stole focus: before=${frontmostBefore.pid}:${frontmostBefore.name} after=${frontmostAfter.pid}:${frontmostAfter.name}`,
        );
    }

    console.log(
        `WEBVIEW_OVERLAY_CONFORMANCE_PASS window=${window.id} screenshot=${screenshotPath} scrolled=${scrolledScreenshotPath} webviewPainted=${webviewPainted} webview=${webviewCenter.join(",")} overlay=${overlayCenter.join(",")} corner=${clippedCorner.join(",")} backing=${backing.join(",")} scrollTop=${scrollTop}`,
    );

    function sampleWindowPixel(x, y) {
        return samplePixel(screenshotPath, Math.round(x * scaleX), Math.round(y * scaleY));
    }
} catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
} finally {
    await stopFixture();
}
if (failureMessage) fail(failureMessage);

async function waitForOverlayWindow(pid, timeoutMs) {
    return waitForWindow(
        (window) =>
            window.pid === pid &&
            window.title === "react-native-gpui" &&
            Math.abs(window.width - expectedWindow.width) <= 80 &&
            Math.abs(window.height - expectedWindow.height) <= 80,
        {
            timeoutMs,
            isFixtureExited: () => {
                if (!overlayExited()) return false;
                throw new Error(`fixture exited before window appeared: ${exitLabel}\n${readOutput().trim()}`);
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

async function waitForOutputMatch(pattern, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let output = readOutput();
    let match = output.match(pattern);
    while (!match && Date.now() < deadline) {
        await sleep(25);
        if (overlayExited()) break;
        output = readOutput();
        match = output.match(pattern);
    }
    if (!match) {
        throw new Error(`timed out waiting for output ${pattern}: ${readOutput().trim()}`);
    }
    return match;
}

async function waitForPositiveScrollTop(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let scrollTop = latestMessageNumber('scroll');
    while (!(scrollTop > 0) && Date.now() < deadline) {
        await sleep(25);
        if (overlayExited()) break;
        scrollTop = latestMessageNumber('scroll');
    }
    if (!(scrollTop > 0)) {
        throw new Error(`webview wheel forwarding did not move scrollTop: latest=${scrollTop ?? 'none'} output=${readOutput().trim()}`);
    }
    return scrollTop;
}

function latestMessageNumber(kind) {
    const pattern = new RegExp(`WEBVIEW_OVERLAY_MESSAGE ${kind}:(\\d+)`, 'g');
    const output = readOutput();
    let latest = null;
    let match;
    while ((match = pattern.exec(output))) latest = Number(match[1]);
    return latest;
}

function postWheelToPid({ pid, x, y, deltaY }) {
    const swift = `
import CoreGraphics
let env = ProcessInfo.processInfo.environment
let pid = pid_t(Int(env["RNGPUI_SCROLL_PID"]!)!)
let x = Double(env["RNGPUI_SCROLL_X"]!)!
let y = Double(env["RNGPUI_SCROLL_Y"]!)!
let deltaY = Int32(Int(env["RNGPUI_SCROLL_DELTA_Y"]!)!)
guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: 0, wheel3: 0) else {
    fatalError("scroll event creation failed")
}
event.location = CGPoint(x: x, y: y)
event.postToPid(pid)
`;
    execFileSync("swift", ["-e", swift], {
        encoding: "utf8",
        env: {
            ...process.env,
            RNGPUI_SCROLL_PID: String(pid),
            RNGPUI_SCROLL_X: String(x),
            RNGPUI_SCROLL_Y: String(y),
            RNGPUI_SCROLL_DELTA_Y: String(deltaY),
        },
        stdio: "pipe",
    });
}

function nearColor(actual, expected, tolerance) {
    return actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOutput() {
    return output;
}

function overlayExited() {
    return exited;
}

async function stopFixture() {
    killExactPids([overlayWindow?.pid, readPid(servicePidPath), child.pid]);
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

function fail(message) {
    const output = readOutput();
    if (output.trim()) console.error(output.trim());
    console.error(`WEBVIEW_OVERLAY_CONFORMANCE_FAIL ${message}`);
    process.exit(1);
}
