// Host → native imperative commands. These don't go through the React commit/tree;
// the embedded Hermes runtime hands them to the native service as host calls.
// Components call `sendCommand`; the render layer wires the sink to the bridge.
import type { SerializedTerminalFrame } from "./runtime";

export type AppCommandBinding = {
    id: string;
    key: string;
    context?: string;
};

export type AppCommandMenuItem =
    | { kind: "action"; id: string; label: string }
    | { kind: "separator" }
    | { kind: "submenu"; label: string; items: AppCommandMenuItem[] };

export type NativeMenuCommandItem =
    | {
          kind: "action";
          id: string;
          label: string;
          disabled?: boolean;
          checked?: boolean;
          destructive?: boolean;
      }
    | { kind: "label"; label: string }
    | { kind: "separator" }
    | { kind: "submenu"; label: string; disabled?: boolean; items: NativeMenuCommandItem[] };

export type AppCommandMenu = {
    label: string;
    items: AppCommandMenuItem[];
};

export type AppCommandConfig = {
    bindings: AppCommandBinding[];
    menus: AppCommandMenu[];
};

export type Command =
    // sent once by createRoot, before the first render, so the host can open its
    // window concurrently with that render instead of after it.
    | { $cmd: "windowSize"; width: number; height: number }
    | { $cmd: "eval"; id: number; js: string }
    | { $cmd: "reload"; id: number }
    | { $cmd: "scrollTo"; id: number; x?: number; y?: number }
    | { $cmd: "scrollToEnd"; id: number }
    | {
          $cmd: "terminalSession";
          id: number;
          sessionId: string;
          frames: SerializedTerminalFrame[];
      }
    | {
          $cmd: "nativeLayout";
          key: string;
          width?: number;
          height?: number;
          x?: number;
          y?: number;
          animateMs?: number;
          clear?: boolean;
      }
    | { $cmd: "focusInput"; id: number }
    | { $cmd: "clearInput"; id: number }
    | { $cmd: "blurInput"; id: number }
    | { $cmd: "dockBadge"; label: string }
    | { $cmd: "requestAttention"; critical?: boolean }
    | { $cmd: "openWindow" }
    | { $cmd: "appTint"; color: string | null }
    | {
          $cmd: "nativeContextMenu";
          x: number;
          y: number;
          items: NativeMenuCommandItem[];
          closeId?: string;
      }
    | { $cmd: "clipboardWrite"; text: string }
    | ({ $cmd: "appCommands" } & AppCommandConfig);

let sink: ((cmd: Command) => void) | null = null;
let lastAppCommandConfig = "";
const appCommandListeners = new Set<(id: string) => void>();
const nativeMenuCallbacks = new Map<string, () => void>();
let nextNativeMenuCallbackId = 1;

export function setCommandSink(fn: (cmd: Command) => void) {
    sink = fn;
}

export function sendCommand(cmd: Command) {
    sink?.(cmd);
}

export type NativeLayoutAnimationOptions = {
    animateMs?: number;
};

export const NativeLayout = {
    setSize(key: string, size: { width?: number; height?: number; x?: number; y?: number }, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, ...size, ...options });
    },

    setFrame(key: string, frame: { width?: number; height?: number; x?: number; y?: number }, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, ...frame, ...options });
    },

    setWidth(key: string, width: number, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, width, ...options });
    },

    setHeight(key: string, height: number, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, height, ...options });
    },

    setX(key: string, x: number, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, x, ...options });
    },

    animateSize(key: string, size: { width?: number; height?: number; x?: number; y?: number }, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, ...size, animateMs });
    },

    animateFrame(key: string, frame: { width?: number; height?: number; x?: number; y?: number }, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, ...frame, animateMs });
    },

    animateWidth(key: string, width: number, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, width, animateMs });
    },

    animateHeight(key: string, height: number, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, height, animateMs });
    },

    animateX(key: string, x: number, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, x, animateMs });
    },

    clear(key: string) {
        sendCommand({ $cmd: "nativeLayout", key, clear: true });
    },
};

// macOS dock affordances over the host-command channel (no async reply). The
// native service sets NSApp.dockTile.badgeLabel and fires NSApp requestUserAttention.
export const Dock = {
    // pass null/"" to clear the badge.
    setBadge(label: string | null) {
        sendCommand({ $cmd: "dockBadge", label: label ?? "" });
    },

    // dock bounce. macOS only fires it when the app is not the active app.
    requestAttention(critical = false) {
        sendCommand({ $cmd: "requestAttention", critical });
    },
};

// open a new native window (macOS/GPUI: spawns a new process of the same app).
// on platforms without native multi-window, this is a no-op.
export const NativeWindow = {
    open() {
        sendCommand({ $cmd: "openWindow" });
    },

    // Tint the app background: the bottom-most layer of the window, BELOW the glass
    // blur, the Metal chrome, the WebView underlay, and every drop shadow. That is
    // what makes it the right way to give translucent chrome a tone — an opaque fill
    // on a chrome element sits above the stage's shadow gutter and clips the shadow.
    //
    // Pass a translucent color to keep the desktop blur reading through (a frost), an
    // opaque one for a solid shell, or null for raw glass. Themed apps should call
    // this whenever the color scheme changes; the RNGPUI_APP_TINT env var seeds the
    // same layer at launch but is read once and cannot follow a theme.
    setTint(color: string | null) {
        sendCommand({ $cmd: "appTint", color });
    },
};

export const NativeClipboard = {
    setString(text: string) {
        sendCommand({ $cmd: "clipboardWrite", text });
    },
};

export const NativeMenus = {
    showContextMenu({
        x,
        y,
        items,
        closeId,
    }: {
        x: number;
        y: number;
        items: NativeMenuCommandItem[];
        closeId?: string;
    }) {
        sendCommand({ $cmd: "nativeContextMenu", x, y, items, closeId });
    },

    registerCallback(callback: () => void) {
        const id = `native-menu:${nextNativeMenuCallbackId++}`;
        nativeMenuCallbacks.set(id, callback);
        return id;
    },

    unregisterCallback(id: string) {
        nativeMenuCallbacks.delete(id);
    },

    _emit(id: string) {
        const callback = nativeMenuCallbacks.get(id);
        if (!callback) return false;
        callback();
        return true;
    },
};

export const AppCommands = {
    configure(config: AppCommandConfig) {
        const serialized = JSON.stringify(config);
        if (serialized === lastAppCommandConfig) return;
        lastAppCommandConfig = serialized;
        sendCommand({ $cmd: "appCommands", ...config });
    },

    addListener(listener: (id: string) => void) {
        appCommandListeners.add(listener);
        return () => {
            appCommandListeners.delete(listener);
        };
    },

    _emit(id: string) {
        for (const listener of appCommandListeners) listener(id);
    },
};
