#!/usr/bin/env bun
/**
 * runs the C ABI shim's own selftest against the system JavaScriptCore. the shim
 * is compiled into the service by build.rs, and shim_selftest.cpp has had no
 * build wiring since the Hermes migration, so the checks it makes were not
 * reachable from any script: prompt microtasks, host-function userdata, the
 * shared ArrayBuffer between two runtimes, and — since the control socket gained
 * `collectGarbage` — that a forced collection actually collects.
 *
 * the collection check is the one that needs a real program rather than a
 * reading: the public JSGarbageCollect returns without collecting, so a test
 * that asserted "the call returned" would stay green over a no-op. the selftest
 * asserts through WeakRef.deref() with a before-collection control that must
 * still read all-alive, and a copy of the shim with the collect replaced by
 * `return 0` fails it at exit 15, so the assertion can fail.
 *
 * signed with the same entitlements as the service, so the test runs the
 * JavaScriptCore the engine actually runs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(tsRoot, "..");
const shim = join(repo, "rust", "jsc_shim");
const entitlements = join(repo, "rust", "jsc.entitlements");
const workdir = mkdtempSync(join(tmpdir(), "rngpui-jsc-shim-"));
const binary = join(workdir, "shim-selftest");

try {
    execFileSync(
        "clang++",
        [
            "-std=c++17",
            "-O1",
            "-framework",
            "JavaScriptCore",
            "-o",
            binary,
            join(shim, "shim_selftest.cpp"),
            join(shim, "jsc_shim.cpp"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
} catch (error) {
    console.error("JSC_SHIM_UNIT_FAIL clang++ could not build the shim selftest");
    console.error(String(error.stderr ?? error));
    process.exit(1);
}

if (existsSync(entitlements)) {
    execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, "--options", "runtime", binary], {
        stdio: ["ignore", "pipe", "pipe"],
    });
}

// the exit code is the assertion: the selftest returns a distinct code per check
// (1 create, 3 microtasks, 4 userdata, 7/8/9 shared buffer, 12 the control,
// 13 no collector, 15 the collection itself) and 0 only when all of them passed.
// its stdout names whichever one failed, so it is printed rather than parsed.
let result;
try {
    result = execFileSync(binary, [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
    console.error("JSC_SHIM_UNIT_FAIL the shim selftest reported a failing check");
    console.error(String(error.stdout ?? ""));
    console.error(String(error.stderr ?? ""));
    process.exit(1);
}
for (const line of result.trim().split("\n")) console.log(line);
console.log("JSC_SHIM_UNIT_PASS");
rmSync(workdir, { recursive: true, force: true });
