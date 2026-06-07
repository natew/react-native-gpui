#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { decodePng, encodePng } from "./png.mjs";

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
// excluded rects (semicolon-separated "x,y,w,h" in the same pixel space as crop) are
// ignored entirely: not counted as changed and not counted in the total. Used to mask
// regions that aren't a fair comparison — e.g. the desktop stage where the timeline is
// a separate WKWebView (blank in a Metal-layer capture) but the web build draws it.
const exclude = parseExclude(args.exclude);

const result = diffImages(before, after, crop, threshold, exclude);
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
        result.excluded ? `excluded=${result.excluded}` : "",
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
  --exclude x,y,w,h[;...]    ignore region(s) entirely (not changed, not in total)
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

function parseExclude(value) {
    if (!value) return [];
    return String(value)
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const [x, y, width, height] = part.split(",").map((n) => Number(n.trim()));
            if ([x, y, width, height].some((n) => !Number.isFinite(n))) {
                throw new Error(`invalid exclude rect "${part}", expected x,y,w,h`);
            }
            return { x, y, width, height };
        });
}

function inExclude(x, y, exclude) {
    for (const rect of exclude) {
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
            return true;
        }
    }
    return false;
}

function diffImages(before, after, crop, threshold, exclude = []) {
    const diff = Buffer.alloc(crop.width * crop.height * 4);
    let changed = 0;
    let deltaSum = 0;
    let maxDelta = 0;
    let excluded = 0;

    for (let y = 0; y < crop.height; y += 1) {
        for (let x = 0; x < crop.width; x += 1) {
            const srcX = crop.x + x;
            const srcY = crop.y + y;
            const outIndexEarly = (y * crop.width + x) * 4;
            if (inExclude(srcX, srcY, exclude)) {
                // paint excluded regions a flat blue so the diff image shows the mask.
                diff[outIndexEarly] = 40;
                diff[outIndexEarly + 1] = 60;
                diff[outIndexEarly + 2] = 120;
                diff[outIndexEarly + 3] = 255;
                excluded += 1;
                continue;
            }
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

    const total = crop.width * crop.height - excluded;
    return { changed, total, excluded, meanDelta: total ? deltaSum / total : 0, maxDelta, diff };
}
