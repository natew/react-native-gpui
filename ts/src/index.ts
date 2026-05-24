/**
 * react-native-gpui
 *
 * Public API: createRoot, View, Text, StyleSheet
 */

import { launchWindow, ElementNode } from "./runtime";
import type { RNStyle } from "./style";
export type { RNStyle } from "./style";
export { StyleSheet } from "./style";
export type { ViewProps, TextProps } from "./style";

// ── React element types ─────────────────────────────────────────────

export type ViewProps = {
    style?: RNStyle | RNStyle[];
    children?: React.ReactNode;
};

export type TextProps = {
    style?: RNStyle | RNStyle[];
    children?: React.ReactNode;
};

// ── createRoot ──────────────────────────────────────────────────────

let gid = 1;
function nextId(): number {
    return gid++;
}

function buildNode(type: string, props: Record<string, unknown>, children: (ElementNode | string)[]): ElementNode {
    const node: ElementNode = {
        globalId: nextId(),
        type: type === "Text" ? "text" : "div",
    };

    // Extract style
    const style = props.style as RNStyle | undefined;

    // Build JSON-friendly style
    const jsonStyle: Record<string, unknown> = {};
    if (style) {
        const s = Array.isArray(style) ? Object.assign({}, ...style) : style;
        for (const key of Object.keys(s) as (keyof RNStyle)[]) {
            const val = s[key];
            if (val !== undefined) {
                jsonStyle[key] = val;
            }
        }
    }
    if (Object.keys(jsonStyle).length > 0) {
        node.style = jsonStyle;
    }

    // Handle children
    const nodeChildren: ElementNode[] = [];
    for (const child of children) {
        if (typeof child === "string") {
            nodeChildren.push({ globalId: nextId(), type: "text", text: child });
        } else {
            nodeChildren.push(child);
        }
    }
    if (nodeChildren.length > 0) {
        node.children = nodeChildren;
    }

    return node;
}

/**
 * Render tree via JSX elements produced by createElement.
 */
function renderElement(element: Record<string, unknown>): ElementNode {
    const type = element.type as string;
    // It's a function/class component — call it to get children
    if (typeof element.type === "function") {
        const Component = element.type as (props: Record<string, unknown>) => Record<string, unknown>;
        const compResult = Component(element.props as Record<string, unknown> ?? {});
        return renderElement(compResult);
    }
    // Host element — "View" or "Text"
    const props = element.props as Record<string, unknown> ?? {};
    const children = element.props
        ? ((element.props as Record<string, unknown>).children as (Record<string, unknown> | string)[]) ?? []
        : [];
    const renderedChildren: (ElementNode | string)[] = [];
    for (const child of children) {
        if (typeof child === "string" || typeof child === "number") {
            renderedChildren.push(String(child));
        } else if (child && typeof child === "object") {
            renderedChildren.push(renderElement(child as Record<string, unknown>));
        }
    }
    return buildNode(type, props, renderedChildren);
}

/**
 * Create a GPUI window root that renders React components.
 */
export function createRoot() {
    return {
        async render(element: Record<string, unknown>): Promise<{ close: () => void }> {
            gid = 1;
            const root = renderElement(element);
            return launchWindow(root, { width: 720, height: 800 });
        },
    };
}
