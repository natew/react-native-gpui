#!/usr/bin/env bun
/**
 * react-native-gpui demo via createRoot API.
 *
 * Builds the element tree using createRoot/view/text helpers (no JSX).
 */

import { createRoot } from "./index";
import { launchWindow, ElementNode } from "./runtime";

// ── Helpers ─────────────────────────────────────────────────────────

let gid = 1;
function nextId(): number {
    return gid++;
}

function box(color: string, size: number, label: string): ElementNode {
    return {
        globalId: nextId(),
        type: "div",
        style: { width: size, height: size, backgroundColor: color, justifyContent: "center", alignItems: "center", borderRadius: 4 },
        children: [
            { globalId: nextId(), type: "text", text: label, style: { color: "#ffffff", fontSize: 11 } },
        ],
    };
}

function text(text: string, style?: Record<string, unknown>): ElementNode {
    return { globalId: nextId(), type: "text", text, style };
}

function div(style: Record<string, unknown>, children: ElementNode[]): ElementNode {
    return { globalId: nextId(), type: "div", style, children };
}

// ── Build the full demo tree ────────────────────────────────────────

function buildDemoTree(): ElementNode {
    gid = 1;

    return div(
        {
            width: 700,
            flexDirection: "column",
            backgroundColor: "#1e1e2e",
            gap: 10,
            padding: 16,
        },
        [
            // Header
            text("React Native GPUI", { color: "#00d9ff", fontSize: 28 }),
            text("Kitchen Sink :: createRoot API", { color: "#888888", fontSize: 13 }),

            // Flexbox demo
            text("Flexbox Row", { color: "#cccccc", fontSize: 15 }),
            div(
                { flexDirection: "row", gap: 8, padding: 8, backgroundColor: "#1a1a2e", borderRadius: 8 },
                [
                    box("#e74c3c", 50, "R"),
                    box("#2ecc71", 50, "G"),
                    box("#3498db", 50, "B"),
                    box("#f39c12", 50, "Y"),
                    box("#9b59b6", 50, "P"),
                ]
            ),

            // Flexbox column
            text("Flexbox Column", { color: "#cccccc", fontSize: 15 }),
            div(
                { flexDirection: "column", gap: 4, padding: 8, backgroundColor: "#0f3460", borderRadius: 8 },
                [
                    box("#e74c3c", 30, "1"),
                    box("#2ecc71", 30, "2"),
                    box("#3498db", 30, "3"),
                ]
            ),

            // Borders & Radius
            text("Borders & Radius", { color: "#cccccc", fontSize: 15 }),
            div(
                { flexDirection: "row", gap: 12 },
                [
                    div({ width: 50, height: 50, backgroundColor: "#34495e", borderRadius: 8 }, []),
                    div({ width: 50, height: 50, backgroundColor: "#e67e22", borderRadius: 25 }, []),
                    div({ width: 50, height: 50, backgroundColor: "#1abc9c", borderWidth: 3, borderColor: "#ffffff", borderRadius: 4 }, []),
                ]
            ),

            // Color swatches
            text("Color Swatches", { color: "#cccccc", fontSize: 15 }),
            div(
                { flexDirection: "row", gap: 6, padding: 8, backgroundColor: "#16213e", borderRadius: 8 },
                [
                    box("#e74c3c", 40, "1"),
                    box("#2ecc71", 40, "2"),
                    box("#3498db", 40, "3"),
                    box("#f39c12", 40, "4"),
                    box("#9b59b6", 40, "5"),
                    box("#1abc9c", 40, "6"),
                    box("#e67e22", 40, "7"),
                    box("#00d9ff", 40, "8"),
                ]
            ),

            // Text samples
            text("Text Sizes", { color: "#cccccc", fontSize: 15 }),
            text("Small (12px)", { color: "#aaaaaa", fontSize: 12 }),
            text("Large Gold (24px)", { color: "#f1c40f", fontSize: 24 }),
            text("Cyan Text", { color: "#00d9ff", fontSize: 18 }),

            // Footer
            div({ padding: 8 }, [
                text("~ react-native-gpui v0.1 ~", { color: "#555555", fontSize: 11 }),
            ]),
        ]
    );
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log("Building element tree...");
    const tree = buildDemoTree();
    console.log("Launching GPUI window...");
    const { onEvent, close } = await launchWindow(tree, { width: 720, height: 800 });

    onEvent((evt) => {
        console.log("[event]", evt);
    });

    process.on("SIGINT", () => {
        close();
        process.exit(0);
    });

    // Keep alive
    setInterval(() => {}, 10000);
}

main().catch((err) => {
    console.error("demo failed:", err);
    process.exit(1);
});
