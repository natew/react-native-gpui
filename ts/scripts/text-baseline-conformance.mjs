// Glyph vertical-centering conformance: line-height'd text must center in its
// flex box the way CSS/Chrome does. Launches examples/text-baseline-conformance.tsx
// offscreen with RNGPUI_CAPTURE_PNG and asserts the ink-row center of both rows
// (plain + fontWeight/StyledText path) sits within 1px of the 40px box center.
// Reference: headless Chrome measures 20.25 for the same spec; gpui 0.2.2 with no
// baseline shim measures 20.75. The stale `baseline_correction` shim regressed
// this to 22.25 (all labels ~2px low) without tripping the pixel-parity AA floor.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const pngPath = `/tmp/rngpui-text-baseline-${process.pid}.png`;

rmSync(pngPath, { force: true });
const run = spawnSync(
    "node",
    ["scripts/run-hermes-example.mjs", "examples/text-baseline-conformance.tsx"],
    {
        cwd: tsRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            RNGPUI_CAPTURE_PNG: pngPath,
            // the fixture renders a static frame; the capture fires on first paint
            // and the runner's timeout is the exit path.
            RNGPUI_EXAMPLE_TIMEOUT_MS: "15000",
        },
    },
);
if (!existsSync(pngPath)) {
    console.error(`TEXT_BASELINE_FAIL no capture written\n${run.stdout}\n${run.stderr}`);
    process.exit(1);
}

const { readPng } = await import("./png.mjs");
const img = readPng(pngPath);
const scale = img.width / 200; // fixture is 200 logical wide

function inkCenter(y0Logical, hLogical) {
    const y0 = Math.round(y0Logical * scale);
    const h = Math.round(hLogical * scale);
    let first = -1;
    let last = -1;
    for (let r = 0; r < h; r++) {
        let ink = 0;
        for (let c = 0; c < img.width; c++) {
            const i = ((y0 + r) * img.width + c) * 4;
            if (
                img.rgba[i + 3] > 200 &&
                img.rgba[i] < 120 &&
                img.rgba[i + 1] < 120 &&
                img.rgba[i + 2] < 120
            ) {
                ink++;
            }
        }
        if (ink > 0) {
            if (first < 0) first = r;
            last = r;
        }
    }
    if (first < 0) return null;
    return (first + last) / 2 / scale;
}

const BOX_CENTER = 20; // 40px box
const TOLERANCE = 1.25; // sub-pixel AA + descender optics ("Changes" has a 'g')
const plain = inkCenter(0, 40);
const weighted = inkCenter(40, 40);
rmSync(pngPath, { force: true });

const failures = [];
if (plain == null) failures.push("plain row has no ink");
if (weighted == null) failures.push("weighted row has no ink");
if (plain != null && Math.abs(plain - BOX_CENTER) > TOLERANCE) {
    failures.push(`plain ink center ${plain.toFixed(2)} off box center ${BOX_CENTER} by >${TOLERANCE}`);
}
if (weighted != null && Math.abs(weighted - BOX_CENTER) > TOLERANCE) {
    failures.push(`weighted ink center ${weighted.toFixed(2)} off box center ${BOX_CENTER} by >${TOLERANCE}`);
}
if (plain != null && weighted != null && Math.abs(plain - weighted) > 0.5) {
    failures.push(`plain (${plain.toFixed(2)}) and weighted (${weighted.toFixed(2)}) paths diverge`);
}

if (failures.length) {
    console.error(`TEXT_BASELINE_FAIL ${failures.join("; ")}`);
    process.exit(1);
}
console.log(
    `TEXT_BASELINE_PASS plain=${plain.toFixed(2)} weighted=${weighted.toFixed(2)} boxCenter=${BOX_CENTER}`,
);
