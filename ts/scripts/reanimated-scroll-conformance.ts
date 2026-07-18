import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchHost, type DumpNode, type LaunchedHost } from "../cli/host";

let host: LaunchedHost | null = null;
try {
    host = await launchHost("examples/reanimated-scroll-conformance.tsx", { size: "420x360" });
    const initial = await host.dump();
    const scrollHost = findNativeId(initial, "reanimated-scroll-host");
    const trigger = findNativeId(initial, "reanimated-scroll-trigger");
    const initialTarget = findNativeId(initial, "reanimated-scroll-target");
    assert(scrollHost, "Reanimated ScrollView host was not mounted");
    assert(trigger?.bounds, "Reanimated scroll trigger was not laid out");
    assert(!intersectsWindow(initialTarget?.bounds), "deep target started inside the viewport");

    const started = performance.now();
    const { x, y, width, height } = trigger.bounds;
    const tap = await host.request<{ ok: boolean; error?: string }>({
        $cmd: "tap",
        x: x + width / 2,
        y: y + height / 2,
    });
    assert(tap.ok, tap.error ?? "scroll trigger tap failed");
    const deadline = started + 3_000;
    let target: DumpNode | null = null;
    let observedY = 0;
    while (performance.now() < deadline) {
        const tree = await host.dump();
        target = findNativeId(tree, "reanimated-scroll-target");
        const status = findNativeId(tree, "reanimated-scroll-status");
        observedY = Number(/^y:(\d+)$/.exec(textContent(status))?.[1]);
        if (intersectsWindow(target?.bounds) && observedY >= 7_000) break;
        await sleep(12);
    }
    assert(intersectsWindow(target?.bounds), "Reanimated scrollTo did not paint the deep target");
    assert(observedY >= 6_900, `native onScroll did not acknowledge the worklet offset: ${observedY}`);
    const elapsedMs = performance.now() - started;
    console.log(
        `REANIMATED_SCROLL_CONFORMANCE_PASS host=${scrollHost.globalId} target=180 offset=${observedY} elapsed=${elapsedMs.toFixed(1)}ms`,
    );
} catch (error) {
    const serviceLog = host ? tail(readFileSync(join(host.sessionDir, "service.log"), "utf8"), 40) : "";
    console.error(
        `REANIMATED_SCROLL_CONFORMANCE_FAIL ${error instanceof Error ? error.message : String(error)}` +
            (serviceLog ? `\n--- service log tail ---\n${serviceLog}` : ""),
    );
    process.exitCode = 1;
} finally {
    host?.close();
}

function findNativeId(node: DumpNode, nativeID: string): DumpNode | null {
    if (node.accessibility?.nativeID === nativeID) return node;
    for (const child of node.children ?? []) {
        const found = findNativeId(child, nativeID);
        if (found) return found;
    }
    return null;
}

function textContent(node: DumpNode | null): string {
    if (!node) return "";
    return [node.text, ...(node.children ?? []).map(textContent)].filter(Boolean).join("");
}

function intersectsWindow(bounds: DumpNode["bounds"]): boolean {
    return !!bounds && bounds.width > 0 && bounds.height > 0 && bounds.y < 360 && bounds.y + bounds.height > 0;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(value: string, lines: number): string {
    return value.trimEnd().split("\n").slice(-lines).join("\n");
}
