#!/usr/bin/env bun
// Preview a captured PNG in the terminal as an ANSI truecolor grid — "see" an
// offscreen frame without opening an image viewer. Each cell is the average
// color of the corresponding image region.
//
//   bun scripts/png-grid.mjs <png> [--cols N] [--rows M] [--crop x,y,w,h] [--hex]
//
//   --cols N      grid columns (default 48); rows auto-fit the aspect ratio
//   --rows M      force grid rows
//   --crop ...    preview only a sub-rect
//   --hex         print a hex-value grid instead of color blocks (pipe-safe)
//
// example:
//   bun native-shell/scripts/capture-desktop.ts && \
//     bun ../../react-native-gpui/ts/scripts/png-grid.mjs /tmp/agentbus-desktop.png
import { readPng } from './png.mjs'
import { averageColor, toHex } from './pixel.mjs'

const argv = process.argv.slice(2)
const path = argv.find((a) => !a.startsWith('--'))
if (!path) {
  console.error('usage: bun scripts/png-grid.mjs <png> [--cols N] [--rows M] [--crop x,y,w,h] [--hex]')
  process.exit(1)
}
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}
// color blocks are great in a live terminal but pure noise when the output is
// captured as text (an agent reading tool output) — default to the hex grid then.
const hex = argv.includes('--hex') || (!argv.includes('--color') && !process.stdout.isTTY)
const cols = Math.max(1, Number(opt('--cols', '48')))
const crop = opt('--crop', null)

const img = readPng(path)
const region = crop
  ? (() => {
      const [x, y, width, height] = crop.split(',').map(Number)
      return { x, y, width, height }
    })()
  : { x: 0, y: 0, width: img.width, height: img.height }

// terminal cells are ~2x taller than wide; with 2 chars per cell, grid aspect ≈
// cols/rows, so rows = cols * (regionH / regionW) keeps the preview proportional.
const rows = Math.max(1, Math.min(Number(opt('--rows', '0')) || Math.round(cols * (region.height / region.width)), 60))
const cellW = region.width / cols
const cellH = region.height / rows

const lines = []
for (let r = 0; r < rows; r += 1) {
  let line = ''
  for (let c = 0; c < cols; c += 1) {
    const rect = {
      x: region.x + c * cellW,
      y: region.y + r * cellH,
      width: Math.max(1, Math.ceil(cellW)),
      height: Math.max(1, Math.ceil(cellH)),
    }
    const { r: rr, g, b } = averageColor(img, rect)
    if (hex) {
      line += toHex({ r: rr, g, b }).slice(1) + ' '
    } else {
      line += `\x1b[48;2;${Math.round(rr)};${Math.round(g)};${Math.round(b)}m  \x1b[0m`
    }
  }
  lines.push(line)
}

console.log(`${path}  ${img.width}x${img.height}  grid ${cols}x${rows}`)
console.log(lines.join('\n'))
