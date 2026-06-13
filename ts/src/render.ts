/**
 * The render entry point. Drives react-reconciler into the GPUI bridge:
 *   React tree → reconciler → serialized node tree → startBridge → GPUI window.
 * Native events (press / changeText / layout / resize) flow back the other way.
 */
import { createElement, type ReactElement, type ComponentType } from "react";
import { isHotUpdateEvaluating } from "./refresh";
import Reconciler, { setCommitSink, serializeContainer, invalidateSerializeCaches, dispatchEvent, type Container } from "./reconciler";
import { setEventBatcher, startBridge, type Bridge, type BridgeEvent, type BridgeOptions, type SerializedNode } from "./runtime";
import { toWireDelta } from "./wire-delta";

// coalesced event batches (resize/layout/scroll floods) dispatch inside one React update so
// a window resize produces one re-render per batch instead of one per event.
setEventBatcher((run) => (Reconciler as { batchedUpdates(fn: (a: unknown) => void, a?: unknown): void }).batchedUpdates(run));
import { AppCommands, setCommandSink } from "./commands";
import { Dimensions } from "./Dimensions";
import { applyNativeColorScheme, setAppearanceUpdateSink } from "./colors";
import { dispatchPseudo } from "./platform-driver";

const EMPTY_NODES: ReadonlyArray<SerializedNode> = [];
const EMPTY_STYLE: Readonly<Record<string, unknown>> = {};

export type DevtoolsOptions = {
    /** hold Option to inspect native GPUI nodes; Option-click copies a node snapshot. */
    inspector?: boolean;
};

export interface RootOptions {
    /** initial window size; defaults to the current Dimensions window */
    width?: number;
    height?: number;
    /** optional native development tools for this root */
    devtools?: boolean | DevtoolsOptions;
}

export interface Root {
    render(element: ReactElement): void;
    unmount(): void;
}

let rootSeq = 1;
const noopError = (e: unknown) => {
    if (e) console.error(e);
};

export function createRoot(options: RootOptions = {}): Root {
    const win = Dimensions.get("window");
    const container: Container = {
        rootID: rootSeq++,
        width: options.width ?? win.width,
        height: options.height ?? win.height,
        children: [],
    };

    let bridge: Bridge | null = null;
    let lastTree: SerializedNode | null = null;
    // objects the host currently holds in full; toWireDelta emits refs for these. see its doc.
    const sentNodes = new WeakSet<SerializedNode>();
    const bridgeOptions: BridgeOptions = {
        inspector: options.devtools === true || (typeof options.devtools === "object" && options.devtools.inspector === true),
    };

    // Diff bridge: skip the apply when the committed tree is unchanged. The
    // reconciler memoizes serialization so an unchanged subtree re-emits the SAME
    // node object; any real change bubbles a fresh object up to the root's direct
    // children (markSerializeDirty propagates to the root). So comparing the root
    // style + top-level children by reference detects "nothing changed" in O(top
    // children) — and lets us drop the whole stringify → applyTree → Rust parse →
    // GPUI re-render → webview-host reposition for no-op commits (the selection
    // cascade's redundant frames, hover that didn't change output, background
    // streaming). This is what stops the webview "doing a lot" on idle churn.
    const sameTree = (a: SerializedNode, b: SerializedNode): boolean => {
        if (a === b) return true;
        if (a.globalId !== b.globalId) return false;
        const ac = a.children ?? EMPTY_NODES;
        const bc = b.children ?? EMPTY_NODES;
        if (ac.length !== bc.length) return false;
        for (let i = 0; i < ac.length; i++) if (ac[i] !== bc[i]) return false;
        // root style carries the window size (resize); compare it directly (tiny).
        const as = a.style ?? EMPTY_STYLE;
        const bs = b.style ?? EMPTY_STYLE;
        const ak = Object.keys(as);
        if (ak.length !== Object.keys(bs).length) return false;
        for (const k of ak) if ((as as Record<string, unknown>)[k] !== (bs as Record<string, unknown>)[k]) return false;
        return true;
    };
    const pushTree = (tree: SerializedNode) => {
        // sameTree compares the MEMOIZED tree (cheap O(top-children) ref check) to skip
        // no-op commits entirely; toWireDelta runs only when we actually send, and lastTree
        // stays the memoized tree so the next sameTree/delta sees real object identity.
        if (!bridge) {
            bridge = startBridge(toWireDelta(tree, sentNodes), bridgeOptions);
            bridge.onEvent(handleEvent);
            lastTree = tree;
            return;
        }
        if (lastTree && sameTree(tree, lastTree)) return;
        const wire = toWireDelta(tree, sentNodes);
        if (typeof process !== "undefined" && process.env?.RNGPUI_WIRE_TRACE) {
            // diagnostic: how much of the wire crossed as refs vs full nodes —
            // pairs with RNGPUI_SERIALIZE_TRACE to localize delta regressions
            // (memo hitting but wire full = the WeakSet membership is broken).
            let refs = 0;
            let full = 0;
            const count = (n: SerializedNode) => {
                if (n.ref) {
                    refs++;
                    return;
                }
                full++;
                for (const c of n.children ?? []) count(c);
            };
            count(wire);
            console.error(`[wire] refs=${refs} full=${full}`);
        }
        bridge.update(wire);
        lastTree = tree;
    };

    const handleEvent = (e: BridgeEvent) => {
        if (e.type === "ready" || e.type === "resize") {
            const changed = Dimensions._setWindow(e.width, e.height);
            container.width = e.width;
            container.height = e.height;
            // re-emit even if a hook already re-rendered: the root's own width/height
            // must track the window for components that don't subscribe to dimensions.
            if (changed && bridge) pushTree(serializeContainer(container));
            return;
        }
        if (e.type === "command") {
            AppCommands._emit(e.id);
            return;
        }
        if (e.type === "appearance") {
            if (process.env.RNGPUI_DEBUG_APPEARANCE) {
                console.error(`[appearance] native colorScheme=${e.colorScheme}`);
            }
            applyNativeColorScheme(e.colorScheme);
            return;
        }
        // renderer→JS pseudo lane: a native hover/press flip routes to the platform
        // driver's listeners (tamagui), NOT the React event path — so a hover never
        // triggers a React commit. Handled before dispatchEvent so it never falls through.
        if (e.type === "event" && e.event === "pseudo") {
            dispatchPseudo(e.id, e.hovered ?? false, e.pressed ?? false);
            return;
        }
        // a native UI event → route to the React handler; its setState (if any)
        // schedules a re-render, which commits a fresh tree back to the bridge.
        dispatchEvent(e.id, e.event, {
            value: e.value,
            key: e.key,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            pressDrag: e.pressDrag,
            pageX: e.pageX,
            pageY: e.pageY,
            locationX: e.locationX,
            locationY: e.locationY,
            layout: e.layout,
            cols: e.cols,
            rows: e.rows,
        });
    };

    // The reconciler calls this after every commit with the serialized tree.
    setCommitSink((tree: SerializedNode) => {
        pushTree(tree);
    });
    setAppearanceUpdateSink(() => {
        // the scheme changed: every cached serialization may hold stale
        // scheme-resolved colors (DynamicColorIOS bakes at serialize time) —
        // drop all caches so this re-serialize resolves under the new scheme.
        invalidateSerializeCaches(container);
        if (bridge) pushTree(serializeContainer(container));
    });

    // Imperative host → frame commands (WebView.injectJavaScript / reload). Commands
    // only fire after mount, by which point the bridge exists.
    setCommandSink((cmd) => bridge?.command(cmd));

    // tag 1 = ConcurrentRoot. Urgent input state (pressed row, text input) still
    // commits immediately, while startTransition work can be superseded when a
    // fast press-drag or tap stream selects a newer target before the stage mounts.
    const fiberRoot = (Reconciler as any).createContainer(
        container,
        1,
        null,
        false,
        null,
        "",
        noopError,
        noopError,
        noopError,
        null,
    );

    return {
        render(element: ReactElement) {
            Reconciler.updateContainer(element as any, fiberRoot, null, null);
        },
        unmount() {
            Reconciler.updateContainer(null, fiberRoot, null, null);
            bridge?.close();
            setAppearanceUpdateSink(undefined);
            bridge = null;
        },
    };
}

/** Convenience: render an element into a fresh root and return it. */
export function render(element: ReactElement, options?: RootOptions): Root {
    const root = createRoot(options);
    root.render(element);
    return root;
}

// ── AppRegistry (RN-familiar entry point) ───────────────────────────
type ComponentProvider = () => ComponentType<any>;
export interface RunApplicationOptions extends RootOptions {
    initialProps?: Record<string, unknown>;
}

const registry = new Map<string, ComponentProvider>();
const running = new Map<
    string,
    {
        root: Root;
        initialProps?: Record<string, unknown>;
        width?: number;
        height?: number;
        devtools?: boolean | DevtoolsOptions;
    }
>();

export const AppRegistry = {
    registerComponent(appKey: string, provider: ComponentProvider): string {
        registry.set(appKey, provider);
        return appKey;
    },
    runApplication(appKey: string, options: RunApplicationOptions = {}): Root {
        const provider = registry.get(appKey);
        if (!provider) throw new Error(`Application "${appKey}" has not been registered.`);
        const { initialProps, width, height, devtools } = options;
        const active = running.get(appKey);
        if (active) {
            active.initialProps = initialProps;
            active.width = width;
            active.height = height;
            active.devtools = devtools;
            const renderActive = () => {
                const latestProvider = registry.get(appKey);
                if (!latestProvider) return;
                const Component = latestProvider();
                active.root.render(createElement(Component, active.initialProps));
            };
            if (!isHotUpdateEvaluating()) {
                renderActive();
            }
            return active.root;
        }
        const Component = provider();
        const root = render(createElement(Component, initialProps), { width, height, devtools });
        running.set(appKey, { root, initialProps, width, height, devtools });
        return root;
    },
    getAppKeys(): string[] {
        return [...registry.keys()];
    },
};
