import { spawn, execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const expected = "alpha\nbeta";
const servicePattern = "/react-native-gpui/ts/native/rngpui-service";
const deadlineMs = 20_000;
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const cuaDriver = "/Users/n8/.local/bin/cua-driver";
const ignoredServicePids = new Set(await servicePids());
let fixturePid = 0;

const child = spawn("bun", ["run", "examples/input-conformance.tsx"], {
    cwd: root,
    env: {
        ...process.env,
        RNGPUI_INPUT_EXPECT: expected,
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
            const pid = await servicePid();
            if (pid) {
                const windows = await cuaJson("list_windows", { pid });
                const window = [...(windows.windows || [])]
                    .filter((item) => item.title === "react-native-gpui")
                    .sort((a, b) => Number(b.is_on_screen) - Number(a.is_on_screen))[0];
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

async function servicePid() {
    const pids = await servicePids();
    const fresh = pids.filter((pid) => !ignoredServicePids.has(pid));
    return fresh.sort((a, b) => b - a)[0] ?? 0;
}

async function servicePids() {
    const result = await execFileText("pgrep", ["-alf", servicePattern], { reject: false });
    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => /^(\d+)\s+(.+)$/.exec(line))
        .filter(Boolean)
        .filter((match) => match?.[2].includes(servicePattern))
        .map((match) => Number(match?.[1]))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
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

function execFileText(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
            if (error && options.reject !== false) {
                reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
                return;
            }
            resolve({ stdout, stderr, error });
        });
    });
}

async function cleanupFixtureServices() {
    const pids = new Set(await servicePids());
    if (fixturePid) pids.add(fixturePid);
    for (const pid of pids) {
        if (ignoredServicePids.has(pid)) continue;
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
