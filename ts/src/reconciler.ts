import { createContext } from "react";
import ReactReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";
import { normalizeStyle } from "./StyleSheet";
import type { SerializedAccessibility, SerializedNode } from "./runtime";

// ── ids + instances ─────────────────────────────────────────────────
let nextId = 1;
const genId = () => nextId++;

export interface Instance {
    id: number;
    type: string;
    props: Record<string, unknown>;
    children: Array<Instance | TextInstance>;
    measure: (callback: MeasureCallback) => void;
    measureInWindow: (callback: MeasureInWindowCallback) => void;
    measureLayout: (
        relativeToNativeNode: Instance | number | null,
        onSuccess: (left: number, top: number, width: number, height: number) => void,
        onFail?: () => void,
    ) => void;
}
export interface TextInstance {
    id: number;
    text: string;
}
export interface Container {
    rootID: number;
    width: number;
    height: number;
    children: Array<Instance | TextInstance>;
}

let commit: ((tree: SerializedNode) => void) | null = null;
let currentContainer: Container | null = null;
const hoveredIds = new Set<number>();
const pressedIds = new Set<number>();
const measuredIds = new Set<number>();
const layouts = new Map<number, LayoutRect>();
const instances = new Map<number, Instance>();
const pendingMeasures = new Map<number, Array<() => void>>();
const layoutSignatures = new Map<number, string>();
const PORTAL_HOST_TYPE = "RNTPortalHostView";
const PORTAL_VIEW_TYPE = "RNTPortalView";

type LayoutRect = { x: number; y: number; width: number; height: number };
type MeasureCallback = (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void;
type MeasureInWindowCallback = (x: number, y: number, width: number, height: number) => void;

// ── event registry (id → { event: handler }) ────────────────────────
const PROP_TO_EVENT: Record<string, string> = {
    onClick: "click",
    onMouseDown: "mouseDown",
    onMouseUp: "mouseUp",
    onMouseEnter: "mouseEnter",
    onMouseLeave: "mouseLeave",
    onMouseOver: "mouseOver",
    onMouseOut: "mouseOut",
    onMouseMove: "mouseMove",
    onPointerDown: "pointerDown",
    onPointerUp: "pointerUp",
    onPointerEnter: "pointerEnter",
    onPointerLeave: "pointerLeave",
    onPointerMove: "pointerMove",
    onTouchStart: "touchStart",
    onTouchMove: "touchMove",
    onTouchEnd: "touchEnd",
    onTouchCancel: "touchCancel",
    onStartShouldSetResponder: "startShouldSetResponder",
    onStartShouldSetResponderCapture: "startShouldSetResponderCapture",
    onResponderGrant: "responderGrant",
    onResponderMove: "responderMove",
    onResponderRelease: "responderRelease",
    onResponderStart: "responderStart",
    onResponderEnd: "responderEnd",
    onResponderTerminate: "responderTerminate",
    onResponderTerminationRequest: "responderTerminationRequest",
    onHoverIn: "mouseEnter",
    onHoverOut: "mouseLeave",
    onPress: "press",
    onPressIn: "pressIn",
    onPressOut: "pressOut",
    onLongPress: "longPress",
    onChangeText: "changeText",
    onChange: "change",
    onSubmitEditing: "submit",
    onKeyPress: "keyPress",
    onFocus: "focus",
    onBlur: "blur",
    onLayout: "layout",
    onScroll: "scroll",
    onMessage: "message",
    onLoad: "load",
};
const handlers = new Map<number, Record<string, Function>>();

function chainHandler(first: Function | undefined, next: Function) {
    return first
        ? (...args: unknown[]) => {
              first(...args);
              next(...args);
          }
        : next;
}

function setPseudoState(set: Set<number>, id: number, active: boolean) {
    const changed = active ? !set.has(id) : set.has(id);
    if (!changed) return;
    if (active) set.add(id);
    else set.delete(id);
    requestPseudoCommit();
}

function requestPseudoCommit() {
    if (commit && currentContainer) commit(serializeContainer(currentContainer));
}

function registerHandlers(id: number, props: Record<string, unknown>) {
    const map: Record<string, Function> = {};
    for (const [prop, event] of Object.entries(PROP_TO_EVENT)) {
        const next = props[prop];
        if (typeof next === "function") {
            map[event] = chainHandler(map[event], next);
        }
    }
    if (props.hoverStyle) {
        map.mouseEnter = chainHandler(map.mouseEnter, () => setPseudoState(hoveredIds, id, true));
        map.mouseLeave = chainHandler(map.mouseLeave, () => setPseudoState(hoveredIds, id, false));
    } else {
        hoveredIds.delete(id);
    }
    if (props.pressStyle) {
        map.pressIn = chainHandler(map.pressIn, () => setPseudoState(pressedIds, id, true));
        map.pressOut = chainHandler(map.pressOut, () => setPseudoState(pressedIds, id, false));
        map.responderTerminate = chainHandler(map.responderTerminate, () => setPseudoState(pressedIds, id, false));
        map.mouseLeave = chainHandler(map.mouseLeave, () => setPseudoState(pressedIds, id, false));
    } else {
        pressedIds.delete(id);
    }
    if (Object.keys(map).length) handlers.set(id, map);
    else handlers.delete(id);
}

/** Called by the render layer when the bridge reports a native event. */
export function dispatchEvent(
    id: number,
    event: string,
    payload: {
        value?: string;
        key?: string;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
        pageX?: number;
        pageY?: number;
        locationX?: number;
        locationY?: number;
        scrollX?: number;
        scrollY?: number;
        layout?: unknown;
    },
) {
    if (event === "layout" && payload.layout && typeof payload.layout === "object") {
        const layout = payload.layout as Partial<LayoutRect>;
        if (
            typeof layout.x === "number" &&
            typeof layout.y === "number" &&
            typeof layout.width === "number" &&
            typeof layout.height === "number"
        ) {
            layouts.set(id, { x: layout.x, y: layout.y, width: layout.width, height: layout.height });
            flushPendingMeasures(id);
        }
    }
    const fn = handlers.get(id)?.[event];
    if (!fn) return;
    let result: unknown;
    if (event === "changeText") result = fn(payload.value ?? "");
    else if (event === "change") result = fn(createValueEvent(event, payload.value ?? ""));
    else if (event === "message") result = fn({ nativeEvent: { data: payload.value ?? "" } });
    else if (event === "layout") result = fn({ nativeEvent: { layout: payload.layout } });
    else if (event === "keyPress") result = fn(createKeyPressEvent(payload));
    else if (event === "submit") result = fn(createSubmitEvent(payload.value ?? ""));
    else result = fn(createEvent(event, payload));

    if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch((error) => {
            console.error("[react-native-gpui] unhandled event handler rejection", error);
        });
    }
}

function layoutFor(id: number): LayoutRect {
    return layouts.get(id) ?? { x: 0, y: 0, width: 0, height: 0 };
}

function requestMeasuredLayout(id: number): boolean {
    const hasLayout = layouts.has(id);
    if (!measuredIds.has(id)) {
        measuredIds.add(id);
        requestPseudoCommit();
    } else if (!hasLayout) {
        requestPseudoCommit();
    }
    return hasLayout;
}

function afterMeasuredLayout(id: number, callback: () => void) {
    if (requestMeasuredLayout(id)) {
        callback();
        return;
    }
    const callbacks = pendingMeasures.get(id) ?? [];
    callbacks.push(callback);
    pendingMeasures.set(id, callbacks);
}

function flushPendingMeasures(id: number) {
    const callbacks = pendingMeasures.get(id);
    if (!callbacks?.length) return;
    pendingMeasures.delete(id);
    for (const callback of callbacks) callback();
}

function layoutSignature(type: string, props: Record<string, unknown>): string {
    const style = normalizeStyle(props.style as never) ?? {};
    return JSON.stringify({
        type,
        style,
        numberOfLines: props.numberOfLines,
        multiline: props.multiline,
        source: props.source,
        src: props.src,
        nativeLayoutKey: props.nativeLayoutKey,
        nativeResize: props.nativeResize,
    });
}

function invalidateLayout(node: Instance | TextInstance) {
    if (isTextLike(node)) return;
    layouts.delete(node.id);
    for (const child of node.children) invalidateLayout(child);
}

function cleanupInstance(node: Instance | TextInstance) {
    if (isTextLike(node)) return;
    handlers.delete(node.id);
    hoveredIds.delete(node.id);
    pressedIds.delete(node.id);
    measuredIds.delete(node.id);
    layouts.delete(node.id);
    instances.delete(node.id);
    layoutSignatures.delete(node.id);
    pendingMeasures.delete(node.id);
    for (const child of node.children) cleanupInstance(child);
}

function unwrapRef(node: unknown): unknown {
    if (node && typeof node === "object" && "current" in node) {
        return (node as { current?: unknown }).current;
    }
    return node;
}

function resolveInstance(node: Instance | number | null | undefined): Instance | undefined {
    node = unwrapRef(node) as Instance | number | null | undefined;
    if (typeof node === "number") return instances.get(node);
    if (node && typeof node.id === "number") return node;
    return undefined;
}

export function findHostNodeId(ref: unknown): number | null {
    const node = resolveInstance(ref as Instance | number | null | undefined);
    return node?.id ?? null;
}

export function measureHostNode(
    node: Instance | number | null | undefined,
    callback: MeasureCallback,
) {
    const inst = resolveInstance(node);
    if (!inst) return;
    inst.measure(callback);
}

export function measureHostNodeInWindow(
    node: Instance | number | null | undefined,
    callback: MeasureInWindowCallback,
) {
    const inst = resolveInstance(node);
    if (!inst) return;
    inst.measureInWindow(callback);
}

export function measureHostNodeLayout(
    node: Instance | number | null | undefined,
    relativeToNativeNode: Instance | number | null | undefined,
    onSuccess: (left: number, top: number, width: number, height: number) => void,
    onFail?: () => void,
) {
    const inst = resolveInstance(node);
    if (!inst) {
        onFail?.();
        return;
    }
    inst.measureLayout(relativeToNativeNode ?? null, onSuccess, onFail);
}

function createPublicInstance(type: string, props: Record<string, unknown>): Instance {
    const id = genId();
    const instance: Instance = {
        id,
        type,
        props,
        children: [],
        measure(callback) {
            afterMeasuredLayout(id, () => {
                const layout = layoutFor(id);
                callback(0, 0, layout.width, layout.height, layout.x, layout.y);
            });
        },
        measureInWindow(callback) {
            afterMeasuredLayout(id, () => {
                const layout = layoutFor(id);
                callback(layout.x, layout.y, layout.width, layout.height);
            });
        },
        measureLayout(relativeToNativeNode, onSuccess, onFail) {
            const relativeId =
                typeof relativeToNativeNode === "number"
                    ? relativeToNativeNode
                    : relativeToNativeNode && typeof relativeToNativeNode.id === "number"
                      ? relativeToNativeNode.id
                      : null;
            const run = () => {
                const layout = layoutFor(id);
                const relative = relativeId == null ? { x: 0, y: 0 } : layouts.get(relativeId);
                if (relativeId != null && !relative) {
                    onFail?.();
                    return;
                }
                onSuccess(layout.x - (relative?.x ?? 0), layout.y - (relative?.y ?? 0), layout.width, layout.height);
            };
            afterMeasuredLayout(id, () => {
                if (relativeId == null) {
                    run();
                    return;
                }
                afterMeasuredLayout(relativeId, run);
            });
        },
    };
    instances.set(id, instance);
    layoutSignatures.set(id, layoutSignature(type, props));
    return instance;
}

function createValueEvent(type: string, value: string) {
    return {
        ...createEvent(type, { value }),
        target: { value },
        currentTarget: { value },
        nativeEvent: { text: value, value },
    };
}

function createKeyPressEvent(payload: {
    key?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
}) {
    const event = createEvent("keyPress", payload);
    event.key = payload.key;
    event.shiftKey = !!payload.shiftKey;
    event.ctrlKey = !!payload.ctrlKey;
    event.altKey = !!payload.altKey;
    event.metaKey = !!payload.metaKey;
    event.nativeEvent.key = payload.key;
    event.nativeEvent.shiftKey = !!payload.shiftKey;
    event.nativeEvent.ctrlKey = !!payload.ctrlKey;
    event.nativeEvent.altKey = !!payload.altKey;
    event.nativeEvent.metaKey = !!payload.metaKey;
    return event;
}

function createSubmitEvent(text: string) {
    const event = createEvent("submit", { value: text });
    event.nativeEvent.text = text;
    event.nativeEvent.value = text;
    return event;
}

function createEvent(
    type: string,
    payload: {
        value?: string;
        key?: string;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
        pageX?: number;
        pageY?: number;
        locationX?: number;
        locationY?: number;
        scrollX?: number;
        scrollY?: number;
        layout?: unknown;
    },
) {
    let defaultPrevented = false;
    let propagationStopped = false;
    const eventObject: any = {
        type,
        altKey: !!payload.altKey,
        button: 0,
        buttons: 0,
        cancelable: true,
        ctrlKey: !!payload.ctrlKey,
        currentTarget: {},
        defaultPrevented,
        metaKey: !!payload.metaKey,
        nativeEvent: {
            type,
            value: payload.value,
            key: payload.key,
            shiftKey: !!payload.shiftKey,
            ctrlKey: !!payload.ctrlKey,
            altKey: !!payload.altKey,
            metaKey: !!payload.metaKey,
            layout: payload.layout,
            locationX: payload.locationX ?? 0,
            locationY: payload.locationY ?? 0,
            pageX: payload.pageX ?? 0,
            pageY: payload.pageY ?? 0,
            contentOffset: {
                x: payload.scrollX ?? 0,
                y: payload.scrollY ?? 0,
            },
        },
        locationX: payload.locationX ?? 0,
        locationY: payload.locationY ?? 0,
        pageX: payload.pageX ?? 0,
        pageY: payload.pageY ?? 0,
        shiftKey: !!payload.shiftKey,
        target: {},
        timeStamp: Date.now(),
        preventDefault() {
            defaultPrevented = true;
            eventObject.defaultPrevented = true;
        },
        stopPropagation() {
            propagationStopped = true;
        },
        isDefaultPrevented() {
            return defaultPrevented;
        },
        isPropagationStopped() {
            return propagationStopped;
        },
    };
    return eventObject;
}

// ── host type → bridge node ─────────────────────────────────────────
function isTextLike(x: Instance | TextInstance): x is TextInstance {
    return "text" in x && typeof (x as TextInstance).text === "string";
}

function gatherText(inst: Instance): string {
    let out = "";
    for (const c of inst.children) {
        if (isTextLike(c)) out += c.text;
        else if (c.type === "Text") out += gatherText(c);
    }
    if (out === "" && typeof inst.props.children === "string") out = inst.props.children as string;
    if (out === "" && typeof inst.props.children === "number") out = String(inst.props.children);
    return out;
}

function stringProp(props: Record<string, unknown>, ...names: string[]): string | undefined {
    for (const name of names) {
        const value = props[name];
        if (typeof value === "string" && value.length > 0) return value;
        if (typeof value === "number") return String(value);
    }
    return undefined;
}

function boolProp(props: Record<string, unknown>, ...names: string[]): boolean | undefined {
    for (const name of names) {
        const value = props[name];
        if (typeof value === "boolean") return value;
    }
    return undefined;
}

function accessibilityValueText(value: unknown): string | undefined {
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (!value || typeof value !== "object") return undefined;
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string" || typeof text === "number") return String(text);
    const now = (value as { now?: unknown }).now;
    if (typeof now === "string" || typeof now === "number") return String(now);
    return undefined;
}

function serializeAccessibility(inst: Instance, node: SerializedNode): SerializedAccessibility | undefined {
    const props = inst.props;
    const state = (props.accessibilityState && typeof props.accessibilityState === "object"
        ? props.accessibilityState
        : {}) as Record<string, unknown>;
    const important = props.importantForAccessibility;
    const hidden =
        boolProp(props, "accessibilityElementsHidden", "aria-hidden") ??
        (important === "no-hide-descendants" ? true : undefined);

    const info: SerializedAccessibility = {
        accessible:
            boolProp(props, "accessible") ??
            (important === "no" ? false : important === "yes" ? true : undefined),
        hidden,
        label: stringProp(props, "accessibilityLabel", "aria-label"),
        role: stringProp(props, "accessibilityRole", "role"),
        hint: stringProp(props, "accessibilityHint", "aria-description"),
        value: accessibilityValueText(props.accessibilityValue),
        identifier: stringProp(props, "nativeID", "testID", "id"),
        disabled: boolProp(state, "disabled"),
        selected: boolProp(state, "selected"),
        checked: typeof state.checked === "boolean" || state.checked === "mixed" ? state.checked : undefined,
        expanded: boolProp(state, "expanded"),
    };

    if (!info.label && node.type === "text" && node.text) info.label = node.text;
    if (!info.value && (node.type === "textinput" || node.type === "textarea") && node.value) info.value = node.value;
    if (!info.label && (node.type === "textinput" || node.type === "textarea") && node.placeholder) {
        info.label = node.placeholder;
    }
    if (!info.label && (info.accessible || info.role || info.identifier || handlers.has(inst.id))) {
        const text = gatherText(inst).trim();
        if (text) info.label = text;
    }

    return Object.values(info).some((value) => value !== undefined) ? info : undefined;
}

type SerRun = { text: string; fontWeight?: string; color?: string; fontStyle?: string };

// Walk a <Text> tree into flowing styled runs, so a nested <Text bold> inside a
// paragraph keeps its weight/color instead of being flattened to the parent's.
function gatherRuns(inst: Instance, inherited: Omit<SerRun, "text">): SerRun[] {
    const own = (normalizeStyle(inst.props.style as never) ?? {}) as Record<string, unknown>;
    const cur: Omit<SerRun, "text"> = {
        fontWeight: (own.fontWeight as string) ?? inherited.fontWeight,
        color: (own.color as string) ?? inherited.color,
        fontStyle: (own.fontStyle as string) ?? inherited.fontStyle,
    };
    const runs: SerRun[] = [];
    for (const c of inst.children) {
        if (isTextLike(c)) {
            if (c.text) runs.push({ text: c.text, ...cur });
        } else if (c.type === "Text") {
            runs.push(...gatherRuns(c, cur));
        }
    }
    if (runs.length === 0) {
        const ch = inst.props.children;
        if (typeof ch === "string" || typeof ch === "number") runs.push({ text: String(ch), ...cur });
    }
    return runs;
}

type PortalContext = {
    byHost: Map<string, Instance[]>;
    usedHosts: Set<string>;
};

function portalHostName(props: Record<string, unknown>): string {
    return stringProp(props, "hostName", "name") ?? "root";
}

function collectPortals(node: Instance | TextInstance, byHost: Map<string, Instance[]>) {
    if (isTextLike(node)) return;
    if (node.type === PORTAL_VIEW_TYPE) {
        const hostName = portalHostName(node.props);
        const entries = byHost.get(hostName);
        if (entries) entries.push(node);
        else byHost.set(hostName, [node]);
    }
    for (const child of node.children) collectPortals(child, byHost);
}

function serializeChildren(children: Array<Instance | TextInstance>, context: PortalContext): SerializedNode[] {
    const out: SerializedNode[] = [];
    for (const child of children) {
        const next = serialize(child, context);
        if (next) out.push(next);
    }
    return out;
}

function serializePortalEntry(inst: Instance, context: PortalContext): SerializedNode[] {
    const style = (normalizeStyle(inst.props.style as never) ?? {}) as Record<string, unknown>;
    const children = serializeChildren(inst.children, context);
    if (Object.keys(style).length === 0) return children;
    return [
        {
            globalId: inst.id,
            type: "div",
            style,
            children,
        },
    ];
}

function serialize(inst: Instance | TextInstance, context: PortalContext): SerializedNode | null {
    if (isTextLike(inst)) return { globalId: inst.id, type: "text", text: inst.text };
    if (inst.type === PORTAL_VIEW_TYPE) return null;

    const props = inst.props;
    const baseStyle = (normalizeStyle(props.style as never) ?? {}) as Record<string, unknown>;
    const hoverStyle =
        props.hoverStyle && hoveredIds.has(inst.id)
            ? ((normalizeStyle(props.hoverStyle as never) ?? {}) as Record<string, unknown>)
            : undefined;
    const pressStyle =
        props.pressStyle && pressedIds.has(inst.id)
            ? ((normalizeStyle(props.pressStyle as never) ?? {}) as Record<string, unknown>)
            : undefined;
    const style = { ...baseStyle, ...hoverStyle, ...pressStyle };
    const node: SerializedNode = { globalId: inst.id, type: "div" };

    switch (inst.type) {
        case "Text": {
            node.type = "text";
            const runs = gatherRuns(inst, {
                fontWeight: style.fontWeight as string | undefined,
                color: style.color as string | undefined,
                fontStyle: style.fontStyle as string | undefined,
            });
            node.text = runs.map((r) => r.text).join("");
            if (typeof props.numberOfLines === "number" && props.numberOfLines > 0) {
                node.numberOfLines = Math.floor(props.numberOfLines);
            }
            // emit runs only when there's >1 segment (inline style changes)
            if (runs.length > 1) node.runs = runs;
            break;
        }
        case "TextInput":
            node.type = props.multiline ? "textarea" : "textinput";
            node.placeholder = (props.placeholder as string) ?? "";
            if (props.editable === false) node.editable = false;
            if (props.secureTextEntry === true) node.secureTextEntry = true;
            if (props.value != null) node.value = String(props.value);
            else if (props.defaultValue != null) node.value = String(props.defaultValue);
            break;
        case "Image":
            node.type = "image";
            node.src = imageSource(props.source) ?? (props.src as string);
            break;
        case "Svg":
            node.type = "svg";
            node.name = props.name as string;
            break;
        case "WebView": {
            node.type = "webview";
            const src = props.source as { uri?: string; html?: string } | undefined;
            if (src?.uri) node.src = src.uri;
            if (src?.html) node.text = src.html;
            break;
        }
        case "ScrollView":
            node.type = "div";
            if (style.overflow === undefined) style.overflow = "scroll";
            break;
        case PORTAL_HOST_TYPE:
            node.type = "div";
            break;
        default:
            node.type = "div";
    }

    if (Object.keys(style).length) node.style = style;
    const nativeLayoutKey = stringProp(props, "nativeLayoutKey");
    if (nativeLayoutKey) node.nativeLayoutKey = nativeLayoutKey;
    const nativeResize = normalizeNativeResize(props.nativeResize);
    if (nativeResize) node.nativeResize = nativeResize;
    const evts = handlers.get(inst.id);
    const eventNames = evts ? Object.keys(evts) : [];
    if (measuredIds.has(inst.id) && !eventNames.includes("layout")) eventNames.push("layout");
    if (eventNames.length) node.events = eventNames;
    const accessibility = serializeAccessibility(inst, node);
    if (accessibility) node.accessibility = accessibility;

    if (node.type === "div" || node.type === "svg" /* svg has no children but harmless */) {
        const kids = serializeChildren(inst.children, context);
        if (inst.type === PORTAL_HOST_TYPE) {
            const hostName = portalHostName(props);
            if (!context.usedHosts.has(hostName)) {
                context.usedHosts.add(hostName);
                const portalEntries = context.byHost.get(hostName) ?? [];
                for (const entry of portalEntries) {
                    kids.push(...serializePortalEntry(entry, context));
                }
            }
        }
        if (kids.length) node.children = kids;
    }
    return node;
}

function normalizeNativeResize(value: unknown): SerializedNode["nativeResize"] | undefined {
    if (!value || typeof value !== "object") return undefined;
    const spec = value as Record<string, unknown>;
    const target = spec.target;
    const edge = spec.edge;
    if (typeof target !== "string" || target.length === 0) return undefined;
    if (edge !== "left" && edge !== "right" && edge !== "top" && edge !== "bottom") return undefined;
    const out: NonNullable<SerializedNode["nativeResize"]> = { target, edge };
    if (typeof spec.min === "number") out.min = spec.min;
    if (typeof spec.max === "number") out.max = spec.max;
    return out;
}

function imageSource(source: unknown): string | undefined {
    if (typeof source === "string") return source;
    if (source && typeof source === "object" && "uri" in source) return (source as { uri: string }).uri;
    return undefined;
}

export function serializeContainer(c: Container): SerializedNode {
    currentContainer = c;
    const byHost = new Map<string, Instance[]>();
    for (const child of c.children) collectPortals(child, byHost);
    const context: PortalContext = { byHost, usedHosts: new Set() };
    // id 0 is reserved for the window root, so it never collides with element ids
    // (genId starts at 1) — keeps scroll/input/webview maps keyed cleanly.
    return {
        globalId: 0,
        type: "div",
        style: { width: c.width, height: c.height, flexDirection: "column" },
        children: serializeChildren(c.children, context),
    };
}

export function setCommitSink(fn: (tree: SerializedNode) => void) {
    commit = fn;
}

// ── host config ─────────────────────────────────────────────────────
const hostConfig: any = {
    supportsMutation: true,
    supportsPersistence: false,
    isPrimaryRenderer: true,
    noTimeout: -1,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    now: () => performance.now(),
    supportsMicrotasks: true,
    scheduleMicrotask: queueMicrotask,

    createInstance(type: string, props: Record<string, unknown>): Instance {
        const inst = createPublicInstance(type, props);
        registerHandlers(inst.id, props);
        return inst;
    },
    createTextInstance(text: string): TextInstance {
        return { id: genId(), text };
    },
    appendInitialChild(parent: Instance, child: Instance | TextInstance) {
        parent.children.push(child);
        invalidateLayout(parent);
    },
    appendChild(parent: Instance, child: Instance | TextInstance) {
        parent.children.push(child);
        invalidateLayout(parent);
    },
    appendChildToContainer(container: Container, child: Instance | TextInstance) {
        container.children.push(child);
    },
    removeChild(parent: Instance, child: Instance | TextInstance) {
        const i = parent.children.indexOf(child);
        if (i !== -1) {
            parent.children.splice(i, 1);
            invalidateLayout(parent);
            cleanupInstance(child);
        }
    },
    removeChildFromContainer(container: Container, child: Instance | TextInstance) {
        const i = container.children.indexOf(child);
        if (i !== -1) {
            container.children.splice(i, 1);
            cleanupInstance(child);
        }
    },
    insertBefore(parent: Instance, child: Instance | TextInstance, before: Instance | TextInstance) {
        const i = parent.children.indexOf(before);
        parent.children.splice(i === -1 ? parent.children.length : i, 0, child);
        invalidateLayout(parent);
    },
    insertInContainerBefore(container: Container, child: Instance | TextInstance, before: Instance | TextInstance) {
        const i = container.children.indexOf(before);
        container.children.splice(i === -1 ? container.children.length : i, 0, child);
    },
    // react-reconciler 0.31 signature: (instance, type, prevProps, nextProps, handle)
    commitUpdate(instance: Instance, _type: string, _prevProps: unknown, nextProps: Record<string, unknown>) {
        const nextSignature = layoutSignature(instance.type, nextProps);
        if (layoutSignatures.get(instance.id) !== nextSignature) {
            layoutSignatures.set(instance.id, nextSignature);
            invalidateLayout(instance);
        }
        instance.props = nextProps;
        registerHandlers(instance.id, nextProps);
    },
    commitTextUpdate(textInstance: TextInstance, _old: string, next: string) {
        textInstance.text = next;
    },
    finalizeInitialChildren: () => false,
    shouldSetTextContent: (type: string, props: Record<string, unknown>) =>
        type === "Text" && (typeof props.children === "string" || typeof props.children === "number"),
    getPublicInstance: (i: Instance) => i,
    getRootHostContext: () => ({}),
    getChildHostContext: () => ({}),
    prepareForCommit: () => null,
    resetAfterCommit(container: Container) {
        if (commit) commit(serializeContainer(container));
    },
    preparePortalMount: () => {},
    clearContainer(container: Container) {
        for (const child of container.children) cleanupInstance(child);
        container.children = [];
    },
    detachDeletedInstance(inst: Instance) {
        cleanupInstance(inst);
    },
    getInstanceFromNode: () => null,
    beforeActiveInstanceBlur: () => {},
    afterActiveInstanceBlur: () => {},
    prepareScopeUpdate: () => {},
    getInstanceFromScope: () => null,
    shouldYield: () => false,

    // ── event priority (required by react-reconciler 0.31) ──────────
    setCurrentUpdatePriority(priority: number) {
        currentUpdatePriority = priority;
    },
    getCurrentUpdatePriority() {
        return currentUpdatePriority;
    },
    resolveUpdatePriority() {
        return currentUpdatePriority !== NoEventPriority ? currentUpdatePriority : DefaultEventPriority;
    },
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1.1,
    shouldAttemptEagerTransition: () => false,
    requestPostPaintCallback: () => {},
    trackSchedulerEvent: () => {},

    // ── suspense / transitions (no-op for this renderer) ────────────
    maySuspendCommit: () => false,
    startSuspendingCommit: () => {},
    suspendInstance: () => {},
    waitForCommitToBeReady: () => null,
    NotPendingTransition: null,
    HostTransitionContext: createContext(null),
    resetFormInstance: () => {},
};

let currentUpdatePriority: number = NoEventPriority;

const Reconciler = ReactReconciler(hostConfig);
export default Reconciler;
