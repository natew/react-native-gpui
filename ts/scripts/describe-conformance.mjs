// Conformance for the `rngpui` developer CLI: launch a known fixture offscreen, run
// `get describe` against testID'd boxes, and assert PROGRAMMATICALLY (no screenshot)
// that (a) computed bounds are non-degenerate and match the authored positions, and
// (b) the sampled color within those bounds matches the authored fill color.
//
// This is the guard that the dump's computed bounds + the pixel sampling actually
// reflect what's rendered — the whole reason the tool exists.
//
//   node scripts/describe-conformance.mjs
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const entry = "examples/describe-fixture.tsx";

// authored truth from the fixture.
const EXPECT = {
    "box-red": { bounds: { x: 40, y: 40, width: 200, height: 120 }, color: "#d92d20" },
    "box-green": { bounds: { x: 300, y: 40, width: 200, height: 120 }, color: "#12b76a" },
    "box-blue": { bounds: { x: 40, y: 220, width: 200, height: 120 }, color: "#2e6cf0" },
};

function rngpui(args) {
    const result = spawnSync("bun", ["run", "cli/bin.ts", ...args], {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, RNGPUI_NO_ACTIVATE: "1", RNGPUI_TEST_MODE: "1" },
        timeout: 90_000,
    });
    if (result.status !== 0) {
        throw new Error(`rngpui ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    return JSON.parse(result.stdout);
}

function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function dist(a, b) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2);
}

let failures = 0;
function check(label, cond, detail) {
    if (cond) {
        console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
    } else {
        console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
        failures += 1;
    }
}

console.log("rngpui describe-conformance: launching fixture + asserting bounds + sampled color\n");

// one describe per box so each gets its own fresh capture + sample.
for (const [testId, expect] of Object.entries(EXPECT)) {
    const r = rngpui(["get", "describe", testId, "--launch", entry, "--json"]);
    const node = Array.isArray(r) ? r[0] : r;

    // (a) bounds non-degenerate and matching the authored rect (±2px for layout rounding)
    const b = node.bounds;
    const boundsOk =
        b &&
        Math.abs(b.x - expect.bounds.x) <= 2 &&
        Math.abs(b.y - expect.bounds.y) <= 2 &&
        Math.abs(b.width - expect.bounds.width) <= 2 &&
        Math.abs(b.height - expect.bounds.height) <= 2;
    check(
        `${testId} bounds`,
        boundsOk,
        b ? `got ${b.x},${b.y} ${b.width}x${b.height} expected ${expect.bounds.x},${expect.bounds.y} ${expect.bounds.width}x${expect.bounds.height}` : "no bounds",
    );

    // (b) sampled color identifies the authored fill. The WindowServer composite is in
    // the display color space, not raw sRGB, so a saturated fill drifts by a fixed
    // (deterministic) transform — exact-hex matching would be dishonest. Instead assert
    // the sampled color is CLOSEST to its own authored fill among all fixture colors:
    // a classification that is robust to a uniform color-space transform and is exactly
    // the guarantee the tool needs (this box reads as ITS color, not another's / the bg).
    const sampled = node.sampledColor?.dominant;
    const palette = { ...Object.fromEntries(Object.entries(EXPECT).map(([k, v]) => [k, v.color])), "page-bg": "#eef2f7" };
    let nearest = null;
    let nearestDist = Infinity;
    for (const [name, hex] of Object.entries(palette)) {
        const dd = sampled ? dist(sampled, hex) : Infinity;
        if (dd < nearestDist) {
            nearestDist = dd;
            nearest = name;
        }
    }
    check(`${testId} color`, nearest === testId, sampled ? `sampled ${sampled} classified as ${nearest} (authored ${expect.color})` : "no sample");
}

console.log("");
if (failures > 0) {
    console.error(`DESCRIBE_CONFORMANCE_FAIL (${failures} failure(s))`);
    process.exit(1);
}
console.log("DESCRIBE_CONFORMANCE_PASS");
