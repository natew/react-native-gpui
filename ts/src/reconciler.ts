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
        layout?: unknown;
    },
) {
    const fn = handlers.get(id)?.[event];
    if (!fn) return;
    let result: unknown;
    if (event === "changeText") result = fn(payload.value ?? "");
    else if (event === "change") result = fn(createValueEvent(event, payload.value ?? ""));
    else if (event === "message") result = fn({ nativeEvent: { data: payload.value ?? "" } });
    else if (event === "layout") result = fn({ nativeEvent: { layout: payload.layout } });
    else if (event === "keyPress") result = fn(createKeyPressEvent(payload));
    else result = fn(createEvent(event, payload));

    if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch((error) => {
            console.error("[react-native-gpui] unhandled event handler rejection", error);
        });
    }
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

function serialize(inst: Instance | TextInstance): SerializedNode {
    if (isTextLike(inst)) return { globalId: inst.id, type: "text", text: inst.text };

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
        default:
            node.type = "div";
    }

    if (Object.keys(style).length) node.style = style;
    const evts = handlers.get(inst.id);
    if (evts) node.events = Object.keys(evts);
    const accessibility = serializeAccessibility(inst, node);
    if (accessibility) node.accessibility = accessibility;

    if (node.type === "div" || node.type === "svg" /* svg has no children but harmless */) {
        const kids: SerializedNode[] = [];
        for (const c of inst.children) kids.push(serialize(c));
        if (kids.length) node.children = kids;
    }
    return node;
}

function imageSource(source: unknown): string | undefined {
    if (typeof source === "string") return source;
    if (source && typeof source === "object" && "uri" in source) return (source as { uri: string }).uri;
    return undefined;
}

export function serializeContainer(c: Container): SerializedNode {
    currentContainer = c;
    // id 0 is reserved for the window root, so it never collides with element ids
    // (genId starts at 1) — keeps scroll/input/webview maps keyed cleanly.
    return {
        globalId: 0,
        type: "div",
        style: { width: c.width, height: c.height, flexDirection: "column" },
        children: c.children.map(serialize),
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
        const inst: Instance = { id: genId(), type, props, children: [] };
        registerHandlers(inst.id, props);
        return inst;
    },
    createTextInstance(text: string): TextInstance {
        return { id: genId(), text };
    },
    appendInitialChild(parent: Instance, child: Instance | TextInstance) {
        parent.children.push(child);
    },
    appendChild(parent: Instance, child: Instance | TextInstance) {
        parent.children.push(child);
    },
    appendChildToContainer(container: Container, child: Instance | TextInstance) {
        container.children.push(child);
    },
    removeChild(parent: Instance, child: Instance | TextInstance) {
        const i = parent.children.indexOf(child);
        if (i !== -1) parent.children.splice(i, 1);
    },
    removeChildFromContainer(container: Container, child: Instance | TextInstance) {
        const i = container.children.indexOf(child);
        if (i !== -1) container.children.splice(i, 1);
    },
    insertBefore(parent: Instance, child: Instance | TextInstance, before: Instance | TextInstance) {
        const i = parent.children.indexOf(before);
        parent.children.splice(i === -1 ? parent.children.length : i, 0, child);
    },
    insertInContainerBefore(container: Container, child: Instance | TextInstance, before: Instance | TextInstance) {
        const i = container.children.indexOf(before);
        container.children.splice(i === -1 ? container.children.length : i, 0, child);
    },
    // react-reconciler 0.31 signature: (instance, type, prevProps, nextProps, handle)
    commitUpdate(instance: Instance, _type: string, _prevProps: unknown, nextProps: Record<string, unknown>) {
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
        container.children = [];
    },
    detachDeletedInstance(inst: Instance) {
        if (inst && inst.id != null) handlers.delete(inst.id);
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
