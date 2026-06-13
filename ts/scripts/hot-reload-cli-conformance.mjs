#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tsRoot = resolve(import.meta.dirname, "..");
const workdir = mkdtempSync(join(tmpdir(), "rngpui-hot-cli-"));
const bundlePath = join(workdir, "hot.js");
const buildScript = join(workdir, "build.mjs");
const socketPath = join(workdir, "control.sock");
let child = null;
let server = null;
let output = "";
let received = null;

try {
    writeFileSync(
        buildScript,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(bundlePath)}, "globalThis.__hotReloadCliConformance = true;\\n");\n`,
    );

    child = spawn(
        "bun",
        [
            "run",
            "cli/bin.ts",
            "hot-reload",
            "--once",
            "--socket",
            socketPath,
            "--bundle",
            bundlePath,
            "--build",
            `${process.execPath} ${buildScript}`,
            "--label",
            "hot-cli-conformance",
        ],
        {
            cwd: tsRoot,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));

    await sleep(300);
    server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const idx = buffer.indexOf("\n");
            if (idx < 0) return;
            received = JSON.parse(buffer.slice(0, idx));
            socket.end(JSON.stringify({ ok: true }) + "\n");
        });
    });
    await listen(server, socketPath);

    const code = await waitForExit(child);
    if (code !== 0) throw new Error(`hot-reload cli exited ${code}; output:\n${output}`);
    if (!received) throw new Error(`control socket received no hotEval request; output:\n${output}`);
    if (received.$cmd !== "hotEval") throw new Error(`expected hotEval, received ${received.$cmd}`);
    if (received.url !== bundlePath) throw new Error(`unexpected hotEval url: ${received.url}`);
    if (!String(received.code).includes("__hotReloadCliConformance")) throw new Error("hotEval body did not include built bundle");
    if (!existsSync(bundlePath) || !readFileSync(bundlePath, "utf8").includes("__hotReloadCliConformance")) {
        throw new Error("build command did not write bundle");
    }
    console.log("HOT_RELOAD_CLI_CONFORMANCE_PASS delayed-socket=waited hot-eval=sent");
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`output:\n${output}`);
    process.exitCode = 1;
} finally {
    if (child && child.exitCode == null) {
        try {
            child.kill("SIGTERM");
        } catch {}
    }
    await closeServer(server);
    rmSync(workdir, { recursive: true, force: true });
}

function listen(server, path) {
    return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
            server.off("error", reject);
            resolveListen();
        });
    });
}

function waitForExit(proc) {
    return new Promise((resolveExit) => {
        proc.on("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });
}

function closeServer(server) {
    if (!server) return Promise.resolve();
    return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
