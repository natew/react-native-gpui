#!/usr/bin/env bun
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Animated, Easing } from "../src/index.ts";

let crcTable;

const outDir = process.argv[2] || "/tmp/rngpui-animation-conformance";
const beforePath = `${outDir}/frame-before.png`;
const afterPath = `${outDir}/frame-after.png`;
const diffPath = `${outDir}/frame-diff.png`;

mkdirSync(outDir, { recursive: true });

const before = { left: 18, opacity: 0.28 };
const after = await runAnimation();

writePng(beforePath, drawFrame(before));
writePng(afterPath, drawFrame(after));

const diff = diffImages(drawFrame(before), drawFrame(after), 12);
writePng(diffPath, diff.image);

const ratio = diff.changed / diff.total;
console.log(
    [
        "ANIMATION_FRAME_DIFF",
        `before=${beforePath}`,
        `after=${afterPath}`,
        `diff=${diffPath}`,
        `beforeLeft=${before.left.toFixed(1)}`,
        `afterLeft=${after.left.toFixed(1)}`,
        `pixels=${diff.total}`,
        `changed=${diff.changed}`,
        `ratio=${ratio.toFixed(6)}`,
    ].join(" "),
);

if (after.left < 240 || after.opacity < 0.98) {
    console.error(`animation did not reach final values: left=${after.left} opacity=${after.opacity}`);
    process.exit(1);
}
if (ratio < 0.01) {
    console.error(`animation frame diff ratio ${ratio.toFixed(6)} is below 0.01`);
    process.exit(1);
}

async function runAnimation() {
    const left = new Animated.Value(18);
    const opacity = new Animated.Value(0.28);
    return await new Promise((resolve) => {
        Animated.parallel([
            Animated.timing(left, {
                toValue: 244,
                duration: 180,
                easing: Easing.inOut(Easing.cubic),
                useNativeDriver: false,
            }),
            Animated.timing(opacity, {
                toValue: 1,
                duration: 180,
                easing: Easing.inOut(Easing.cubic),
                useNativeDriver: false,
            }),
        ]).start(({ finished }) => {
            if (!finished) {
                resolve({ left: left.__getValue(), opacity: opacity.__getValue() });
                return;
            }
            resolve({ left: left.__getValue(), opacity: opacity.__getValue() });
        });
    });
}

function drawFrame({ left, opacity }) {
    const width = 404;
    const height = 180;
    const rgba = Buffer.alloc(width * height * 4, 0xff);
    fill(rgba, width, 0, 0, width, height, [243, 246, 251, 255]);
    roundRect(rgba, width, 22, 22, 360, 136, 12, [255, 255, 255, 255]);
    strokeRoundRect(rgba, width, 22, 22, 360, 136, 12, [202, 213, 230, 255]);
    roundRect(rgba, width, 56, 72, 312, 52, 26, [217, 229, 246, 255]);
    roundRect(rgba, width, Math.round(56 + left), 80, 52, 36, 18, [47, 111, 237, Math.round(255 * opacity)]);
    return { width, height, rgba };
}

function fill(rgba, width, x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) setPixel(rgba, width, xx, yy, color);
    }
}

function roundRect(rgba, width, x, y, w, h, r, color) {
    for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) {
            if (insideRoundRect(xx, yy, x, y, w, h, r)) blendPixel(rgba, width, xx, yy, color);
        }
    }
}

function strokeRoundRect(rgba, width, x, y, w, h, r, color) {
    roundRect(rgba, width, x, y, w, 1, 1, color);
    roundRect(rgba, width, x, y + h - 1, w, 1, 1, color);
    roundRect(rgba, width, x, y, 1, h, 1, color);
    roundRect(rgba, width, x + w - 1, y, 1, h, 1, color);
    for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) {
            const outer = insideRoundRect(xx, yy, x, y, w, h, r);
            const inner = insideRoundRect(xx, yy, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1));
            if (outer && !inner) blendPixel(rgba, width, xx, yy, color);
        }
    }
}

function insideRoundRect(px, py, x, y, w, h, r) {
    const rx = px < x + r ? x + r : px >= x + w - r ? x + w - r - 1 : px;
    const ry = py < y + r ? y + r : py >= y + h - r ? y + h - r - 1 : py;
    const dx = px - rx;
    const dy = py - ry;
    return dx * dx + dy * dy <= r * r;
}

function setPixel(rgba, width, x, y, [r, g, b, a]) {
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
}

function blendPixel(rgba, width, x, y, [r, g, b, a]) {
    const i = (y * width + x) * 4;
    const alpha = a / 255;
    rgba[i] = Math.round(r * alpha + rgba[i] * (1 - alpha));
    rgba[i + 1] = Math.round(g * alpha + rgba[i + 1] * (1 - alpha));
    rgba[i + 2] = Math.round(b * alpha + rgba[i + 2] * (1 - alpha));
    rgba[i + 3] = 255;
}

function diffImages(before, after, threshold) {
    const image = { width: before.width, height: before.height, rgba: Buffer.alloc(before.rgba.length) };
    let changed = 0;
    for (let i = 0; i < before.rgba.length; i += 4) {
        const dr = Math.abs(before.rgba[i] - after.rgba[i]);
        const dg = Math.abs(before.rgba[i + 1] - after.rgba[i + 1]);
        const db = Math.abs(before.rgba[i + 2] - after.rgba[i + 2]);
        const changedPixel = Math.max(dr, dg, db) > threshold;
        if (changedPixel) changed += 1;
        image.rgba[i] = changedPixel ? 255 : after.rgba[i];
        image.rgba[i + 1] = changedPixel ? 0 : after.rgba[i + 1];
        image.rgba[i + 2] = changedPixel ? 180 : after.rgba[i + 2];
        image.rgba[i + 3] = 255;
    }
    return { image, changed, total: before.width * before.height };
}

function writePng(path, image) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodePng(image.width, image.height, image.rgba));
}

function encodePng(width, height, rgba) {
    const rowBytes = width * 4;
    const raw = Buffer.alloc((rowBytes + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (rowBytes + 1)] = 0;
        rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, y * rowBytes + rowBytes);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr(width, height)),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function ihdr(width, height) {
    const buf = Buffer.alloc(13);
    buf.writeUInt32BE(width, 0);
    buf.writeUInt32BE(height, 4);
    buf[8] = 8;
    buf[9] = 6;
    buf[10] = 0;
    buf[11] = 0;
    buf[12] = 0;
    return buf;
}

function chunk(type, data) {
    const name = Buffer.from(type);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    name.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
    return out;
}

function crc32(buf) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n += 1) {
            let c = n;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
