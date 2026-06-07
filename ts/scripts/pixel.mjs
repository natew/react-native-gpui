// Pixel / color sampling on decoded PNGs — the "what color is it actually
// rendering" primitives the conformance + parity scripts kept re-deriving by
// hand. Operates on a decoded image ({ width, height, rgba }) from png.mjs, or
// on a path/Buffer (auto-decoded). All colors come back as { r, g, b, a, hex }.
import { decodePng, readPng } from './png.mjs'

// accept a decoded {width,height,rgba}, a Buffer, or a file path.
export function toImage(src) {
    if (src && typeof src === 'object' && src.rgba && typeof src.width === 'number') return src
    if (Buffer.isBuffer(src)) return decodePng(src)
    if (typeof src === 'string') return readPng(src)
    throw new Error('expected a decoded image, png Buffer, or file path')
}

export function toHex({ r, g, b }) {
    const h = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')
    return `#${h(r)}${h(g)}${h(b)}`
}

// "#rrggbb" / "#rgb" / "#rrggbbaa" / "r,g,b[,a]" → { r, g, b, a }
export function parseColor(value) {
    if (value && typeof value === 'object') return { a: 255, ...value }
    const s = String(value).trim()
    if (s.startsWith('#')) {
        let hex = s.slice(1)
        if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
        if (hex.length === 6) hex += 'ff'
        if (hex.length !== 8) throw new Error(`invalid hex color "${value}"`)
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: parseInt(hex.slice(6, 8), 16),
        }
    }
    const parts = s.split(',').map((n) => Number(n.trim()))
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) throw new Error(`invalid color "${value}"`)
    const [r, g, b, a = 255] = parts
    return { r, g, b, a }
}

function withHex(color) {
    return { ...color, hex: toHex(color) }
}

export function pixelAt(src, x, y) {
    const img = toImage(src)
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
        throw new Error(`pixel ${px},${py} out of bounds (${img.width}x${img.height})`)
    }
    const i = (py * img.width + px) * 4
    return withHex({ r: img.rgba[i], g: img.rgba[i + 1], b: img.rgba[i + 2], a: img.rgba[i + 3] })
}

// clamp a rect to image bounds; default rect = whole image.
function resolveRect(img, rect) {
    if (!rect) return { x: 0, y: 0, width: img.width, height: img.height }
    const x = Math.max(0, Math.round(rect.x ?? 0))
    const y = Math.max(0, Math.round(rect.y ?? 0))
    const width = Math.min(img.width - x, Math.round(rect.width ?? img.width))
    const height = Math.min(img.height - y, Math.round(rect.height ?? img.height))
    if (width <= 0 || height <= 0) throw new Error(`empty rect ${JSON.stringify(rect)} for ${img.width}x${img.height}`)
    return { x, y, width, height }
}

// mean color over a rect. Premultiplies by alpha so transparent pixels don't
// drag the average toward their (often garbage) rgb — and reports mean alpha.
export function averageColor(src, rect) {
    const img = toImage(src)
    const r = resolveRect(img, rect)
    let rs = 0
    let gs = 0
    let bs = 0
    let as = 0
    let weight = 0
    for (let yy = 0; yy < r.height; yy += 1) {
        for (let xx = 0; xx < r.width; xx += 1) {
            const i = ((r.y + yy) * img.width + (r.x + xx)) * 4
            const a = img.rgba[i + 3]
            const w = a / 255
            rs += img.rgba[i] * w
            gs += img.rgba[i + 1] * w
            bs += img.rgba[i + 2] * w
            as += a
            weight += w
        }
    }
    const count = r.width * r.height
    const safe = weight || 1
    return withHex({
        r: rs / safe,
        g: gs / safe,
        b: bs / safe,
        a: as / count,
    })
}

// quantize colors into buckets and return the most-covered bucket (+ coverage
// fraction). Good for "what's the dominant background color of this area".
export function dominantColor(src, rect, { bucket = 16 } = {}) {
    const img = toImage(src)
    const r = resolveRect(img, rect)
    const counts = new Map()
    const q = (n) => Math.min(255, Math.floor(n / bucket) * bucket + Math.floor(bucket / 2))
    let total = 0
    for (let yy = 0; yy < r.height; yy += 1) {
        for (let xx = 0; xx < r.width; xx += 1) {
            const i = ((r.y + yy) * img.width + (r.x + xx)) * 4
            if (img.rgba[i + 3] < 8) continue // skip fully transparent
            const key = (q(img.rgba[i]) << 16) | (q(img.rgba[i + 1]) << 8) | q(img.rgba[i + 2])
            counts.set(key, (counts.get(key) || 0) + 1)
            total += 1
        }
    }
    if (!total) throw new Error('region is fully transparent')
    let bestKey = 0
    let bestN = 0
    for (const [key, n] of counts) {
        if (n > bestN) {
            bestN = n
            bestKey = key
        }
    }
    return {
        ...withHex({ r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff, a: 255 }),
        coverage: bestN / total,
        distinctColors: counts.size,
    }
}

// euclidean rgb distance (0 = identical, ~441 = black↔white).
export function colorDistance(a, b) {
    const dr = a.r - b.r
    const dg = a.g - b.g
    const db = a.b - b.b
    return Math.sqrt(dr * dr + dg * dg + db * db)
}

// assertion helper: does the average color of a rect match `expected` within
// `tolerance` (rgb distance)? Returns { match, actual, expected, distance }.
export function regionMatches(src, rect, expected, tolerance = 12) {
    const actual = averageColor(src, rect)
    const want = withHex(parseColor(expected))
    const distance = colorDistance(actual, want)
    return { match: distance <= tolerance, actual, expected: want, distance, tolerance }
}

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n))
}
