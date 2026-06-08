/**
 * Runtime bridge — in-process host calls to the embedded Hermes host (rust/src/hermes.rs).
 *
 * Single-process model: this code runs inside Hermes on the JS thread; the Rust binary owns
 * the GPUI/Metal main thread. Instead of spawning a service and streaming NDJSON over pipes,
 * every committed tree is handed to the host fn `globalThis.__rngpui_applyTree(json)`, and
 * native events arrive by the host calling `globalThis.__rngpui_onHostEvent(json)`.
 *
 * The JSON tree/event protocol is unchanged from the old stdio bridge — only the transport.
 */

export type SerializedNode = {
    globalId: number;
    type: string;
    style?: Record<string, unknown>;
    accessibility?: SerializedAccessibility;
    text?: string;
    numberOfLines?: number;
    value?: string;
    editable?: boolean;
    secureTextEntry?: boolean;
    src?: string;
    name?: string;
    placeholder?: string;
    events?: string[];
    children?: SerializedNode[];
    /** inline styled runs for `<Text>` with nested `<Text>` children */
    runs?: Array<{ text: string; fontWeight?: string; color?: string; fontStyle?: string }>;
    /** native-only layout override key, used by the gpui runtime without React commits */
    nativeLayoutKey?: string;
    /** native-only resize gesture, applied to a keyed native layout target */
    nativeResize?: SerializedNativeResize;
    /** native-only press-drag selection group */
    nativeListGroup?: string;
    /** native terminal session key; changing it resets the native Ghostty parser */
    terminalSessionId?: string;
    /** ordered terminal frames consumed by the native Ghostty terminal element */
    terminalFrames?: SerializedTerminalFrame[];
};

export type SerializedTerminalFrame = {
    seq: number;
    kind: "snapshot" | "bytes" | "resize";
    data?: string;
    cols?: number;
    rows?: number;
};

export type SerializedNativeResize = {
    target: string;
    edge: "left" | "right" | "top" | "bottom";
    min?: number;
    max?: number;
};

export type SerializedAccessibility = {
    accessible?: boolean;
    hidden?: boolean;
    label?: string;
    role?: string;
    hint?: string;
    value?: string;
    identifier?: string;
    identifierSource?: "nativeID" | "testID" | "id";
    nativeID?: string;
    testID?: string;
    propID?: string;
    disabled?: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
    expanded?: boolean;
};

export type BridgeEvent =
    | { type: "ready"; width: number; height: number }
    | { type: "resize"; width: number; height: number }
    | { type: "command"; id: string }
    | { type: "appearance"; colorScheme: "light" | "dark" }
    | {
          type: "event";
          id: number;
          event: string;
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
          layout?: { x: number; y: number; width: number; height: number };
      };

export interface Bridge {
    update(tree: SerializedNode): void;
    /** send an imperative command (host → frame), e.g. a WebView eval/reload */
    command(cmd: object): void;
    onEvent(cb: (e: BridgeEvent) => void): void;
    close(): void;
}

export interface BridgeOptions {
    /** Enables the native Option-key element inspector in the host. */
    inspector?: boolean;
}

// host fns installed by the Rust host before this bundle is evaluated.
declare const __rngpui_applyTree: (json: string) => void;
declare const __rngpui_close: (() => void) | undefined;

// the host batches high-frequency events (resize/layout/scroll/move during a window
// resize or drag) into one call; this wraps their dispatch in a single React update so a
// flood produces ONE re-render, not one per event. render.ts injects the reconciler's
// batchedUpdates here. Without it (or for single events) dispatch is direct.
let eventBatcher: ((run: () => void) => void) | undefined;
export function setEventBatcher(fn: ((run: () => void) => void) | undefined): void {
    eventBatcher = fn;
}

export function startBridge(initial: SerializedNode, options: BridgeOptions = {}): Bridge {
    const listeners: Array<(e: BridgeEvent) => void> = [];

    const deliver = (evt: BridgeEvent) => {
        for (const cb of listeners) cb(evt);
    };

    // the host (Rust) calls this on the JS thread to deliver a single native event.
    (globalThis as any).__rngpui_onHostEvent = (json: string) => {
        let evt: BridgeEvent;
        try {
            evt = JSON.parse(json) as BridgeEvent;
        } catch {
            return;
        }
        deliver(evt);
    };

    // ...and this to deliver a coalesced batch of events as one React update.
    (globalThis as any).__rngpui_onHostEventBatch = (jsonArray: string) => {
        let arr: BridgeEvent[];
        try {
            arr = JSON.parse(jsonArray) as BridgeEvent[];
        } catch {
            return;
        }
        const run = () => {
            for (const evt of arr) deliver(evt);
        };
        if (eventBatcher) eventBatcher(run);
        else run();
    };

    const send = (obj: object) => {
        __rngpui_applyTree(JSON.stringify(obj));
    };

    // push the first tree during bundle evaluation so the native host can size the window.
    send(initial);
    if (options.inspector) {
        send({ $cmd: "inspector", enabled: true });
    }

    return {
        update: send,
        command: send,
        onEvent: (cb) => listeners.push(cb),
        close: () => {
            if (typeof __rngpui_close === "function") __rngpui_close();
        },
    };
}
