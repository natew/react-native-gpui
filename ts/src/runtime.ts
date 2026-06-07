/**
 * Runtime bridge: spawns the rngpui-service GPUI process, streams element trees to
 * it as newline-delimited JSON over stdin, and parses events back over stdout.
 */
import { spawn, ChildProcess } from "child_process";
import { createReadStream, existsSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
    /** Enables the native Option-key element inspector in the service process. */
    inspector?: boolean;
}

function findServiceBinary(): string {
    // explicit override wins
    const env = process.env.RNGPUI_SERVICE;
    if (env && existsSync(env)) return env;

    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        // packaged: the binary is copied next to the build output (dist/ or src/)
        join(here, "native", "rngpui-service"),
        join(here, "..", "native", "rngpui-service"),
        // dev: built straight from the workspace's rust crate
        join(here, "..", "..", "rust", "target", "release", "rngpui-service"),
        join(here, "..", "..", "rust", "target", "debug", "rngpui-service"),
    ];
    for (const p of candidates) if (existsSync(p)) return p;
    return candidates[0];
}

export function startBridge(initial: SerializedNode, options: BridgeOptions = {}): Bridge {
    const bin = findServiceBinary();
    if (!existsSync(bin)) {
        throw new Error(`rngpui-service not found at ${bin}. Build: cd rust && cargo build --release --bin rngpui-service`);
    }

    const env = { ...process.env };
    if (options.inspector) env.RNGPUI_INSPECTOR = "1";
    const proc: ChildProcess = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env });
    const listeners: Array<(e: BridgeEvent) => void> = [];
    if (process.env.RNGPUI_SERVICE_PID_FILE && proc.pid) {
        writeFileSync(process.env.RNGPUI_SERVICE_PID_FILE, `${proc.pid}\n`);
    }

    if (proc.stdout) {
        let buf = "";
        proc.stdout.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line) as BridgeEvent;
                    for (const cb of listeners) cb(evt);
                } catch {
                    /* ignore non-JSON log lines */
                }
            }
        });
    }
    if (proc.stderr) {
        proc.stderr.on("data", (c: Buffer) => process.stderr.write(c));
    }
    proc.on("exit", () => process.exit(0));

    const writeLine = (obj: object) => {
        if (process.env.RNGPUI_DUMP_TREE && isSerializedNode(obj)) {
            writeFileSync(process.env.RNGPUI_DUMP_TREE, JSON.stringify(obj, null, 2));
        }
        if (proc.stdin && proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + "\n");
    };
    writeLine(initial);

    // Control channel for the `rngpui` developer CLI: when RNGPUI_CONTROL_FIFO points
    // at a named pipe, every JSON line written to it is forwarded straight to the
    // service stdin (dump / tap / type / scroll commands), and the service's stdout
    // events are mirrored to RNGPUI_CONTROL_EVENTS so the CLI can await acks
    // (dumpReady) without owning the service's pipes. This is the single hook that
    // makes a launched host driveable; absent the env var it is inert.
    const controlFifo = process.env.RNGPUI_CONTROL_FIFO;
    if (controlFifo && existsSync(controlFifo)) {
        const eventsPath = process.env.RNGPUI_CONTROL_EVENTS;
        if (eventsPath) {
            listeners.push((evt) => {
                try {
                    writeFileSync(eventsPath, JSON.stringify(evt) + "\n", { flag: "a" });
                } catch {
                    /* events file may be rotated by the CLI between commands */
                }
            });
        }
        const pumpControl = () => {
            const rl = createInterface({ input: createReadStream(controlFifo), crlfDelay: Infinity });
            rl.on("line", (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                try {
                    writeLine(JSON.parse(trimmed));
                } catch {
                    /* ignore non-JSON control lines */
                }
            });
            // a fifo returns EOF when the last writer closes; reopen so subsequent CLI
            // commands keep flowing to the same long-lived host.
            rl.on("close", () => setTimeout(pumpControl, 10));
        };
        pumpControl();
    }

    return {
        update: writeLine,
        command: writeLine,
        onEvent: (cb) => listeners.push(cb),
        close: () => {
            if (proc.stdin) proc.stdin.end();
            proc.kill();
        },
    };
}

function isSerializedNode(obj: object): obj is SerializedNode {
    const node = obj as Partial<SerializedNode>;
    return typeof node.globalId === "number" && typeof node.type === "string";
}
