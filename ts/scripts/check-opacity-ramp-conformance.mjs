#!/usr/bin/env bun
// Pixel ANIMATION conformance: a div's opacity must animate AND paint per frame on the
// real composited surface — not just ramp in the style tree. This is the regression guard
// the dead-opacity bug needed: every other animation conformance reads the tree-dump VALUE
// (or "any pixel moved"), so a dead opacity / dead transform passes them. Here we sample
// the actual composited pixel across time.
//
// Fixture examples/opacity-ramp.tsx pulses a STATIONARY red box opacity 0.15↔1. We launch
// it composited+invisible (rngpui dev → RNGPUI_CAPTURE_ONSCREEN), read the live frame.png
// at intervals, and assert the box-center pixel interpolates: red over white at low opacity
// is pale (green channel high), at full opacity is saturated (green low). A dead opacity →
// constant pixel → FAIL.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPng } from './png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tsRoot = resolve(here, '..')
const fixture = resolve(tsRoot, 'examples/opacity-ramp.tsx')
const W = 520, H = 360

function fail(msg) {
  console.error(`OPACITY_RAMP_CONFORMANCE_FAIL ${msg}`)
  process.exit(1)
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// launch a kept, composited, invisible instance; parse its session dir.
const dev = spawnSync(
  'bun',
  ['run', 'cli/bin.ts', 'dev', '--launch', fixture, '--size', `${W}x${H}`, '--appearance', 'light'],
  { cwd: tsRoot, encoding: 'utf8', env: process.env },
)
const out = `${dev.stdout || ''}${dev.stderr || ''}`
const sessionDir = out.match(/session:\s*(\S+)/)?.[1]
if (dev.status !== 0 || !sessionDir) fail(`dev launch failed:\n${out.slice(0, 1200)}`)
const framePath = join(sessionDir, 'frame.png')

function closeSession() {
  spawnSync('bun', ['run', 'cli/bin.ts', 'close', '--session', sessionDir], { cwd: tsRoot, encoding: 'utf8' })
}

// sample the box-center pixel from the live frame.
function sampleCenter() {
  if (!existsSync(framePath) || statSync(framePath).size === 0) return null
  let png
  try { png = readPng(framePath) } catch { return null }
  const sx = png.width / W, sy = png.height / H
  const px = Math.round((W / 2) * sx), py = Math.round((H / 2) * sy)
  const i = (py * png.width + px) * 4
  return { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] }
}

try {
  const greens = []
  // ~2.6s of sampling at ~280ms — spans more than one 1.6s pulse so we cross multiple
  // opacity levels regardless of where the loop is when we attach.
  for (let k = 0; k < 10; k++) {
    sleep(280)
    const s = sampleCenter()
    if (s) greens.push({ g: s.g, hex: `#${[s.r, s.g, s.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` })
  }
  closeSession()

  if (greens.length < 5) fail(`only ${greens.length} frames captured — capture path not producing frames`)
  const gs = greens.map((x) => x.g)
  const min = Math.min(...gs), max = Math.max(...gs)
  const distinct = new Set(gs.map((g) => Math.round(g / 20))).size
  // pale (low opacity) green ≈ 0.85*255 over white ≈ 180+, saturated (full) green ≈ <60.
  // A real ramp spans a wide green range across ≥3 distinct levels; a dead opacity is flat.
  if (max - min < 70 || distinct < 3) {
    fail(`opacity did not animate in PIXELS: green range ${min}..${max} (Δ${max - min}), distinct=${distinct}. ` +
         `samples=[${greens.map((x) => x.hex).join(', ')}]. A dead opacity paints a constant box.`)
  }
  console.log(`OPACITY_RAMP_CONFORMANCE_PASS green ${min}..${max} (Δ${max - min}) distinct=${distinct} frames=${greens.length}`)
} catch (e) {
  closeSession()
  fail(e instanceof Error ? e.message : String(e))
}
