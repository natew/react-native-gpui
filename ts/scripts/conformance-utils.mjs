import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const cuaDriver =
    process.env.CUA_DRIVER ||
    (existsSync("/Users/n8/.local/bin/cua-driver") ? "/Users/n8/.local/bin/cua-driver" : "cua-driver");

export function conformanceEnv(extra = {}) {
    return {
        ...process.env,
        RNGPUI_NO_ACTIVATE: "1",
        RNGPUI_TEST_MODE: "1",
        ...extra,
    };
}

export async function waitForServicePid(pidPath, { timeoutMs = 5000, isFixtureExited } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
        if (existsSync(pidPath)) {
            const pid = Number(readFileSync(pidPath, "utf8").trim());
            if (Number.isFinite(pid) && pid > 0) {
                try {
                    process.kill(pid, 0);
                    return pid;
                } catch (error) {
                    last = error instanceof Error ? error.message : String(error);
                }
            }
        }
        if (isFixtureExited?.()) break;
        await sleep(25);
    }
    throw new Error(`timed out waiting for service pid at ${pidPath}${last ? `: ${last}` : ""}`);
}

export async function waitForWindow(match, { timeoutMs = 5000, isFixtureExited } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const window = listWindows().find(match);
        if (window) return window;
        if (isFixtureExited?.()) break;
        await sleep(50);
    }
    throw new Error("GPUI window was not found");
}

export function listWindows() {
    const swift = `
import Foundation
import CoreGraphics
let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
for window in list {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let title = window[kCGWindowName as String] as? String ?? ""
    let id = (window[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = (bounds["X"] as? NSNumber)?.doubleValue ?? 0
    let y = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0
    let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
    print("\\(id)\\t\\(pid)\\t\\(owner)\\t\\(title)\\t\\(layer)\\t\\(x)\\t\\(y)\\t\\(width)\\t\\(height)")
}
`;
    const raw = execFileSync("swift", ["-e", swift], { encoding: "utf8", stdio: "pipe" });
    return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [id, pid, owner, title, layer, x, y, width, height] = line.split("\t");
            return {
                id: Number(id),
                window_id: Number(id),
                pid: Number(pid),
                owner,
                app_name: owner,
                title,
                layer: Number(layer),
                x: Number(x),
                y: Number(y),
                width: Number(width),
                height: Number(height),
                bounds: {
                    x: Number(x),
                    y: Number(y),
                    width: Number(width),
                    height: Number(height),
                },
            };
        })
        .filter(
            (window) =>
                Number.isFinite(window.id) &&
                window.id > 0 &&
                Number.isFinite(window.pid) &&
                window.pid > 0 &&
                Number.isFinite(window.width) &&
                window.width > 0 &&
                Number.isFinite(window.height) &&
                window.height > 0,
        );
}

export function captureWindow(window, path) {
    execFileSync(
        cuaDriver,
        [
            "call",
            "get_window_state",
            JSON.stringify({
                pid: window.pid,
                window_id: window.id ?? window.window_id,
                capture_mode: "vision",
                screenshot_out_file: path,
            }),
        ],
        { stdio: "pipe" },
    );
    if (!existsSync(path)) throw new Error(`screenshot was not written at ${path}`);
}

export function frontmostApp() {
    return frontmostProcess().name;
}

export function frontmostProcess() {
    const raw = execFileSync(
        "swift",
        [
            "-e",
            `
import AppKit
let app = NSWorkspace.shared.frontmostApplication
print("\\(app?.processIdentifier ?? 0)\\t\\(app?.localizedName ?? "")")
`,
        ],
        {
            encoding: "utf8",
            stdio: "pipe",
        },
    ).trim();
    const [pid, ...nameParts] = raw.split("\t");
    return { pid: Number(pid), name: nameParts.join("\t") };
}

export function screenFrames() {
    const swift = `
import AppKit
for screen in NSScreen.screens {
    let frame = screen.frame
    print("\\(frame.origin.x)\\t\\(frame.origin.y)\\t\\(frame.size.width)\\t\\(frame.size.height)")
}
`;
    return execFileSync("swift", ["-e", swift], { encoding: "utf8", stdio: "pipe" })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [x, y, width, height] = line.split("\t").map(Number);
            return { x, y, width, height };
        });
}

export function assertWindowOffscreen(window, label = "GPUI test window") {
    const frames = screenFrames();
    const visibleFrame = frames.find((frame) => rectsIntersect(window.bounds ?? window, frame));
    if (!visibleFrame) return;
    throw new Error(
        `${label} is on-screen at ${window.x},${window.y} ${window.width}x${window.height}; screen=${visibleFrame.x},${visibleFrame.y} ${visibleFrame.width}x${visibleFrame.height}`,
    );
}

function rectsIntersect(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function execFileText(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(
            command,
            args,
            {
                encoding: "utf8",
                cwd: options.cwd,
                env: options.env,
            },
            (error, stdout, stderr) => {
                if (error && options.reject !== false) {
                    reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
                    return;
                }
                resolve({ stdout, stderr, error });
            },
        );
        if (options.input != null) child.stdin?.end(options.input);
    });
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
