import { performance } from "node:perf_hooks";
import { rmSync } from "node:fs";
import { launchHost, type DumpNode, type LaunchedHost } from "../cli/host";
import { readPng } from "./png.mjs";

type InputStatus = {
    draft: string;
    secondary: string;
    focused: "none" | "primary" | "secondary";
    sawComposing: boolean;
    lastComposing: boolean;
    eventCount: number;
    submitted: string;
    composingEnter: boolean;
    primaryFocuses: number;
    secondaryFocuses: number;
    primaryEditable: boolean;
    uncontrolledObserved: string;
    unrelatedTick: number;
};

type InputSnapshot = {
    ok: boolean;
    error?: string;
    focusedId?: number;
    value?: string;
    isComposing?: boolean;
    selectedRange?: [number, number] | null;
    markedRange?: [number, number] | null;
    candidateBounds?: { x: number; y: number; width: number; height: number } | null;
    eventCount?: number;
    painted?: {
        frame: number;
        focusedId?: number;
        value?: string;
        eventCount: number;
    };
};

type FrameStats = {
    ok: boolean;
    framesPainted: number;
};

const entry = "examples/input-runtime-conformance.tsx";
const frameBudgetMs = Number(process.env.RNGPUI_INPUT_FRAME_BUDGET_MS ?? 16.67);

let host: LaunchedHost | null = null;
try {
    process.env.RNGPUI_INPUT_PAINT_TRACE = "1";
    host = await launchHost(entry, { size: "780x620" });

    const initialTree = await host.dump();
    const primary = requireTestId(initialTree, "primary-input");
    const secondary = requireTestId(initialTree, "secondary-input");
    const placeholderColorInput = requireTestId(initialTree, "placeholder-color-input");
    const uncontrolledInput = requireTestId(initialTree, "uncontrolled-input");
    const disablePrimary = requireTestId(initialTree, "disable-primary");
    const nodes = countNodes(initialTree);
    assert(nodes >= 1_600, `large-tree fixture only rendered ${nodes} nodes`);

    const initial = await waitForStatus(
        host,
        "programmatic controlled update",
        (status) => status.secondary === "programmatic",
    );
    assert(
        initial.focused === "primary",
        `updating a non-focused controlled input stole focus (${initial.focused})`,
    );
    assert(initial.secondaryFocuses === 0, "secondary input received focus during a value-only commit");

    let snapshot = await inputSnapshot(host);
    assert(snapshot.focusedId === primary.globalId, "autoFocus did not select the primary InputState");
    assertCandidateBounds(snapshot, "initial caret", primary);
    const initialCandidateBounds = snapshot.candidateBounds!;

    await realKey(host, "tab");
    await waitForStatus(host, "forward tab", (status) => status.focused === "secondary");
    snapshot = await inputSnapshot(host);
    assert(snapshot.focusedId === secondary.globalId, "Tab did not move to the next TextInput");

    await realKey(host, "shift-tab");
    await waitForStatus(host, "reverse tab", (status) => status.focused === "primary");
    snapshot = await inputSnapshot(host);
    assert(snapshot.focusedId === primary.globalId, "Shift-Tab did not return to the previous TextInput");

    const axBlurred = await host.request<{ ok: boolean }>({
        $cmd: "axFocus",
        id: primary.globalId,
        focused: false,
    });
    assert(axBlurred.ok, "AX focus=false did not blur the native InputState");
    await waitForStatus(host, "AX blur", (status) => status.focused === "none");
    const axFocused = await host.request<{ ok: boolean }>({
        $cmd: "axFocus",
        id: primary.globalId,
        focused: true,
    });
    assert(axFocused.ok, "AX focus=true did not focus the native InputState");
    await waitForStatus(host, "AX focus", (status) => status.focused === "primary");

    const focusLatencies: number[] = [];
    for (let index = 0; index < 20; index += 1) {
        await realTap(host, secondary);
        await waitForStatus(host, `secondary focus ${index}`, (status) => status.focused === "secondary");
        focusLatencies.push(
            await measurePresentation(
                host,
                () => realTap(host!, primary),
                (painted) => painted.focusedId === primary.globalId,
            ),
        );
        await waitForStatus(host, `primary focus ${index}`, (status) => status.focused === "primary");
    }

    const keyLatencies: number[] = [];
    let expectedDraft = "";
    for (const character of "abcdefghijklmnopqrst") {
        expectedDraft += character;
        keyLatencies.push(
            await measurePresentation(
                host,
                () => host!.request<{ ok: boolean }>({ $cmd: "type", text: character }),
                (painted) =>
                    painted.focusedId === primary.globalId && painted.value === expectedDraft,
            ),
        );
        await waitForStatus(host, `controlled key ${character}`, (status) => status.draft === expectedDraft);
        snapshot = await inputSnapshot(host);
        assert(snapshot.focusedId === primary.globalId, `focus changed after typing ${character}`);
    }

    const colorCapture = `/tmp/rngpui-input-runtime-colors-${process.pid}.png`;
    rmSync(colorCapture, { force: true });
    host.capture(colorCapture);
    const colorImage = readPng(colorCapture);
    assertNodeContainsColor(colorImage, primary, { r: 0x43, g: 0xd1, b: 0x7d }, "TextInput color");
    assertNodeContainsColor(
        colorImage,
        placeholderColorInput,
        { r: 0xff, g: 0x4f, b: 0xa3 },
        "placeholderTextColor",
    );
    rmSync(colorCapture, { force: true });

    const firstMarked = await host.request<InputSnapshot>({
        $cmd: "imeSetMarked",
        text: "に",
        selectedRange: [1, 1],
    });
    assert(firstMarked.ok && firstMarked.isComposing, `first marked-text update failed: ${firstMarked.error ?? ""}`);

    const secondMarked = await host.request<InputSnapshot>({
        $cmd: "imeSetMarked",
        text: "😀日",
        selectedRange: [3, 3],
    });
    assert(
        secondMarked.value === "abcdefghijklmnopqrst😀日",
        `marked replacement produced ${JSON.stringify(secondMarked.value)}`,
    );
    assertRange(secondMarked.markedRange, [20, 23], "marked UTF-16 range");
    assertRange(secondMarked.selectedRange, [23, 23], "marked selection UTF-16 range");
    assert(secondMarked.isComposing === true, "marked replacement lost composing state");

    const composing = await waitForStatus(
        host,
        "React marked-text event",
        (status) => status.draft === "abcdefghijklmnopqrst😀日" && status.lastComposing,
    );
    assert(composing.sawComposing, "React onChange never observed isComposing=true");
    snapshot = await inputSnapshot(host);
    assertRange(snapshot.markedRange, [20, 23], "painted marked UTF-16 range");
    assertCandidateBounds(snapshot, "painted marked text", primary);
    const markedCandidateBounds = snapshot.candidateBounds!;
    assert(
        Math.hypot(
            markedCandidateBounds.x - initialCandidateBounds.x,
            markedCandidateBounds.y - initialCandidateBounds.y,
        ) >= 4,
        `IME candidate rectangle did not follow the shaped caret: initial=${JSON.stringify(initialCandidateBounds)} marked=${JSON.stringify(markedCandidateBounds)}`,
    );

    await realKey(host, "enter");
    snapshot = await inputSnapshot(host);
    assert(snapshot.value === "abcdefghijklmnopqrst😀日", "Enter mutated active marked text");
    assert(snapshot.isComposing === true, "Enter ended composition before AppKit committed it");
    const composingEnter = await waitForStatus(host, "composing Enter keyPress", (status) => status.composingEnter);
    assert(composingEnter.submitted === "", "Enter submitted while marked text was active");

    const committed = await host.request<InputSnapshot>({ $cmd: "imeCommit", text: "日本" });
    assert(
        committed.value === "abcdefghijklmnopqrst日本",
        `IME commit produced ${JSON.stringify(committed.value)}`,
    );
    assert(committed.isComposing === false, "IME commit left composing state active");
    assert(committed.markedRange == null, "IME commit left a marked range");
    await waitForStatus(
        host,
        "React IME commit",
        (status) => status.draft === "abcdefghijklmnopqrst日本" && !status.lastComposing,
    );

    await host.request<InputSnapshot>({
        $cmd: "imeSetMarked",
        text: "語",
        selectedRange: [1, 1],
    });
    const unmarked = await host.request<InputSnapshot>({ $cmd: "imeUnmark" });
    assert(unmarked.value === "abcdefghijklmnopqrst日本語", "unmarkText changed the composed value");
    assert(unmarked.isComposing === false && unmarked.markedRange == null, "unmarkText kept composition active");
    await waitForStatus(
        host,
        "React unmark event",
        (status) => status.draft === "abcdefghijklmnopqrst日本語" && !status.lastComposing,
    );

    snapshot = await inputSnapshot(host);
    const beforeAxCount = snapshot.eventCount ?? 0;
    const axReplaced = await host.request<InputSnapshot>({
        $cmd: "axEdit",
        id: primary.globalId,
        text: "ax-seed:",
        insertAtCursor: false,
    });
    assert(axReplaced.ok && axReplaced.value === "ax-seed:", "AX value edit bypassed the native InputState");
    assert((axReplaced.eventCount ?? 0) > beforeAxCount, "AX value edit did not increment eventCount");
    await waitForStatus(host, "controlled AX value edit", (status) => status.draft === "ax-seed:");

    const axInserted = await host.request<InputSnapshot>({
        $cmd: "axEdit",
        id: primary.globalId,
        text: "AX",
        insertAtCursor: true,
    });
    assert(axInserted.value === "ax-seed:AX", "AX selected-text edit did not insert at the native cursor");
    assert(axInserted.focusedId === primary.globalId, "AX selected-text edit did not retain native focus");
    await waitForStatus(host, "controlled AX selected-text edit", (status) => status.draft === "ax-seed:AX");

    const combining = "e\u0301";
    await host.request<InputSnapshot>({ $cmd: "imeSetMarked", text: combining, selectedRange: [2, 2] });
    const deadKeyUnmarked = await host.request<InputSnapshot>({ $cmd: "imeUnmark" });
    assert(deadKeyUnmarked.value === `ax-seed:AX${combining}`, "dead-key marked text changed on unmark");
    await waitForStatus(host, "dead-key composition", (status) => status.draft === `ax-seed:AX${combining}`);
    await realKey(host, "shift-left");
    snapshot = await inputSnapshot(host);
    assertRange(snapshot.selectedRange, [10, 12], "combining-grapheme selection");
    await assertClipboardSelection(host, combining, "combining grapheme");
    await realKey(host, "backspace");
    await waitForStatus(host, "combining-grapheme deletion", (status) => status.draft === "ax-seed:AX");

    const zwjEmoji = "👩‍💻";
    const typedEmoji = await host.request<{ ok: boolean }>({ $cmd: "type", text: zwjEmoji });
    assert(typedEmoji.ok, "ZWJ insertion did not reach the focused InputState");
    await waitForStatus(host, "ZWJ insertion", (status) => status.draft === `ax-seed:AX${zwjEmoji}`);
    await realKey(host, "shift-left");
    snapshot = await inputSnapshot(host);
    assertRange(snapshot.selectedRange, [10, 15], "ZWJ-grapheme selection");
    await assertClipboardSelection(host, zwjEmoji, "ZWJ grapheme");
    await realKey(host, "backspace");
    await waitForStatus(host, "ZWJ-grapheme deletion", (status) => status.draft === "ax-seed:AX");

    const axReset = await host.request<InputSnapshot>({
        $cmd: "axEdit",
        id: primary.globalId,
        text: "abcdefghijklmnopqrst日本語",
        insertAtCursor: false,
    });
    assert(axReset.value === "abcdefghijklmnopqrst日本語", "AX reset did not reach native text state");
    await waitForStatus(
        host,
        "controlled AX reset",
        (status) => status.draft === "abcdefghijklmnopqrst日本語",
    );

    await realKey(host, "enter");
    const submitted = await waitForStatus(
        host,
        "controlled multiline submit",
        (status) =>
            status.submitted === "abcdefghijklmnopqrst日本語" &&
            status.draft === "abcdefghijklmnopqrst日本語",
    );
    snapshot = await inputSnapshot(host);
    assert(snapshot.value === submitted.draft, "controlled submit left the native newline behind");
    assert(snapshot.focusedId === primary.globalId, "controlled submit lost focus");
    assert((snapshot.eventCount ?? 0) === submitted.eventCount, "native and React event counters diverged");

    await realTap(host, uncontrolledInput);
    await realKey(host, "cmd-a");
    const uncontrolledValue = "uncontrolled-edited";
    const uncontrolledTyped = await host.request<{ ok: boolean }>({
        $cmd: "type",
        text: uncontrolledValue,
    });
    assert(uncontrolledTyped.ok, "uncontrolled native edit failed");
    await waitForStatus(
        host,
        "uncontrolled edit across unrelated commit",
        (status) => status.uncontrolledObserved === uncontrolledValue && status.unrelatedTick > 0,
    );
    snapshot = await inputSnapshot(host);
    assert(snapshot.focusedId === uncontrolledInput.globalId, "unrelated commit moved uncontrolled focus");
    assert(snapshot.value === uncontrolledValue, "defaultValue reset an uncontrolled native edit");

    await realTap(host, primary);
    await waitForStatus(host, "primary refocus before disable", (status) => status.focused === "primary");

    await realTap(host, disablePrimary);
    await waitForStatus(
        host,
        "editable true-to-false blur",
        (status) => !status.primaryEditable && status.focused === "none",
    );
    const disabledSnapshot = await host.request<InputSnapshot>({ $cmd: "inputState" });
    assert(!disabledSnapshot.ok, "disabling the focused input left focused_input populated");
    const disabledAxFocus = await host.request<{ ok: boolean }>({
        $cmd: "axFocus",
        id: primary.globalId,
        focused: true,
    });
    assert(!disabledAxFocus.ok, "AX refocused an editable=false InputState");

    const focus = summarize(focusLatencies);
    const key = summarize(keyLatencies);
    assert(
        focus.p95 <= frameBudgetMs,
        `click-to-painted-focus p95 ${focus.p95.toFixed(2)}ms exceeded ${frameBudgetMs.toFixed(2)}ms`,
    );
    assert(
        key.p95 <= frameBudgetMs,
        `key-to-painted-value p95 ${key.p95.toFixed(2)}ms exceeded ${frameBudgetMs.toFixed(2)}ms`,
    );

    console.log(
        `INPUT_RUNTIME_CONFORMANCE_PASS nodes=${nodes} focusMedian=${focus.median.toFixed(2)}ms focusP95=${focus.p95.toFixed(2)}ms keyMedian=${key.median.toFixed(2)}ms keyP95=${key.p95.toFixed(2)}ms eventCount=${snapshot.eventCount}`,
    );
} catch (error) {
    console.error(`INPUT_RUNTIME_CONFORMANCE_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    host?.close();
    delete process.env.RNGPUI_INPUT_PAINT_TRACE;
}

async function measurePresentation(
    host: LaunchedHost,
    action: () => Promise<{ ok: boolean }>,
    isRequestedPaint: (painted: NonNullable<InputSnapshot["painted"]>) => boolean,
): Promise<number> {
    const before = await frameStats(host);
    const started = performance.now();
    const result = await action();
    assert(result.ok, "input action failed");
    const deadline = started + 1_000;
    while (performance.now() < deadline) {
        const snapshot = await inputSnapshot(host);
        if (
            snapshot.painted &&
            snapshot.painted.frame > before.framesPainted &&
            isRequestedPaint(snapshot.painted)
        ) {
            return performance.now() - started;
        }
        await sleep(1);
    }
    throw new Error("input action did not paint a frame within 1s");
}

async function frameStats(host: LaunchedHost): Promise<FrameStats> {
    const stats = await host.request<FrameStats>({ $cmd: "frameStats" });
    assert(stats.ok, "frameStats failed");
    return stats;
}

async function inputSnapshot(host: LaunchedHost): Promise<InputSnapshot> {
    const snapshot = await host.request<InputSnapshot>({ $cmd: "inputState" });
    assert(snapshot.ok, snapshot.error ?? "inputState failed");
    return snapshot;
}

async function realKey(host: LaunchedHost, key: string): Promise<{ ok: boolean }> {
    const result = await host.request<{ ok: boolean; error?: string }>({ $cmd: "realKey", key });
    assert(result.ok, result.error ?? `realKey ${key} failed`);
    return result;
}

async function realTap(host: LaunchedHost, node: DumpNode): Promise<{ ok: boolean }> {
    const bounds = node.bounds;
    assert(bounds && bounds.width > 0 && bounds.height > 0, "input has no tappable bounds");
    const result = await host.request<{ ok: boolean; error?: string }>({
        $cmd: "realtap",
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
    });
    assert(result.ok, result.error ?? "realtap failed");
    return result;
}

async function waitForStatus(
    host: LaunchedHost,
    label: string,
    predicate: (status: InputStatus) => boolean,
): Promise<InputStatus> {
    const deadline = performance.now() + 5_000;
    let latest: InputStatus | null = null;
    while (performance.now() < deadline) {
        latest = await readStatus(host);
        if (predicate(latest)) return latest;
        await sleep(12);
    }
    throw new Error(`${label} timed out; latest=${JSON.stringify(latest)}`);
}

async function readStatus(host: LaunchedHost): Promise<InputStatus> {
    const node = requireTestId(await host.dump(), "input-runtime-status");
    assert(typeof node.text === "string", "status node has no text");
    return JSON.parse(node.text) as InputStatus;
}

function requireTestId(root: DumpNode, testID: string): DumpNode {
    const node = findNode(root, (candidate) => candidate.accessibility?.testID === testID);
    assert(node, `missing ${testID}`);
    return node;
}

function findNode(root: DumpNode, predicate: (node: DumpNode) => boolean): DumpNode | null {
    if (predicate(root)) return root;
    for (const child of root.children ?? []) {
        const found = findNode(child, predicate);
        if (found) return found;
    }
    return null;
}

function countNodes(root: DumpNode): number {
    return 1 + (root.children ?? []).reduce((total, child) => total + countNodes(child), 0);
}

function assertCandidateBounds(snapshot: InputSnapshot, label: string, input: DumpNode) {
    const bounds = snapshot.candidateBounds;
    assert(bounds, `${label} has no candidate rectangle`);
    assert(
        [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.height > 0,
        `${label} candidate rectangle is invalid: ${JSON.stringify(bounds)}`,
    );
    const inputBounds = input.bounds;
    assert(inputBounds, "input has no layout bounds");
    assert(
        bounds.x >= inputBounds.x - 1 &&
            bounds.x <= inputBounds.x + inputBounds.width + 1 &&
            bounds.y >= inputBounds.y - 1 &&
            bounds.y <= inputBounds.y + inputBounds.height + 1,
        `${label} candidate rectangle is outside the input: ${JSON.stringify(bounds)}`,
    );
}

function assertRange(actual: [number, number] | null | undefined, expected: [number, number], label: string) {
    assert(actual?.[0] === expected[0] && actual[1] === expected[1], `${label} was ${JSON.stringify(actual)}`);
}

async function assertClipboardSelection(host: LaunchedHost, expected: string, label: string) {
    const copied = await host.request<{ ok: boolean; pasteboard?: string }>({
        $cmd: "dispatchAction",
        name: "input::Copy",
    });
    assert(copied.ok, `${label} copy action did not dispatch`);
    assert(copied.pasteboard === expected, `${label} copied ${JSON.stringify(copied.pasteboard)}`);
}

function assertNodeContainsColor(
    image: { width: number; height: number; rgba: Uint8Array },
    node: DumpNode,
    target: { r: number; g: number; b: number },
    label: string,
) {
    const bounds = node.bounds;
    assert(bounds, `${label} node has no bounds`);
    const scaleX = image.width / 780;
    const scaleY = image.height / 520;
    const left = Math.max(0, Math.floor(bounds.x * scaleX));
    const top = Math.max(0, Math.floor(bounds.y * scaleY));
    const right = Math.min(image.width, Math.ceil((bounds.x + bounds.width) * scaleX));
    const bottom = Math.min(image.height, Math.ceil((bounds.y + bounds.height) * scaleY));
    let closePixels = 0;
    let nearest = Number.POSITIVE_INFINITY;
    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
            const offset = (y * image.width + x) * 4;
            const dr = image.rgba[offset] - target.r;
            const dg = image.rgba[offset + 1] - target.g;
            const db = image.rgba[offset + 2] - target.b;
            const distance = Math.sqrt(dr * dr + dg * dg + db * db);
            nearest = Math.min(nearest, distance);
            if (distance <= 64) closePixels += 1;
        }
    }
    assert(closePixels >= 2, `${label} pixels were absent (nearest RGB distance ${nearest.toFixed(1)})`);
}

function summarize(samples: number[]) {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
