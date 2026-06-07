// Minimal dependency-free PNG decode/encode, shared by pixel tooling.
//
// Extracted from pixel-diff.mjs so the decoder isn't trapped inside one CLI.
// Supports the encodings our captures actually produce: 8/16-bit depth,
// non-interlaced, color types 0 (gray), 2 (rgb), 4 (gray+alpha), 6 (rgba).
// Decoded images are always normalized to 8-bit RGBA: { width, height, rgba }.
import { inflateSync, deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let crcTable = null

// Read just the IHDR width/height without decoding pixels — cheap and used a lot.
export function pngSize(pathOrBuffer) {
    const buf = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : readFileSync(pathOrBuffer)
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a png file')
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

export function readPng(path) {
    return decodePng(readFileSync(path))
}

export function decodePng(buffer) {
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('not a png file')
    }

    let width = 0
    let height = 0
    let bitDepth = 0
    let colorType = 0
    const idat = []

    let offset = 8
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset)
        const type = buffer.toString('ascii', offset + 4, offset + 8)
        const dataStart = offset + 8
        const dataEnd = dataStart + length
        const data = buffer.subarray(dataStart, dataEnd)

        if (type === 'IHDR') {
            width = data.readUInt32BE(0)
            height = data.readUInt32BE(4)
            bitDepth = data[8]
            colorType = data[9]
            const compression = data[10]
            const filter = data[11]
            const interlace = data[12]
            if (![8, 16].includes(bitDepth) || compression !== 0 || filter !== 0 || interlace !== 0) {
                throw new Error('unsupported png encoding')
            }
            if (![0, 2, 4, 6].includes(colorType)) {
                throw new Error(`unsupported png color type ${colorType}`)
            }
        } else if (type === 'IDAT') {
            idat.push(data)
        } else if (type === 'IEND') {
            break
        }

        offset = dataEnd + 4
    }

    const bytesPerSample = bitDepth / 8
    const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1
    const raw = inflateSync(Buffer.concat(idat))
    const rowBytes = width * channels * bytesPerSample
    const scanlineBytes = rowBytes + 1
    const unfiltered = Buffer.alloc(rowBytes * height)

    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * scanlineBytes]
        const rowStart = y * rowBytes
        const sourceStart = y * scanlineBytes + 1
        for (let x = 0; x < rowBytes; x += 1) {
            const value = raw[sourceStart + x]
            const left = x >= channels * bytesPerSample ? unfiltered[rowStart + x - channels * bytesPerSample] : 0
            const up = y > 0 ? unfiltered[rowStart + x - rowBytes] : 0
            const upLeft =
                y > 0 && x >= channels * bytesPerSample
                    ? unfiltered[rowStart + x - rowBytes - channels * bytesPerSample]
                    : 0
            switch (filter) {
                case 0:
                    unfiltered[rowStart + x] = value
                    break
                case 1:
                    unfiltered[rowStart + x] = (value + left) & 0xff
                    break
                case 2:
                    unfiltered[rowStart + x] = (value + up) & 0xff
                    break
                case 3:
                    unfiltered[rowStart + x] = (value + Math.floor((left + up) / 2)) & 0xff
                    break
                case 4:
                    unfiltered[rowStart + x] = (value + paeth(left, up, upLeft)) & 0xff
                    break
                default:
                    throw new Error(`unsupported png filter ${filter}`)
            }
        }
    }

    const rgba = Buffer.alloc(width * height * 4)
    const sample = (index) => unfiltered[index]
    for (let i = 0, j = 0; i < unfiltered.length; i += channels * bytesPerSample, j += 4) {
        if (colorType === 6) {
            rgba[j] = sample(i)
            rgba[j + 1] = sample(i + bytesPerSample)
            rgba[j + 2] = sample(i + bytesPerSample * 2)
            rgba[j + 3] = sample(i + bytesPerSample * 3)
        } else if (colorType === 2) {
            rgba[j] = sample(i)
            rgba[j + 1] = sample(i + bytesPerSample)
            rgba[j + 2] = sample(i + bytesPerSample * 2)
            rgba[j + 3] = 255
        } else if (colorType === 4) {
            rgba[j] = sample(i)
            rgba[j + 1] = sample(i)
            rgba[j + 2] = sample(i)
            rgba[j + 3] = sample(i + bytesPerSample)
        } else {
            rgba[j] = sample(i)
            rgba[j + 1] = sample(i)
            rgba[j + 2] = sample(i)
            rgba[j + 3] = 255
        }
    }

    return { width, height, rgba }
}

function paeth(left, up, upLeft) {
    const p = left + up - upLeft
    const pa = Math.abs(p - left)
    const pb = Math.abs(p - up)
    const pc = Math.abs(p - upLeft)
    if (pa <= pb && pa <= pc) return left
    if (pb <= pc) return up
    return upLeft
}

export function encodePng(width, height, rgba) {
    const raw = Buffer.alloc((width * 4 + 1) * height)
    for (let y = 0; y < height; y += 1) {
        const rawStart = y * (width * 4 + 1)
        raw[rawStart] = 0
        rgba.copy(raw, rawStart + 1, y * width * 4, (y + 1) * width * 4)
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    ihdr[10] = 0
    ihdr[11] = 0
    ihdr[12] = 0

    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

function chunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii')
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    typeBuffer.copy(out, 4)
    data.copy(out, 8)
    out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
    return out
}

function crc32(buffer) {
    if (!crcTable) {
        crcTable = new Uint32Array(256)
        for (let n = 0; n < 256; n += 1) {
            let c = n
            for (let k = 0; k < 8; k += 1) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
            }
            crcTable[n] = c >>> 0
        }
    }

    let c = 0xffffffff
    for (const byte of buffer) {
        c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}
