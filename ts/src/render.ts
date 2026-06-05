/**
 * The render entry point. Drives react-reconciler into the GPUI bridge:
 *   React tree → reconciler → serialized node tree → startBridge → GPUI window.
 * Native events (press / changeText / layout / resize) flow back the other way.
 */
import { createElement, type ReactElement, type ComponentType } from "react";
import Reconciler, { setCommitSink, serializeContainer, dispatchEvent, type Container } from "./reconciler";
import { startBridge, type Bridge, type BridgeEvent, type SerializedNode } from "./runtime";
import { AppCommands, setCommandSink } from "./commands";
import { Dimensions } from "./Dimensions";

export interface RootOptions {
    /** initial window size; defaults to the current Dimensions window */
    width?: number;
    height?: number;
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
            bridge = startBridge(tree);
            bridge.onEvent(handleEvent);
        } else {
            bridge.update(tree);
        }
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
const registry = new Map<string, ComponentProvider>();

export const AppRegistry = {
    registerComponent(appKey: string, provider: ComponentProvider): string {
        registry.set(appKey, provider);
        return appKey;
    },
    runApplication(appKey: string, _params?: unknown): Root {
        const provider = registry.get(appKey);
        if (!provider) throw new Error(`Application "${appKey}" has not been registered.`);
        const Component = provider();
        return render(createElement(Component));
    },
    getAppKeys(): string[] {
        return [...registry.keys()];
    },
};
