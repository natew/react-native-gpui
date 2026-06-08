// Conformance for persistent rngpui drive/read sessions:
// launch fixture once, keep it alive, tap via --session, then describe via the same
// session and assert the rendered color changed. No screenshots-as-proof.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const entry = "examples/drive-fixture.tsx";

function run(args, options = {}) {
    const result = spawnSync("bun", ["run", "cli/bin.ts", ...args], {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, RNGPUI_NO_ACTIVATE: "1", RNGPUI_TEST_MODE: "1" },
        timeout: 90_000,
    });
    if (result.status !== 0 && options.allowFailure !== true) {
        throw new Error(`rngpui ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    return result;
}

function describe(session) {
    const result = run(["get", "describe", "toggle-button", "--session", session, "--json"]);
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

function nearest(sampled) {
    const palette = {
        off: "#d92d20",
        on: "#12b76a",
        bg: "#eef2f7",
    };
    let name = "";
    let best = Infinity;
    for (const [key, hex] of Object.entries(palette)) {
        const value = dist(sampled, hex);
        if (value < best) {
            best = value;
            name = key;
        }
    }
    return name;
}

console.log("rngpui drive-conformance: persistent session + tap + measured state change\n");

let session = "";
try {
    const first = run(["get", "describe", "toggle-button", "--launch", entry, "--keep", "--json"]);
    const match = first.stderr.match(/\[rngpui\] session (.+)$/m);
    if (!match) throw new Error(`no session printed\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    session = match[1].trim();

    const before = JSON.parse(first.stdout);
    const beforeColor = before.sampledColor?.dominant;
    if (nearest(beforeColor) !== "off") {
        throw new Error(`expected off before tap, sampled ${beforeColor}`);
    }
    console.log(`  PASS initial color — ${beforeColor} classified as off`);

    run(["do", "tap", "toggle-button", "--session", session, "--json"]);
    const after = describe(session);
    const afterColor = after.sampledColor?.dominant;
    if (nearest(afterColor) !== "on") {
        throw new Error(`expected on after tap, sampled ${afterColor}`);
    }
    console.log(`  PASS tapped color — ${afterColor} classified as on`);

    run(["do", "tap", "drive-input", "--session", session, "--json"]);
    run(["do", "type", "typed-by-rngpui", "--session", session, "--json"]);
    const input = run(["get", "describe", "drive-input", "--session", session, "--json"]);
    const inputNode = JSON.parse(input.stdout);
    if (inputNode.value !== "typed-by-rngpui") {
        throw new Error(`expected typed input value, got ${JSON.stringify(inputNode.value)}`);
    }
    console.log(`  PASS input typing — value=${JSON.stringify(inputNode.value)}`);

    console.log("\nDRIVE_CONFORMANCE_PASS");
} finally {
    if (session) run(["close", "--session", session], { allowFailure: true });
}
