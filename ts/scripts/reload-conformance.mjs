#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const repoRoot = resolve(tsRoot, "..");
const workdir = mkdtempSync(join(tsRoot, ".rngpui-reload-"));
const entry = join(workdir, "app.tsx");
const outJs = join(workdir, "app.js");
const outHbc = outJs.replace(/\.js$/, ".hbc");
const dumpPath = join(workdir, "tree.json");
const pidPath = join(workdir, "service.pid");
let child = null;

try {
    bundle("rngpui reload first", true);
    child = spawn(serviceBinary(), [], {
        cwd: tsRoot,
        env: {
            ...process.env,
            RNGPUI_BUNDLE: outHbc,
            RNGPUI_DUMP_TREE: dumpPath,
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

    await waitForDump("rngpui reload first", () => output);
    bundle("rngpui reload second", false);
    await waitForDump("rngpui reload second", () => output);
    console.log("RELOAD_CONFORMANCE_PASS app=exec-reloads-bytecode");
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    if (child && child.exitCode == null) {
        try {
            child.kill("SIGTERM");
        } catch {}
    }
    rmSync(workdir, { recursive: true, force: true });
}

function bundle(label, autoReload) {
    writeFileSync(
        entry,
        `
import { useEffect } from "react";
import { AppRegistry, Text, View } from ${JSON.stringify(resolve(tsRoot, "src/index.ts"))};

function App() {
  useEffect(() => {
    ${autoReload ? "setTimeout(() => process.kill(process.pid, 'SIGUSR2'), 1200);" : ""}
  }, []);
  return (
    <View style={{ width: 420, height: 240, backgroundColor: "#15171c", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#f7f8fb", fontSize: 20 }}>${label}</Text>
    </View>
  );
}

AppRegistry.registerComponent("ReloadConformance", () => App);
AppRegistry.runApplication("ReloadConformance", { width: 420, height: 240 });
`,
    );
    const result = spawnSync("bun", ["scripts/bundle-hermes.mjs", entry, outJs, "--bytecode"], {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production" },
    });
    if (result.status !== 0) {
        throw new Error(`bundle failed:\n${result.stdout}${result.stderr}`);
    }
}

async function waitForDump(text, output) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (existsSync(dumpPath)) {
            const dump = readFileSync(dumpPath, "utf8");
            if (dump.includes(text)) return;
        }
        if (child?.exitCode != null) {
            throw new Error(`service exited before ${text}; output:\n${output()}`);
        }
        await sleep(100);
    }
    const dump = existsSync(dumpPath) ? readFileSync(dumpPath, "utf8") : "(no dump)";
    throw new Error(`timed out waiting for ${text}; dump:\n${dump}\noutput:\n${output()}`);
}

function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function serviceBinary() {
    const explicit = process.env.RNGPUI_SERVICE ? resolve(process.env.RNGPUI_SERVICE) : "";
    const native = resolve(tsRoot, "native/rngpui-service");
    const release = resolve(repoRoot, "rust/target/release/rngpui-service");
    const binary = [explicit, native, release].filter(Boolean).find(existsSync);
    if (!binary) throw new Error(`rngpui-service not found at ${native} or ${release}`);
    stageServiceDylibs(binary);
    return binary;
}

function stageServiceDylibs(binary) {
    const releaseDir = dirname(binary);
    const hermesRoot = resolve(process.env.HERMES_ROOT || "/Users/n8/github/hermes");
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
