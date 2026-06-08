// `rngpui flow` - run a short semantic input flow and write a profile artifact.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDriveableHost, type AttachedHost, type DriveableHost, type DumpNode, type LaunchedHost } from "../host";
import { centerOf, parsePoint, resolve as resolveSelector, walk } from "../selectors";
import { sleep } from "../../scripts/conformance-utils.mjs";

type Host = LaunchedHost | AttachedHost;
type FlowOptions = { json: boolean; profile: boolean; screenshots?: boolean; settleMs?: number; cadenceMs?: number; out?: string };
type ControlResponse = { ok: boolean; error?: string; targetId?: number; focusedId?: number; activated?: boolean };
type FlowStep = { kind: "tap"; selector: string };

const ACTIONS = new Set(["tap"]);

export async function runFlow(host: Host, args: string[], options: FlowOptions): Promise<number> {
    if (!isDriveableHost(host)) {
        console.error("  flow needs a driveable target: use --launch, --bundle, --session, or attach to an app with RNGPUI_CONTROL_SOCKET metadata");
        return 1;
    }
    const steps = parseSteps(args);
    if (!steps.length) {
        console.error("  usage: rngpui flow [--profile] tap <selector> [tap <selector> ...]");
        return 1;
    }

    const outDir = resolve(options.out || join(tmpdir(), `rngpui-flow-${Date.now().toString(36)}`));
    mkdirSync(outDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const captureScreenshots = options.screenshots ?? options.profile;
    const settleMs = Number.isFinite(options.settleMs) ? Math.max(0, options.settleMs!) : 700;
    const cadenceMs = Number.isFinite(options.cadenceMs) ? Math.max(0, options.cadenceMs!) : 0;
    const profile: Record<string, unknown> = {
        version: 1,
        startedAt,
        target: targetInfo(host),
        options: { profile: options.profile, screenshots: captureScreenshots, settleMs, cadenceMs },
        steps: [],
    };
    const started = performance.now();

    const initial = await host.dump();
    writeJson(join(outDir, "initial-tree.json"), initial);
    captureIfRequested(host, captureScreenshots, join(outDir, "initial.png"));

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const index = i + 1;
        const prefix = `step-${String(index).padStart(3, "0")}`;
        const before = await host.dump();
        const beforeHash = hashDump(before);
        writeJson(join(outDir, `${prefix}-before-tree.json`), before);
        captureIfRequested(host, captureScreenshots, join(outDir, `${prefix}-before.png`));

        const target = resolveTapTarget(before, step.selector);
        if (!target) {
            console.error(`  step ${index}: no node matched "${step.selector}"`);
            return 1;
        }
        const targetActiveBefore = isTargetActive(before, target);

        const tapStart = performance.now();
        const response = await host.request<ControlResponse>({ $cmd: "tap", x: target.x, y: target.y });
        const tapRoundTripMs = performance.now() - tapStart;
        if (!response.ok) {
            console.error(`  step ${index}: tap failed: ${response.error || "no native target"}`);
            return 1;
        }

        const settled =
            settleMs > 0
                ? await waitForTapEffect(host, beforeHash, target, targetActiveBefore, settleMs)
                : await dumpAfterCadence(host, beforeHash, target, targetActiveBefore, cadenceMs);
        writeJson(join(outDir, `${prefix}-after-tree.json`), settled.dump);
        captureIfRequested(host, captureScreenshots, join(outDir, `${prefix}-after.png`));

        const record = {
            index,
            kind: step.kind,
            selector: step.selector,
            target,
            response,
            tapRoundTripMs: round(tapRoundTripMs),
            treeChanged: settled.firstTreeChangeMs !== null,
            firstTreeChangeMs: settled.firstTreeChangeMs === null ? null : round(settled.firstTreeChangeMs),
            targetActiveBefore,
            targetActive: settled.targetActive,
            targetActiveMs: settled.targetActiveMs === null ? null : round(settled.targetActiveMs),
            samples: settled.samples,
            beforeHash,
            afterHash: hashDump(settled.dump),
            beforeDigest: digestTree(before),
            afterDigest: digestTree(settled.dump),
        };
        (profile.steps as unknown[]).push(record);

        if (!options.json) {
            const changed = settled.firstTreeChangeMs !== null ? `${round(settled.firstTreeChangeMs)}ms` : "none";
            const active = settled.targetActiveMs !== null ? `${round(settled.targetActiveMs)}ms` : settled.targetActive ? "active" : "not-active";
            console.log(`  ${index}. tap ${JSON.stringify(step.selector)} -> ${target.label} at ${target.x.toFixed(0)},${target.y.toFixed(0)} socket=${round(tapRoundTripMs)}ms tree=${changed} active=${active}`);
        }
    }

    profile.finishedAt = new Date().toISOString();
    profile.durationMs = round(performance.now() - started);
    profile.outDir = outDir;
    writeJson(join(outDir, "profile.json"), profile);

    if (options.json) {
        console.log(JSON.stringify(profile, null, 2));
    } else {
        console.log(`  profile: ${outDir}`);
    }
    return 0;
}

function parseSteps(args: string[]): FlowStep[] {
    const steps: FlowStep[] = [];
    let i = 0;
    while (i < args.length) {
        const verb = stripComma(args[i]).toLowerCase();
        if (!ACTIONS.has(verb)) {
            i += 1;
            continue;
        }
        i += 1;
        const parts: string[] = [];
        while (i < args.length && !ACTIONS.has(stripComma(args[i]).toLowerCase())) {
            parts.push(stripComma(args[i]));
            i += 1;
        }
        const selector = parts.join(" ").trim();
        if (verb === "tap" && selector) steps.push({ kind: "tap", selector });
    }
    return steps;
}

function stripComma(value: string): string {
    return value.replace(/,+$/, "");
}

function resolveTapTarget(dump: DumpNode, selector: string): { x: number; y: number; label: string; globalId: number | null; selector: string } | null {
    const point = parsePoint(selector);
    if (point) return { ...point, label: selector, globalId: null, selector };
    const { best } = resolveSelector(dump, selector);
    const center = best ? centerOf(best.node) : null;
    if (!best || !center) return null;
    return {
        ...center,
        label: `${shortId(best.node)} #${best.node.globalId}`,
        globalId: best.node.globalId,
        selector,
    };
}

async function waitForTapEffect(
    host: DriveableHost,
    beforeHash: string,
    target: { globalId: number | null; selector: string },
    targetActiveBefore: boolean,
    timeoutMs: number,
): Promise<{ firstTreeChangeMs: number | null; targetActive: boolean; targetActiveMs: number | null; samples: number; dump: DumpNode }> {
    const started = performance.now();
    let samples = 0;
    let firstTreeChangeMs: number | null = null;
    let targetActiveMs: number | null = targetActiveBefore ? 0 : null;
    let latest = await host.dump();
    while (performance.now() - started < timeoutMs) {
        await sleep(35);
        latest = await host.dump();
        samples += 1;
        const elapsedMs = performance.now() - started;
        if (firstTreeChangeMs === null && hashDump(latest) !== beforeHash) firstTreeChangeMs = elapsedMs;
        if (targetActiveMs === null && isTargetActive(latest, target)) targetActiveMs = elapsedMs;
        if (firstTreeChangeMs !== null && targetActiveMs !== null) break;
    }
    return {
        firstTreeChangeMs,
        targetActive: isTargetActive(latest, target),
        targetActiveMs,
        samples,
        dump: latest,
    };
}

async function dumpAfterCadence(
    host: DriveableHost,
    beforeHash: string,
    target: { globalId: number | null; selector: string },
    targetActiveBefore: boolean,
    cadenceMs: number,
): Promise<{ firstTreeChangeMs: number | null; targetActive: boolean; targetActiveMs: number | null; samples: number; dump: DumpNode }> {
    if (cadenceMs > 0) await sleep(cadenceMs);
    const dump = await host.dump();
    const targetActive = isTargetActive(dump, target);
    return {
        firstTreeChangeMs: hashDump(dump) !== beforeHash ? cadenceMs : null,
        targetActive,
        targetActiveMs: targetActiveBefore ? 0 : targetActive ? cadenceMs : null,
        samples: 1,
        dump,
    };
}

function targetInfo(host: DriveableHost) {
    return {
        mode: host.mode,
        appName: host.mode === "launch" ? host.appName : host.appName ?? null,
        servicePid: host.servicePid,
        window: host.window,
        controlSocketPath: host.mode === "attach" ? host.controlSocketPath ?? null : "(session)",
    };
}

function digestTree(dump: DumpNode) {
    const interactive = [...walk(dump)]
        .filter((node) => node.bounds && node.events?.length)
        .slice(0, 20)
        .map((node) => ({
            globalId: node.globalId,
            id: shortId(node),
            bounds: node.bounds,
            events: node.events ?? [],
            stateStyle: stateStyleOf(node),
        }));
    const webviews = [...walk(dump)]
        .filter((node) => node.type === "webview")
        .map((node) => ({ globalId: node.globalId, id: shortId(node), bounds: node.bounds ?? null }));
    return { interactive, webviews };
}

function isTargetActive(dump: DumpNode, target: { globalId: number | null; selector: string }): boolean {
    const node = target.globalId === null ? resolveSelector(dump, target.selector).best?.node : findNodeByGlobalId(dump, target.globalId);
    if (!node) return false;
    const style = stateStyleOf(node);
    return !!(style.backgroundColor || style.boxShadow || style.borderColor);
}

function findNodeByGlobalId(root: DumpNode, globalId: number): DumpNode | null {
    for (const node of walk(root)) if (node.globalId === globalId) return node;
    return null;
}

function hashDump(dump: DumpNode): string {
    return createHash("sha1").update(JSON.stringify(dump)).digest("hex");
}

function shortId(node: DumpNode): string {
    const a = node.accessibility ?? {};
    return a.testID ?? a.identifier ?? a.nativeID ?? a.label ?? (node.text ? `"${node.text.slice(0, 40)}"` : `#${node.globalId}`);
}

function stateStyleOf(node: DumpNode): Record<string, unknown> {
    const style = node.style ?? {};
    const out: Record<string, unknown> = {};
    for (const key of ["backgroundColor", "borderColor", "boxShadow", "opacity", "display"]) {
        const value = style[key];
        if (value !== undefined && value !== "none" && value !== "#00000000") out[key] = value;
    }
    return out;
}

function writeJson(path: string, value: unknown) {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

function captureIfRequested(host: Host, enabled: boolean, path: string) {
    if (!enabled) return;
    try {
        host.capture(path);
        if (!existsSync(path)) {
            writeFileSync(`${path}.missing`, "capture did not write a file\n");
        }
    } catch (error) {
        writeFileSync(`${path}.error.txt`, error instanceof Error ? error.message : String(error));
    }
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}
