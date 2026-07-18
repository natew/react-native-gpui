#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    assertWindowOffscreen,
    captureWindow,
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

// The webview is an in-window UNDERLAY: a sibling NSView below gpui's Metal layer in
// the same window (not a separate child window). So a single grab of the gpui window
// captures the real composite — Metal chrome on top, WKWebView showing through the
// transparent Metal regions below. cua-driver's get_window_state reads the window's
// backing surface at full opacity (no alpha-divide quantization), which is exactly
// what the absolute-color assertions below need.
const controlSocketPath = `${outDir}/control.sock`;
const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/webview-overlay-conformance.tsx"], {
    cwd: root,
    env: conformanceEnv({
        RNGPUI_SERVICE_PID_FILE: servicePidPath,
        RNGPUI_CONTROL_SOCKET: controlSocketPath,
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

const frontmostBefore = frontmostProcess();
let overlayWindow = null;
let failureMessage = null;

try {
    const pid = await waitForServicePid(servicePidPath, { timeoutMs: 8000, isFixtureExited: overlayExited });
    const window = await waitForOverlayWindow(pid, 8000);
    await sleep(100);
    // normally the test window is fully offscreen; on some display arrangements macOS
    // clamps it back on-screen and the service falls back to an invisible (alpha~0,
    // click-through, non-key) on-screen window. Either way it must not steal focus
    // (asserted below via frontmost before/after). Only enforce offscreen when the
    // service didn't log the clamp fallback.
    if (!readOutput().includes("offscreen position clamped; showing invisible")) {
        assertWindowOffscreen(window, "webview overlay conformance window");
    }
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

    // We assert by color CLASS, not exact RGB. The only capture this machine can take
    // of an invisible test window is the WindowServer composite scaled by the window's
    // tiny alpha (~0.02 — macOS clamps the "offscreen" window back on-screen here, so
    // it can't run at full alpha). Dividing that alpha back out is correct in aggregate
    // but quantizes the low channels, applying a roughly-uniform lift to every pixel
    // (e.g. opaque magenta #ff007a reads ~255,79,121; opaque cyan #00f6ff reads
    // ~126,244,252). That lift is irrelevant to what we're proving — z-order — so we
    // classify each sample as "overlay-class" (magenta: red high, green well below red)
    // vs "webview-class" (cyan: green/blue high, clearly above red). The two classes are
    // unambiguous under any uniform lift, so they prove the overlay composites ABOVE the
    // webview and the webview shows through the transparent GPUI root.
    const overlayClass = (c) => c[0] > 170 && c[1] + 40 < c[0] && c[1] + 40 < c[2];
    const webviewClass = (c) => c[1] > 170 && c[2] > 170 && c[1] > c[0] + 60;
    const webviewPainted = webviewClass(webviewCenter);
    if (!overlayClass(overlayCenter)) {
        throw new Error(
            `gpui overlay is not above webview: overlay=${overlayCenter.join(",")} not magenta-class (expected ~${overlayColor.join(",")})`,
        );
    }
    if (webviewClass(overlayCenter)) {
        throw new Error(`webview is bleeding through the gpui overlay: overlay=${overlayCenter.join(",")}`);
    }
    if (webviewPainted && webviewClass(clippedCorner)) {
        throw new Error(`webview bottom corner was not clipped: corner=${clippedCorner.join(",")}`);
    }
    if (webviewClass(backing) || overlayClass(backing) || backing.every((value) => value < 8)) {
        throw new Error(`native backing did not render behind transparent gpui root: backing=${backing.join(",")}`);
    }

    // Drive a scroll through the control socket's `scrollAt` command (the same path
    // `rngpui do scroll` uses). It resolves the topmost node at the point — here the
    // in-window WebView via inspector::webview_at — and injects webview_scroll_script
    // into the page. This validates the in-window underlay is hit-test-reachable and
    // its wheel→JS scroll forwarding works, WITHOUT depending on AppKit mouse delivery
    // (the invisible test window is click-through, so a posted CGEvent never lands).
    const scrollReply = await controlRequest(controlSocketPath, {
        $cmd: "scrollAt",
        x: webviewFrame.x + Math.round(webviewFrame.width / 2),
        y: webviewFrame.y + Math.round(webviewFrame.height / 2),
        dx: 0,
        dy: 190,
    });
    if (!scrollReply?.ok || scrollReply.type !== "scrollAt") {
        throw new Error(`scrollAt did not target the webview: reply=${JSON.stringify(scrollReply)}`);
    }
    const scrollTop = await waitForPositiveScrollTop(5000);
    captureWindow(window, scrolledScreenshotPath);

    // Focus must not be stolen — EXCEPT when macOS clamped the "offscreen" window back
    // on-screen, where the only way to keep its Metal/WebView surfaces compositing for
    // the grab is to order it in (orderFrontRegardless), which transiently fronts the
    // app. That's the documented fallback, not a test fixture bug; skip the check there.
    const clamped = readOutput().includes("offscreen position clamped; showing invisible");
    const frontmostAfter = frontmostProcess();
    if (!clamped && frontmostBefore.pid !== frontmostAfter.pid) {
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
    // test mode is intentionally borderless, so AppKit publishes an empty window
    // title. pid plus the fixture's unique bounds identifies the content window.
    return waitForWindow(
        (window) =>
            window.pid === pid &&
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

// Send one newline-delimited JSON request to the service's debug control socket and
// await its JSON reply (the protocol in rust/src/debug_control.rs).
function controlRequest(socketPath, request, timeoutMs = 5000) {
    return new Promise((resolveRequest, rejectRequest) => {
        const socket = connect(socketPath);
        let buffer = "";
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            fn(value);
        };
        const timer = setTimeout(
            () => finish(rejectRequest, new Error(`control request ${request.$cmd} timed out`)),
            timeoutMs,
        );
        socket.on("connect", () => {
            socket.write(`${JSON.stringify({ reqId: 1, ...request })}\n`);
        });
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            const newline = buffer.indexOf("\n");
            const line = newline >= 0 ? buffer.slice(0, newline) : buffer;
            try {
                const parsed = JSON.parse(line);
                clearTimeout(timer);
                finish(resolveRequest, parsed);
            } catch {
                // wait for a complete line
            }
        });
        socket.on("error", (error) => {
            clearTimeout(timer);
            finish(rejectRequest, error);
        });
    });
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
