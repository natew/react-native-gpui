#!/usr/bin/env node
// THE off-thread reanimated proof gate (plans/off-thread-reanimated.md).
//
// Launches examples/offthread-stall-conformance.tsx offscreen with
// RNGPUI_ANIM_TRACE=1: a continuous reanimated opacity loop runs while the fixture
// blocks the REACT thread in a synchronous 800ms busy-loop. The worklet/UI runtime
// must keep producing `setNodeStyle` crossings the whole time. On the old
// single-runtime architecture the stall window shows ~0 crossings (a blocked JS
// thread can't tick an animation) — this gate is exactly what "reanimated is off
// the React thread" means.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(tsRoot, '..')
const outDir = process.argv[2] || '/tmp/rngpui-offthread-stall-conformance'
const outJs = `${outDir}/app.js`
const outHbc = `${outDir}/app.hbc`

const bundle = spawnSync(
  'bun',
  ['scripts/bundle-hermes.mjs', resolve(tsRoot, 'examples/offthread-stall-conformance.tsx'), outJs, '--bytecode'],
  { cwd: tsRoot, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
)
if (bundle.status !== 0) {
  process.stderr.write(bundle.stdout || '')
  process.stderr.write(bundle.stderr || '')
  fail('bundle failed')
}

const serviceBin = resolve(process.env.RNGPUI_SERVICE || resolve(repoRoot, 'rust', 'target', 'release', 'rngpui-service'))
if (!existsSync(serviceBin)) fail(`rngpui-service not found: ${serviceBin}`)

let output = ''
const child = spawn(serviceBin, [], {
  cwd: tsRoot,
  env: {
    ...process.env,
    RNGPUI_BUNDLE: outHbc,
    RNGPUI_NO_ACTIVATE: '1',
    RNGPUI_TEST_MODE: '1',
    RNGPUI_ANIM_TRACE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', (c) => (output += c.toString()))
child.stderr?.on('data', (c) => (output += c.toString()))

try {
  await waitFor(() => output.includes('offthread-stall RUNNING'), 8000, 'RUNNING')
  await waitFor(() => output.includes('offthread-stall DONE'), 8000, 'DONE')
} catch (e) {
  stop()
  fail(`${e instanceof Error ? e.message : String(e)}\n--- output ---\n${output.trim()}`)
}
stop()

const startIdx = output.indexOf('offthread-stall STALL_START')
const endIdx = output.indexOf('offthread-stall STALL_END')
if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
  fail(`stall markers missing/misordered (start=${startIdx} end=${endIdx})\n--- output ---\n${output.trim()}`)
}
const stallWindow = output.slice(startIdx, endIdx)
const stallCrossings = (stallWindow.match(/\[anim-trace\] setNodeStyle/g) || []).length
const stallCommits = (stallWindow.match(/\[anim-trace\] applyTree/g) || []).length
const totalCrossings = (output.match(/\[anim-trace\] setNodeStyle/g) || []).length

// 800ms stall, 240ms ping-pong loop flushing once per UI-runtime rAF tick:
// ≥25 leaves generous headroom for a loaded machine at 60Hz; single-runtime
// measures ~0 here.
const offThreadOk = stallCrossings >= 25
const noCommitsOk = stallCommits === 0

console.log(
  [
    'OFFTHREAD_STALL_CONFORMANCE',
    `stallCrossings=${stallCrossings}`,
    `stallCommits=${stallCommits}`,
    `totalCrossings=${totalCrossings}`,
    `offThread=${offThreadOk ? 'PASS' : 'FAIL'}`,
    `noCommits=${noCommitsOk ? 'PASS' : 'FAIL'}`,
  ].join(' '),
)
if (!offThreadOk) {
  fail(
    `animation did not survive the React-thread stall: ${stallCrossings} setNodeStyle crossings during the 800ms busy-loop (need ≥25). reanimated is NOT off the React thread.`,
  )
}
if (!noCommitsOk) fail(`React commits during a blocked React thread should be impossible: ${stallCommits}`)
console.log('OFFTHREAD_STALL_CONFORMANCE PASS')
process.exit(0)

function stop() {
  try {
    child.kill('SIGTERM')
  } catch {}
}

function fail(message) {
  console.error(`OFFTHREAD_STALL_CONFORMANCE FAIL: ${message}`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}
