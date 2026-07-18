import { performance } from "node:perf_hooks";
import { launchHost, type DumpNode, type LaunchedHost } from "../cli/host";

let host: LaunchedHost | null = null;
try {
    host = await launchHost("examples/reanimated-scroll-conformance.tsx", { size: "420x360" });
    const initial = await host.dump();
    const initialTarget = findNativeId(initial, "reanimated-scroll-target");
    assert(!intersectsWindow(initialTarget?.bounds), "deep target started inside the viewport");

    const started = performance.now();
    const deadline = started + 3_000;
    let target: DumpNode | null = null;
    while (performance.now() < deadline) {
        target = findNativeId(await host.dump(), "reanimated-scroll-target");
        if (intersectsWindow(target?.bounds)) break;
        await sleep(12);
    }
    assert(intersectsWindow(target?.bounds), "Reanimated scrollTo did not paint the deep target");
    const finalTree = await host.dump();
    const status = findNativeId(finalTree, "reanimated-scroll-status");
    const observedY = Number(/^y:(\d+)$/.exec(textContent(status))?.[1]);
    assert(observedY >= 7_000, `native onScroll did not acknowledge the clamped worklet offset: ${observedY}`);
    const elapsedMs = performance.now() - started;
    console.log(
        `REANIMATED_SCROLL_CONFORMANCE_PASS target=180 offset=${observedY} elapsed=${elapsedMs.toFixed(1)}ms`,
    );
} catch (error) {
    console.error(
        `REANIMATED_SCROLL_CONFORMANCE_FAIL ${error instanceof Error ? error.message : String(error)}`,
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
