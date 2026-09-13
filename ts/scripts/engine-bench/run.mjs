#!/usr/bin/env bun
/**
 * Engine bench: run rngpui's real commit path (React reconcile -> host-config mutation ->
 * serialize -> wire delta -> JSON.stringify -> applyTree) under the two JavaScriptCore
 * embeddings available on macOS.
 *
 *   bun scripts/engine-bench/run.mjs
 *
 * Every row emits byte-identical wire payloads, so a difference in ms is a difference in
 * engine speed and nothing else. For rngpui's per-phase breakdown (mutation / serialize /
 * delta / stringify / bridge) set RNGPUI_COMMIT_TRACE to "1" in globals.ts and re-run.
 *
 * Engines: Bun's JavaScriptCore and the system JavaScriptCore framework rngpui embeds.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..') // ts/
const work = mkdtempSync(join(tmpdir(), 'rngpui-engine-bench-'))
const scenes = ['inline', 'memo']
const RUNS = 3

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', cwd: root, ...opts })

const parse = (stdout) => {
  const line = (stdout || '').split('\n').find((l) => l.startsWith('BENCH '))
  if (!line) return null
  const fields = Object.fromEntries(line.split(' ').slice(2).map((p) => p.split('=')))
  return { perCommitMs: Number(fields.perCommitMs), wireBytes: Number(fields.wireBytes) }
}

const best = (results) => results.filter(Boolean).sort((a, b) => a.perCommitMs - b.perCommitMs)[0]

const systemJsc = join(work, 'jsc-runner')
if (process.platform === 'darwin') {
  const compiled = run('clang++', [
    '-std=c++17',
    join(root, 'scripts/engine-bench/jsc-runner.cpp'),
    resolve(root, '../rust/jsc_shim/jsc_shim.cpp'),
    '-framework', 'JavaScriptCore',
    '-o', systemJsc,
  ])
  if (compiled.status !== 0) {
    console.error(`[engine-bench] system JavaScriptCore runner failed to compile:\n${compiled.stderr}`)
  } else {
    const signed = run('codesign', [
      '--force', '--sign', '-', '--entitlements', resolve(root, '../rust/jsc.entitlements'),
      '--options', 'runtime', systemJsc,
    ])
    if (signed.status !== 0) {
      console.error(`[engine-bench] system JavaScriptCore runner failed to sign:\n${signed.stderr}`)
      process.exit(1)
    }
  }
}

const rows = []
for (const scene of scenes) {
  const bundle = join(work, `${scene}.js`)
  const build = run('bun', [
    'run', 'scripts/bundle-app.mjs',
    join(root, 'scripts/engine-bench', `${scene}.tsx`),
    bundle,
  ], { env: { ...process.env, NODE_ENV: 'production' } })
  if (!existsSync(bundle)) {
    console.error(`[engine-bench] bundling ${scene} failed:\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }

  // bun / JavaScriptCore
  rows.push({
    scene, engine: 'bun (JavaScriptCore)',
    ...best(Array.from({ length: RUNS }, () => parse(run('bun', [bundle]).stdout))),
  })

  if (existsSync(systemJsc)) {
    const raw = Array.from({ length: RUNS }, () => run(systemJsc, [bundle]))
    const b = best(raw.map((r) => parse(r.stdout)))
    if (!b) {
      console.error(`[engine-bench] systemJsc failed for ${scene}:\n${raw[0]?.stderr || raw[0]?.stdout}`)
    }
    rows.push({
      scene, engine: 'System JavaScriptCore',
      ...b,
    })
  }

}

const width = Math.max(...rows.map((r) => r.engine.length))
console.log(`\nbest of ${RUNS} runs, ms per commit (lower is better)\n`)
for (const scene of scenes) {
  console.log(`  ${scene}:`)
  for (const r of rows.filter((r) => r.scene === scene)) {
    console.log(`    ${r.engine.padEnd(width)}  ${r.perCommitMs.toFixed(3)}  (wire ${r.wireBytes} bytes)`)
  }
}
const mismatched = scenes.filter((scene) => new Set(rows.filter((r) => r.scene === scene).map((r) => r.wireBytes)).size > 1)
console.log(
  mismatched.length === 0
    ? '\nwire bytes identical across engines within each scene, so the deltas are engine speed.\n'
    : `\nWARNING: wire bytes diverged within ${mismatched.join(', ')}; those runs are not comparable.\n`,
)
