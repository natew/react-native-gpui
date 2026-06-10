#!/usr/bin/env node
// Conformance driver for the renderer→JS pseudo lane (plans/tamagui-pseudo-hook.md, rngpui half).
//
// Runs examples/pseudo-driver-conformance.tsx offscreen. A box subscribes to its native
// hover/press flips via platformDriver.pseudo.subscribe (the tamagui entry point). This gate
// drives a REAL offscreen pointer move (control-socket `realmove`, NOT synth) over the box,
// then away, and asserts:
//   1. FLIP — the listener fired hovered=true (pointer over box) then hovered=false (away).
//   2. NO RE-RENDER — the React render count logged at each flip equals the mount render count,
//      i.e. a hover never triggered a React commit (the whole point of the lane).
//
// Offscreen only (RNGPUI_NO_ACTIVATE / RNGPUI_TEST_MODE). No foreground window (HARD RULE).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(tsRoot, '..')
const outDir = process.argv[2] || '/tmp/rngpui-pseudo-driver-conformance'

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const outJs = join(outDir, 'app.js')
const outHbc = join(outDir, 'app.hbc')
const controlSocket = join(outDir, 'control.sock')

// bundle the fixture to HBC.
const bundle = spawnSync(
  'bun',
  ['scripts/bundle-hermes.mjs', resolve(tsRoot, 'examples/pseudo-driver-conformance.tsx'), outJs, '--bytecode'],
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
    RNGPUI_CONTROL_SOCKET: controlSocket,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', (c) => (output += c.toString()))
child.stderr?.on('data', (c) => (output += c.toString()))

let mountRenders = 0
try {
  await waitFor(() => /CONFORMANCE pseudo-driver READY/.test(output), 8000, 'READY')
  const ready = /CONFORMANCE pseudo-driver READY id=(\d+) renders=(\d+)/.exec(output)
  if (!ready) fail('no READY line')
  mountRenders = Number(ready[2])

  // the fixture measures the box in window coordinates (which also forces the offscreen
  // window to paint, so hitboxes are live for realmove). read that rect to aim the pointer.
  await waitFor(() => /CONFORMANCE pseudo-driver BOX/.test(output), 6000, 'BOX measure')
  const boxLine = /CONFORMANCE pseudo-driver BOX x=([\d.-]+) y=([\d.-]+) w=([\d.-]+) h=([\d.-]+)/.exec(output)
  if (!boxLine) fail('no BOX line')
  const box = { x: Number(boxLine[1]), y: Number(boxLine[2]), width: Number(boxLine[3]), height: Number(boxLine[4]) }
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // a point well outside the box (top-left corner of the window, inside no other hitbox).
  const awayX = 4
  const awayY = 4

  // 1. move OVER the box → expect a hovered=true flip.
  await realmove(awayX, awayY) // start outside so the first move into the box is a real flip
  await sleep(40)
  await realmove(cx, cy)
  await waitFor(() => /pseudo-driver FLIP hovered=true/.test(output), 3000, 'hover-in flip')
  await sleep(40)
  // 2. move AWAY → expect a hovered=false flip.
  await realmove(awayX, awayY)
  await waitFor(() => /pseudo-driver FLIP hovered=false/.test(output), 3000, 'hover-out flip')
  await sleep(40)
} catch (e) {
  stop()
  fail(`${e instanceof Error ? e.message : String(e)}\n--- output ---\n${output.trim()}`)
}
stop()

// ── analysis ──────────────────────────────────────────────────────────────
const flips = [...output.matchAll(/pseudo-driver FLIP hovered=(true|false) pressed=(true|false) renders=(\d+)/g)].map(
  (m) => ({ hovered: m[1] === 'true', pressed: m[2] === 'true', renders: Number(m[3]) }),
)
const sawHoverIn = flips.some((f) => f.hovered)
const sawHoverOut = flips.some((f) => !f.hovered)
// every flip must have been observed at the MOUNT render count — a hover that caused a
// React commit would log a higher renderCount.
const noReRender = flips.length > 0 && flips.every((f) => f.renders === mountRenders)

console.log(
  [
    'PSEUDO_DRIVER_CONFORMANCE',
    `flips=${flips.length}`,
    `mountRenders=${mountRenders}`,
    `flipRenders=[${flips.map((f) => f.renders).join(',')}]`,
    `hoverIn=${sawHoverIn ? 'PASS' : 'FAIL'}`,
    `hoverOut=${sawHoverOut ? 'PASS' : 'FAIL'}`,
    `noReRender=${noReRender ? 'PASS' : 'FAIL'}`,
  ].join(' '),
)

if (!sawHoverIn) fail('listener never fired hovered=true on hover-in')
if (!sawHoverOut) fail('listener never fired hovered=false on hover-out')
if (!noReRender) fail(`a hover caused a React re-render: mount=${mountRenders} flips=[${flips.map((f) => f.renders).join(',')}]`)
console.log('PSEUDO_DRIVER_CONFORMANCE PASS')
process.exit(0)

// ── helpers ─────────────────────────────────────────────────────────────────
// drive a REAL gpui mouse MOVE through the window's hitbox hit-test (NOT synth) over the
// control socket — the same path an OS hover takes. This is what flips the native hover
// state that the host emits as a `pseudo` event.
function realmove(x, y) {
  return new Promise((resolveP) => {
    const sock = net.connect(controlSocket)
    let buf = ''
    const done = (v) => {
      try {
        sock.end()
      } catch {}
      resolveP(v)
    }
    sock.on('error', () => done(null))
    sock.on('connect', () => sock.write(JSON.stringify({ reqId: 1, $cmd: 'realmove', x, y }) + '\n'))
    sock.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\n')) {
        try {
          done(JSON.parse(buf.trim()))
        } catch {
          done(null)
        }
      }
    })
    setTimeout(() => done(null), 2000)
  })
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
  console.error(`PSEUDO_DRIVER_CONFORMANCE FAIL ${msg}`)
  process.exit(1)
}
