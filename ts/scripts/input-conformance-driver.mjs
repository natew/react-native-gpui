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

const child = spawn("node", ["scripts/run-example.mjs", "examples/input-conformance.tsx"], {
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
    const { pid } = await waitForInputWindow();
    // Address the pid's focused element rather than an AX element_index. An index only means
    // something to the daemon that produced the snapshot it came from, and `cua-driver call`
    // is one process per invocation: on a machine reporting `cua-driver daemon is not
    // running` the next call has no record of it and fails deterministically with `Element
    // index 1 not found. Call get_window_state first.` The wait above still requires the
    // engine to tag the input in its AX tree, so that coverage stays.
    //
    // Keys go through `hotkey`. The fixture's assertions are untouched; what follows is the
    // one thing about this gate that is still not deterministic, measured 25 runs per row.
    //
    // An UNMODIFIED Return is lost in roughly one run in ten, on every delivery path cua-driver
    // 0.3.2 offers, and the loss is in the posting rather than in the app: the fixture logs
    // every key it dispatches and a lost run logs none, and 0 of 5 failing runs logged the
    // `blur` the fixture emits whenever the engine takes focus off the input. The window is
    // deliberately non-key (`service.rs:3339`, `show_onscreen_capture_window`: "alpha ~0,
    // non-key, click-through", taken because this display arrangement clamps a fully offscreen
    // window), and a Return carrying a modifier is never lost to the same window:
    //   hotkey ["return"]                     23/25
    //   press_key {pid, key}                  22/25
    //   press_key {pid, window_id, key}       17/25   (NSMenu path, also the focus-stealing one)
    //   hotkey ["shift","return"]           0 losses in ~100 runs
    //   type_text (AX, not a key event)      1 loss in ~100 runs
    // The engine's own key dispatch and multiline submit are covered by input-runtime, which
    // passes and drives the same path without synthetic events. Do not read a red `input` here
    // as an engine defect until the fixture's log shows a keyPress for the Return that the
    // assertion is about.
    //
    // The fixture keeps asking for focus until the engine grants it and logs when it lands;
    // typing before that sends the keystroke to whatever is focused instead, which is nothing.
    await waitForFixture("CONFORMANCE input focused");
    await cuaAction("type_text", {
        pid,
        text: "alpha",
        delay_ms: 0,
    });
    await waitForFixture('change value="alpha"');
    await cuaAction("hotkey", {
        pid,
        keys: ["shift", "return"],
    });
    await waitForFixture('change value="alpha\\n"');
    await cuaAction("type_text", {
        pid,
        text: "beta",
        delay_ms: 0,
    });
    await waitForFixture('change value="alpha\\nbeta"');
    await cuaAction("hotkey", {
        pid,
        keys: ["return"],
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
                        return { pid };
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

// Each step waits for the fixture to report the previous one. Sending all four actions
// back to back lost the submit Return in a fifth of runs - the fixture ends with the draft
// already correct and no Enter, or with the Enter on the shift path - and a 20s fixture
// clock did not change that, so it is the sequencing that is wrong, not a budget. Waiting
// on the fixture's own log line makes the next keystroke depend on the app having drained
// the last one.
function waitForFixture(needle, timeoutMs = 8000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const poll = setInterval(() => {
            if (output.includes(needle)) {
                clearInterval(poll);
                resolve(undefined);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                clearInterval(poll);
                reject(new Error(`fixture never reported ${needle}; output:\n${output.trim()}`));
            }
        }, 20);
    });
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
