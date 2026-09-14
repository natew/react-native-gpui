#!/usr/bin/env node
// Pixel conformance for native-macOS TextInput fidelity. Launches
// examples/input-visual-conformance.tsx offscreen (non-activating) with the
// in-process full-opacity capture (RNGPUI_CAPTURE_PNG) in BOTH light and dark, then
// scans the PNGs to assert:
//   1. CARET — a thin accent-blue insertion bar in the focused empty field, ~1px
//      logical wide, the accent (not the text color); and it BLINKS (an on-frame and an
//      off-frame both occur over ~1.6s of sampling); and it stays SOLID across a burst of
//      keystrokes (the pause-while-typing behavior).
//   2. TEXT COLOR — typed text in dark mode is the light label color (not pure white,
//      not the old black-on-dark bug), and dark in light mode.
//   3. VERTICAL CENTERING — typed text and the placeholder both center vertically in a
//      field box that is taller than the input's intrinsic height.
//
// The service rewrites the capture file on a ~30ms timer (service.rs:3479), so a frame is
// always present; we copy it at intervals to collect distinct blink phases. Everything is
// offscreen + non-activating.
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

// does field A show a keystroke's own result yet? field A is authored empty, so strong
// ink in its text band that is not the accent caret can only be a typed glyph. This is
// the freshness signal for the capture: a frame carrying it was composited after the
// keystroke, which is what makes its caret a statement about typing rather than about
// the idle blink.
function fieldHasTypedGlyph(img, scale, fieldLuma) {
    const y0 = Math.round(L.fieldA.y * scale);
    const h = Math.round(L.fieldA.height * scale);
    const cLo = Math.round((L.fieldA.x + L.padLeft) * scale);
    const cHi = Math.round((L.fieldA.x + L.padLeft + 40) * scale);
    for (let r = 4; r < h - 4; r++) {
        for (let c = cLo; c < cHi; c++) {
            const p = rgbAt(img, c, y0 + r);
            if (p.a < 150 || isBlueish(p.r, p.g, p.b)) continue;
            if (Math.abs(luma(p.r, p.g, p.b) - fieldLuma) > 40) return true;
        }
    }
    return false;
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

// caret metrics in field A: scan the field's text area for blue ink, return the
// horizontal run width (device px) at the row of peak blue coverage + the peak color.
function caretMetrics(img, scale) {
    const y0 = Math.round(L.fieldA.y * scale);
    const h = Math.round(L.fieldA.height * scale);
    // The caret sits where the text ends, so it walks right as the field fills: the `type`
    // command inserts at the caret, and one glyph is ~8px. Scan the whole text area rather
    // than a strip beside the origin — a 40px strip stops containing the caret after four
    // keystrokes, and the caret reading it then reports is "no caret in a field whose
    // caret is simply further right". The caret is the only blue thing in field A, so a
    // wide band costs nothing.
    const cLo = Math.round((L.fieldA.x + L.padLeft) * scale);
    const cHi = Math.round((L.fieldA.x + L.fieldA.width - 10) * scale);
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
    const child = spawn("node", ["scripts/run-example.mjs", "examples/input-visual-conformance.tsx"], {
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

    // collect distinct blink phases: the caret toggles ~567ms, so sampling every ~280ms
    // over ~1.7s yields both on and off frames.
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
    const baseline = blinkFrames.at(-1) ?? null;
    const scale = baseline ? baseline.width / L.window.width : 2;

    // TYPE-PAUSE: type into the focused field A and require the caret in every frame that
    // carries a keystroke's result. Real typing pauses the blink and keeps the caret
    // solid, and each keystroke re-arms that 500ms pause, so across the burst below the
    // caret can never legitimately blank.
    //
    // Sampling this by clock alone does not work, and the way it fails is a lie about the
    // caret. The capture is a readback of the WindowServer composite, which lags the
    // keystroke: a frame copied 100ms after the command can still be the frame from
    // BEFORE it, showing the idle blink's off phase. Measured under 16-way concurrency, 8
    // of 80 runs sampled such a frame, and every one of them carried NO typed glyph, so
    // the composite predated the keystroke; no run ever showed the glyph with the caret
    // blanked. The old fixed 3-sample window read that lag as "the caret blanked while
    // typing" and failed a build whose caret behavior was correct.
    //
    // So the burst types repeatedly and a capture is believed only once it shows the
    // glyph, with the lagging frames skipped rather than read as a caret state.
    const typeFrames = [];
    let typeSkipped = 0;
    if (!exited && baseline && existsSync(socketPath)) {
        // field A is empty, so a clean patch on its right side is its own field bg.
        const fieldLumaA = measurePatchLuma(baseline, scale, L.fieldA, 200, 300);
        // bounded so the burst cannot outlive the fixture: run-example kills it 12s after
        // launch (RNGPUI_EXAMPLE_TIMEOUT_MS), and a burst killed mid-flight would read as
        // a slow capture timer rather than as the timeout it is.
        const typeDeadline = Date.now() + 4500;
        while (Date.now() < typeDeadline && typeFrames.length < 8 && !exited) {
            try {
                await requestSocket(socketPath, { $cmd: "type", text: "x" });
            } catch (e) {
                log += `\ntype command failed: ${e?.message || e}`;
                break;
            }
            // one capture generation after the keystroke: the writer's timer is 30ms and
            // its readback is not free, so a generation takes ~50ms unloaded and longer
            // under load.
            await sleep(90);
            if (exited) break;
            const snap = `${outDir}/${appearance}-type-${typeFrames.length + typeSkipped}.png`;
            let frame = null;
            try {
                copyFileSync(capturePath, snap);
                frame = readPng(snap);
            } catch {}
            if (!frame || !fieldHasTypedGlyph(frame, scale, fieldLumaA)) {
                typeSkipped += 1;
                continue;
            }
            typeFrames.push(frame);
        }
    }

    child.kill("SIGTERM");
    return { blinkFrames, typeFrames, typeSkipped };
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
    const fieldLuma = measurePatchLuma(img0, scale, L.fieldB, L.fieldB.width - 80, L.fieldB.width - 20);

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

    // 1e. caret SOLID WHILE TYPING: each keystroke re-arms the 500ms blink pause, so the
    //     caret must be present in EVERY frame the burst believes (see runAppearance: a
    //     frame is only believed once it shows the keystroke's own glyph). Four believed
    //     frames is the precondition — fewer means the capture could not keep up with the
    //     burst, which is a fact about the machine and is reported as such rather than
    //     passed on the strength of one lucky frame.
    const typeMetrics = typeFrames.map((f) => caretMetrics(f, scale));
    const typeBlanks = typeMetrics.filter((m) => m.totalBlue === 0).length;
    ok(`${appearance} caret stays solid while typing`, typeMetrics.length >= 4 && typeBlanks === 0,
        `${typeMetrics.length} believed frames (${captures.typeSkipped} skipped as pre-keystroke), ` +
            `bluePx [${typeMetrics.map((m) => m.totalBlue).join(", ")}]`);

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

// median luma of a clear (text-free) patch of a field, at [xLo, xHi) relative to its left
// edge and inset vertically. Used to measure the authored field bg through whatever
// display-color-space transform the capture applies, rather than hardcoding #7a7a7a.
function measurePatchLuma(img, scale, field, xLo, xHi) {
    const y0 = Math.round((field.y + 8) * scale);
    const y1 = Math.round((field.y + field.height - 8) * scale);
    const x0 = Math.round((field.x + xLo) * scale);
    const x1 = Math.round((field.x + xHi) * scale);
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
