#!/usr/bin/env bun

const {
    firstKeyboardNavigationTarget,
    hasKeyboardNavigationModifier,
    nextKeyboardNavigationTarget,
    nextSequentialKeyboardNavigationTarget,
} = await import("../src/keyboard.tsx");

let failed = false;
function check(name, ok, detail = "") {
    console.log(`UNIT_${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
    if (!ok) failed = true;
}

const rect = (x, y, width = 100, height = 30) => ({ x, y, width, height });
const options = { groupOrder: ["trees", "stage", "files"], verticalScope: "group" };
const targets = [
    { id: "left-a", group: "trees", rect: rect(10, 80) },
    { id: "left-b", group: "trees", rect: rect(10, 120) },
    { id: "stage-tab", group: "stage", rect: rect(220, 8) },
    { id: "stage-body", group: "stage", rect: rect(220, 92, 400, 400) },
    { id: "composer", group: "stage", rect: rect(220, 540, 400, 44) },
    { id: "right-tab", group: "files", rect: rect(700, 8) },
    { id: "right-disabled", group: "files", rect: rect(700, 50), disabled: true },
    { id: "right-file", group: "files", rect: rect(700, 90) },
];

check("first target follows group order", firstKeyboardNavigationTarget(targets, options) === "left-a");
check(
    "sequential skips disabled and wraps",
    nextSequentialKeyboardNavigationTarget(targets, "right-tab", 1, options) === "right-file" &&
        nextSequentialKeyboardNavigationTarget(targets, "right-file", 1, options) === "left-a",
);
check(
    "vertical group scope stays in group",
    nextKeyboardNavigationTarget(targets, "stage-tab", "down", options) === "stage-body" &&
        nextKeyboardNavigationTarget(targets, "stage-tab", "up", options) === "stage-tab",
);
check(
    "horizontal crosses groups by geometry",
    nextKeyboardNavigationTarget(targets, "stage-body", "right", options) === "right-file" &&
        nextKeyboardNavigationTarget(targets, "right-file", "left", options) === "stage-body",
);
check(
    "missing current never auto jumps",
    nextKeyboardNavigationTarget(targets, "missing", "down", options) === "",
);

const flowOptions = { groupOrder: ["blocks", "dock"], verticalScope: "all" };
const flowTargets = [
    { id: "block-a", group: "blocks", rect: rect(120, 80, 160, 100) },
    { id: "block-b", group: "blocks", rect: rect(320, 80, 160, 100) },
    { id: "dock-a", group: "dock", rect: rect(120, 400, 160, 48) },
];
check(
    "flow-style vertical can move between groups",
    nextKeyboardNavigationTarget(flowTargets, "dock-a", "up", flowOptions) === "block-a",
);
check(
    "flow-style horizontal moves between blocks",
    nextKeyboardNavigationTarget(flowTargets, "block-a", "right", flowOptions) === "block-b",
);
check(
    "modifier helper preserves shift-tab only",
    hasKeyboardNavigationModifier({ nativeEvent: { key: "ArrowRight", shiftKey: true } }) &&
        hasKeyboardNavigationModifier({ key: "ArrowRight", ctrlKey: true }) &&
        hasKeyboardNavigationModifier({ key: "ArrowRight", altKey: true }) &&
        hasKeyboardNavigationModifier({ key: "ArrowRight", metaKey: true }) &&
        !hasKeyboardNavigationModifier({ key: "Tab", shiftKey: true }, { allowShift: true }) &&
        !hasKeyboardNavigationModifier({ key: "ArrowRight" }),
);

console.log(failed ? "KEYBOARD_NAVIGATION_UNIT_FAIL" : "KEYBOARD_NAVIGATION_UNIT_OK");
process.exit(failed ? 1 : 0);
