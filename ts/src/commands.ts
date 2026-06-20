// Host → native imperative commands. These don't go through the React commit/tree;
// the embedded Hermes runtime hands them to the native service as host calls.
// Components call `sendCommand`; the render layer wires the sink to the bridge.
export type AppCommandBinding = {
    id: string;
    key: string;
    context?: string;
};

export type AppCommandMenuItem =
    | { kind: "action"; id: string; label: string }
    | { kind: "separator" }
    | { kind: "submenu"; label: string; items: AppCommandMenuItem[] };

export type AppCommandMenu = {
    label: string;
    items: AppCommandMenuItem[];
};

export type AppCommandConfig = {
    bindings: AppCommandBinding[];
    menus: AppCommandMenu[];
};

export type Command =
    | { $cmd: "eval"; id: number; js: string }
    | { $cmd: "reload"; id: number }
    | { $cmd: "scrollTo"; id: number; x?: number; y?: number }
    | { $cmd: "scrollToEnd"; id: number }
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
    | { $cmd: "blurInput"; id: number }
    | { $cmd: "dockBadge"; label: string }
    | { $cmd: "requestAttention"; critical?: boolean }
    | { $cmd: "openWindow" }
    | ({ $cmd: "appCommands" } & AppCommandConfig);

let sink: ((cmd: Command) => void) | null = null;
let lastAppCommandConfig = "";
const appCommandListeners = new Set<(id: string) => void>();

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
