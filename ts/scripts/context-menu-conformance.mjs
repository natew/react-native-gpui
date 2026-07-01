#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(tsRoot, "..");
const outDir = process.argv[2] || "/tmp/rngpui-context-menu-conformance";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const outJs = join(outDir, "app.js");
const outHbc = join(outDir, "app.hbc");
const controlSocket = join(outDir, "control.sock");

const bundle = spawnSync(
    "bun",
    ["scripts/bundle-hermes.mjs", resolve(tsRoot, "examples/context-menu-conformance.tsx"), outJs, "--bytecode"],
    { cwd: tsRoot, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
);
if (bundle.status !== 0) {
    process.stderr.write(bundle.stdout || "");
    process.stderr.write(bundle.stderr || "");
    fail("bundle failed");
}

const serviceBin = resolve(
    process.env.RNGPUI_SERVICE || resolve(repoRoot, "rust", "target", "release", "rngpui-service"),
);
if (!existsSync(serviceBin)) fail(`rngpui-service not found: ${serviceBin} (build it or set RNGPUI_SERVICE)`);

let output = "";
const child = spawn(serviceBin, [], {
    cwd: tsRoot,
    env: {
        ...process.env,
        RNGPUI_BUNDLE: outHbc,
        RNGPUI_NO_ACTIVATE: "1",
        RNGPUI_TEST_MODE: "1",
        RNGPUI_CONTROL_SOCKET: controlSocket,
    },
    stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (c) => (output += c.toString()));
child.stderr?.on("data", (c) => (output += c.toString()));

try {
    await waitFor(() => /CONFORMANCE context-menu READY/.test(output), 8000, "READY");
    await waitFor(() => /CONFORMANCE context-menu BOX/.test(output), 6000, "BOX measure");
    const boxLine = /CONFORMANCE context-menu BOX x=([\d.-]+) y=([\d.-]+) w=([\d.-]+) h=([\d.-]+)/.exec(output);
    if (!boxLine) fail("no BOX line");
    const box = { x: Number(boxLine[1]), y: Number(boxLine[2]), width: Number(boxLine[3]), height: Number(boxLine[4]) };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const result = await controlRequest("realcontext", x, y);
    if (!result?.handlerFired) fail(`realcontext did not emit a bridge event: ${JSON.stringify(result)}`);
    await waitFor(() => /CONFORMANCE context-menu FIRED/.test(output), 3000, "contextMenu handler");
} catch (error) {
    stop();
    fail(`${error instanceof Error ? error.message : String(error)}\n--- output ---\n${output.trim()}`);
}
stop();

const fired = /CONFORMANCE context-menu FIRED button=(\d+) buttons=(\d+) nativeButton=(\d+) nativeButtons=(\d+) pageX=([\d.-]+) pageY=([\d.-]+)/.exec(output);
if (!fired) fail(`missing fired payload\n--- output ---\n${output.trim()}`);
const [button, buttons, nativeButton, nativeButtons] = fired.slice(1, 5).map(Number);
if (button !== 2 || buttons !== 2 || nativeButton !== 2 || nativeButtons !== 2) {
    fail(`wrong button payload button=${button} buttons=${buttons} nativeButton=${nativeButton} nativeButtons=${nativeButtons}`);
}

console.log(
    [
        "CONTEXT_MENU_CONFORMANCE PASS",
        `button=${button}`,
        `buttons=${buttons}`,
        `nativeButton=${nativeButton}`,
        `nativeButtons=${nativeButtons}`,
    ].join(" "),
);
process.exit(0);

function controlRequest(command, x, y) {
    return new Promise((resolveRequest, rejectRequest) => {
        const socket = net.connect(controlSocket);
        let buffer = "";
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            fn(value);
        };
        const timer = setTimeout(
            () => finish(rejectRequest, new Error(`control request ${command} timed out`)),
            5000,
        );
        socket.on("connect", () => {
            socket.write(`${JSON.stringify({ reqId: 1, $cmd: command, x, y })}\n`);
        });
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            const line = buffer.slice(0, newline);
            try {
                const parsed = JSON.parse(line);
                clearTimeout(timer);
                finish(resolveRequest, parsed);
            } catch {
                // wait for a complete JSON line
            }
        });
        socket.on("error", (error) => {
            clearTimeout(timer);
            finish(rejectRequest, error);
        });
    });
}

function stop() {
    if (child.exitCode == null) {
        try {
            child.kill("SIGTERM");
        } catch {}
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return;
        if (child.exitCode != null) throw new Error(`service exited before ${label}`);
        await sleep(20);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function fail(message) {
    console.error(`CONTEXT_MENU_CONFORMANCE FAIL ${message}`);
    process.exit(1);
}
