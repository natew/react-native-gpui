#!/usr/bin/env bun
// Transform render conformance: `transform` must actually PAINT (move/scale pixels),
// not just sit parsed in the style tree. Regression guard for P0.1, where transform was
// parsed and listed paint-only but never applied — every dialog/sheet scale/translateY
// spring silently no-oped.
//
// Static fixture (examples/transform-probe.tsx) on white:
//   tx-translate  red,  translateY(60) — red must paint 60px BELOW its layout slot
//   tx-scale      blue, scale(0.5)     — blue must shrink to half around its center
//   tx-marker     green, untransformed control
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPng } from './png.mjs'
import { pixelAt } from './pixel.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tsRoot = resolve(here, '..')

function fail(msg) {
  console.error(`TRANSFORM_CONFORMANCE_FAIL ${msg}`)
  process.exit(1)
}

const out = '/tmp/transform-conformance.png'
const run = spawnSync(
  'bun',
  ['run', 'cli/bin.ts', 'shot', '--launch', resolve(tsRoot, 'examples/transform-probe.tsx'),
   '--size', '700x360', '--appearance', 'light', '--out', out],
  { cwd: tsRoot, encoding: 'utf8', env: process.env },
)
if (run.status !== 0) fail(`shot failed:\n${(run.stdout || '') + (run.stderr || '')}`.slice(0, 1200))

const png = readPng(out)
const scale = png.width / 700 // capture may be 2x
const at = (x, y) => {
  const p = pixelAt(png, Math.round(x * scale), Math.round(y * scale))
  return { r: p.r, g: p.g, b: p.b }
}
const isWhite = (c) => c.r > 230 && c.g > 230 && c.b > 230
const isRed = (c) => c.r > 150 && c.g < 110 && c.b < 110
const isBlue = (c) => c.b > 150 && c.r < 110
const isGreen = (c) => c.g > 120 && c.r < 120 && c.b < 120

// translate: layout slot is 60,60..180,180; painted body is 60px lower
if (!isWhite(at(120, 70))) fail(`tx-translate still paints in its layout slot (${JSON.stringify(at(120, 70))}) — translateY not applied`)
if (!isRed(at(120, 220))) fail(`tx-translate did not paint 60px below (${JSON.stringify(at(120, 220))})`)

// scale: layout slot 260,60..380,180; scale(0.5) leaves the slot corner bare, center filled
if (!isWhite(at(275, 75))) fail(`tx-scale corner still painted (${JSON.stringify(at(275, 75))}) — scale not applied`)
if (!isBlue(at(320, 120))) fail(`tx-scale center not painted (${JSON.stringify(at(320, 120))})`)

// control: untransformed box must be exactly where layout put it
if (!isGreen(at(520, 120))) fail(`control box wrong (${JSON.stringify(at(520, 120))}) — capture/layout issue`)

console.log('TRANSFORM_CONFORMANCE_PASS translateY moves pixels, scale shrinks around center, control intact')
