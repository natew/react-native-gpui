#!/usr/bin/env node
// Asserts hit-test RESOLUTION, not painting.
//
// Every stack in examples/hit-test-conformance.tsx paints identically whether or not
// resolution is correct, so a pixel or occlusion check cannot see this class of break.
// For each stack we press the same point twice:
//
//   realtap — a genuine PlatformInput::MouseDown/Up through gpui's own dispatch, the
//             path a user's click takes. Establishes what correct resolution IS.
//   tap     — the `rngpui do tap` driver, which resolves through inspector::tap_target_at.
//             Must agree with realtap, or the debug driver is lying about the app.
//
// Both must land on the covering node, and the covered node must stay silent.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(tsRoot, "..");
const outDir = process.argv[2] || "/tmp/rngpui-hit-test-conformance";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const outJs = join(outDir, "app.js");
const outHbc = join(outDir, "app.hbc");
const controlSocket = join(outDir, "control.sock");

const bundle = spawnSync(
    "bun",
    [
        "scripts/bundle-hermes.mjs",
        resolve(tsRoot, "examples/hit-test-conformance.tsx"),
        outJs,
        "--bytecode",
    ],
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

const STACKS = ["plain", "deep", "zlift"];
const results = [];

try {
    await waitFor(() => /CONFORMANCE hit-test READY/.test(output), 10000, "READY");
    for (const stack of STACKS) {
        await waitFor(
            () => boxFor(stack) != null,
            6000,
            `${stack} BOX measure`,
        );
    }

    // every case runs even after one fails: which of realtap/tap breaks, and on which
    // stack, is the whole diagnostic. Stopping at the first failure hides whether real
    // input and the debug driver disagree or are broken together.
    for (const stack of STACKS) {
        const box = boxFor(stack);
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        for (const command of ["realtap", "tap"]) {
            const before = output.length;
            const reply = await controlRequest(command, x, y);
            await sleep(250);
            const handlers = firedSince(before);
            const got =
                reply?.ok === false
                    ? `rejected(${reply.error ?? "?"})`
                    : handlers.length === 1
                      ? handlers[0]
                      : `[${handlers.join(",")}]`;
            results.push({ stack, command, got, ok: got === `${stack}-overlay` });
        }
    }
} catch (error) {
    stop();
    fail(`${error instanceof Error ? error.message : String(error)}\n--- output ---\n${output.trim()}`);
}
stop();

const summary = results.map((r) => `${r.stack}:${r.command}=${r.got}`).join(" ");
const broken = results.filter((r) => !r.ok);
if (broken.length > 0) {
    fail(
        `${broken.length}/${results.length} presses resolved to the wrong node ` +
            `(each should reach <stack>-overlay, the covering node): ${summary}`,
    );
}
console.log(`HIT_TEST_CONFORMANCE PASS ${summary}`);
process.exit(0);

function boxFor(stack) {
    const line = new RegExp(
        `CONFORMANCE hit-test BOX ${stack} x=([\\d.-]+) y=([\\d.-]+) w=([\\d.-]+) h=([\\d.-]+)`,
    ).exec(output);
    if (!line) return null;
    return {
        x: Number(line[1]),
        y: Number(line[2]),
        width: Number(line[3]),
        height: Number(line[4]),
    };
}

function firedSince(offset) {
    return [...output.slice(offset).matchAll(/CONFORMANCE hit-test FIRED (\S+)/g)].map((m) => m[1]);
}

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
            try {
                const parsed = JSON.parse(buffer.slice(0, newline));
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
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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
    console.error(`HIT_TEST_CONFORMANCE FAIL ${message}`);
    process.exit(1);
}
