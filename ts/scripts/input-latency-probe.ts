import { performance } from "node:perf_hooks";
import { launchHost, type DumpNode, type LaunchedHost } from "../cli/host";

type Status = {
    draft: string;
    secondary: string;
    focused: string;
    primaryFocuses: number;
    secondaryFocuses: number;
};

type PaintedInput = {
    frame: number;
    focusedId?: number;
    value?: string;
};

let host: LaunchedHost | null = null;
try {
    process.env.RNGPUI_INPUT_PAINT_TRACE = "1";
    host = await launchHost("examples/input-runtime-conformance.tsx", { size: "780x620" });
    const tree = await host.dump();
    const primary = requireTestId(tree, "primary-input");
    const secondary = requireTestId(tree, "secondary-input");
    const initial = await waitForStatus(host, (status) => status.secondary === "programmatic");

    const focusSamples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
        await tap(host, secondary);
        await waitForStatus(host, (status) => status.focused === "secondary");
        focusSamples.push(
            await measurePaint(
                host,
                () => tap(host!, primary),
                (painted) => painted.focusedId === primary.globalId,
            ),
        );
        await waitForStatus(host, (status) => status.focused === "primary");
    }

    const keySamples: number[] = [];
    let draft = (await readStatus(host)).draft;
    for (const character of "abcdefghijklmnopqrst") {
        draft += character;
        keySamples.push(
            await measurePaint(
                host,
                () => host!.request<{ ok: boolean }>({ $cmd: "type", text: character }),
                (painted) => painted.focusedId === primary.globalId && painted.value === draft,
            ),
        );
        await waitForStatus(host, (status) => status.draft === draft);
    }

    console.log(
        `INPUT_LATENCY_PROBE ${JSON.stringify({
            nodes: countNodes(tree),
            focusAfterUnrelatedCommit: initial.focused,
            primaryFocuses: initial.primaryFocuses,
            secondaryFocuses: initial.secondaryFocuses,
            focusMs: summarize(focusSamples),
            keyMs: summarize(keySamples),
        })}`,
    );
} catch (error) {
    console.error(`INPUT_LATENCY_PROBE_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    host?.close();
    delete process.env.RNGPUI_INPUT_PAINT_TRACE;
}

async function measurePaint(
    host: LaunchedHost,
    action: () => Promise<{ ok: boolean }>,
    isRequestedPaint: (painted: PaintedInput) => boolean,
) {
    const before = await frames(host);
    const started = performance.now();
    const result = await action();
    if (!result.ok) throw new Error("input action failed");
    const deadline = started + 1_000;
    while (performance.now() < deadline) {
        const snapshot = await host.request<{ ok: boolean; painted?: PaintedInput }>({ $cmd: "inputState" });
        if (snapshot.ok && snapshot.painted?.frame > before && isRequestedPaint(snapshot.painted)) {
            return performance.now() - started;
        }
        await sleep(1);
    }
    throw new Error("input action did not paint within 1s");
}

async function frames(host: LaunchedHost) {
    const result = await host.request<{ ok: boolean; framesPainted: number }>({ $cmd: "frameStats" });
    if (!result.ok) throw new Error("frameStats failed");
    return result.framesPainted;
}

async function tap(host: LaunchedHost, node: DumpNode) {
    const bounds = node.bounds;
    if (!bounds) throw new Error("input has no bounds");
    return host.request<{ ok: boolean }>({
        $cmd: "realtap",
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
    });
}

async function waitForStatus(host: LaunchedHost, predicate: (status: Status) => boolean) {
    const deadline = performance.now() + 5_000;
    let latest: Status | null = null;
    while (performance.now() < deadline) {
        latest = await readStatus(host);
        if (predicate(latest)) return latest;
        await sleep(12);
    }
    throw new Error(`status timed out: ${JSON.stringify(latest)}`);
}

async function readStatus(host: LaunchedHost): Promise<Status> {
    const status = requireTestId(await host.dump(), "input-runtime-status");
    if (typeof status.text !== "string") throw new Error("status has no text");
    return JSON.parse(status.text) as Status;
}

function requireTestId(root: DumpNode, testID: string): DumpNode {
    const node = findTestId(root, testID);
    if (!node) throw new Error(`missing ${testID}`);
    return node;
}

function findTestId(root: DumpNode, testID: string): DumpNode | null {
    if (root.accessibility?.testID === testID) return root;
    for (const child of root.children ?? []) {
        const found = findTestId(child, testID);
        if (found) return found;
    }
    return null;
}

function countNodes(root: DumpNode): number {
    return 1 + (root.children ?? []).reduce((total, child) => total + countNodes(child), 0);
}

function summarize(samples: number[]) {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
        p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
        max: Number(sorted.at(-1)!.toFixed(2)),
    };
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
