#!/usr/bin/env node
// Conformance driver for REAL react-native-reanimated@4 + worklets on react-native-gpui.
//
// Builds examples/reanimated-conformance.tsx (an `Animated.View` whose width is driven
// by `useAnimatedStyle(() => ({ width: withSpring(target) }))`) and runs it offscreen,
// asserting:
//   1. RAMP — the box width hits many distinct rounded values (a real spring incl.
//      overshoot, not a snap from start→end).
//   2. FAST PATH — during the spring the host receives many `setNodeStyle` crossings and
//      few `applyTree` re-commits (the overlay drives layout; React isn't re-committing
//      per frame).
//
// Requires the esbuild-prebuilt reanimated chunk (bun scripts/prebuild-reanimated.mjs).
// Offscreen only.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(tsRoot, '..')
const outDir = process.argv[2] || '/tmp/rngpui-reanimated-conformance'
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const outJs = `${outDir}/app.js`
const outHbc = `${outDir}/app.hbc`
const dumpPath = `${outDir}/tree.json`

// ensure the prebuilt reanimated chunk exists (build it if missing).
if (!existsSync(resolve(tsRoot, '.reanimated-prebuilt/react-native-reanimated.mjs'))) {
  const pre = spawnSync('bun', ['scripts/prebuild-reanimated.mjs'], { cwd: tsRoot, encoding: 'utf8' })
  if (pre.status !== 0) {
    process.stderr.write(pre.stdout || '')
    process.stderr.write(pre.stderr || '')
    fail('prebuild-reanimated failed')
  }
}

const bundle = spawnSync(
  'bun',
  ['scripts/bundle-hermes.mjs', resolve(tsRoot, 'examples/reanimated-conformance.tsx'), outJs, '--bytecode'],
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
    RNGPUI_DUMP_TREE: dumpPath,
    RNGPUI_ANIM_TRACE: '1',
    RNGPUI_REANIMATED_HOLD_MS: '600',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', (c) => (output += c.toString()))
child.stderr?.on('data', (c) => (output += c.toString()))

const widths = new Set()
try {
  await waitFor(() => output.includes('CONFORMANCE reanimated RUNNING'), 7000, 'RUNNING')
  const deadline = Date.now() + 2800
  while (Date.now() < deadline && !output.includes('CONFORMANCE reanimated PASS')) {
    const w = readWidth(dumpPath)
    if (typeof w === 'number') widths.add(Math.round(w))
    await sleep(20)
  }
  await waitFor(() => output.includes('CONFORMANCE reanimated PASS'), 4000, 'PASS')
} catch (e) {
  stop()
  fail(`${e instanceof Error ? e.message : String(e)}\n--- output ---\n${output.trim()}`)
}
stop()

const applyTree = (output.match(/\[anim-trace\] applyTree/g) || []).length
const setNodeStyle = (output.match(/\[anim-trace\] setNodeStyle/g) || []).length
const distinct = [...widths].sort((a, b) => a - b)
const rampOk = distinct.length > 3 && distinct[0] <= 90 && distinct[distinct.length - 1] >= 280
const fastPathOk = setNodeStyle >= 10 && applyTree <= 6 && setNodeStyle > applyTree * 3

console.log(
  [
    'REANIMATED_CONFORMANCE',
    `distinctWidths=${distinct.length}`,
    `widths=[${distinct.join(',')}]`,
    `setNodeStyle=${setNodeStyle}`,
    `applyTree=${applyTree}`,
    `ramp=${rampOk ? 'PASS' : 'FAIL'}`,
    `fastPath=${fastPathOk ? 'PASS' : 'FAIL'}`,
  ].join(' '),
)
if (!rampOk) fail(`spring did not ramp: ${distinct.length} distinct [${distinct.join(',')}]`)
if (!fastPathOk) fail(`fast path not proven: setNodeStyle=${setNodeStyle} applyTree=${applyTree}`)
console.log('REANIMATED_CONFORMANCE PASS')
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
  console.error(`REANIMATED_CONFORMANCE FAIL ${msg}`)
  process.exit(1)
}
