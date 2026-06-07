/**
 * The render entry point. Drives react-reconciler into the GPUI bridge:
 *   React tree → reconciler → serialized node tree → startBridge → GPUI window.
 * Native events (press / changeText / layout / resize) flow back the other way.
 */
import { createElement, type ReactElement, type ComponentType } from "react";
import Reconciler, { setCommitSink, serializeContainer, dispatchEvent, type Container } from "./reconciler";
import { setEventBatcher, startBridge, type Bridge, type BridgeEvent, type BridgeOptions, type SerializedNode } from "./runtime";

// coalesced event batches (resize/layout/scroll floods) dispatch inside one React update so
// a window resize produces one re-render per batch instead of one per event (legacy root has
// no automatic batching for host-driven events).
setEventBatcher((run) => (Reconciler as { batchedUpdates(fn: (a: unknown) => void, a?: unknown): void }).batchedUpdates(run));
import { AppCommands, setCommandSink } from "./commands";
import { Dimensions } from "./Dimensions";
import { applyNativeColorScheme, setAppearanceUpdateSink } from "./colors";

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
    const bridgeOptions: BridgeOptions = {
        inspector: options.devtools === true || (typeof options.devtools === "object" && options.devtools.inspector === true),
    };

    const handleEvent = (e: BridgeEvent) => {
        if (e.type === "ready" || e.type === "resize") {
            const changed = Dimensions._setWindow(e.width, e.height);
            container.width = e.width;
            container.height = e.height;
            // re-emit even if a hook already re-rendered: the root's own width/height
            // must track the window for components that don't subscribe to dimensions.
            if (changed && bridge) bridge.update(serializeContainer(container));
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
        // a native UI event → route to the React handler; its setState (if any)
        // schedules a re-render, which commits a fresh tree back to the bridge.
        dispatchEvent(e.id, e.event, {
            value: e.value,
            key: e.key,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            pageX: e.pageX,
            pageY: e.pageY,
            locationX: e.locationX,
            locationY: e.locationY,
            layout: e.layout,
        });
    };

    // The reconciler calls this after every commit with the serialized tree.
    setCommitSink((tree: SerializedNode) => {
        if (!bridge) {
            bridge = startBridge(tree, bridgeOptions);
            bridge.onEvent(handleEvent);
        } else {
            bridge.update(tree);
        }
    });
    setAppearanceUpdateSink(() => {
        if (bridge) bridge.update(serializeContainer(container));
    });

    // Imperative host → frame commands (WebView.injectJavaScript / reload). Commands
    // only fire after mount, by which point the bridge exists.
    setCommandSink((cmd) => bridge?.command(cmd));

    // tag 0 = LegacyRoot → synchronous commits, so each render flushes straight
    // through resetAfterCommit into the bridge.
    const fiberRoot = (Reconciler as any).createContainer(
        container,
        0,
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

export const AppRegistry = {
    registerComponent(appKey: string, provider: ComponentProvider): string {
        registry.set(appKey, provider);
        return appKey;
    },
    runApplication(appKey: string, options: RunApplicationOptions = {}): Root {
        const provider = registry.get(appKey);
        if (!provider) throw new Error(`Application "${appKey}" has not been registered.`);
        const Component = provider();
        const { initialProps, width, height, devtools } = options;
        return render(createElement(Component, initialProps), { width, height, devtools });
    },
    getAppKeys(): string[] {
        return [...registry.keys()];
    },
};
