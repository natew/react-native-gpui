#!/usr/bin/env bun
// Gate: the two native stage surfaces — the GhosttyTerminal (painted into Metal)
// and the WebView (an AppKit underlay below Metal) — both round their corners to
// the element's borderRadius and cast a soft drop shadow.
//
// TERMINAL is verified by PIXELS off the in-service capture (sandbox-safe): the
// rounded corner must show the bright field through the arc (not a square terminal
// fill), and a darker shadow band must sit just outside the card edge.
//
// WEBVIEW page content can't render under a sandboxed shell (WebContent XPC never
// starts), and its decor-shadow lives on a separate NSView layer that doesn't
// composite into the offscreen Metal readback — so its native corner-clip + drop
// shadow are verified by the screenshot-independent GEOMETRY_DEBUG log the renderer
// emits when it applies the host-layer mask and the decor shadow. That proves the
// same code path runs; the on-screen look is a user-eyes / unsandboxed concern.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pixelAt } from "./pixel.mjs";
import { readPng } from "./png.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "examples/card-corner-shadow-conformance.tsx";
const OUT = "/tmp/rngpui-card-corner-shadow.png";
const SCALE = 2;

// fixture geometry (logical px) — must match the fixture.
const FIELD = { r: 0xf2, g: 0xc8, b: 0x4b };
const TERMINAL = { x: 480, y: 60, w: 360, h: 460, r: 24, fill: { r: 0x05, g: 0x05, b: 0x07 } };

const fails = [];
function check(ok, message) {
    if (!ok) fails.push(message);
}
function near(a, b, tol) {
    return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}
function brightness(c) {
    return (c.r + c.g + c.b) / 3;
}

// ---- step 1: capture via the rngpui CLI shot (in-service CGWindowList readback) ----
rmSync(OUT, { force: true });
const shotLog = await run(
    "bun",
    [
        "cli/bin.ts",
        "shot",
        "--launch",
        FIXTURE,
        "--size",
        "900x620",
        "--appearance",
        "dark",
        "--out",
        OUT,
    ],
    { RNGPUI_NO_ACTIVATE: "1", RNGPUI_TEST_MODE: "1" },
);
if (!existsSync(OUT)) fail(`shot did not produce a capture at ${OUT}\n${shotLog}`);

const img = readPng(OUT);
const samp = (lx, ly) => pixelAt(img, Math.round(lx * SCALE), Math.round(ly * SCALE));

// ---- terminal: rounded corner clip ----
// the extreme corner of a r=24 card must be the FIELD (clipped away), not terminal fill.
const tlCorner = samp(TERMINAL.x + 1, TERMINAL.y + 1);
check(
    !near(tlCorner, TERMINAL.fill, 24),
    `terminal TL corner is not clipped — got #${hex(tlCorner)} (looks like the square terminal fill; the rounded arc should expose the field)`,
);
// deep inside the card (past the arc) must BE the terminal fill.
const tlInside = samp(TERMINAL.x + TERMINAL.r + 8, TERMINAL.y + TERMINAL.r + 8);
check(
    near(tlInside, TERMINAL.fill, 24),
    `terminal interior should be the terminal fill — got #${hex(tlInside)}`,
);

// ---- terminal: drop shadow band just outside the edge ----
// a soft shadow darkens the bright field for a few px outside the left edge before
// it recovers to the field. sample a point clear of the rounded corners (mid-height).
const midY = TERMINAL.y + TERMINAL.h / 2;
const justOutside = samp(TERMINAL.x - 4, midY); // inside the shadow band
const farOutside = samp(TERMINAL.x - 40, midY); // past the shadow, ~field
const fieldRef = brightness(FIELD);
check(
    brightness(justOutside) < fieldRef - 18,
    `terminal drop shadow missing — pixel 4px outside the left edge (#${hex(justOutside)}, lum ${brightness(justOutside).toFixed(0)}) should be darker than the field (lum ${fieldRef.toFixed(0)})`,
);
check(
    brightness(justOutside) < brightness(farOutside) - 8,
    `terminal shadow should fall off — 4px out (lum ${brightness(justOutside).toFixed(0)}) must be darker than 40px out (lum ${brightness(farOutside).toFixed(0)})`,
);

// ---- step 2: webview native corner-clip + decor-shadow path (log proof) ----
const geomLog = await run(
    "node",
    ["scripts/run-hermes-example.mjs", FIXTURE, "--timeout-ms", "9000"],
    { RNGPUI_NO_ACTIVATE: "1", RNGPUI_TEST_MODE: "1", RNGPUI_WEBVIEW_GEOMETRY_DEBUG: "1" },
);
check(
    /\[webview \d+ decor-shadow\].*corner=24/.test(geomLog),
    `webview decor drop shadow was not applied with the card's 24px corner radius (no matching decor-shadow log line)\n${tail(geomLog)}`,
);
check(
    /\[webview host-layer\].*opaque=true/.test(geomLog),
    `webview host layer base/clip was not applied (no opaque host-layer log line)\n${tail(geomLog)}`,
);

if (fails.length) {
    fail(fails.join("\n"));
}
console.log(
    `CARD_CORNER_SHADOW_CONFORMANCE_PASS terminal-corner-clipped + terminal-shadow-band + webview-host-clip + webview-decor-shadow capture=${OUT}`,
);

function hex(c) {
    return [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function tail(s) {
    return s.split("\n").slice(-12).join("\n");
}
function fail(message) {
    console.error(`CARD_CORNER_SHADOW_CONFORMANCE_FAIL ${message}`);
    process.exit(1);
}
function run(cmd, args, extraEnv) {
    return new Promise((resolveRun) => {
        const child = spawn(cmd, args, {
            cwd: root,
            env: { ...process.env, ...extraEnv },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout?.on("data", (c) => (out += c.toString()));
        child.stderr?.on("data", (c) => (out += c.toString()));
        child.on("exit", () => resolveRun(out));
        child.on("error", (e) => resolveRun(`${out}\nspawn error: ${e.message}`));
    });
}
