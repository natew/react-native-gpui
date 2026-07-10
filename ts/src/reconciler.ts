import "./refresh";
import { createContext } from "react";
import ReactReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";
import { cssColorString, normalizeStyle } from "./StyleSheet";
import { resolveColorValue } from "./colors";
import type { SerializedAccessibility, SerializedNode } from "./runtime";

// ── ids + instances ─────────────────────────────────────────────────
let nextId = 1;
const genId = () => nextId++;

export interface Instance {
    id: number;
    type: string;
    props: Record<string, unknown>;
    children: Array<Instance | TextInstance>;
    // ── serialization memo ──
    // parent backlink + dirty flag let us cache each node's SerializedNode and
    // only recompute the ones that actually changed (see markSerializeDirty /
    // serialize). A dirty node may retain its previous cache so serialization can
    // reuse that exact object when React supplied new props with identical output.
    parent: Instance | null;
    dirty: boolean;
    cached: SerializedNode | undefined;
    cachedListGroup: string | undefined;
    // commitUpdate defers layout comparison until serialize() has already built
    // the normalized native node, avoiding a second style normalization pass.
    layoutSnapshot: LayoutSnapshot | undefined;
    layoutDirty: boolean;
    // true if this node is a portal host/view or has one in its subtree; such
    // nodes embed external mutable content (PortalContext) so they are never
    // cached — but their siblings/cousins still memoize normally.
    hasPortal: boolean;
    measure: (callback: MeasureCallback) => void;
    measureInWindow: (callback: MeasureInWindowCallback) => void;
    measureLayout: (
        relativeToNativeNode: Instance | number | null,
        onSuccess: (left: number, top: number, width: number, height: number) => void,
        onFail?: () => void,
    ) => void;
    // ── react-native-reanimated host-instance shims ──
    // reanimated's createAnimatedComponent resolves an animated node's native tag via
    // these RN fabric fields (findHostInstance fast path reads __nativeTag +
    // __internalInstanceHandle + _viewConfig; getShadowNodeWrapperFromRef reads
    // __internalInstanceHandle.stateNode.node). The gpui reconciler returns the
    // Instance itself as the public instance, so we make `globalId` BE the viewTag and
    // the shadowNodeWrapper — the reanimated-seam's `_updateProps` then maps an op's
    // shadowNodeWrapper (= id) straight to the globalId Rust keys its animated overlay
    // on. No separate registry, no patched reanimated internals.
    __nativeTag: number;
    __internalInstanceHandle: { stateNode: { node: number }; type: string };
    _viewConfig: { uiViewClassName: string };
}
export interface TextInstance {
    id: number;
    text: string;
    parent: Instance | null;
}
export interface Container {
    rootID: number;
    width: number;
    height: number;
    children: Array<Instance | TextInstance>;
}

let commit: ((tree: SerializedNode) => void) | null = null;
let currentContainer: Container | null = null;
const measuredIds = new Set<number>();
const layouts = new Map<number, LayoutRect>();
const instances = new Map<number, Instance>();
const pendingMeasures = new Map<number, Array<() => void>>();
// globalIds that opted into the renderer→JS pseudo lane (set imperatively by the
// platform driver via setPseudoEvents). serialize() emits `pseudoEvents: true` for
// these so the host wires the hover/press flip → `pseudo` event emit. Mirrors
// `measuredIds`: a side set the serializer reads, not a React prop.
const pseudoEventIds = new Set<number>();
const PORTAL_HOST_TYPE = "RNTPortalHostView";
const PORTAL_VIEW_TYPE = "RNTPortalView";

// ── serialization memo ──────────────────────────────────────────────
// serialize() rebuilds a node's SerializedNode from scratch — normalizing every
// style object and re-walking children — and it runs on EVERY React commit AND
// every hover/press/measure. For the full control room that was ~12-32ms per
// commit over the whole tree even when ~3 nodes changed, all on the single JS
// thread, which is what froze input. We cache each Instance's SerializedNode and
// recompute only dirty nodes (+ their ancestors, whose children array changed),
// so a commit costs O(changed), not O(tree).
//
// Portal hosts embed content from elsewhere in the tree via a mutable
// PortalContext, so their serialization isn't a pure function of their own
// subtree. We never cache a node that is (or contains) a portal host/view —
// tracked per-node via `hasPortal` — so those subtrees recompute every commit
// while the rest of the tree (sidebar, stage, etc.) memoizes. Tamagui keeps a
// portal host permanently mounted, so a global "any portal → disable memo"
// guard would disable memoization forever; per-node is what makes it real.
const isPortalType = (type: string) => type === PORTAL_HOST_TYPE || type === PORTAL_VIEW_TYPE;
// diagnostic: cache hit/miss per commit (RNGPUI_SERIALIZE_TRACE=1)
const SERIALIZE_TRACE = typeof process !== "undefined" && !!process.env?.RNGPUI_SERIALIZE_TRACE;
let serHit = 0;
let serMiss = 0;
let commitUpdates = 0;
let creates = 0;
const serMissByGroup: Record<string, number> = {};

// Serialized output bakes in values that depend on global state outside props —
// DynamicColorIOS resolves against the CURRENT color scheme at serialize time — so
// an appearance change must invalidate EVERY cache even though no props changed.
// Without this, a node with a stable DynamicColor style (e.g. the chrome-tinted
// divider) keeps its dark-resolved serialization forever after macOS reports
// light, until some unrelated state change happens to re-render it. Called from
// the appearance sink (render.ts) before the post-change re-serialize; appearance
// flips are rare, so a one-shot O(tree) walk beats a per-hit epoch check.
export function invalidateSerializeCaches(container: Container) {
    const walk = (node: Instance | TextInstance) => {
        if (isTextLike(node)) return;
        node.dirty = true;
        node.cached = undefined;
        for (const child of node.children) walk(child);
    };
    for (const child of container.children) walk(child);
}

// Mark a node and its ancestors dirty: an ancestor's cached SerializedNode
// embeds its children's nodes, so a child change must invalidate the chain up to
// the root. Stops early once it hits an already-dirty ancestor.
function markSerializeDirty(node: Instance | TextInstance | null) {
    let cur: Instance | TextInstance | null = node;
    while (cur) {
        if (isTextLike(cur)) {
            cur = cur.parent;
            continue;
        }
        if (cur.dirty) return;
        cur.dirty = true;
        cur = cur.parent;
    }
}

// serialized nodes contain JSON-compatible values only. React still calls
// commitUpdate for common no-op shapes such as a fresh inline style object or a
// fresh callback with the same event name. Reuse the previous cached object when
// the resulting wire node is identical, allowing that equality to collapse all
// the way through its ancestors and into a tiny delta ref.
function sameSerializedValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!sameSerializedValue(a[i], b[i])) return false;
        }
        return true;
    }
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    if (aKeys.length !== Object.keys(bRecord).length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false;
        if (!sameSerializedValue(aRecord[key], bRecord[key])) return false;
    }
    return true;
}

type LayoutSnapshot = Pick<
    SerializedNode,
    | "type"
    | "style"
    | "text"
    | "runs"
    | "numberOfLines"
    | "placeholder"
    | "value"
    | "src"
    | "nativeLayoutKey"
    | "nativeResize"
>;

function layoutSnapshot(node: SerializedNode): LayoutSnapshot {
    return {
        type: node.type,
        style: node.style,
        text: node.text,
        runs: node.runs,
        numberOfLines: node.numberOfLines,
        placeholder: node.placeholder,
        value: node.value,
        src: node.src,
        nativeLayoutKey: node.nativeLayoutKey,
        nativeResize: node.nativeResize,
    };
}

function markSerializeDirtyById(id: number) {
    markSerializeDirty(instances.get(id) ?? null);
}

type LayoutRect = { x: number; y: number; width: number; height: number };
type MeasureCallback = (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void;
type MeasureInWindowCallback = (x: number, y: number, width: number, height: number) => void;

// ── event registry (id → { event: handler }) ────────────────────────
const PROP_TO_EVENT: Record<string, string> = {
    onClick: "click",
    onContextMenu: "contextMenu",
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
    onInsertText: "terminalText",
    onMeasureViewport: "terminalViewport",
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

// force a re-commit (re-serialize the dirty container) outside React's render — used when a
// native signal changes a node's serialized output (e.g. a measured layout grants the
// 'layout' event). hover/press no longer take this path; they're resolved natively in the host.
function requestRecommit() {
    if (commit && currentContainer) commit(serializeContainer(currentContainer));
}

/** The platform driver opts a node into (or out of) the renderer→JS pseudo lane by
 * globalId. Toggles `pseudoEvents` in the serializer's side set, marks the node dirty,
 * and recommits so the host learns the flag without a React render. */
export function setPseudoEvents(id: number, on: boolean): void {
    const had = pseudoEventIds.has(id);
    if (on === had) return;
    if (on) pseudoEventIds.add(id);
    else pseudoEventIds.delete(id);
    markSerializeDirtyById(id);
    requestRecommit();
}

function registerHandlers(id: number, props: Record<string, unknown>) {
    const map: Record<string, Function> = {};
    for (const [prop, event] of Object.entries(PROP_TO_EVENT)) {
        const next = props[prop];
        if (typeof next === "function") {
            map[event] = chainHandler(map[event], next);
        }
    }
    // hoverStyle/pressStyle are consumed by the styling layer (Tamagui) through the platform
    // driver, not wired as JS mouse handlers here. Only the user's own onHoverIn/onPressIn/etc.
    // (mapped above via PROP_TO_EVENT) produce listeners.
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
        button?: number;
        buttons?: number;
        pressDrag?: boolean;
        pageX?: number;
        pageY?: number;
        locationX?: number;
        locationY?: number;
        scrollX?: number;
        scrollY?: number;
        scrollWidth?: number;
        scrollHeight?: number;
        scrollContentWidth?: number;
        scrollContentHeight?: number;
        layout?: unknown;
        cols?: number;
        rows?: number;
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
    else if (event === "terminalText") result = fn(payload.value ?? "");
    else if (event === "terminalViewport")
        result = fn({ cols: payload.cols ?? 0, rows: payload.rows ?? 0 });
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
        // gaining a 'layout' event changes this node's serialized `events`.
        markSerializeDirtyById(id);
        requestRecommit();
    } else if (!hasLayout) {
        requestRecommit();
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

const TOP_LEVEL_STYLE_PROPS = [
    "alignContent",
    "alignItems",
    "alignSelf",
    "aspectRatio",
    "backgroundColor",
    "backgroundImage",
    "borderBottomColor",
    "borderBottomLeftRadius",
    "borderBottomRightRadius",
    "borderBottomWidth",
    "borderColor",
    "borderLeftColor",
    "borderLeftWidth",
    "borderRadius",
    "borderRightColor",
    "borderRightWidth",
    "borderStartWidth",
    "borderEndWidth",
    "borderStyle",
    "borderTopColor",
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderTopWidth",
    "borderWidth",
    "bottom",
    "boxShadow",
    "color",
    "columnGap",
    "cursor",
    "display",
    "elevation",
    "end",
    "experimental_backgroundImage",
    "flex",
    "flexBasis",
    "flexDirection",
    "flexGrow",
    "flexShrink",
    "flexWrap",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "gap",
    "height",
    "inset",
    "justifyContent",
    "left",
    "letterSpacing",
    "lineHeight",
    "margin",
    "marginBottom",
    "marginEnd",
    "marginHorizontal",
    "marginLeft",
    "marginRight",
    "marginStart",
    "marginTop",
    "marginVertical",
    "maxHeight",
    "maxWidth",
    "minHeight",
    "minWidth",
    "opacity",
    "overflow",
    "padding",
    "paddingBottom",
    "paddingEnd",
    "paddingHorizontal",
    "paddingLeft",
    "paddingRight",
    "paddingStart",
    "paddingTop",
    "paddingVertical",
    "position",
    "right",
    "rowGap",
    "shadowColor",
    "shadowOffset",
    "shadowOpacity",
    "shadowRadius",
    "start",
    "textAlign",
    "textDecorationLine",
    "textTransform",
    "tintColor",
    "top",
    "transform",
    "width",
    "zIndex",
] as const;

function normalizePropsStyle(props: Record<string, unknown>): Record<string, unknown> | undefined {
    const topLevelStyle: Record<string, unknown> = {};
    for (const key of TOP_LEVEL_STYLE_PROPS) {
        const value = props[key];
        if (value !== undefined) topLevelStyle[key] = value;
    }
    if (Object.keys(topLevelStyle).length === 0) {
        return (normalizeStyle(props.style as never) ?? undefined) as Record<string, unknown> | undefined;
    }
    return (normalizeStyle([props.style as never, topLevelStyle as never] as never) ?? undefined) as
        | Record<string, unknown>
        | undefined;
}

function invalidateLayout(node: Instance | TextInstance) {
    if (isTextLike(node)) return;
    layouts.delete(node.id);
    for (const child of node.children) invalidateLayout(child);
}

function cleanupInstance(node: Instance | TextInstance) {
    if (isTextLike(node)) {
        node.parent = null;
        return;
    }
    node.parent = null;
    node.cached = undefined;
    handlers.delete(node.id);
    measuredIds.delete(node.id);
    pseudoEventIds.delete(node.id);
    layouts.delete(node.id);
    instances.delete(node.id);
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

function explicitHostId(props: Record<string, unknown>): number | undefined {
    const id = props.__rngpuiHostId;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function createPublicInstance(type: string, props: Record<string, unknown>): Instance {
    const id = explicitHostId(props) ?? genId();
    const instance: Instance = {
        id,
        type,
        props,
        children: [],
        parent: null,
        dirty: true,
        cached: undefined,
        cachedListGroup: undefined,
        layoutSnapshot: undefined,
        layoutDirty: false,
        hasPortal: false,
        // reanimated host-instance shims — see the Instance interface. globalId IS the
        // native tag + shadow-node wrapper, so the reanimated seam maps animated ops to
        // the same id Rust's overlay uses.
        __nativeTag: id,
        __internalInstanceHandle: { stateNode: { node: id }, type },
        _viewConfig: { uiViewClassName: type },
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
        button?: number;
        buttons?: number;
        pressDrag?: boolean;
        pageX?: number;
        pageY?: number;
        locationX?: number;
        locationY?: number;
        scrollX?: number;
        scrollY?: number;
        scrollWidth?: number;
        scrollHeight?: number;
        scrollContentWidth?: number;
        scrollContentHeight?: number;
        layout?: unknown;
    },
) {
    let defaultPrevented = false;
    let propagationStopped = false;
    const eventObject: any = {
        type,
        altKey: !!payload.altKey,
        button: payload.button ?? 0,
        buttons: payload.buttons ?? 0,
        cancelable: true,
        ctrlKey: !!payload.ctrlKey,
        currentTarget: {},
        defaultPrevented,
        metaKey: !!payload.metaKey,
        pressDrag: !!payload.pressDrag,
        nativeEvent: {
            type,
            value: payload.value,
            key: payload.key,
            shiftKey: !!payload.shiftKey,
            ctrlKey: !!payload.ctrlKey,
            altKey: !!payload.altKey,
            metaKey: !!payload.metaKey,
            button: payload.button ?? 0,
            buttons: payload.buttons ?? 0,
            pressDrag: !!payload.pressDrag,
            layout: payload.layout,
            locationX: payload.locationX ?? 0,
            locationY: payload.locationY ?? 0,
            pageX: payload.pageX ?? 0,
            pageY: payload.pageY ?? 0,
            contentOffset: {
                x: payload.scrollX ?? 0,
                y: payload.scrollY ?? 0,
            },
            contentSize: {
                width: payload.scrollContentWidth ?? 0,
                height: payload.scrollContentHeight ?? 0,
            },
            layoutMeasurement: {
                width: payload.scrollWidth ?? 0,
                height: payload.scrollHeight ?? 0,
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

// aria-* attributes arrive as either real booleans (RN-style props) or the
// stringified "true"/"false" the DOM form uses (react-native-web's
// createDOMProps rewrites accessibilityState → aria-checked/selected/disabled
// before the tree reaches us). Read both so accessibility STATE survives the
// same web↔native dual-path we already honor for label/role.
function ariaBoolProp(props: Record<string, unknown>, ...names: string[]): boolean | undefined {
    for (const name of names) {
        const value = props[name];
        if (typeof value === "boolean") return value;
        if (value === "true") return true;
        if (value === "false") return false;
    }
    return undefined;
}

function numberProp(props: Record<string, unknown>, ...names: string[]): number | undefined {
    for (const name of names) {
        const value = props[name];
        if (typeof value === "number" && Number.isFinite(value)) return value;
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
    const explicitHidden = boolProp(props, "accessibilityElementsHidden", "aria-hidden");
    const svgHasExplicitAccessibility =
        node.type === "svg" &&
        (props.accessibilityLabel != null ||
            props["aria-label"] != null ||
            props.accessibilityRole != null ||
            props.role != null ||
            props.accessible === true ||
            important === "yes");
    const hidden =
        explicitHidden ??
        (important === "no-hide-descendants" ? true : undefined) ??
        (node.type === "svg" && !svgHasExplicitAccessibility ? true : undefined);

    const nativeID = stringProp(props, "nativeID");
    const testID = stringProp(props, "testID");
    const propID = stringProp(props, "id");
    const identifier = nativeID ?? testID ?? propID;
    const info: SerializedAccessibility = {
        accessible:
            boolProp(props, "accessible") ??
            (important === "no" ? false : important === "yes" ? true : undefined),
        hidden,
        label: stringProp(props, "accessibilityLabel", "aria-label"),
        role: stringProp(props, "accessibilityRole", "role"),
        hint: stringProp(props, "accessibilityHint", "aria-description"),
        value: accessibilityValueText(props.accessibilityValue),
        identifier,
        identifierSource: nativeID ? "nativeID" : testID ? "testID" : propID ? "id" : undefined,
        nativeID,
        testID,
        propID,
        disabled: boolProp(state, "disabled") ?? ariaBoolProp(props, "aria-disabled"),
        selected: boolProp(state, "selected") ?? ariaBoolProp(props, "aria-selected", "aria-pressed"),
        checked:
            typeof state.checked === "boolean" || state.checked === "mixed"
                ? state.checked
                : props["aria-checked"] === "mixed"
                  ? "mixed"
                  : ariaBoolProp(props, "aria-checked"),
        expanded: boolProp(state, "expanded") ?? ariaBoolProp(props, "aria-expanded"),
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
    const own = (normalizePropsStyle(inst.props) ?? {}) as Record<string, unknown>;
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

function serializeChildren(
    children: Array<Instance | TextInstance>,
    context: PortalContext,
    listGroup?: string,
): SerializedNode[] {
    const out: SerializedNode[] = [];
    for (const child of children) {
        const next = serialize(child, context, listGroup);
        if (next) out.push(next);
    }
    return out;
}

function serializePortalEntry(inst: Instance, context: PortalContext, listGroup?: string): SerializedNode[] {
    const style = (normalizePropsStyle(inst.props) ?? {}) as Record<string, unknown>;
    const children = serializeChildren(inst.children, context, listGroup);
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

function serialize(inst: Instance | TextInstance, context: PortalContext, inheritedListGroup?: string): SerializedNode | null {
    if (isTextLike(inst)) return { globalId: inst.id, type: "text", text: inst.text };
    if (inst.type === PORTAL_VIEW_TYPE) return null;

    // Memo fast path: a clean, non-portal node serialized under the same inherited
    // list group re-emits its cached node (and its whole clean subtree) with zero
    // style/object work. `cached` is only ever set for non-portal nodes, so this
    // never returns stale portal content.
    if (!inst.dirty && inst.cached !== undefined && inst.cachedListGroup === inheritedListGroup) {
        if (SERIALIZE_TRACE) serHit++;
        return inst.cached;
    }
    if (SERIALIZE_TRACE) serMiss++;
    const previousCached = inst.cached;

    const props = inst.props;
    const listGroup = stringProp(props, "nativeListGroup") ?? inheritedListGroup;
    if (SERIALIZE_TRACE) {
        const g = listGroup ?? "(none)";
        serMissByGroup[g] = (serMissByGroup[g] ?? 0) + 1;
    }
    const style = (normalizePropsStyle(props) ?? {}) as Record<string, unknown>;
    // hover/press style props stay in the styling layer. The host only receives `pseudoEvents`
    // for nodes that Tamagui subscribed through the platform driver; the resulting native
    // hover flips feed Tamagui's emitter/animation path instead of a serialized paint delta.
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
            if (props.selectable === true) node.selectable = true;
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
        case "NativeButton":
            // real AppKit NSButton underlay. `text` carries the button title (the host
            // overloads it the same way it does for input placeholders); `editable=false`
            // carries the disabled state.
            node.type = "nativebutton";
            node.text = props.title != null ? String(props.title) : "";
            if (props.disabled === true) node.editable = false;
            break;
        case "NativeTextInput":
            // real AppKit NSTextField/NSSecureTextField underlay. Same wire fields as the
            // gpui-drawn textinput so the host parses them identically.
            node.type = "nativeinput";
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
        case "SystemView": {
            node.type = "system";
            const material = stringProp(props, "material");
            if (material) node.systemMaterial = material;
            const glassVariant = stringProp(props, "glassVariant");
            if (glassVariant) node.systemGlassVariant = glassVariant;
            if (props.tint != null) {
                const tint = cssColorString(resolveColorValue(props.tint));
                if (tint) node.systemTint = tint;
            }
            const shadow = normalizeSystemShadow(props.shadow);
            if (shadow) node.systemShadow = shadow;
            const edgeFade = numberProp(props, "edgeFade");
            if (edgeFade && edgeFade > 0) node.systemEdgeFade = edgeFade;
            const topFadeStart = numberProp(props, "topFadeStart");
            if (topFadeStart != null) node.systemTopFadeStart = topFadeStart;
            break;
        }
        case "GhosttyTerminal": {
            node.type = "ghostty-terminal";
            const sessionId = stringProp(props, "sessionId");
            if (sessionId) node.terminalSessionId = sessionId;
            const frames = normalizeTerminalFrames(props.frames);
            if (frames.length) node.terminalFrames = frames;
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
    if (pseudoEventIds.has(inst.id)) node.pseudoEvents = true;
    // in-app liquid-glass backdrop blur for a plain <View>: a logical-px gaussian sigma
    // plus an optional tint composited over the blurred content (the desktop <Glass>).
    const backdropBlur = numberProp(props, "backdropBlur");
    if (backdropBlur && backdropBlur > 0) node.backdropBlur = backdropBlur;
    if (props.backdropTint != null) {
        const backdropTint = cssColorString(resolveColorValue(props.backdropTint));
        if (backdropTint) node.backdropTint = backdropTint;
    }
    const nativeLayoutKey = stringProp(props, "nativeLayoutKey");
    if (nativeLayoutKey) node.nativeLayoutKey = nativeLayoutKey;
    const nativeResize = normalizeNativeResize(props.nativeResize);
    if (nativeResize) node.nativeResize = nativeResize;
    if (listGroup) node.nativeListGroup = listGroup;
    const evts = handlers.get(inst.id);
    const eventNames = evts ? Object.keys(evts) : [];
    if (measuredIds.has(inst.id) && !eventNames.includes("layout")) eventNames.push("layout");
    if (eventNames.length) node.events = eventNames;
    const accessibility = serializeAccessibility(inst, node);
    if (accessibility) node.accessibility = accessibility;
    // authored JSX source location stamped by the babel source-location plugin
    // (rngsSource="<abs-path>:<line>:<col>"); the native inspector reads it for
    // open-in-editor. Plain prop name (not data-*) so Tamagui forwards it to native.
    const source = stringProp(props, "rngsSource");
    if (source) node.source = source;

    if (node.type === "div" || node.type === "svg" /* svg has no children but harmless */) {
        const kids = serializeChildren(inst.children, context, listGroup);
        if (inst.type === PORTAL_HOST_TYPE) {
            const hostName = portalHostName(props);
            if (!context.usedHosts.has(hostName)) {
                context.usedHosts.add(hostName);
                const portalEntries = context.byHost.get(hostName) ?? [];
                for (const entry of portalEntries) {
                    kids.push(...serializePortalEntry(entry, context, listGroup));
                }
            }
        }
        if (kids.length) node.children = kids;
    }
    // a node "has a portal" if it IS one or any non-text child does (children were
    // just serialized above, so child.hasPortal is current; cache-hit children keep
    // their last value, which is still valid until a structural change dirties them).
    inst.hasPortal = isPortalType(inst.type) || inst.children.some((c) => !isTextLike(c) && c.hasPortal);
    if (inst.layoutDirty || inst.layoutSnapshot === undefined) {
        const nextLayoutSnapshot = layoutSnapshot(node);
        if (
            inst.layoutSnapshot !== undefined &&
            !sameSerializedValue(nextLayoutSnapshot, inst.layoutSnapshot)
        ) {
            invalidateLayout(inst);
        }
        inst.layoutSnapshot = nextLayoutSnapshot;
        inst.layoutDirty = false;
    }
    inst.dirty = false;
    if (inst.hasPortal) {
        inst.cached = undefined;
    } else {
        inst.cached = previousCached && sameSerializedValue(node, previousCached) ? previousCached : node;
        inst.cachedListGroup = inheritedListGroup;
    }
    return inst.cached ?? node;
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

function normalizeSystemShadow(value: unknown): SerializedNode["systemShadow"] | undefined {
    if (!value || typeof value !== "object") return undefined;
    const spec = value as Record<string, unknown>;
    const out: NonNullable<SerializedNode["systemShadow"]> = {};
    if (spec.color != null) {
        const color = cssColorString(resolveColorValue(spec.color));
        if (color) out.color = color;
    }
    if (typeof spec.radius === "number") out.radius = spec.radius;
    if (typeof spec.offsetX === "number") out.offsetX = spec.offsetX;
    if (typeof spec.offsetY === "number") out.offsetY = spec.offsetY;
    if (typeof spec.opacity === "number") out.opacity = spec.opacity;
    // emit only when something is actually set, so a `shadow={{}}` doesn't draw.
    return Object.keys(out).length ? out : undefined;
}

function normalizeTerminalFrames(value: unknown): NonNullable<SerializedNode["terminalFrames"]> {
    if (!Array.isArray(value)) return [];
    const out: NonNullable<SerializedNode["terminalFrames"]> = [];
    for (const frame of value) {
        if (!frame || typeof frame !== "object") continue;
        const typed = frame as {
            seq?: unknown;
            kind?: unknown;
            data?: unknown;
            cols?: unknown;
            rows?: unknown;
        };
        const seq = typeof typed.seq === "number" && Number.isFinite(typed.seq) ? Math.floor(typed.seq) : 0;
        if (seq <= 0) continue;
        if (typed.kind !== "snapshot" && typed.kind !== "bytes" && typed.kind !== "resize") continue;
        const next: NonNullable<SerializedNode["terminalFrames"]>[number] = {
            seq,
            kind: typed.kind,
        };
        if (typeof typed.data === "string") next.data = typed.data;
        if (typeof typed.cols === "number" && Number.isFinite(typed.cols)) next.cols = Math.max(1, Math.floor(typed.cols));
        if (typeof typed.rows === "number" && Number.isFinite(typed.rows)) next.rows = Math.max(1, Math.floor(typed.rows));
        out.push(next);
    }
    return out;
}

function imageSource(source: unknown): string | undefined {
    if (typeof source === "string") return source;
    if (source && typeof source === "object" && "uri" in source) return (source as { uri: string }).uri;
    return undefined;
}

export function serializeContainer(c: Container): SerializedNode {
    currentContainer = c;
    // commitUpdate/createInstance fire during the React commit phase BEFORE this
    // serialize runs, so capture them now, then reset for the next commit.
    const updThisCommit = commitUpdates;
    const creThisCommit = creates;
    if (SERIALIZE_TRACE) {
        serHit = 0;
        serMiss = 0;
        commitUpdates = 0;
        creates = 0;
        for (const k of Object.keys(serMissByGroup)) delete serMissByGroup[k];
    }
    const byHost = new Map<string, Instance[]>();
    for (const child of c.children) collectPortals(child, byHost);
    const context: PortalContext = { byHost, usedHosts: new Set() };
    // id 0 is reserved for the window root, so it never collides with element ids
    // (genId starts at 1) — keeps scroll/input/webview maps keyed cleanly.
    const root = {
        globalId: 0,
        type: "div",
        style: { width: c.width, height: c.height, flexDirection: "column", position: "relative" },
        children: serializeChildren(c.children, context),
    };
    if (SERIALIZE_TRACE && (serMiss > 0 || updThisCommit > 0 || creThisCommit > 0)) {
        const groups = Object.entries(serMissByGroup)
            .sort((a, b) => b[1] - a[1])
            .map(([g, n]) => `${g}:${n}`)
            .join(" ");
        console.error(`[ser] updates=${updThisCommit} creates=${creThisCommit} miss=${serMiss} hit=${serHit} | ${groups}`);
    }
    return root;
}

export function setCommitSink(fn: (tree: SerializedNode) => void) {
    commit = fn;
}

function detachForMove<T>(children: T[], child: T) {
    const index = children.indexOf(child);
    if (index !== -1) children.splice(index, 1);
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
        if (SERIALIZE_TRACE) creates++;
        const inst = createPublicInstance(type, props);
        registerHandlers(inst.id, props);
        return inst;
    },
    createTextInstance(text: string): TextInstance {
        return { id: genId(), text, parent: null };
    },
    appendInitialChild(parent: Instance, child: Instance | TextInstance) {
        parent.children.push(child);
        child.parent = parent;
        invalidateLayout(parent);
        markSerializeDirty(parent);
    },
    appendChild(parent: Instance, child: Instance | TextInstance) {
        detachForMove(parent.children, child);
        parent.children.push(child);
        child.parent = parent;
        invalidateLayout(parent);
        markSerializeDirty(parent);
    },
    appendChildToContainer(container: Container, child: Instance | TextInstance) {
        detachForMove(container.children, child);
        container.children.push(child);
        child.parent = null;
    },
    removeChild(parent: Instance, child: Instance | TextInstance) {
        const i = parent.children.indexOf(child);
        if (i !== -1) {
            parent.children.splice(i, 1);
            invalidateLayout(parent);
            markSerializeDirty(parent);
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
        detachForMove(parent.children, child);
        const i = parent.children.indexOf(before);
        parent.children.splice(i === -1 ? parent.children.length : i, 0, child);
        child.parent = parent;
        invalidateLayout(parent);
        markSerializeDirty(parent);
    },
    insertInContainerBefore(container: Container, child: Instance | TextInstance, before: Instance | TextInstance) {
        detachForMove(container.children, child);
        const i = container.children.indexOf(before);
        container.children.splice(i === -1 ? container.children.length : i, 0, child);
        child.parent = null;
    },
    // react-reconciler 0.31 signature: (instance, type, prevProps, nextProps, handle)
    commitUpdate(instance: Instance, _type: string, _prevProps: unknown, nextProps: Record<string, unknown>) {
        instance.props = nextProps;
        instance.layoutDirty = true;
        registerHandlers(instance.id, nextProps);
        markSerializeDirty(instance);
        if (SERIALIZE_TRACE) commitUpdates++;
    },
    commitTextUpdate(textInstance: TextInstance, _old: string, next: string) {
        textInstance.text = next;
        // text has no cache of its own; its serialized form lives in its parent.
        markSerializeDirty(textInstance.parent);
    },
    // React sets the ContentReset flag (and calls this) when a host node that
    // held inline string content (shouldSetTextContent → true, so the text lives
    // in props.children rather than child TextInstances) is about to receive
    // element/child mutations instead. Clear the inline string so it doesn't leak
    // through the props.children fallback in serialize(). REQUIRED: without it
    // React invokes an undefined host-config method mid-commit
    // ("undefined is not a function"), which tears down the tree and blanks the
    // window once dynamic content toggles between text and elements.
    resetTextContent(instance: Instance) {
        const children = instance.props?.children;
        if (typeof children === "string" || typeof children === "number") {
            instance.props = { ...instance.props, children: undefined };
            instance.layoutDirty = true;
            invalidateLayout(instance);
            markSerializeDirty(instance);
        }
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
if (typeof __DEV__ !== "undefined" && __DEV__) {
    (Reconciler as unknown as { injectIntoDevTools?: (config: { bundleType: 1; version: string; rendererPackageName: string }) => boolean })
        .injectIntoDevTools?.({
            bundleType: 1,
            version: "0.1.26",
            rendererPackageName: "react-native-gpui",
        });
}
export default Reconciler;
