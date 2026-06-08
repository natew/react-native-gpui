// Hard cap for the single-process Hermes host startup budget.
// Builds a bytecode fixture, launches rngpui-service, and fails if any measured
// internal first-render time exceeds 200ms.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tsRoot = resolve(import.meta.dirname, "..");
const workdir = mkdtempSync(join(tmpdir(), "rngpui-startup-"));
const outJs = join(workdir, "startup.js");
const binary = resolve(tsRoot, "..", "rust", "target", "release", "rngpui-service");

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production" },
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
    }
    return result;
}

try {
    run("bun", ["scripts/bundle-hermes.mjs", "examples/superconductor.tsx", outJs, "--bytecode"]);
    const hbc = outJs.replace(/\.js$/, ".hbc");
    const result = run("node", ["scripts/measure-hermes-startup.mjs", binary, hbc, "--runs", "6", "--max-ms", "200"]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
} finally {
    rmSync(workdir, { recursive: true, force: true });
}
