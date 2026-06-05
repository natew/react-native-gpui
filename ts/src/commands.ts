// Host → native imperative commands. These don't go through the React commit/tree;
// they're sent straight to the service over stdin and applied by the native app.
// The render layer wires the sink to the bridge; components call `sendCommand`.
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
          animateMs?: number;
          clear?: boolean;
      }
    | { $cmd: "focusInput"; id: number }
    | { $cmd: "blurInput"; id: number }
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
    setSize(key: string, size: { width?: number; height?: number }, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, ...size, ...options });
    },

    setWidth(key: string, width: number, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, width, ...options });
    },

    setHeight(key: string, height: number, options?: NativeLayoutAnimationOptions) {
        sendCommand({ $cmd: "nativeLayout", key, height, ...options });
    },

    animateSize(key: string, size: { width?: number; height?: number }, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, ...size, animateMs });
    },

    animateWidth(key: string, width: number, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, width, animateMs });
    },

    animateHeight(key: string, height: number, animateMs = 180) {
        sendCommand({ $cmd: "nativeLayout", key, height, animateMs });
    },

    clear(key: string) {
        sendCommand({ $cmd: "nativeLayout", key, clear: true });
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
