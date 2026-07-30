#!/usr/bin/env node
// Asserts that a covering view stops input reaching what it covers.
//
// hit-test-conformance already asserts the overlay WINS the press. This asserts the
// covered node hears nothing at all: press resolution is single-winner, but the
// down-side and hover-side handlers are gated independently, so a covered node can
// still receive pressIn / mouseDown / mouseEnter under an overlay that owns the press.
//
// Drives real gpui input only (realmove, realtap) — the synth `do tap` path addresses a
// single resolved node by id and cannot exercise this at all.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(tsRoot, "..");
const outDir = process.argv[2] || "/tmp/rngpui-overlay-occlusion-conformance";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const outJs = join(outDir, "app.js");
const outHbc = join(outDir, "app.hbc");
const controlSocket = join(outDir, "control.sock");

const bundle = spawnSync(
    "bun",
    [
        "scripts/bundle-hermes.mjs",
        resolve(tsRoot, "examples/overlay-occlusion-conformance.tsx"),
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

let leaked = [];
let overlaySaw = [];

try {
    await waitFor(() => /CONFORMANCE occlusion READY/.test(output), 10000, "READY");
    await waitFor(() => boxFor() != null, 6000, "BOX measure");
    const box = boxFor();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // park the pointer away from the stack first, so the move into it is a real enter
    await controlRequest("realmove", box.x + box.width + 20, box.y + box.height + 20);
    await sleep(150);

    const before = output.length;
    await controlRequest("realmove", x, y);
    await sleep(150);
    await controlRequest("realtap", x, y);
    await sleep(300);

    const seen = sawSince(before);
    leaked = seen.filter((entry) => entry.startsWith("covered "));
    overlaySaw = seen.filter((entry) => entry.startsWith("overlay "));
} catch (error) {
    stop();
    fail(`${error instanceof Error ? error.message : String(error)}\n--- output ---\n${output.trim()}`);
}
stop();

if (overlaySaw.length === 0) {
    fail(`the overlay itself received nothing — the press never landed, so this run proves nothing`);
}
if (leaked.length > 0) {
    fail(
        `covered node received ${leaked.length} event(s) through the overlay ` +
            `[${leaked.join(", ")}]; overlay received [${overlaySaw.join(", ")}]`,
    );
}

console.log(`OVERLAY_OCCLUSION_CONFORMANCE PASS overlay=[${overlaySaw.join(",")}] covered=[]`);
process.exit(0);

function boxFor() {
    const line = /CONFORMANCE occlusion BOX x=([\d.-]+) y=([\d.-]+) w=([\d.-]+) h=([\d.-]+)/.exec(output);
    if (!line) return null;
    return {
        x: Number(line[1]),
        y: Number(line[2]),
        width: Number(line[3]),
        height: Number(line[4]),
    };
}

function sawSince(offset) {
    return [...output.slice(offset).matchAll(/CONFORMANCE occlusion SAW (\S+) (\S+)/g)].map(
        (m) => `${m[1]} ${m[2]}`,
    );
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
    console.error(`OVERLAY_OCCLUSION_CONFORMANCE FAIL ${message}`);
    process.exit(1);
}
