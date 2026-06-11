#!/usr/bin/env bun
// Opacity render conformance: a div's `opacity` must actually paint (fade the element
// AND its drop shadow), not just sit in the style tree. This is the regression guard for
// the bug where `style.opacity` was set on the gpui style but never pushed onto gpui's
// element-opacity stack, so every dialog/sheet fade (opacity spring / enterStyle /
// exitStyle / AnimatePresence) rendered at FULL opacity — only `transform` animated.
//
// Static fixture (examples/opacity-probe.tsx): three identical red boxes on white,
// differing ONLY in opacity, so the sampled pixel isolates opacity (no transform, no
// movement that a frame-diff could pass on). Captured via the in-service composited
// readback (shot --launch → RNGPUI_CAPTURE_ONSCREEN).
//
//   op-full   opacity 1.0  → saturated red
//   op-half   opacity 0.3  → red over white at 0.3 ≈ pale pink (G,B raised toward 255)
//   op-shadow opacity 0.3  → same pale pink (its hard black shadow must fade too)
//
// PASS when op-half is markedly lighter than op-full (white shows through), i.e. its
// green/blue channels rise well above op-full's. FAIL (the regression) when op-half ==
// op-full (opacity ignored).
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tsRoot = resolve(here, '..')
const fixture = resolve(tsRoot, 'examples/opacity-probe.tsx')

function fail(msg) {
  console.error(`OPACITY_CONFORMANCE_FAIL ${msg}`)
  process.exit(1)
}

const run = spawnSync(
  'bun',
  ['run', 'cli/bin.ts', 'shot', '--launch', fixture, '--size', '900x360', '--appearance', 'light',
   '--select', 'op-full', '--select', 'op-half', '--select', 'op-shadow', '--json',
   '--out', '/tmp/opacity-conformance.png'],
  { cwd: tsRoot, encoding: 'utf8', env: process.env },
)
const out = `${run.stdout || ''}`
const jsonStart = out.indexOf('{')
if (run.status !== 0 || jsonStart < 0) fail(`shot failed:\n${(run.stdout || '') + (run.stderr || '')}`.slice(0, 1500))

let result
try {
  result = JSON.parse(out.slice(jsonStart))
} catch {
  fail('could not parse shot --json output')
}

const by = Object.fromEntries((result.measurements || []).map((m) => [m.selector, m]))
const hex = (sel) => {
  const m = by[sel]
  if (!m || !m.dominant) fail(`no measurement for ${sel}`)
  return m.dominant
}
const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) })

const full = rgb(hex('op-full'))
const half = rgb(hex('op-half'))
const shadow = rgb(hex('op-shadow'))

// op-full is saturated red: green + blue both low.
if (full.g > 90 || full.b > 90) fail(`op-full is not saturated red (got ${hex('op-full')}) — fixture/capture issue`)

// the core assertion: op-half (opacity 0.3 red over white) must be markedly LIGHTER than
// op-full — white shows through, lifting green + blue. If opacity is ignored they are
// equal. Use a generous margin (the in-service capture has alpha-division AA), but well
// above the ~0 delta of the regression.
const dg = half.g - full.g
const db = half.b - full.b
if (dg < 70 || db < 70) {
  fail(`div opacity not painted: op-half ${hex('op-half')} ~= op-full ${hex('op-full')} (Δg=${dg} Δb=${db}). ` +
       `opacity 0.3 over white should lift green/blue toward ~178. The element-opacity wrap in div.rs paint is missing/broken.`)
}

// op-shadow (also opacity 0.3) must fade like op-half, not paint a full-opacity body.
const sdg = shadow.g - full.g
if (sdg < 70) fail(`op-shadow body did not fade (${hex('op-shadow')} vs full ${hex('op-full')}) — opacity not applied to a shadowed node`)

console.log(`OPACITY_CONFORMANCE_PASS op-full=${hex('op-full')} op-half=${hex('op-half')} op-shadow=${hex('op-shadow')} (Δg=${dg} Δb=${db})`)
