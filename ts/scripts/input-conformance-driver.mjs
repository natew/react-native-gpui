import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { conformanceEnv, cuaDriver, execFileText, listWindows, waitForServicePid } from "./conformance-utils.mjs";

const expected = "alpha\nbeta";
const deadlineMs = 20_000;
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const pidPath = `/tmp/rngpui-input-conformance-${process.pid}.pid`;
let fixturePid = 0;

const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/input-conformance.tsx"], {
    cwd: root,
    env: conformanceEnv({
        RNGPUI_INPUT_EXPECT: expected,
        RNGPUI_SERVICE_PID_FILE: pidPath,
    }),
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
    const { pid, windowId, inputIndex } = await waitForInputWindow();
    await cuaAction("type_text", {
        pid,
        window_id: windowId,
        element_index: inputIndex,
        text: "alpha",
        delay_ms: 0,
    });
    await cuaAction("hotkey", {
        pid,
        keys: ["shift", "return"],
    });
    await cuaAction("type_text", {
        pid,
        window_id: windowId,
        element_index: inputIndex,
        text: "beta",
        delay_ms: 0,
    });
    await cuaAction("press_key", {
        pid,
        window_id: windowId,
        element_index: inputIndex,
        key: "return",
    });

    await waitForPass(deadlineMs);
    console.log("INPUT_CONFORMANCE_DRIVER_PASS");
} catch (error) {
    if (!child.killed) child.kill("SIGTERM");
    await cleanupFixtureServices();
    console.error(`INPUT_CONFORMANCE_DRIVER_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
await cleanupFixtureServices();

async function waitForInputWindow() {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < deadlineMs) {
        try {
            const pid = await waitForServicePid(pidPath, {
                timeoutMs: Math.max(50, deadlineMs - (Date.now() - started)),
                isFixtureExited: () => child.exitCode != null,
            });
            if (pid) {
                const windows = listGpuiWindows(pid);
                const window = [...windows]
                    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
                if (window) {
                    const state = await cuaJson("get_window_state", {
                        pid,
                        window_id: window.window_id,
                        capture_mode: "ax",
                        query: "Message conformance",
                    });
                    const inputIndex = elementIndex(state.tree_markdown || "", "Message conformance");
                    if (inputIndex != null) {
                        fixturePid = pid;
                        return { pid, windowId: window.window_id, inputIndex };
                    }
                    lastError = `missing input in tree: ${state.tree_markdown || ""}`;
                }
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await sleep(150);
    }
    throw new Error(`timed out waiting for input window: ${lastError}`);
}

function listGpuiWindows(pid) {
    return listWindows()
        .filter((window) => window.pid === pid)
        .map((window) => ({
            window_id: window.window_id,
            title: window.title,
            layer: window.layer,
            width: window.width,
            height: window.height,
        }));
}

function elementIndex(tree, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\[(\\d+)\\][^\\n]*${escaped}`).exec(tree);
    return match ? Number(match[1]) : null;
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

async function cleanupFixtureServices() {
    const pids = fixturePid ? [fixturePid] : [];
    for (const pid of pids) {
        await execFileText("kill", [String(pid)], { reject: false });
    }
}

function waitForPass(timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (!child.killed) child.kill("SIGTERM");
            if (output.includes("CONFORMANCE input all PASS")) {
                resolve(undefined);
                return;
            }
            resolve(new Error(`input fixture timed out; output:\n${output.trim()}`));
        }, timeoutMs);
        const poll = setInterval(() => {
            if (!output.includes("CONFORMANCE input all PASS")) return;
            clearTimeout(timer);
            clearInterval(poll);
            if (!child.killed) child.kill("SIGTERM");
            resolve(undefined);
        }, 50);
        child.once("exit", (code) => {
            clearTimeout(timer);
            clearInterval(poll);
            if (output.includes("CONFORMANCE input all PASS")) {
                resolve(undefined);
                return;
            }
            resolve(new Error(`input fixture exited ${code ?? -1}; output:\n${output.trim()}`));
        });
    }).then((result) => {
        if (result instanceof Error) throw result;
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
