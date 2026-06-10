import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = resolve(root, "..", "rust", "target", "release");
const serviceSource = join(releaseDir, "rngpui-service");
const nativeDir = join(root, "native");
const serviceTarget = join(nativeDir, "rngpui-service");

mkdirSync(nativeDir, { recursive: true });
copyFileSync(serviceSource, serviceTarget);

const linkedDylibs = linkedLibraries(serviceTarget);
const needsHermes = linkedDylibs.some((line) => line.includes("libhermesvm"));
const hermesDylib = join(process.env.HERMES_ROOT || "/Users/n8/github/hermes", "build", "lib", "libhermesvm.dylib");
if (needsHermes) {
    if (!existsSync(hermesDylib)) {
        throw new Error(`rngpui-service links libhermesvm, but libhermesvm.dylib was not found at ${hermesDylib}`);
    }
    copyFileSync(hermesDylib, join(nativeDir, "libhermesvm.dylib"));
}

const needsGhostty = linkedDylibs.some((line) => line.includes("libghostty-vt"));
const ghosttyDylibs = findNativeDylibs(join(releaseDir, "build"));
if (needsGhostty && ghosttyDylibs.length === 0) {
    throw new Error(`rngpui-service links libghostty-vt, but no libghostty-vt dylib was found under ${join(releaseDir, "build")}`);
}

for (const dylib of ghosttyDylibs) {
    copyFileSync(dylib, join(nativeDir, dylib.split("/").pop()));
}

if (readdirSync(nativeDir).some((entry) => entry.endsWith(".dylib")) && !hasRpath(serviceTarget, "@executable_path")) {
    execFileSync("install_name_tool", ["-add_rpath", "@executable_path", serviceTarget]);
}

// the worklet/UI runtime bundle ships next to the binary — the service resolves
// ui-runtime.js beside its executable (plans/off-thread-reanimated.md).
const uiRuntime = spawnSync("bun", ["scripts/build-ui-runtime.mjs"], { cwd: root, stdio: "inherit" });
if (uiRuntime.status !== 0) {
    throw new Error("build-ui-runtime.mjs failed — the shipped package needs native/ui-runtime.js");
}

function findNativeDylibs(dir) {
    if (!existsSync(dir)) return [];
    const out = [];
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(path);
            } else if (entry.name.endsWith(".dylib") && entry.name.startsWith("libghostty-vt")) {
                out.push(path);
            }
        }
    }
    return out;
}

function hasRpath(binary, rpath) {
    const output = linkedLoadCommands(binary);
    return output.includes(`path ${rpath} `);
}

function linkedLibraries(binary) {
    return execFileSync("otool", ["-L", binary], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function linkedLoadCommands(binary) {
    return execFileSync("otool", ["-l", binary], { encoding: "utf8" });
}
