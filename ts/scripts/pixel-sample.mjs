#!/usr/bin/env bun
// Sample colors out of a captured PNG without eyeballing it.
//
//   bun scripts/pixel-sample.mjs <png> [op...] [--json]
//
// ops (repeatable; if none given, prints size + whole-image average + dominant):
//   --at x,y                color of a single pixel
//   --avg x,y,w,h           alpha-weighted mean color of a rect
//   --dominant x,y,w,h      most-covered quantized color of a rect (+ coverage)
//   --expect x,y,w,h=COLOR  assert a rect's mean ≈ COLOR; nonzero exit on mismatch
//                           COLOR is #rrggbb / #rgb / #rrggbbaa / r,g,b[,a]
//   --tolerance n           rgb-distance tolerance for --expect (default 12)
//
// examples:
//   bun scripts/pixel-sample.mjs /tmp/agentbus-parity/desktop-dark.png --at 40,40
//   bun scripts/pixel-sample.mjs cap.png --avg 0,0,200,48 --json
//   bun scripts/pixel-sample.mjs cap.png --expect 0,0,40,40=#101115 --tolerance 16
import { pngSize } from './png.mjs'
import { averageColor, dominantColor, pixelAt, regionMatches } from './pixel.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const positionals = argv.filter((a) => !a.startsWith('--'))
const path = positionals[0]
if (!path) {
    console.error('usage: bun scripts/pixel-sample.mjs <png> [--at x,y] [--avg x,y,w,h] [--dominant x,y,w,h] [--expect x,y,w,h=COLOR] [--tolerance n] [--json]')
    process.exit(1)
}

const tolerance = Number(flagValue('--tolerance') ?? 12)
const results = []
let failed = false

const ops = collectOps(argv)
if (!ops.length) {
    const [w, h] = pngSize(path)
    results.push({ op: 'size', width: w, height: h })
    results.push({ op: 'avg', rect: { x: 0, y: 0, width: w, height: h }, ...averageColor(path) })
    results.push({ op: 'dominant', rect: { x: 0, y: 0, width: w, height: h }, ...dominantColor(path) })
} else {
    for (const op of ops) {
        if (op.kind === 'at') {
            results.push({ op: 'at', x: op.x, y: op.y, ...pixelAt(path, op.x, op.y) })
        } else if (op.kind === 'avg') {
            results.push({ op: 'avg', rect: op.rect, ...averageColor(path, op.rect) })
        } else if (op.kind === 'dominant') {
            results.push({ op: 'dominant', rect: op.rect, ...dominantColor(path, op.rect) })
        } else if (op.kind === 'expect') {
            const m = regionMatches(path, op.rect, op.color, tolerance)
            results.push({ op: 'expect', rect: op.rect, ...m })
            if (!m.match) failed = true
        }
    }
}

if (json) {
    console.log(JSON.stringify(results, null, 2))
} else {
    for (const r of results) console.log(formatResult(r))
}
process.exit(failed ? 1 : 0)

function collectOps(args) {
    const ops = []
    for (let i = 0; i < args.length; i += 1) {
        const a = args[i]
        if (a === '--at') ops.push({ kind: 'at', ...parsePoint(args[++i]) })
        else if (a === '--avg') ops.push({ kind: 'avg', rect: parseRect(args[++i]) })
        else if (a === '--dominant') ops.push({ kind: 'dominant', rect: parseRect(args[++i]) })
        else if (a === '--expect') {
            const [rectStr, color] = String(args[++i]).split('=')
            ops.push({ kind: 'expect', rect: parseRect(rectStr), color })
        }
    }
    return ops
}

function parsePoint(s) {
    const [x, y] = String(s).split(',').map((n) => Number(n.trim()))
    if (![x, y].every(Number.isFinite)) throw new Error(`invalid point "${s}", expected x,y`)
    return { x, y }
}

function parseRect(s) {
    const [x, y, width, height] = String(s).split(',').map((n) => Number(n.trim()))
    if (![x, y, width, height].every(Number.isFinite)) throw new Error(`invalid rect "${s}", expected x,y,w,h`)
    return { x, y, width, height }
}

function flagValue(name) {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : null
}

function formatResult(r) {
    const rect = r.rect ? ` rect=${r.rect.x},${r.rect.y},${r.rect.width},${r.rect.height}` : ''
    if (r.op === 'size') return `size ${r.width}x${r.height}`
    if (r.op === 'at') return `at ${r.x},${r.y} → ${r.hex} rgba(${round(r.r)},${round(r.g)},${round(r.b)},${round(r.a)})`
    if (r.op === 'avg') return `avg${rect} → ${r.hex} rgba(${round(r.r)},${round(r.g)},${round(r.b)},${round(r.a)})`
    if (r.op === 'dominant') return `dominant${rect} → ${r.hex} coverage=${(r.coverage * 100).toFixed(1)}% distinct=${r.distinctColors}`
    if (r.op === 'expect') {
        const verdict = r.match ? 'MATCH' : 'MISMATCH'
        return `expect${rect} → ${verdict} actual=${r.actual.hex} expected=${r.expected.hex} distance=${r.distance.toFixed(1)} tol=${r.tolerance}`
    }
    return JSON.stringify(r)
}

function round(n) {
    return Math.round(n)
}
