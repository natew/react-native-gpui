#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/rngpui-webview-render-conformance";
const firstPath = `${outDir}/webview-first.png`;
const secondPath = `${outDir}/webview-second.png`;
const diffPath = `${outDir}/webview-clock-diff.png`;
const appName = `RNGPUIWebViewRender${process.pid}`;
const appRoot = `${outDir}/${appName}.app`;
const executable = `${appRoot}/Contents/MacOS/${appName}`;
const logPath = `${outDir}/webview-probe.log`;
const pidPath = `${outDir}/webview-probe.pid`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

launchProbeApp();

try {
    await waitForOutput("page-load finished", 8000);
    const probeWindow = await waitForProbeWindow();
    await sleep(500);
    captureWindow(probeWindow, firstPath);
    await sleep(1250);
    captureWindow(probeWindow, secondPath);

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
    console.log(`WEBVIEW_RENDER_CONFORMANCE_PASS window=${probeWindow.id} crop=${crop} first=${firstPath} second=${secondPath}`);
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
} finally {
    killProbeApp();
}

async function waitForProbeWindow() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const match = listWindows().find(
            (window) =>
                window.owner === appName &&
                window.title === "react-native-gpui" &&
                Math.abs(window.width - 1180) <= 80 &&
                Math.abs(window.height - 760) <= 80,
        );
        if (match) return match;
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
    let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (bounds["Width"] as? NSNumber)?.intValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.intValue ?? 0
    print("\\(number)\\t\\(owner)\\t\\(title)\\t\\(pid)\\t\\(width)\\t\\(height)")
}
`;
    return execFileSync("swift", ["-e", swift], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [id, owner, title, pid, width, height] = line.split("\t");
            return {
                id: Number(id),
                owner,
                title,
                pid: Number(pid),
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
    waitForReadableImage(path);
}

function clockCrop(path) {
    const { width, height } = imageSize(path);
    const cropWidth = Math.min(360, width);
    const cropHeight = Math.min(140, height);
    const x = Math.max(0, Math.round(width / 2 - cropWidth / 2));
    const y = Math.max(0, Math.round(height * 0.54));
    return `${x},${y},${cropWidth},${cropHeight}`;
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

function launchProbeApp() {
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(
        `${appRoot}/Contents/Info.plist`,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIdentifier</key>
  <string>dev.rngpui.webview-render.${process.pid}</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
</dict>
</plist>
`,
    );
    writeFileSync(
        executable,
        `#!/bin/zsh
set -e
export PATH=${quote(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin")}
export HOME=${quote(process.env.HOME || "")}
export USER=${quote(process.env.USER || "")}
export SHELL=${quote(process.env.SHELL || "/bin/zsh")}
export TMPDIR=${quote(process.env.TMPDIR || "/tmp/")}
export RNGPUI_NO_ACTIVATE=1
export RNGPUI_WEBVIEW_DEBUG=1
cd ${quote(root)}
child=0
cleanup() {
  if [[ "$child" != "0" ]]; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
}
trap cleanup TERM INT EXIT
echo $$ > ${quote(pidPath)}
${quote(process.execPath)} examples/webview-probe.tsx > ${quote(logPath)} 2>&1 &
child=$!
wait "$child"
`,
    );
    chmodSync(executable, 0o755);
    execFileSync("open", ["-gj", appRoot], { stdio: "pipe" });
}

function readOutput() {
    return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

function probePid() {
    if (!existsSync(pidPath)) return null;
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function probeExited() {
    const pid = probePid();
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch {
        return true;
    }
}

function killProbeApp() {
    const pid = probePid();
    if (!pid) return;
    try {
        process.kill(pid, "SIGTERM");
    } catch {}
}

function quote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}
