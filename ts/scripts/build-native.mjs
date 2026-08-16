import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = resolve(root, "..", "rust", "target", "release");
const serviceSource = join(releaseDir, "rngpui-service");
const nativeDir = join(root, "native");
const serviceTarget = join(nativeDir, "rngpui-service");

mkdirSync(nativeDir, { recursive: true });
stage(serviceSource, serviceTarget);

const linkedDylibs = linkedLibraries(serviceTarget);
const needsHermes = linkedDylibs.some((line) => line.includes("libhermesvm"));
const hermesDylib = join(process.env.HERMES_ROOT || join(homedir(), "github", "hermes"), "build", "lib", "libhermesvm.dylib");
if (needsHermes) {
    if (!existsSync(hermesDylib)) {
        throw new Error(`rngpui-service links libhermesvm, but libhermesvm.dylib was not found at ${hermesDylib}`);
    }
    stage(hermesDylib, join(nativeDir, "libhermesvm.dylib"));
}

const needsGhostty = linkedDylibs.some((line) => line.includes("libghostty-vt"));
const ghosttyDylibs = findNativeDylibs(join(releaseDir, "build"));
if (needsGhostty && ghosttyDylibs.length === 0) {
    throw new Error(`rngpui-service links libghostty-vt, but no libghostty-vt dylib was found under ${join(releaseDir, "build")}`);
}

// staged beside the packaged binary, and beside the cargo one too: build.rs embeds an
// @executable_path rpath, and the dylib is otherwise left buried under target/release/build,
// so `rust/target/release/rngpui-service` dies at dyld before printing a single line. Every
// conformance gate defaults to exactly that path, which turns one missing file into a whole
// suite that fails with no output and no explanation.
for (const dylib of ghosttyDylibs) {
    const name = dylib.split("/").pop();
    stage(dylib, join(nativeDir, name));
    stage(dylib, join(releaseDir, name));
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

// Write beside the target and rename over it, never copy onto it. A plain
// copyFileSync reuses the inode, and macOS caches a code signature per (device,
// inode): overwrite the file a running service is mapped from and the NEXT launch
// is SIGKILLed by AMFI with `EXC_BAD_ACCESS ... CODESIGNING / Invalid Page`, on a
// binary `codesign --verify` still calls valid on disk. The launch fails before it
// writes a line, so the harness reports only "service did not start (no service
// log)" and the cause is invisible. A rename gives the new bytes a new inode and
// nothing stale can be consulted.
function stage(source, target) {
    const temp = `${target}.staging`;
    copyFileSync(source, temp);
    renameSync(temp, target);
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
