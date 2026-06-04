#!/usr/bin/env bun
import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let crcTable = null;

const args = parseArgs(process.argv.slice(2));
if (args.help || args.positionals.length < 2) {
    printUsage();
    process.exit(args.help ? 0 : 1);
}

const [beforePath, afterPath] = args.positionals;
const before = decodePng(readFileSync(beforePath));
const after = decodePng(readFileSync(afterPath));
const crop = parseCrop(args.crop, before, after);
const threshold = numberArg(args.threshold, 24);
const maxDiffRatio = optionalNumberArg(args["max-diff-ratio"]);
const minDiffRatio = optionalNumberArg(args["min-diff-ratio"]);

const result = diffImages(before, after, crop, threshold);
const ratio = result.changed / result.total;

if (args["diff-out"]) {
    writeFileSync(args["diff-out"], encodePng(crop.width, crop.height, result.diff));
}

console.log(
    [
        "PIXEL_DIFF",
        `before=${basename(beforePath)}`,
        `after=${basename(afterPath)}`,
        `crop=${crop.x},${crop.y},${crop.width},${crop.height}`,
        `threshold=${threshold}`,
        `pixels=${result.total}`,
        `changed=${result.changed}`,
        `ratio=${ratio.toFixed(6)}`,
        `meanDelta=${result.meanDelta.toFixed(3)}`,
        `maxDelta=${result.maxDelta}`,
        args["diff-out"] ? `diffOut=${args["diff-out"]}` : "",
    ]
        .filter(Boolean)
        .join(" "),
);

if (maxDiffRatio != null && ratio > maxDiffRatio) {
    console.error(`pixel diff ratio ${ratio.toFixed(6)} exceeds max ${maxDiffRatio}`);
    process.exit(1);
}
if (minDiffRatio != null && ratio < minDiffRatio) {
    console.error(`pixel diff ratio ${ratio.toFixed(6)} is below min ${minDiffRatio}`);
    process.exit(1);
}

function printUsage() {
    console.log(`usage: bun scripts/pixel-diff.mjs before.png after.png [options]

options:
  --crop x,y,w,h             compare a screenshot region; defaults to common bounds
  --threshold n              per-channel change threshold, default 24
  --diff-out path.png        write a magenta-on-grayscale diff image
  --max-diff-ratio n         fail if changed pixel ratio is above n
  --min-diff-ratio n         fail if changed pixel ratio is below n
`);
}

function parseArgs(argv) {
    const parsed = { positionals: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            parsed.positionals.push(arg);
            continue;
        }
        const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
        if (rawKey === "help" || rawKey === "h") {
            parsed.help = true;
            continue;
        }
        parsed[rawKey] = inlineValue ?? argv[++i];
    }
    return parsed;
}

function numberArg(value, fallback) {
    if (value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`invalid number: ${value}`);
    return n;
}

function optionalNumberArg(value) {
    return value == null ? null : numberArg(value, 0);
}

function parseCrop(value, before, after) {
    if (!value) {
        return {
            x: 0,
            y: 0,
            width: Math.min(before.width, after.width),
            height: Math.min(before.height, after.height),
        };
    }
    const parts = String(value).split(",").map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
        throw new Error(`invalid crop "${value}", expected x,y,w,h`);
    }
    const [x, y, width, height] = parts.map(Math.round);
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
        throw new Error(`invalid crop "${value}", dimensions must be positive`);
    }
    if (x + width > before.width || y + height > before.height || x + width > after.width || y + height > after.height) {
        throw new Error(`crop "${value}" exceeds image bounds`);
    }
    return { x, y, width, height };
}

function diffImages(before, after, crop, threshold) {
    const diff = Buffer.alloc(crop.width * crop.height * 4);
    let changed = 0;
    let deltaSum = 0;
    let maxDelta = 0;

    for (let y = 0; y < crop.height; y += 1) {
        for (let x = 0; x < crop.width; x += 1) {
            const srcX = crop.x + x;
            const srcY = crop.y + y;
            const beforeIndex = (srcY * before.width + srcX) * 4;
            const afterIndex = (srcY * after.width + srcX) * 4;
            const outIndex = (y * crop.width + x) * 4;
            const dr = Math.abs(before.rgba[beforeIndex] - after.rgba[afterIndex]);
            const dg = Math.abs(before.rgba[beforeIndex + 1] - after.rgba[afterIndex + 1]);
            const db = Math.abs(before.rgba[beforeIndex + 2] - after.rgba[afterIndex + 2]);
            const da = Math.abs(before.rgba[beforeIndex + 3] - after.rgba[afterIndex + 3]);
            const maxChannelDelta = Math.max(dr, dg, db, da);
            const delta = dr + dg + db + da;
            maxDelta = Math.max(maxDelta, maxChannelDelta);
            deltaSum += delta;

            if (maxChannelDelta > threshold) {
                changed += 1;
                diff[outIndex] = 255;
                diff[outIndex + 1] = 0;
                diff[outIndex + 2] = 180;
                diff[outIndex + 3] = 255;
            } else {
                const gray =
                    (after.rgba[afterIndex] * 0.299 +
                        after.rgba[afterIndex + 1] * 0.587 +
                        after.rgba[afterIndex + 2] * 0.114) |
                    0;
                diff[outIndex] = gray;
                diff[outIndex + 1] = gray;
                diff[outIndex + 2] = gray;
                diff[outIndex + 3] = 255;
            }
        }
    }

    const total = crop.width * crop.height;
    return { changed, total, meanDelta: deltaSum / total, maxDelta, diff };
}

function decodePng(buffer) {
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error("not a png file");
    }

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat = [];

    let offset = 8;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString("ascii", offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const data = buffer.subarray(dataStart, dataEnd);

        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            const compression = data[10];
            const filter = data[11];
            const interlace = data[12];
            if (![8, 16].includes(bitDepth) || compression !== 0 || filter !== 0 || interlace !== 0) {
                throw new Error("unsupported png encoding");
            }
            if (![0, 2, 4, 6].includes(colorType)) {
                throw new Error(`unsupported png color type ${colorType}`);
            }
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }

        offset = dataEnd + 4;
    }

    const bytesPerSample = bitDepth / 8;
    const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
    const raw = inflateSync(Buffer.concat(idat));
    const rowBytes = width * channels * bytesPerSample;
    const scanlineBytes = rowBytes + 1;
    const unfiltered = Buffer.alloc(rowBytes * height);

    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * scanlineBytes];
        const rowStart = y * rowBytes;
        const sourceStart = y * scanlineBytes + 1;
        for (let x = 0; x < rowBytes; x += 1) {
            const value = raw[sourceStart + x];
            const left = x >= channels * bytesPerSample ? unfiltered[rowStart + x - channels * bytesPerSample] : 0;
            const up = y > 0 ? unfiltered[rowStart + x - rowBytes] : 0;
            const upLeft =
                y > 0 && x >= channels * bytesPerSample
                    ? unfiltered[rowStart + x - rowBytes - channels * bytesPerSample]
                    : 0;
            switch (filter) {
                case 0:
                    unfiltered[rowStart + x] = value;
                    break;
                case 1:
                    unfiltered[rowStart + x] = (value + left) & 0xff;
                    break;
                case 2:
                    unfiltered[rowStart + x] = (value + up) & 0xff;
                    break;
                case 3:
                    unfiltered[rowStart + x] = (value + Math.floor((left + up) / 2)) & 0xff;
                    break;
                case 4:
                    unfiltered[rowStart + x] = (value + paeth(left, up, upLeft)) & 0xff;
                    break;
                default:
                    throw new Error(`unsupported png filter ${filter}`);
            }
        }
    }

    const rgba = Buffer.alloc(width * height * 4);
    const sample = (index) => unfiltered[index];
    for (let i = 0, j = 0; i < unfiltered.length; i += channels * bytesPerSample, j += 4) {
        if (colorType === 6) {
            rgba[j] = sample(i);
            rgba[j + 1] = sample(i + bytesPerSample);
            rgba[j + 2] = sample(i + bytesPerSample * 2);
            rgba[j + 3] = sample(i + bytesPerSample * 3);
        } else if (colorType === 2) {
            rgba[j] = sample(i);
            rgba[j + 1] = sample(i + bytesPerSample);
            rgba[j + 2] = sample(i + bytesPerSample * 2);
            rgba[j + 3] = 255;
        } else if (colorType === 4) {
            rgba[j] = sample(i);
            rgba[j + 1] = sample(i);
            rgba[j + 2] = sample(i);
            rgba[j + 3] = sample(i + bytesPerSample);
        } else {
            rgba[j] = sample(i);
            rgba[j + 1] = sample(i);
            rgba[j + 2] = sample(i);
            rgba[j + 3] = 255;
        }
    }

    return { width, height, rgba };
}

function paeth(left, up, upLeft) {
    const p = left + up - upLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upLeft);
    if (pa <= pb && pa <= pc) return left;
    if (pb <= pc) return up;
    return upLeft;
}

function encodePng(width, height, rgba) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const rawStart = y * (width * 4 + 1);
        raw[rawStart] = 0;
        rgba.copy(raw, rawStart + 1, y * width * 4, (y + 1) * width * 4);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        PNG_SIGNATURE,
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function chunk(type, data) {
    const typeBuffer = Buffer.from(type, "ascii");
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    typeBuffer.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
    return out;
}

function crc32(buffer) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n += 1) {
            let c = n;
            for (let k = 0; k < 8; k += 1) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c >>> 0;
        }
    }

    let c = 0xffffffff;
    for (const byte of buffer) {
        c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
