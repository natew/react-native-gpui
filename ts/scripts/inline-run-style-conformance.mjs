// Inline-run styling conformance: styles carried by a nested <Text> must survive
// being flattened into a shaped text run. Launches examples/inline-run-style-conformance.tsx
// offscreen with RNGPUI_CAPTURE_PNG and asserts three things against the capture:
//
//   PLATE    row A contains a run of the inline-code background colour, and that plate
//            is ROUNDED. A run background is exactly the width of the run's glyph
//            advances, so it can carry a colour and a radius but never padding — that
//            would have to move the surrounding glyphs. This asserts colour + radius.
//   NESTED   row B (nested <Text fontStyle=italic>) differs from row C (upright).
//   PLAIN    row D (plain <Text fontStyle=italic>) differs from row C.
//
// Both italic checks are bitmap comparisons against the same upright control, so a
// dropped fontStyle — whether dropped by the serializer, by the style parser, or by
// font matching silently resolving to the upright face — shows up as "identical".
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const pngPath = `/tmp/rngpui-inline-run-style-${process.pid}.png`;

// Geist has no italic face — that is the whole point of the italic rows. Fall back
// to the app's bundled copy so the fixture is runnable from a bare checkout, and say
// so loudly if it is missing rather than silently measuring the system font (which
// HAS a real italic and would make the italic rows pass for the wrong reason).
const fontDir = process.env.RNGPUI_FONT_DIR || `${process.env.HOME}/team-machine/gui/native-shell/fonts`;
if (!existsSync(fontDir)) {
    console.error(`INLINE_RUN_STYLE_FAIL no font dir at ${fontDir} (set RNGPUI_FONT_DIR)`);
    process.exit(1);
}

rmSync(pngPath, { force: true });
const run = spawnSync(
    "node",
    ["scripts/run-example.mjs", "examples/inline-run-style-conformance.tsx"],
    {
        cwd: tsRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            RNGPUI_FONT_DIR: fontDir,
            RNGPUI_CAPTURE_PNG: pngPath,
            RNGPUI_EXAMPLE_TIMEOUT_MS: "15000",
        },
    },
);
if (!existsSync(pngPath)) {
    console.error(`INLINE_RUN_STYLE_FAIL no capture written\n${run.stdout}\n${run.stderr}`);
    process.exit(1);
}

const { readPng } = await import("./png.mjs");
const img = readPng(pngPath);
const W = 460;
const ROW = 40;
const scale = img.width / W;

const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
};

// --- PLATE: does row A carry the inline-code background anywhere? ---------------
// The offscreen PNG capture quantizes each channel to 1/5 steps (measured: only
// 0/51/102/153/204/255 appear), so the #e6e0ff plate lands on 204,204,255 and the
// #111111 body text lands on 0,0,0. A tolerance wide enough to absorb that also
// swallows white, so match the plate by its SHAPE in colour space instead: light,
// and distinctly blue-dominant. White has no blue dominance and the violet glyph
// colour (#6633cc → 102,51,204) is far too dark.
const isPlate = (px) => px[2] - px[0] >= 25 && px[2] - px[1] >= 25 && px[0] >= 150;

let plateCount = 0;
let plateMinX = Infinity;
let plateMaxX = -Infinity;
let plateMinY = Infinity;
let plateMaxY = -Infinity;
for (let y = 0; y < Math.round(ROW * scale); y++) {
    for (let x = 0; x < img.width; x++) {
        if (isPlate(at(x, y))) {
            plateCount++;
            if (x < plateMinX) plateMinX = x;
            if (x > plateMaxX) plateMaxX = x;
            if (y < plateMinY) plateMinY = y;
            if (y > plateMaxY) plateMaxY = y;
        }
    }
}
const plateW = plateCount ? (plateMaxX - plateMinX + 1) / scale : 0;
const plateH = plateCount ? (plateMaxY - plateMinY + 1) / scale : 0;

// Rounded corners mean the plate's TOP row is inset from its widest row on both
// sides. A square quad has identical spans, so cornerInset is 0 and this fails.
function rowSpan(yDevice) {
    let min = Infinity;
    let max = -Infinity;
    for (let x = 0; x < img.width; x++) {
        if (isPlate(at(x, yDevice))) {
            if (x < min) min = x;
            if (x > max) max = x;
        }
    }
    return min === Infinity ? null : { min, max };
}
const topSpan = rowSpan(plateMinY);
const midSpan = rowSpan(Math.round((plateMinY + plateMaxY) / 2));
const cornerInset =
    topSpan && midSpan
        ? Math.min(topSpan.min - midSpan.min, midSpan.max - topSpan.max) / scale
        : 0;

// --- ITALIC: compare each italic row's ink against the upright control ----------
// Ink = any pixel meaningfully darker than the white background. Rows are compared
// column-by-column as ink-coverage profiles, which is what a slant actually changes
// (a shear moves ink horizontally as a function of height) and is robust to the
// sub-pixel AA differences a straight bitmap XOR would trip over.
function inkProfile(rowIndex) {
    const y0 = Math.round(rowIndex * ROW * scale);
    const h = Math.round(ROW * scale);
    const cols = new Array(img.width).fill(0);
    for (let r = 0; r < h; r++) {
        for (let x = 0; x < img.width; x++) {
            const p = at(x, y0 + r);
            if (p[0] < 160 && p[1] < 160 && p[2] < 160 && p[3] > 128) cols[x]++;
        }
    }
    return cols;
}

const profileB = inkProfile(1); // nested italic
const profileC = inkProfile(2); // upright control
const profileD = inkProfile(3); // plain italic

const totalInk = (p) => p.reduce((a, b) => a + b, 0);
// normalized L1 distance between two column profiles
function divergence(a, b) {
    const sum = totalInk(a) + totalInk(b);
    if (sum === 0) return 0;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    return diff / sum;
}

const dNested = divergence(profileB, profileC);
const dPlain = divergence(profileD, profileC);

// An applied slant redistributes a double-digit percentage of the ink columns.
// Identical rendering scores ~0. 0.08 sits well above AA noise and well below a
// real slant (measured: a 12deg oblique on this string scores >0.30).
const ITALIC_MIN_DIVERGENCE = 0.08;

const results = [
    {
        name: "PLATE",
        ok: plateCount > 0 && plateW >= 40,
        detail: `plate px=${plateCount} spans ${plateW.toFixed(1)}x${plateH.toFixed(1)} logical`,
    },
    {
        // borderRadius 5 at this size insets the top row by ~1.5px per side; a square
        // quad insets by 0. 1.0 clears AA noise without demanding an exact radius.
        name: "PLATE_ROUNDED",
        ok: cornerInset >= 1.0,
        detail: `top-row corner inset = ${cornerInset.toFixed(2)}px per side (need >= 1.0)`,
    },
    {
        name: "NESTED_ITALIC",
        ok: dNested >= ITALIC_MIN_DIVERGENCE,
        detail: `divergence vs upright = ${dNested.toFixed(4)} (need >= ${ITALIC_MIN_DIVERGENCE})`,
    },
    {
        name: "PLAIN_ITALIC",
        ok: dPlain >= ITALIC_MIN_DIVERGENCE,
        detail: `divergence vs upright = ${dPlain.toFixed(4)} (need >= ${ITALIC_MIN_DIVERGENCE})`,
    },
];

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
console.log(`capture: ${pngPath}`);

if (results.some((r) => !r.ok)) {
    console.error("INLINE_RUN_STYLE_FAIL");
    process.exit(1);
}
console.log("INLINE_RUN_STYLE_OK");
