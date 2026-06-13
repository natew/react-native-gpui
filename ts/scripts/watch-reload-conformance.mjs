#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const workdir = mkdtempSync(join(tmpdir(), "rngpui-watch-reload-"));
const watchRoot = join(workdir, "src");
const pidPath = join(workdir, "service.pid");
const markerPath = join(workdir, "reload.marker");
const childScript = join(workdir, "signal-target.mjs");
const sourceFile = join(watchRoot, "app.tsx");
let watcher = null;
let target = null;
let watcherOutput = "";
let targetOutput = "";

try {
    mkdirSync(watchRoot, { recursive: true });
    writeFileSync(
        childScript,
        `
import { writeFileSync } from "node:fs";
process.on("SIGUSR2", () => writeFileSync(${JSON.stringify(markerPath)}, String(Date.now())));
console.log("ready");
setInterval(() => {}, 1000);
`,
    );

    target = spawn(process.execPath, [childScript], {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(pidPath, String(target.pid));
    target.stdout.on("data", (chunk) => (targetOutput += chunk.toString()));
    target.stderr.on("data", (chunk) => (targetOutput += chunk.toString()));
    await waitFor(() => targetOutput.includes("ready"), "target ready");

    watcher = spawn("bun", ["run", "cli/bin.ts", "watch-reload", "--pid", pidPath, "--root", watchRoot, "--debounce-ms", "50", "--label", "watch-conformance"], {
        cwd: tsRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
    watcher.stdout.on("data", (chunk) => (watcherOutput += chunk.toString()));
    watcher.stderr.on("data", (chunk) => (watcherOutput += chunk.toString()));

    await waitFor(() => watcherOutput.includes("live reload armed"), "watcher armed");
    writeFileSync(sourceFile, "export const reloadProbe = true;\n");
    await waitFor(() => existsSync(markerPath), "SIGUSR2 marker");
    await waitFor(() => watcherOutput.includes("-> reload (SIGUSR2 ->"), "watcher reload log");
    process.kill(target.pid, 0);
    console.log("WATCH_RELOAD_CONFORMANCE_PASS signal=SIGUSR2 pid-file=yes");
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`watcher output:\n${watcherOutput}`);
    console.error(`target output:\n${targetOutput}`);
    process.exitCode = 1;
} finally {
    killChild(watcher);
    killChild(target);
    rmSync(workdir, { recursive: true, force: true });
}

async function waitFor(predicate, label) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        if (watcher?.exitCode != null) throw new Error(`watcher exited before ${label}`);
        if (target?.exitCode != null) throw new Error(`target exited before ${label}`);
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function killChild(child) {
    if (!child || child.exitCode != null) return;
    try {
        child.kill("SIGTERM");
    } catch {}
}
