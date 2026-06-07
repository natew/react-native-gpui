#!/usr/bin/env bun
// Unit tests for the pixel/PNG tooling (load-bearing for the desktop debugging
// workflow). Run: bun scripts/pixel.test.mjs
import { decodePng, encodePng } from './png.mjs'
import { averageColor, colorDistance, dominantColor, parseColor, pixelAt, regionMatches, toHex } from './pixel.mjs'

let failures = 0
function check(cond, label) {
  if (!cond) { console.error(`FAIL ${label}`); failures += 1 }
}
function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
    failures += 1
  }
}

// build a synthetic 4x2 RGBA image: top row red, bottom row blue (+ one green px).
const W = 4
const H = 2
const rgba = Buffer.alloc(W * H * 4)
const put = (x, y, r, g, b, a = 255) => {
  const i = (y * W + x) * 4
  rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a
}
for (let x = 0; x < W; x++) put(x, 0, 255, 0, 0)
for (let x = 0; x < W; x++) put(x, 1, 0, 0, 255)
put(0, 1, 0, 255, 0) // one green pixel in the blue row

// roundtrip through the PNG encoder/decoder must be lossless for 8-bit RGBA.
const decoded = decodePng(encodePng(W, H, rgba))
eq([decoded.width, decoded.height], [W, H], 'png roundtrip dimensions')
check(Buffer.compare(decoded.rgba, rgba) === 0, 'png roundtrip pixels lossless')

const img = { width: W, height: H, rgba }

// pixelAt
eq(pixelAt(img, 0, 0).hex, '#ff0000', 'pixelAt top-left red')
eq(pixelAt(img, 0, 1).hex, '#00ff00', 'pixelAt green pixel')
let threw = false
try { pixelAt(img, 99, 0) } catch { threw = true }
check(threw, 'pixelAt out-of-bounds throws')

// averageColor of the all-red top row = pure red
eq(averageColor(img, { x: 0, y: 0, width: 4, height: 1 }).hex, '#ff0000', 'averageColor red row')

// dominantColor of the bottom row = blue (3 of 4 px), green is minority. The
// returned color is the QUANTIZED bucket center (bucket=16), so assert it's
// blue-ish (within a bucket of pure blue) rather than exactly #0000ff.
const dom = dominantColor(img, { x: 0, y: 1, width: 4, height: 1 })
check(colorDistance(dom, { r: 0, g: 0, b: 255 }) < 16, `dominantColor blue-ish (got ${dom.hex})`)
check(dom.coverage >= 0.7, 'dominantColor coverage ~75%')

// regionMatches tolerance behaviour
check(regionMatches(img, { x: 0, y: 0, width: 4, height: 1 }, '#ff0000', 5).match, 'regionMatches exact')
check(!regionMatches(img, { x: 0, y: 0, width: 4, height: 1 }, '#00ff00', 5).match, 'regionMatches mismatch')

// parseColor + toHex + colorDistance
eq(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 255 }, 'parseColor #rgb')
eq(parseColor('10,20,30'), { r: 10, g: 20, b: 30, a: 255 }, 'parseColor csv')
eq(toHex({ r: 255, g: 0, b: 128 }), '#ff0080', 'toHex')
eq(colorDistance({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }), 0, 'colorDistance identical')
check(Math.abs(colorDistance({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) - 441.67) < 0.5, 'colorDistance black-white')

if (failures) { console.error(`PIXEL_TEST_FAIL ${failures} failing`); process.exit(1) }
console.log('PIXEL_TEST_PASS')
