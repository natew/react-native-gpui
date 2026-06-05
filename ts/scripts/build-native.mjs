import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = resolve(root, "..", "rust", "target", "release");
const serviceSource = join(releaseDir, "rngpui-service");
const nativeDir = join(root, "native");
const serviceTarget = join(nativeDir, "rngpui-service");

mkdirSync(nativeDir, { recursive: true });
copyFileSync(serviceSource, serviceTarget);

for (const dylib of findNativeDylibs(join(releaseDir, "build"))) {
    copyFileSync(dylib, join(nativeDir, dylib.split("/").pop()));
}

if (readdirSync(nativeDir).some((entry) => entry.endsWith(".dylib")) && !hasRpath(serviceTarget, "@executable_path")) {
    execFileSync("install_name_tool", ["-add_rpath", "@executable_path", serviceTarget]);
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
    const output = execFileSync("otool", ["-l", binary], { encoding: "utf8" });
    return output.includes(`path ${rpath} `);
}
