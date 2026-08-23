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

    await waitForDump("first:1:", () => output);
    let dump = await dumpTree();
    const input = requireNode(dump, "hot-input");
    const scroll = requireNode(dump, "hot-scroll");
    await requestSocket(socketPath, { $cmd: "tap", ...center(input) });
    await requestSocket(socketPath, { $cmd: "type", text: "draft" });
    await waitForDump("first:1:draft", () => output);
    await requestSocket(socketPath, { $cmd: "scrollAt", ...center(scroll), dx: 0, dy: 180 });
    const inputBefore = await requestSocket(socketPath, { $cmd: "inputState" });
    const scrollBefore = await waitForScroll(center(scroll));
    const pidBefore = Number(readFileSync(pidPath, "utf8").trim());
    writeEntry("second", false, "react-native-gpui");
    const hotCode = bundleHotUpdate();
    await requestSocket(socketPath, {
        $cmd: "hotEval",
        url: outJs,
        code: hotCode,
    });
    await waitForDump("second:1:draft", () => output);
    const pidAfter = Number(readFileSync(pidPath, "utf8").trim());
    if (pidAfter !== pidBefore) throw new Error(`Fast Refresh changed pid: ${pidBefore} -> ${pidAfter}`);
    const inputAfter = await requestSocket(socketPath, { $cmd: "inputState" });
    dump = await dumpTree();
    const scrollAfterNode = requireNode(dump, "hot-scroll");
    const scrollAfter = await requestSocket(socketPath, { $cmd: "scrollDriverStats", ...center(scrollAfterNode) });
    if (!inputBefore.ok || !inputAfter.ok) throw new Error(`input state unavailable: ${JSON.stringify({ inputBefore, inputAfter })}`);
    if (inputAfter.focusedId !== inputBefore.focusedId || inputAfter.value !== "draft") {
        throw new Error(`focused input state was not preserved: ${JSON.stringify({ inputBefore, inputAfter })}`);
    }
    if (
        !scrollAfter.ok ||
        scrollAfter.targetId !== scrollBefore.targetId ||
        Math.abs(scrollAfter.offsetY - scrollBefore.offsetY) > 1
    ) {
        throw new Error(`scroll state was not preserved: ${JSON.stringify({ scrollBefore, scrollAfter })}`);
    }
    console.log(
        `HOT_RELOAD_CONFORMANCE_PASS hook-state=preserved focus=preserved scroll=${scrollAfter.offsetY.toFixed(1)} pid-stable=yes`,
    );
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
import {
  AppRegistry, RefreshControl, ScrollView, Text, TextInput, TurboModuleRegistry, View,
  NativeClipboard, NativeMenus, NativeWindow, hasKeyboardNavigationModifier,
  setupTamaguiNativeMenus, unstable_batchedUpdates,
} from ${JSON.stringify(appRegistryImport)};

function Counter() {
  void [RefreshControl, TurboModuleRegistry, NativeClipboard, NativeMenus, NativeWindow,
    hasKeyboardNavigationModifier, setupTamaguiNativeMenus, unstable_batchedUpdates];
  const [count, setCount] = React.useState(0);
  const [draft, setDraft] = React.useState("");
  React.useEffect(() => {
    ${increment ? "setTimeout(() => setCount(1), 50);" : ""}
  }, []);
  return React.createElement(View, { style: { width: 420, height: 300, backgroundColor: "#111", padding: 20, gap: 12 } },
    React.createElement(Text, { testID: "hot-status", style: { color: "#fff", fontSize: 18 } }, ${JSON.stringify(label)} + ":" + count + ":" + draft),
    React.createElement(TextInput, { testID: "hot-input", value: draft, onChangeText: setDraft, style: { width: 360, height: 36, color: "#fff", backgroundColor: "#222" } }),
    React.createElement(ScrollView, { testID: "hot-scroll", style: { width: 360, height: 150, backgroundColor: "#181818" } },
      Array.from({ length: 30 }, (_, index) => React.createElement(Text, { key: index, style: { color: "#ddd", height: 24 } }, "row " + index))
    )
  );
}
AppRegistry.registerComponent("HotRefreshConformance", () => Counter);
AppRegistry.runApplication("HotRefreshConformance", { width: 420, height: 300 });
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

async function dumpTree() {
    const response = await requestSocket(socketPath, { $cmd: "dump" });
    if (!response.ok || !response.tree) throw new Error(`dump failed: ${JSON.stringify(response)}`);
    return response.tree;
}

function requireNode(node, testID) {
    if (node.accessibility?.testID === testID) return node;
    for (const child of node.children ?? []) {
        const found = requireNodeOptional(child, testID);
        if (found) return found;
    }
    throw new Error(`missing node testID=${testID}`);
}

function requireNodeOptional(node, testID) {
    if (node.accessibility?.testID === testID) return node;
    for (const child of node.children ?? []) {
        const found = requireNodeOptional(child, testID);
        if (found) return found;
    }
    return null;
}

function center(node) {
    if (!node.bounds) throw new Error(`node ${node.globalId} has no bounds`);
    return { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 };
}

async function waitForScroll(point) {
    const deadline = Date.now() + 5_000;
    let latest = null;
    while (Date.now() < deadline) {
        latest = await requestSocket(socketPath, { $cmd: "scrollDriverStats", ...point });
        if (latest.ok && latest.offsetY > 0) return latest;
        await sleep(50);
    }
    throw new Error(`scroll offset did not advance: ${JSON.stringify(latest)}`);
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
