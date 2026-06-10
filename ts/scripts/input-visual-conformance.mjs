#!/usr/bin/env node
// Pixel conformance for native-macOS TextInput fidelity. Launches
// examples/input-visual-conformance.tsx offscreen (non-activating) with the
// in-process full-opacity capture (RNGPUI_CAPTURE_PNG) in BOTH light and dark, then
// scans the PNGs to assert:
//   1. CARET — a thin accent-blue insertion bar in the focused empty field, ~1px
//      logical wide, the accent (not the text color); and it BLINKS (an on-frame and an
//      off-frame both occur over ~1.6s of sampling); and it goes SOLID right after a
//      keystroke (the pause-while-typing behavior).
//   2. TEXT COLOR — typed text in dark mode is the light label color (not pure white,
//      not the old black-on-dark bug), and dark in light mode.
//   3. VERTICAL CENTERING — typed text and the placeholder both center vertically in a
//      field box that is taller than the input's intrinsic height.
//
// The capture file is overwritten by the service on a 250ms timer; we copy it at
// intervals to collect distinct blink phases. Everything is offscreen + non-activating.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const outDir = process.argv[2] || "/tmp/rngpui-input-visual";
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const { readPng } = await import("./png.mjs");

// authored layout (mirror of the fixture's LAYOUT, logical px).
const L = {
    window: { width: 400, height: 320 },
    fieldA: { x: 40, y: 32, width: 320, height: 44 },
    fieldB: { x: 40, y: 108, width: 320, height: 44 },
    fieldC: { x: 40, y: 184, width: 320, height: 44 },
    padLeft: 10,
};
// expected colors (logical truth from service.rs apply_native_input_theme).
const ACCENT = { dark: { r: 0x0a, g: 0x84, b: 0xff }, light: { r: 0x00, g: 0x7a, b: 0xff } };
// the authored field bg is #7a7a7a, but the WindowServer composite the in-process
// capture reads applies a fixed display-color-space transform, so we MEASURE the field
// bg luma from a clear patch of the capture rather than hardcoding the authored value.

let failures = 0;
const ok = (label, cond, detail) => {
    if (cond) console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
    else {
        console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
        failures += 1;
    }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const isBlueish = (r, g, b) => b > 140 && b - r > 50 && b - g > 30; // accent-blue caret vs gray bg
function rgbAt(img, x, y) {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return { r: img.rgba[i], g: img.rgba[i + 1], b: img.rgba[i + 2], a: img.rgba[i + 3] };
}

// vertical ink center: for the given field, scan a horizontal band and find the
// row-range that contains ink matching `inkTest`, return its center as a fraction of
// the field height (0=top, 1=bottom). scale converts logical→device px.
function inkVerticalCenter(img, scale, field, xLo, xHi, inkTest) {
    const y0 = Math.round(field.y * scale);
    const h = Math.round(field.height * scale);
    const cLo = Math.round((field.x + xLo) * scale);
    const cHi = Math.round((field.x + xHi) * scale);
    let first = -1;
    let last = -1;
    for (let r = 0; r < h; r++) {
        let ink = 0;
        for (let c = cLo; c < cHi; c++) {
            const p = rgbAt(img, c, y0 + r);
            if (p.a > 200 && inkTest(p.r, p.g, p.b)) ink++;
        }
        if (ink > 1) {
            if (first < 0) first = r;
            last = r;
        }
    }
    if (first < 0) return null;
    return (first + last) / 2 / h;
}

// caret metrics in field A: scan the left-padding column band for blue ink, return the
// horizontal run width (device px) at the row of peak blue coverage + the peak color.
function caretMetrics(img, scale) {
    const y0 = Math.round(L.fieldA.y * scale);
    const h = Math.round(L.fieldA.height * scale);
    // caret sits at the field's text origin: field.x + our paddingHorizontal +
    // gpui-component's own input_px (12px @ Medium). scan a generous band that also
    // covers the post-type caret position (one glyph to the right).
    const cLo = Math.round((L.fieldA.x + L.padLeft) * scale);
    const cHi = Math.round((L.fieldA.x + L.padLeft + 40) * scale);
    let bestWidth = 0;
    let bestColor = null;
    let totalBlue = 0;
    for (let r = 4; r < h - 4; r++) {
        let runWidth = 0;
        let rowColor = null;
        for (let c = cLo; c < cHi; c++) {
            const p = rgbAt(img, c, y0 + r);
            if (p.a > 150 && isBlueish(p.r, p.g, p.b)) {
                runWidth++;
                totalBlue++;
                if (!rowColor) rowColor = p;
            }
        }
        if (runWidth > bestWidth) {
            bestWidth = runWidth;
            bestColor = rowColor;
        }
    }
    return { widthDevice: bestWidth, color: bestColor, totalBlue };
}

// one-shot control-socket request: write a JSON command + newline, read one reply line.
function requestSocket(socketPath, cmd) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buf = "";
        const done = (fn, arg) => {
            socket.destroy();
            fn(arg);
        };
        socket.on("connect", () => socket.write(JSON.stringify(cmd) + "\n"));
        socket.on("data", (d) => {
            buf += d;
            const i = buf.indexOf("\n");
            if (i >= 0) {
                try {
                    done(resolve, JSON.parse(buf.slice(0, i)));
                } catch (e) {
                    done(reject, e);
                }
            }
        });
        socket.on("error", (e) => done(reject, e));
        setTimeout(() => done(reject, new Error("socket timeout")), 3000);
    });
}

async function runAppearance(appearance) {
    console.log(`\n[${appearance}] launching fixture offscreen + sampling blink phases`);
    const capturePath = `${outDir}/${appearance}-live.png`;
    const pidPath = `${outDir}/${appearance}-service.pid`;
    const socketPath = join(outDir, `${appearance}-control.sock`);
    rmSync(capturePath, { force: true });
    const child = spawn("node", ["scripts/run-hermes-example.mjs", "examples/input-visual-conformance.tsx"], {
        cwd: tsRoot,
        env: {
            ...process.env,
            RNGPUI_NO_ACTIVATE: "1",
            RNGPUI_TEST_MODE: "1",
            RNGPUI_FORCE_APPEARANCE: appearance,
            RNGPUI_INPUT_FIXTURE_APPEARANCE: appearance,
            RNGPUI_CAPTURE_PNG: capturePath,
            RNGPUI_CONTROL_SOCKET: socketPath,
            RNGPUI_SERVICE_PID_FILE: pidPath,
            RNGPUI_EXAMPLE_TIMEOUT_MS: "12000",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout?.on("data", (c) => (log += c));
    child.stderr?.on("data", (c) => (log += c));
    let exited = false;
    child.on("exit", () => (exited = true));

    // wait for the first capture to appear.
    const deadline = Date.now() + 7000;
    while (!existsSync(capturePath) && Date.now() < deadline && !exited) await sleep(120);
    if (!existsSync(capturePath)) {
        child.kill("SIGTERM");
        throw new Error(`[${appearance}] no capture written\n${log}`);
    }

    // collect distinct blink phases: the caret toggles ~567ms, capture timer ~250ms,
    // so sampling every ~280ms over ~1.7s yields both on and off frames.
    const blinkFrames = [];
    for (let i = 0; i < 7; i++) {
        await sleep(280);
        if (exited) break;
        const snap = `${outDir}/${appearance}-frame-${i}.png`;
        try {
            copyFileSync(capturePath, snap);
            blinkFrames.push(readPng(snap));
        } catch {}
    }

    // TYPE-PAUSE: type into the focused field A and sample the pause window (~450ms).
    // real typing pauses the blink and keeps the caret solid; assert the caret is present
    // in EVERY frame across the pause window (no blink-off gap).
    const typeFrames = [];
    if (!exited && existsSync(socketPath)) {
        try {
            await requestSocket(socketPath, { $cmd: "type", text: "x" });
        } catch (e) {
            log += `\ntype command failed: ${e?.message || e}`;
        }
        // sample inside the 500ms PAUSE_DELAY, leaving margin for the 250ms capture timer
        // and command latency: 3 frames at ~100/200/300ms after typing.
        for (let i = 0; i < 3; i++) {
            await sleep(100);
            if (exited) break;
            const snap = `${outDir}/${appearance}-type-${i}.png`;
            try {
                copyFileSync(capturePath, snap);
                typeFrames.push(readPng(snap));
            } catch {}
        }
    }

    child.kill("SIGTERM");
    return { blinkFrames, typeFrames };
}

function assertAppearance(appearance, captures) {
    const frames = captures.blinkFrames;
    const typeFrames = captures.typeFrames;
    if (!frames.length) {
        ok(`${appearance} captured frames`, false, "no frames");
        return;
    }
    const img0 = frames[0];
    const scale = img0.width / L.window.width;
    // measure the field bg luma from a clear (text-free) patch on the right side of
    // field B — robust to the capture's display-color-space transform.
    const fieldLuma = measureFieldLuma(img0, scale);

    // CARET: across frames, find the max-blue (on) and min-blue (off) caret states.
    const metrics = frames.map((f) => caretMetrics(f, scale));
    const onIdx = metrics.reduce((best, m, i) => (m.totalBlue > metrics[best].totalBlue ? i : best), 0);
    const offIdx = metrics.reduce((best, m, i) => (m.totalBlue < metrics[best].totalBlue ? i : best), 0);
    const on = metrics[onIdx];
    const off = metrics[offIdx];

    // 1a. caret present (an on-frame shows a blue bar).
    ok(`${appearance} caret present`, on.totalBlue > 0 && on.widthDevice > 0,
        `peakWidth=${on.widthDevice}dev bluePx=${on.totalBlue}`);

    // 1b. caret width ~1px logical (allow 0.5–2.0px logical for AA spread at this scale).
    const widthLogical = on.widthDevice / scale;
    ok(`${appearance} caret width ~1px logical`, widthLogical >= 0.5 && widthLogical <= 2.2,
        `${widthLogical.toFixed(2)}px logical (${on.widthDevice}dev @${scale}x)`);

    // 1c. caret color is the accent blue, not the text/label color.
    if (on.color) {
        const want = ACCENT[appearance];
        const blueish = isBlueish(on.color.r, on.color.g, on.color.b);
        ok(`${appearance} caret is accent-blue`, blueish,
            `sampled rgb(${on.color.r},${on.color.g},${on.color.b}) vs accent rgb(${want.r},${want.g},${want.b})`);
    } else ok(`${appearance} caret is accent-blue`, false, "no caret color sampled");

    // 1d. caret BLINKS: an on-frame and an off-frame differ substantially.
    ok(`${appearance} caret blinks`, on.totalBlue - off.totalBlue >= 3,
        `on=${on.totalBlue} off=${off.totalBlue} bluePx`);

    // 1e. caret SOLID WHILE TYPING: after a keystroke the blink pauses, so the caret must
    //     be present in EVERY frame sampled across the pause window (no blink-off gap).
    if (typeFrames.length) {
        const typeMetrics = typeFrames.map((f) => caretMetrics(f, scale));
        const allOn = typeMetrics.every((m) => m.totalBlue > 0);
        ok(`${appearance} caret stays solid after typing`, allOn,
            `bluePx per frame: [${typeMetrics.map((m) => m.totalBlue).join(", ")}]`);
    } else {
        ok(`${appearance} caret stays solid after typing`, false, "no type-pause frames captured");
    }

    // pick the on-frame for the static text/centering checks (any frame works for text,
    // text doesn't blink, but use the on-frame for consistency).
    const img = frames[onIdx];

    // directional ink test: glyph cores fall on the label side of the field bg (lighter
    // in dark mode, darker in light mode). counting only that side excludes the opposite
    // AA halo so means reflect the real glyph color, robust to the capture's color-space
    // transform (we compare against the MEASURED field luma, not the authored #7a7a7a).
    const labelInk = (thresh) => (r, g, b) =>
        appearance === "dark" ? luma(r, g, b) > fieldLuma + thresh : luma(r, g, b) < fieldLuma - thresh;

    // 2. TEXT COLOR (field B "Hg"): mean of the label-side ink is clearly on the label side.
    const textInk = sampleInkColor(img, scale, L.fieldB, 4, 30, labelInk(28));
    if (textInk) {
        const lum = luma(textInk.r, textInk.g, textInk.b);
        const dirOk = appearance === "dark" ? lum > fieldLuma + 40 : lum < fieldLuma - 40;
        ok(`${appearance} text color is the label color`, dirOk,
            `ink luma=${lum.toFixed(0)} field=${fieldLuma.toFixed(0)} (${appearance === "dark" ? "expect lighter" : "expect darker"})`);
    } else ok(`${appearance} text color is the label color`, false, "no text ink found");

    // 3a. TEXT centering (field B): ink vertical center within ~12% of field mid.
    const textCenter = inkVerticalCenter(img, scale, L.fieldB, 4, 30, labelInk(28));
    centeringCheck(`${appearance} text vertically centered`, textCenter);

    // 3b. PLACEHOLDER centering + color (field C). Placeholder is the MUTED label color:
    //     same side as the label but dimmer (closer to the field) than the typed text.
    const phCenter = inkVerticalCenter(img, scale, L.fieldC, 4, 120, labelInk(14));
    centeringCheck(`${appearance} placeholder vertically centered`, phCenter);
    const phInk = sampleInkColor(img, scale, L.fieldC, 4, 120, labelInk(14));
    if (phInk && textInk) {
        const phLum = luma(phInk.r, phInk.g, phInk.b);
        const txLum = luma(textInk.r, textInk.g, textInk.b);
        // on the label side …
        const sameSide = appearance === "dark" ? phLum > fieldLuma : phLum < fieldLuma;
        // … but dimmer than the full label (muted), i.e. closer to the field bg.
        const dimmer = Math.abs(phLum - fieldLuma) < Math.abs(txLum - fieldLuma);
        ok(`${appearance} placeholder is the muted label color`, sameSide && dimmer,
            `placeholder luma=${phLum.toFixed(0)} text luma=${txLum.toFixed(0)} field=${fieldLuma.toFixed(0)}`);
    } else ok(`${appearance} placeholder is the muted label color`, false, "no placeholder ink");
}

// median luma of a clear (text-free) patch on the right half of field B.
function measureFieldLuma(img, scale) {
    const y0 = Math.round((L.fieldB.y + 8) * scale);
    const y1 = Math.round((L.fieldB.y + L.fieldB.height - 8) * scale);
    const x0 = Math.round((L.fieldB.x + L.fieldB.width - 80) * scale);
    const x1 = Math.round((L.fieldB.x + L.fieldB.width - 20) * scale);
    const ls = [];
    for (let y = y0; y < y1; y += 2)
        for (let x = x0; x < x1; x += 2) {
            const p = rgbAt(img, x, y);
            if (p.a > 200) ls.push(luma(p.r, p.g, p.b));
        }
    ls.sort((a, b) => a - b);
    return ls.length ? ls[Math.floor(ls.length / 2)] : 122;
}

function centeringCheck(label, frac) {
    if (frac == null) {
        ok(label, false, "no ink");
        return;
    }
    ok(label, Math.abs(frac - 0.5) <= 0.12, `ink center at ${(frac * 100).toFixed(1)}% of field height`);
}

function sampleInkColor(img, scale, field, xLo, xHi, inkTest) {
    const y0 = Math.round(field.y * scale);
    const h = Math.round(field.height * scale);
    const cLo = Math.round((field.x + xLo) * scale);
    const cHi = Math.round((field.x + xHi) * scale);
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let r = 0; r < h; r++) {
        for (let c = cLo; c < cHi; c++) {
            const p = rgbAt(img, c, y0 + r);
            if (p.a > 200 && inkTest(p.r, p.g, p.b)) {
                rs += p.r; gs += p.g; bs += p.b; n++;
            }
        }
    }
    if (!n) return null;
    return { r: rs / n, g: gs / n, b: bs / n };
}

console.log("input-visual-conformance: caret + text-color + vertical-centering pixel gate");
for (const appearance of ["dark", "light"]) {
    const frames = await runAppearance(appearance);
    assertAppearance(appearance, frames);
}

console.log("");
if (failures > 0) {
    console.error(`INPUT_VISUAL_FAIL (${failures} failure(s)) — captures in ${outDir}`);
    process.exit(1);
}
console.log(`INPUT_VISUAL_PASS — captures in ${outDir}`);
