import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { conformanceEnv, execFileText, waitForServicePid } from "./conformance-utils.mjs";

const deadlineMs = 20_000;
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const pidPath = `/tmp/rngpui-inspector-conformance-${process.pid}.pid`;
const sentinel = `rngpui-inspector-sentinel-${process.pid}`;
const previousClipboard = await readClipboard();
await writeClipboard(sentinel);
let fixturePid = 0;

const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/inspector-devtools.tsx"], {
    cwd: root,
    env: conformanceEnv({
        RNGPUI_SERVICE_PID_FILE: pidPath,
        RNGPUI_INSPECTOR_COPY_AT: "64,30",
        RNGPUI_INSPECTOR_NO_WEBVIEW: "1",
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
    fixturePid = await waitForServicePid(pidPath, {
        timeoutMs: deadlineMs,
        isFixtureExited: () => child.exitCode != null,
    });

    const snapshot = await waitForClipboardSnapshot();
    assert(snapshot.includes("# react-native-gpui inspector snapshot"), "clipboard should contain an inspector snapshot");
    assert(/^type: text$/m.test(snapshot), `snapshot should target a text node, got:\n${snapshot}`);
    assert(/^label: Inspector$/m.test(snapshot), `snapshot should include the hovered node label, got:\n${snapshot}`);
    assert(/^testID: inspector-title$/m.test(snapshot), `snapshot should include testID, got:\n${snapshot}`);
    assert(/^identifierSource: testID$/m.test(snapshot), `snapshot should identify testID source, got:\n${snapshot}`);
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

async function waitForClipboardSnapshot() {
    const started = Date.now();
    while (Date.now() - started < 3000) {
        const value = await readClipboard();
        if (value.includes("# react-native-gpui inspector snapshot")) return value;
        await sleep(50);
    }
    throw new Error(`clipboard did not receive inspector snapshot; current value: ${await readClipboard()}`);
}

async function readClipboard() {
    const result = await execFileText("pbpaste", [], { reject: false });
    return result.stdout;
}

async function writeClipboard(value) {
    await execFileText("pbcopy", [], { input: value, reject: false });
}

async function cleanupFixtureServices() {
    const pids = fixturePid ? [fixturePid] : [];
    for (const pid of pids) {
        await execFileText("kill", [String(pid)], { reject: false });
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
