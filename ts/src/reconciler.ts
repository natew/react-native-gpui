import { createContext } from "react";
import ReactReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";
import { normalizeStyle } from "./StyleSheet";
import type { SerializedNode } from "./runtime";

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

// ── event registry (id → { event: handler }) ────────────────────────
const PROP_TO_EVENT: Record<string, string> = {
    onPress: "press",
    onPressIn: "pressIn",
    onPressOut: "pressOut",
    onLongPress: "longPress",
    onChangeText: "changeText",
    onChange: "change",
    onSubmitEditing: "submit",
    onFocus: "focus",
    onBlur: "blur",
    onLayout: "layout",
    onScroll: "scroll",
};
const handlers = new Map<number, Record<string, Function>>();

function registerHandlers(id: number, props: Record<string, unknown>) {
    const map: Record<string, Function> = {};
    for (const [prop, event] of Object.entries(PROP_TO_EVENT)) {
        if (typeof props[prop] === "function") map[event] = props[prop] as Function;
    }
    if (Object.keys(map).length) handlers.set(id, map);
    else handlers.delete(id);
}

/** Called by the render layer when the bridge reports a native event. */
export function dispatchEvent(id: number, event: string, payload: { value?: string; layout?: unknown }) {
    const fn = handlers.get(id)?.[event];
    if (!fn) return;
    if (event === "changeText") fn(payload.value ?? "");
    else if (event === "layout") fn({ nativeEvent: { layout: payload.layout } });
    else fn({ nativeEvent: {} });
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

function serialize(inst: Instance | TextInstance): SerializedNode {
    if (isTextLike(inst)) return { globalId: inst.id, type: "text", text: inst.text };

    const props = inst.props;
    const style = normalizeStyle(props.style as never) ?? {};
    const node: SerializedNode = { globalId: inst.id, type: "div" };

    switch (inst.type) {
        case "Text":
            node.type = "text";
            node.text = gatherText(inst);
            break;
        case "TextInput":
            node.type = props.multiline ? "textarea" : "textinput";
            node.placeholder = (props.placeholder as string) ?? "";
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
    // id 0 is reserved for the window root, so it never collides with element ids
    // (genId starts at 1) — keeps scroll/input/webview maps keyed cleanly.
    return {
        globalId: 0,
        type: "div",
        style: { width: c.width, height: c.height, flexDirection: "column" },
        children: c.children.map(serialize),
    };
}

// ── commit sink (set by render layer) ───────────────────────────────
let commit: ((tree: SerializedNode) => void) | null = null;
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
