#!/usr/bin/env node
// Conformance driver for the off-thread-reanimated FAST PATH (seam + Rust overlay).
//
// Runs examples/anim-overlay-conformance.tsx offscreen, polling RNGPUI_DUMP_TREE for
// the spring box's overlay-merged width while the spring runs, and asserts:
//   1. RAMP — the box width hits >3 distinct rounded values (a real spring, not a snap).
//   2. FAST PATH — during the animation the host receives many `setNodeStyle` crossings
//      and (essentially) no `applyTree` re-commits between them (React isn't
//      re-committing per frame; the overlay drives layout).
//
// Offscreen only (RNGPUI_NO_ACTIVATE / RNGPUI_TEST_MODE). No foreground window.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(tsRoot, '..')
const outDir = process.argv[2] || '/tmp/rngpui-anim-overlay-conformance'
const holdMs = 500

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const outJs = `${outDir}/app.js`
const outHbc = `${outDir}/app.hbc`
const dumpPath = `${outDir}/tree.json`

// bundle the fixture to HBC (esbuild via Bun + reanimated seam plugin).
const bundle = spawnSync(
  'bun',
  ['scripts/bundle-hermes.mjs', resolve(tsRoot, 'examples/anim-overlay-conformance.tsx'), outJs, '--bytecode'],
  { cwd: tsRoot, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
)
if (bundle.status !== 0) {
  process.stderr.write(bundle.stdout || '')
  process.stderr.write(bundle.stderr || '')
  fail('bundle failed')
}

const serviceBin = resolve(
  process.env.RNGPUI_SERVICE || resolve(repoRoot, 'rust', 'target', 'release', 'rngpui-service'),
)
if (!existsSync(serviceBin)) fail(`rngpui-service not found: ${serviceBin} (build it or set RNGPUI_SERVICE)`)

let output = ''
const child = spawn(serviceBin, [], {
  cwd: tsRoot,
  env: {
    ...process.env,
    RNGPUI_BUNDLE: outHbc,
    RNGPUI_NO_ACTIVATE: '1',
    RNGPUI_TEST_MODE: '1',
    RNGPUI_DUMP_TREE: dumpPath,
    RNGPUI_ANIM_TRACE: '1',
    RNGPUI_ANIM_HOLD_MS: String(holdMs),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', (c) => (output += c.toString()))
child.stderr?.on('data', (c) => (output += c.toString()))

const widths = new Set()
try {
  await waitFor(() => output.includes('CONFORMANCE anim-overlay RUNNING'), 6000, 'RUNNING')
  // sample the overlay-merged width through the dump for ~2.5s while the spring runs.
  const deadline = Date.now() + 2800
  while (Date.now() < deadline && !output.includes('CONFORMANCE anim-overlay PASS')) {
    const w = readWidth(dumpPath)
    if (typeof w === 'number') widths.add(Math.round(w))
    await sleep(25)
  }
  // grab a couple more after settle
  for (let i = 0; i < 4; i++) {
    const w = readWidth(dumpPath)
    if (typeof w === 'number') widths.add(Math.round(w))
    await sleep(25)
  }
  await waitFor(() => output.includes('CONFORMANCE anim-overlay PASS'), 4000, 'PASS')
} catch (e) {
  stop()
  fail(`${e instanceof Error ? e.message : String(e)}\n--- output ---\n${output.trim()}`)
}
stop()

const applyTree = (output.match(/\[anim-trace\] applyTree/g) || []).length
const setNodeStyle = (output.match(/\[anim-trace\] setNodeStyle/g) || []).length
const distinct = [...widths].sort((a, b) => a - b)

const rampOk = distinct.length > 3 && distinct[0] <= 80 && distinct[distinct.length - 1] >= 280
// during the animation we expect MANY setNodeStyle crossings and only a few applyTree
// (initial mount + the two phase setStates). fast path = setNodeStyle dominates.
const fastPathOk = setNodeStyle >= 10 && applyTree <= 6 && setNodeStyle > applyTree * 3

console.log(
  [
    'ANIM_OVERLAY_CONFORMANCE',
    `distinctWidths=${distinct.length}`,
    `widths=[${distinct.join(',')}]`,
    `setNodeStyle=${setNodeStyle}`,
    `applyTree=${applyTree}`,
    `ramp=${rampOk ? 'PASS' : 'FAIL'}`,
    `fastPath=${fastPathOk ? 'PASS' : 'FAIL'}`,
  ].join(' '),
)

if (!rampOk) fail(`spring did not ramp: only ${distinct.length} distinct widths [${distinct.join(',')}]`)
if (!fastPathOk) fail(`fast path not proven: setNodeStyle=${setNodeStyle} applyTree=${applyTree}`)
console.log('ANIM_OVERLAY_CONFORMANCE PASS')
process.exit(0)

function readWidth(path) {
  if (!existsSync(path)) return undefined
  let tree
  try {
    tree = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  return find(tree)
  function find(n) {
    if (n && typeof n === 'object') {
      if ((n.accessibility || {}).nativeID === 'spring-box') {
        const w = n.style?.width
        return typeof w === 'number' ? w : typeof w === 'string' ? Number(w) : undefined
      }
      for (const c of n.children || []) {
        const r = find(c)
        if (r !== undefined) return r
      }
    }
    return undefined
  }
}

function stop() {
  if (child.exitCode == null) {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
async function waitFor(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    if (child.exitCode != null) throw new Error(`service exited before ${label}`)
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}
function fail(msg) {
  console.error(`ANIM_OVERLAY_CONFORMANCE FAIL ${msg}`)
  process.exit(1)
}
