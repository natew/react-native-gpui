// Conformance for the rngpui diagnostics CLI surface. This exercises the same
// offscreen, driveable session path users use for `get stats` / `get webviews`.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, "..");
const entry = "examples/webview-probe.tsx";

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

let session = "";
try {
    const first = run(["get", "stats", "--launch", entry, "--keep", "--json"]);
    const match = first.stderr.match(/\[rngpui\] session (.+)$/m);
    if (!match) throw new Error(`no session printed\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    session = match[1].trim();

    const stats = JSON.parse(first.stdout);
    if (stats.nodes < 4) throw new Error(`expected a non-trivial tree, got nodes=${stats.nodes}`);
    if (stats.visible < 3) throw new Error(`expected visible nodes, got visible=${stats.visible}`);
    if (stats.duplicateGlobalIds.length) {
        throw new Error(`expected no duplicate globalIds, got ${stats.duplicateGlobalIds.join(",")}`);
    }
    if (stats.webviews.total !== 1 || stats.webviews.visible !== 1 || stats.webviews.hidden !== 0) {
        throw new Error(`expected exactly one visible webview, got ${JSON.stringify(stats.webviews)}`);
    }

    const webviewsResult = run(["get", "webviews", "--session", session, "--json"]);
    const webviews = JSON.parse(webviewsResult.stdout);
    if (!Array.isArray(webviews) || webviews.length !== 1) {
        throw new Error(`expected one webview row, got ${JSON.stringify(webviews)}`);
    }
    const webview = webviews[0];
    if (!webview.visible || !webview.bounds || webview.bounds.width < 100 || webview.bounds.height < 100) {
        throw new Error(`expected visible webview bounds, got ${JSON.stringify(webview)}`);
    }
    if (webview.source?.kind !== "html" || webview.source.bytes < 500) {
        throw new Error(`expected inline html source metadata, got ${JSON.stringify(webview.source)}`);
    }

    console.log(
        `DIAGNOSTICS_CONFORMANCE_PASS nodes=${stats.nodes} visible=${stats.visible} webviews=${stats.webviews.total}`
    );
} finally {
    if (session) run(["close", "--session", session], { allowFailure: true });
}
