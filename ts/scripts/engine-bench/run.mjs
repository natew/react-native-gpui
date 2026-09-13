#!/usr/bin/env bun
/**
 * Engine bench: run rngpui's real commit path (React reconcile -> host-config mutation ->
 * serialize -> wire delta -> JSON.stringify -> applyTree) under every JS engine we can
 * reach, on identical work.
 *
 *   bun scripts/engine-bench/run.mjs
 *
 * Every row emits byte-identical wire payloads, so a difference in ms is a difference in
 * engine speed and nothing else. For rngpui's per-phase breakdown (mutation / serialize /
 * delta / stringify / bridge) set RNGPUI_COMMIT_TRACE to "1" in globals.ts and re-run.
 *
 * Engines: bun (JavaScriptCore), Hermes bytecode via the static_h build, and Static Hermes
 * native via shermes when that binary exists. HERMES_ROOT overrides the checkout.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..') // ts/
const hermesRoot = process.env.HERMES_ROOT || join(process.env.HOME, 'github/hermes')
const bin = join(hermesRoot, 'build/bin')
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

const rows = []
for (const scene of scenes) {
  const bundle = join(work, `${scene}.js`)
  const build = run('bun', [
    'run', 'scripts/bundle-hermes.mjs',
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

  // Hermes bytecode: what rngpui ships today
  const hermesc = join(bin, 'hermesc')
  const hermes = join(bin, 'hermes')
  if (existsSync(hermesc) && existsSync(hermes)) {
    const hbc = join(work, `${scene}.hbc`)
    run(hermesc, ['-emit-binary', '-O', '-Xes6-block-scoping', bundle, '-out', hbc])
    rows.push({
      scene, engine: 'Hermes bytecode',
      ...best(Array.from({ length: RUNS }, () => parse(run(hermes, ['-Xes6-block-scoping', hbc]).stdout))),
    })
  } else {
    console.error(`[engine-bench] no hermesc/hermes in ${bin}; build them with: ninja -C ${hermesRoot}/build bin/hermesc bin/hermes`)
  }

  // Static Hermes native
  const shermes = join(bin, 'shermes')
  if (existsSync(shermes)) {
    const exe = join(work, `${scene}.native`)
    const libs = [join(hermesRoot, 'build/tools/shermes'), join(hermesRoot, 'build/lib')].join(':')
    const compiled = run(shermes, ['-Xes6-block-scoping', '-O', bundle, '-o', exe], {
      env: { ...process.env, LIBRARY_PATH: `${libs}:${process.env.LIBRARY_PATH || ''}` },
    })
    if (existsSync(exe)) {
      rows.push({
        scene, engine: 'Static Hermes native',
        ...best(Array.from({ length: RUNS }, () => parse(run(exe, []).stdout))),
      })
    } else {
      console.error(`[engine-bench] shermes failed for ${scene}:\n${compiled.stderr}`)
    }
  } else {
    console.error(`[engine-bench] no shermes in ${bin}; build it with: ninja -C ${hermesRoot}/build bin/shermes shermes_console_a`)
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
