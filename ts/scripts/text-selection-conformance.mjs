// Conformance gate for the <Text selectable> drag selection.
//
// The engine had no coverage for this at all, and Team Machine now marks ~36 desktop
// text sites selectable (692c63172), several of them the nested-run shape where only the
// OUTER Text carries the prop. That shape is only sound because the reconciler flattens
// nested Text into the parent's string and layout, so a reading of the source says it is
// fine. This gate is what makes it a measurement: a real platform drag across each of
// three sites, read back through the engine's own selection registry.
//
// The negative control is what keeps it honest. A drag across `sel-none` (a Text with no
// `selectable`) has to select NOTHING: without it, a selection readout that leaked text
// from a neighbouring node would satisfy the positive assertions.
//
// Selection state lives in a main-thread thread_local, so the readout is a `selectedText`
// control command answered on the main loop rather than from the socket thread.
import { existsSync } from "node:fs";
import { launchHost } from "../cli/host.ts";
import { sleep } from "./conformance-utils.mjs";

const service =
    process.env.RNGPUI_SERVICE ?? new URL("../../rust/target/release/rngpui-service", import.meta.url).pathname;
const previousService = process.env.RNGPUI_SERVICE;
process.env.RNGPUI_SERVICE = service;

const flatten = (node, out = []) => {
    out.push(node);
    for (const child of node.children ?? []) flatten(child, out);
    return out;
};

const selectedText = async (host) => {
    const reply = await host.request({ $cmd: "selectedText" });
    if (!reply.ok) throw new Error(`selectedText refused: ${JSON.stringify(reply)}`);
    return reply.text;
};

// A drag from the left edge of a word to its right edge, INSIDE one line: the selection
// anchors where the press lands and stretches to the release, so a horizontal drag over
// a single text site selects a prefix of that site and never a neighbour.
const dragAcross = async (host, box, from, to) => {
    await host.request({
        $cmd: "realdragpath",
        points: [
            { x: box.x + box.width * from, y: box.y + box.height / 2 },
            { x: box.x + box.width * ((from + to) / 2), y: box.y + box.height / 2 },
            { x: box.x + box.width * to, y: box.y + box.height / 2 },
        ],
    });
    return sleep(60);
};

let host;
try {
    if (!existsSync(service)) throw new Error(`rngpui-service not found: ${service}`);
    host = await launchHost(new URL("../examples/selection-conformance.tsx", import.meta.url).pathname, {
        size: "700x400",
    });
    const tree = await host.dump();
    const bounds = (id) => {
        const node = flatten(tree).find((entry) => entry.accessibility?.testID === id);
        if (!node?.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) {
            throw new Error(`${id} has no measured bounds`);
        }
        return node.bounds;
    };

    // The three sites have to exist before any drag can mean anything, and they have to be
    // distinct rows: a fixture whose rows collapsed onto each other would let one drag
    // cover two sites and the per-site assertions below would stop discriminating.
    const plain = bounds("sel-plain");
    const nested = bounds("sel-nested");
    const none = bounds("sel-none");
    if (!(plain.y < nested.y && nested.y < none.y)) {
        throw new Error(`the three text sites are not three separate rows: ${JSON.stringify({ plain, nested, none })}`);
    }

    // The press lands mid-row, so the selection starts partway through the first word.
    // Each case is therefore identified by a token that only that row's text contains and
    // that sits after the press point: "three" for the plain row, "six" for the nested
    // run (the outer's own text is just "betalead: ", so "six" can only come from the
    // nested run's glyphs), and any text at all for the negative control.
    const dismiss = async () => {
        // `realtap`, not `tap`: dismissal is the capture-phase mousedown in
        // wire_native_selection, and the synthetic `tap` invokes handlers straight off the
        // tree without going through gpui's event loop, so the clear never runs.
        await host.request({ $cmd: "realtap", x: 4, y: 4 });
        await sleep(60);
        const leftover = await selectedText(host);
        if (leftover) throw new Error(`a press did not dismiss the previous selection: ${JSON.stringify(leftover)}`);
    };

    await dragAcross(host, plain, 0.02, 0.5);
    const plainText = await selectedText(host);
    if (!plainText || !plainText.includes("three")) {
        throw new Error(`a drag across the plain selectable Text selected ${JSON.stringify(plainText)}`);
    }
    await dismiss();

    await dragAcross(host, nested, 0.02, 0.9);
    const nestedText = await selectedText(host);
    if (!nestedText || !nestedText.includes("six")) {
        throw new Error(
            `a drag across a selectable Text whose text lives in a nested Text selected ` +
                `${JSON.stringify(nestedText)}; the parent's hitbox and per-character test must cover the ` +
                `nested run's glyphs`,
        );
    }
    if (nestedText.includes("three") || nestedText.includes("nine")) {
        throw new Error(`the nested drag also picked up a neighbouring row: ${JSON.stringify(nestedText)}`);
    }
    await dismiss();

    await dragAcross(host, none, 0.02, 0.9);
    const noneText = await selectedText(host);
    if (noneText) {
        throw new Error(`a drag across a Text with no \`selectable\` selected ${JSON.stringify(noneText)}`);
    }

    console.log(
        `TEXT_SELECTION_CONFORMANCE PASS plain=${JSON.stringify(plainText)} nested=${JSON.stringify(nestedText)} ` +
            `unselectable=${JSON.stringify(noneText)}`,
    );
} catch (error) {
    console.error(
        `TEXT_SELECTION_CONFORMANCE FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
} finally {
    host?.close();
    if (previousService === undefined) delete process.env.RNGPUI_SERVICE;
    else process.env.RNGPUI_SERVICE = previousService;
}
