// Conformance gate for :focus-visible on a freshly mounted focus scope.
//
// `useKeyboardNavigationController` requires an `initialId`, so every app that uses
// keyboard navigation mounts with a focused target. If that target reads as
// `:focus-visible`, its focus ring paints before the user has touched anything — on
// Team Machine that painted the full-stage ring on a cold launch and read as a
// permanent divider between panes.
//
// examples/focus-visible-conformance.tsx reports the target's own `focusVisible` twice:
// once as mounted, once after `activateFocused()` (the reveal every keyboard path runs
// before it moves focus). Both are asserted here, because a regression that suppressed
// the ring entirely would satisfy the first line alone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchHost } from "../cli/host.ts";
import { frontmostProcess, sleep } from "./conformance-utils.mjs";

const service =
    process.env.RNGPUI_SERVICE ?? new URL("../../rust/target/release/rngpui-service", import.meta.url).pathname;
const previousService = process.env.RNGPUI_SERVICE;
process.env.RNGPUI_SERVICE = service;

const INITIAL = "CONFORMANCE focus-visible initial alpha=false beta=false";
const KEYBOARD = "CONFORMANCE focus-visible keyboard alpha=true beta=false";

async function waitForLog(path, needle, timeoutMs = 6_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path) && readFileSync(path, "utf8").includes(needle)) return;
        await sleep(20);
    }
    throw new Error(`timed out waiting for "${needle}"`);
}

const frontmostBefore = frontmostProcess();
let host;
try {
    if (!existsSync(service)) throw new Error(`rngpui-service not found: ${service}`);
    host = await launchHost(new URL("../examples/focus-visible-conformance.tsx", import.meta.url).pathname, {
        size: "420x320",
    });
    const logPath = join(host.sessionDir, "service.log");

    try {
        await waitForLog(logPath, KEYBOARD);
    } catch (error) {
        const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
        const reported = log
            .split("\n")
            .filter((line) => line.includes("CONFORMANCE focus-visible"))
            .join("\n");
        throw new Error(`${error.message}\n--- reported ---\n${reported || "(nothing)"}`);
    }

    const log = readFileSync(logPath, "utf8");
    if (!log.includes(INITIAL)) {
        const reported = log
            .split("\n")
            .filter((line) => line.includes("CONFORMANCE focus-visible initial"))
            .join("\n");
        throw new Error(`a target focused by mount read :focus-visible:\n${reported || "(nothing)"}`);
    }

    const frontmostAfter = frontmostProcess();
    if (frontmostAfter.pid !== frontmostBefore.pid) {
        throw new Error(`fixture stole focus from pid ${frontmostBefore.pid} to ${frontmostAfter.pid}`);
    }
    console.log("FOCUS_VISIBLE_CONFORMANCE PASS initial=hidden keyboard=visible");
} catch (error) {
    console.error(`FOCUS_VISIBLE_CONFORMANCE FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    host?.close();
    if (previousService === undefined) delete process.env.RNGPUI_SERVICE;
    else process.env.RNGPUI_SERVICE = previousService;
}
