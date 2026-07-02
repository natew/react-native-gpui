#!/usr/bin/env node
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const repoRoot = resolve(tsRoot, "..");
const workdir = mkdtempSync(join(tsRoot, ".rngpui-hot-reload-"));
const entry = join(workdir, "app.tsx");
const outJs = join(workdir, "app.js");
const outHbc = outJs.replace(/\.js$/, ".hbc");
const dumpPath = join(workdir, "tree.json");
const pidPath = join(workdir, "service.pid");
const socketPath = join(workdir, "control.sock");
let child = null;

try {
    writeEntry("first", true);
    bundle();
    child = spawn(serviceBinary(), [], {
        cwd: tsRoot,
        env: {
            ...process.env,
            NODE_ENV: "development",
            RNGPUI_BUNDLE: outHbc,
            RNGPUI_DUMP_TREE: dumpPath,
            RNGPUI_CONTROL_SOCKET: socketPath,
            RNGPUI_NO_ACTIVATE: "1",
            RNGPUI_TEST_MODE: "1",
            RNGPUI_SERVICE_PID_FILE: pidPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    child.on("exit", (code, signal) => {
        if (signal !== "SIGTERM") output += `\nservice exited code=${code} signal=${signal}\n`;
    });

    await waitForDump("first:1", () => output);
    const pidBefore = Number(readFileSync(pidPath, "utf8").trim());
    writeEntry("second", false, "react-native-gpui");
    const hotCode = bundleHotUpdate();
    await requestSocket(socketPath, {
        $cmd: "hotEval",
        url: outJs,
        code: hotCode,
    });
    await waitForDump("second:1", () => output);
    const pidAfter = Number(readFileSync(pidPath, "utf8").trim());
    if (pidAfter !== pidBefore) throw new Error(`hot reload changed pid: ${pidBefore} -> ${pidAfter}`);
    console.log("HOT_RELOAD_CONFORMANCE_PASS state=preserved pid-stable=yes");
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    const dump = existsSync(dumpPath) ? readFileSync(dumpPath, "utf8") : "(no dump)";
    console.error(`dump:\n${dump}`);
    process.exitCode = 1;
} finally {
    if (child && child.exitCode == null) {
        try {
            child.kill("SIGTERM");
        } catch {}
    }
    rmSync(workdir, { recursive: true, force: true });
}

function writeEntry(label, increment, appRegistryImport = resolve(tsRoot, "src/index.ts")) {
    writeFileSync(
        entry,
        `
import * as React from "react";
import { AppRegistry } from ${JSON.stringify(appRegistryImport)};

function Counter() {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    ${increment ? "setTimeout(() => setCount(1), 50);" : ""}
  }, []);
  return React.createElement("View", { style: { width: 420, height: 240, backgroundColor: "#111", alignItems: "center", justifyContent: "center" } },
    React.createElement("Text", { style: { color: "#fff", fontSize: 18 } }, ${JSON.stringify(label)} + ":" + count)
  );
}
AppRegistry.registerComponent("HotRefreshConformance", () => Counter);
AppRegistry.runApplication("HotRefreshConformance", { width: 420, height: 240 });
`,
    );
}

function bundle() {
    const result = spawnSync("bun", ["scripts/bundle-hermes.mjs", entry, outJs, "--bytecode"], {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development" },
    });
    if (result.status !== 0) throw new Error(`bundle failed:\n${result.stdout}${result.stderr}`);
}

function bundleHotUpdate() {
    const result = spawnSync("bun", ["scripts/bundle-hermes.mjs", entry, outJs], {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development", RNGPUI_HOT_UPDATE: "1" },
    });
    if (result.status !== 0) throw new Error(`hot update bundle failed:\n${result.stdout}${result.stderr}`);
    return readFileSync(outJs, "utf8");
}

async function waitForDump(text, output) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (existsSync(dumpPath)) {
            const dump = readFileSync(dumpPath, "utf8");
            if (dump.includes(text)) return;
        }
        if (child?.exitCode != null) throw new Error(`service exited before ${text}; output:\n${output()}`);
        await sleep(100);
    }
    const dump = existsSync(dumpPath) ? readFileSync(dumpPath, "utf8") : "(no dump)";
    throw new Error(`timed out waiting for ${text}; dump:\n${dump}\noutput:\n${output()}`);
}

function requestSocket(path, body) {
    return new Promise((resolveRequest, reject) => {
        const socket = createConnection(path);
        let buffer = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`control request timed out on ${path}`));
        }, 10_000);
        socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const idx = buffer.indexOf("\n");
            if (idx < 0) return;
            clearTimeout(timer);
            socket.end();
            const response = JSON.parse(buffer.slice(0, idx));
            if (!response.ok) reject(new Error(response.error || "hotEval failed"));
            else resolveRequest(response);
        });
        socket.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function serviceBinary() {
    const explicit = process.env.RNGPUI_SERVICE ? resolve(process.env.RNGPUI_SERVICE) : "";
    const native = resolve(tsRoot, "native/rngpui-service");
    const release = resolve(repoRoot, "rust/target/release/rngpui-service");
    const debug = resolve(repoRoot, "rust/target/debug/rngpui-service");
    const binary = [explicit, native, release, debug].filter(Boolean).find(existsSync);
    if (!binary) throw new Error(`rngpui-service not found at ${native}, ${release}, or ${debug}`);
    stageServiceDylibs(binary);
    return binary;
}

function stageServiceDylibs(binary) {
    const releaseDir = dirname(binary);
    const hermesRoot = resolve(process.env.HERMES_ROOT || join(homedir(), "github", "hermes"));
    const hermesDylib = resolve(hermesRoot, "build", "lib", "libhermesvm.dylib");
    const stagedHermes = join(releaseDir, "libhermesvm.dylib");
    if (!existsSync(stagedHermes)) {
        if (!existsSync(hermesDylib)) throw new Error(`libhermesvm.dylib not found: ${hermesDylib}`);
        copyFileSync(hermesDylib, stagedHermes);
    }
    for (const dylib of findDylibs(resolve(releaseDir, "build"), "libghostty-vt")) {
        copyFileSync(dylib, join(releaseDir, dylib.split("/").pop()));
    }
}

function findDylibs(dir, prefix) {
    if (!existsSync(dir)) return [];
    const out = [];
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of readdirSafe(current)) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.name.startsWith(prefix) && entry.name.endsWith(".dylib")) out.push(full);
        }
    }
    return out;
}

function readdirSafe(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}
