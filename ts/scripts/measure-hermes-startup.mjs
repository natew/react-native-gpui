// Measure single-process Hermes cold start: process launch → first painted frame.
// Uses the invisible on-screen capture window (paints, no focus theft) and reads the
// binary's "[startup] first render +Xms" marker (RNGPUI_STARTUP_TIMING).
//
//   node scripts/measure-hermes-startup.mjs <binary> <bundle.js|.hbc> [runs]
//   node scripts/measure-hermes-startup.mjs <binary> <bundle.js|.hbc> --runs 8 --max-ms 200
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const positional = []
let runs = 6
let maxMs = 0
let timeoutMs = 5000
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--runs') runs = Number(process.argv[++i] || runs)
  else if (arg === '--max-ms') maxMs = Number(process.argv[++i] || 0)
  else if (arg === '--timeout-ms') timeoutMs = Number(process.argv[++i] || timeoutMs)
  else positional.push(arg)
}
const bin = positional[0]
const bundle = positional[1]
if (!bin || !bundle) {
  console.error('usage: node scripts/measure-hermes-startup.mjs <binary> <bundle.js|.hbc> [runs] [--max-ms 200]')
  process.exit(1)
}
if (positional[2]) runs = Number(positional[2])
stageServiceDylibs(bin)

function once() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        RNGPUI_BUNDLE: bundle,
        RNGPUI_STARTUP_TIMING: '1',
        RNGPUI_NO_ACTIVATE: '1',
        RNGPUI_TEST_MODE: '1',
        RNGPUI_CAPTURE_ONSCREEN: '1',
        RNGPUI_OPAQUE_WINDOW: '1',
        RNGPUI_CAPTURE_ALPHA: '0.02',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let buf = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: `timed out after ${timeoutMs}ms`, log: buf })
    }, timeoutMs)
    child.stderr.on('data', (c) => {
      buf += c.toString()
      const m = buf.match(/\[startup\] first render \+([\d.]+)ms/)
      if (m) {
        const wall = Number(process.hrtime.bigint() - t0) / 1e6
        finish({ ok: true, wall, internal: Number(m[1]) })
      }
    })
    child.on('exit', (code, signal) => {
      finish({ ok: false, error: `exited before first render (code=${code ?? 'null'} signal=${signal ?? 'null'})`, log: buf })
    })
  })
}

const results = []
for (let i = 0; i < runs; i++) {
  const r = await once()
  results.push(r)
  console.log(`run ${i + 1}: ${r.ok ? `wall ${r.wall.toFixed(0)}ms · internal ${r.internal.toFixed(0)}ms` : `FAILED (${r.error})`}`)
  await new Promise((res) => setTimeout(res, 300))
}
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error(`startup measurement had ${failed.length} failed run(s)`)
  for (const fail of failed) {
    const tail = String(fail.log || '').split('\n').slice(-12).join('\n')
    if (tail.trim()) console.error(`--- failed run log tail ---\n${tail}`)
  }
  process.exit(1)
}
const ok = results
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
const stat = (vals) => `min ${Math.min(...vals).toFixed(0)} · median ${med(vals).toFixed(0)} · max ${Math.max(...vals).toFixed(0)} ms`
const wall = ok.map((r) => r.wall)
const internal = ok.map((r) => r.internal)
console.log('\n' + '─'.repeat(56))
console.log(`bundle: ${bundle}`)
console.log(`wall (launch → first paint):  ${stat(wall)}`)
console.log(`internal (main → first paint): ${stat(internal)}`)
if (maxMs > 0) {
  const worst = Math.max(...wall)
  if (worst > maxMs) {
    console.error(`STARTUP_CONFORMANCE_FAIL wall max ${worst.toFixed(1)}ms > ${maxMs}ms`)
    process.exit(1)
  }
  console.log(`STARTUP_CONFORMANCE_PASS wall max ${worst.toFixed(1)}ms <= ${maxMs}ms`)
}

function stageServiceDylibs(binary) {
  const releaseDir = dirname(resolve(binary))
  const hermesRoot = resolve(process.env.HERMES_ROOT || '/Users/n8/github/hermes')
  const hermesDylib = resolve(hermesRoot, 'build', 'lib', 'libhermesvm.dylib')
  const stagedHermes = join(releaseDir, 'libhermesvm.dylib')
  if (!existsSync(stagedHermes)) {
    if (!existsSync(hermesDylib)) throw new Error(`libhermesvm.dylib not found: ${hermesDylib}`)
    copyFileSync(hermesDylib, stagedHermes)
  }

  const ghostty = findDylibs(resolve(releaseDir, 'build'), 'libghostty-vt')
  const stagedGhostty = findDylibs(releaseDir, 'libghostty-vt')
  if (!ghostty.length && !stagedGhostty.length) {
    throw new Error(`libghostty-vt dylib not found under ${resolve(releaseDir, 'build')} or ${releaseDir}`)
  }
  for (const dylib of ghostty) copyFileSync(dylib, join(releaseDir, dylib.split('/').pop()))
}

function findDylibs(dir, prefix) {
  if (!existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('.dylib') && entry.name.startsWith(prefix)) out.push(path)
    }
  }
  return out
}
