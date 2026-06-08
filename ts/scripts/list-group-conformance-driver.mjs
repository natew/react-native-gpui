import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    conformanceEnv,
    execFileText,
    frontmostProcess,
    listWindows,
    waitForServicePid,
} from "./conformance-utils.mjs";

const deadlineMs = 20_000;
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const repo = dirname(root);
const pidPath = `/tmp/rngpui-list-group-conformance-${process.pid}.pid`;
const treePath = `/tmp/rngpui-list-group-conformance-${process.pid}.json`;
let fixturePid = 0;

await execFileText("cargo", ["test", "--bin", "rngpui-service", "press_drag"], {
    cwd: `${repo}/rust`,
});

const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/list-group-conformance.tsx"], {
    cwd: root,
    env: conformanceEnv({
        RNGPUI_LIST_GROUP_SMOKE: "1",
        RNGPUI_DUMP_TREE: treePath,
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
    const { pid, window } = await waitForFixtureWindow();
    assertFixtureNotFrontmost("during");
    const tree = await waitForSerializedTree();
    if (!hasListGroup(tree, "primary-list")) {
        throw new Error(`missing nativeListGroup primary-list in serialized tree`);
    }
    for (const row of ["alpha", "beta", "gamma"]) {
        if (!hasAccessibilityLabel(tree, `Drag row ${row}`)) {
            throw new Error(`missing row ${row} in serialized tree`);
        }
    }
    await waitForSmokePass(deadlineMs);
    assertFixtureNotFrontmost("after");
    console.log("LIST_GROUP_CONFORMANCE_DRIVER_PASS");
} catch (error) {
    if (!child.killed) child.kill("SIGTERM");
    await cleanupFixtureServices();
    console.error(`LIST_GROUP_CONFORMANCE_DRIVER_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
await cleanupFixtureServices();

async function waitForFixtureWindow() {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < deadlineMs) {
        try {
            const pid = await waitForServicePid(pidPath, {
                timeoutMs: Math.max(50, deadlineMs - (Date.now() - started)),
                isFixtureExited: () => child.exitCode != null,
            });
            if (pid) {
                const window = listWindows()
                    .filter((item) => item.pid === pid && item.title === "react-native-gpui")
                    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
                if (window) {
                    fixturePid = pid;
                    return { pid, window };
                }
                lastError = `missing react-native-gpui window for pid ${pid}`;
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await sleep(150);
    }
    throw new Error(`timed out waiting for list-group window: ${lastError}`);
}

function assertFixtureNotFrontmost(label) {
    const front = frontmostProcess();
    if (fixturePid && front.pid === fixturePid) {
        throw new Error(`fixture became frontmost ${label}: pid=${front.pid} name=${JSON.stringify(front.name)}`);
    }
}

async function waitForSerializedTree() {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < deadlineMs) {
        if (existsSync(treePath)) {
            try {
                return JSON.parse(readFileSync(treePath, "utf8"));
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
        }
        await sleep(50);
    }
    throw new Error(`timed out waiting for serialized tree: ${lastError}`);
}

async function cleanupFixtureServices() {
    if (fixturePid) {
        await execFileText("kill", [String(fixturePid)], { reject: false });
    }
    removeFile(pidPath);
    removeFile(treePath);
}

function waitForSmokePass(timeoutMs) {
    return new Promise((resolve) => {
        if (output.includes("CONFORMANCE list-group smoke PASS")) {
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => {
            if (!child.killed) child.kill("SIGTERM");
            if (output.includes("CONFORMANCE list-group smoke PASS")) {
                resolve(undefined);
                return;
            }
            resolve(new Error(`list-group fixture timed out; output:\n${output.trim()}`));
        }, timeoutMs);
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (output.includes("CONFORMANCE list-group smoke PASS")) {
                resolve(undefined);
                return;
            }
            resolve(new Error(`list-group fixture exited ${code ?? -1}; output:\n${output.trim()}`));
        });
    }).then((result) => {
        if (result instanceof Error) throw result;
    });
}

function hasListGroup(node, id) {
    if (node?.nativeListGroup === id) return true;
    return (node?.children || []).some((child) => hasListGroup(child, id));
}

function hasAccessibilityLabel(node, label) {
    if (node?.accessibility?.label === label) return true;
    return (node?.children || []).some((child) => hasAccessibilityLabel(child, label));
}

function removeFile(path) {
    try {
        if (existsSync(path)) unlinkSync(path);
    } catch {
        // best-effort temp cleanup
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
