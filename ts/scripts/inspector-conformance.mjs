import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const deadlineMs = 20_000;
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const servicePath = join(root, "native", "rngpui-service");
const cuaDriver = process.env.CUA_DRIVER || (existsSync("/Users/n8/.local/bin/cua-driver") ? "/Users/n8/.local/bin/cua-driver" : "cua-driver");
const sentinel = `rngpui-inspector-sentinel-${process.pid}`;
const previousClipboard = await readClipboard();
const ignoredServicePids = new Set(await servicePids());
let fixturePid = 0;

const child = spawn("bun", ["run", "examples/inspector-devtools.tsx"], {
    cwd: root,
    env: {
        ...process.env,
        RNGPUI_NO_ACTIVATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
    output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
    output += chunk.toString();
});

try {
    const { pid, windowId } = await waitForInspectorWindow();
    await writeClipboard(sentinel);

    await cuaJson("get_window_state", {
        pid,
        window_id: windowId,
        capture_mode: "vision",
    });

    await cuaAction("click", {
        pid,
        window_id: windowId,
        x: 124,
        y: 62,
        modifier: ["option"],
    });

    const snapshot = await waitForClipboardSnapshot();
    assert(snapshot.includes("# react-native-gpui inspector snapshot"), "clipboard should contain an inspector snapshot");
    assert(/^type: text$/m.test(snapshot), `snapshot should target a text node, got:\n${snapshot}`);
    assert(/^label: Inspector$/m.test(snapshot), `snapshot should include the hovered node label, got:\n${snapshot}`);
    assert(snapshot !== sentinel, "inspector should replace the sentinel clipboard value");

    console.log("INSPECTOR_CONFORMANCE_PASS");
} catch (error) {
    console.error(`INSPECTOR_CONFORMANCE_FAIL ${error instanceof Error ? error.message : String(error)}`);
    if (output.trim()) console.error(output.trim());
    process.exitCode = 1;
} finally {
    if (!child.killed) child.kill("SIGTERM");
    await cleanupFixtureServices();
    await writeClipboard(previousClipboard);
}

async function waitForInspectorWindow() {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < deadlineMs) {
        try {
            const pid = await servicePid();
            if (pid) {
                const windows = await listGpuiWindows(pid);
                const window = windows
                    .filter((item) => item.title === "react-native-gpui")
                    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
                if (window) {
                    fixturePid = pid;
                    return { pid, windowId: window.window_id };
                }
                lastError = `no react-native-gpui window for pid ${pid}`;
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        if (child.exitCode != null) {
            throw new Error(`inspector fixture exited ${child.exitCode}; output:\n${output.trim()}`);
        }
        await sleep(150);
    }
    throw new Error(`timed out waiting for inspector window: ${lastError}`);
}

async function servicePid() {
    const pids = await servicePids();
    const fresh = pids.filter((pid) => !ignoredServicePids.has(pid));
    return fresh.sort((a, b) => b - a)[0] ?? 0;
}

async function servicePids() {
    const result = await execFileText("pgrep", ["-alf", "rngpui-service"], { reject: false });
    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => /^(\d+)\s+(.+)$/.exec(line))
        .filter(Boolean)
        .filter((match) => match?.[2].includes(servicePath))
        .map((match) => Number(match?.[1]))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
}

async function listGpuiWindows(pid) {
    const swift = `
import Foundation
import CoreGraphics
let targetPid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
for window in list {
    let ownerPid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    if ownerPid != targetPid { continue }
    let id = (window[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let title = window[kCGWindowName as String] as? String ?? ""
    let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
    print("\\(id)\\t\\(title)\\t\\(layer)\\t\\(width)\\t\\(height)")
}
`;
    const result = await execFileText("swift", ["-e", swift, String(pid)]);
    return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [window_id, title, layer, width, height] = line.split("\t");
            return {
                window_id: Number(window_id),
                title,
                layer: Number(layer),
                width: Number(width),
                height: Number(height),
            };
        })
        .filter((window) => Number.isFinite(window.window_id) && window.window_id > 0 && window.width > 0 && window.height > 0);
}

async function waitForClipboardSnapshot() {
    const started = Date.now();
    while (Date.now() - started < 3000) {
        const value = await readClipboard();
        if (value.includes("# react-native-gpui inspector snapshot")) return value;
        await sleep(50);
    }
    throw new Error(`clipboard did not receive inspector snapshot; current value: ${await readClipboard()}`);
}

async function cuaAction(tool, args) {
    await execFileText(cuaDriver, ["call", tool, JSON.stringify(args)]);
}

async function cuaJson(tool, args) {
    const result = await execFileText(cuaDriver, ["call", tool, JSON.stringify(args)]);
    const start = result.stdout.indexOf("{");
    const end = result.stdout.lastIndexOf("}");
    if (start < 0 || end < start) {
        throw new Error(`${tool} did not return JSON: ${result.stdout.trim()}`);
    }
    return JSON.parse(result.stdout.slice(start, end + 1));
}

async function readClipboard() {
    const result = await execFileText("pbpaste", [], { reject: false });
    return result.stdout;
}

async function writeClipboard(value) {
    await execFileText("pbcopy", [], { input: value, reject: false });
}

async function cleanupFixtureServices() {
    const pids = new Set(await servicePids());
    if (fixturePid) pids.add(fixturePid);
    for (const pid of pids) {
        if (ignoredServicePids.has(pid)) continue;
        await execFileText("kill", [String(pid)], { reject: false });
    }
}

function execFileText(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const childProcess = execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
            if (error && options.reject !== false) {
                reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
                return;
            }
            resolve({ stdout, stderr, error });
        });
        if (options.input != null) childProcess.stdin?.end(options.input);
    });
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
