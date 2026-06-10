#!/usr/bin/env bun
// Build the reanimated worklet/UI runtime bundle (dist/ui-runtime.js) — the
// app-independent second-runtime bundle hermes::start_ui evaluates (see
// plans/off-thread-reanimated.md). Plain JS (not bytecode) so it carries no
// hermesc version coupling; eval cost is a few ms at startup.
//
//   bun scripts/build-ui-runtime.mjs [--force]
//
// mtime-gated: rebuilds only when a source under src/reanimated/, src/raf.ts,
// or the bundler scripts is newer than the output. Always (re)stages the bundle
// next to every rngpui-service binary it can find — the service resolves
// `ui-runtime.js` beside its executable (rust/src/service.rs load_ui_bundle).
// bundle-hermes.mjs invokes this after every app bundle, so all launchers in
// this repo stay staged automatically.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist", "ui-runtime.js");
const force = process.argv.includes("--force");

function newestMtime(path) {
    const stat = statSync(path);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let newest = 0;
    for (const name of readdirSync(path)) {
        newest = Math.max(newest, newestMtime(join(path, name)));
    }
    return newest;
}

const sources = [
    join(root, "src", "reanimated"),
    join(root, "src", "raf.ts"),
    join(root, "scripts", "bundle-hermes.mjs"),
    join(root, "scripts", "reanimated-bun-plugin.mjs"),
    join(root, "scripts", "prebuild-reanimated.mjs"),
];
const fresh =
    !force &&
    existsSync(out) &&
    sources.every((src) => !existsSync(src) || newestMtime(src) < statSync(out).mtimeMs);

if (!fresh) {
    mkdirSync(join(root, "dist"), { recursive: true });
    const entry = join(root, "src", "reanimated", "ui-entry.ts");
    const result = spawnSync("bun", ["scripts/bundle-hermes.mjs", entry, out], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
} else {
    console.log(`[build-ui-runtime] ${out} up to date`);
}

for (const dir of [
    resolve(root, "..", "rust", "target", "release"),
    resolve(root, "..", "rust", "target", "debug"),
    join(root, "native"),
]) {
    if (!existsSync(join(dir, "rngpui-service"))) continue;
    const staged = join(dir, "ui-runtime.js");
    if (existsSync(staged) && statSync(staged).mtimeMs >= statSync(out).mtimeMs) continue;
    copyFileSync(out, staged);
    console.log(`[build-ui-runtime] staged ${staged}`);
}
