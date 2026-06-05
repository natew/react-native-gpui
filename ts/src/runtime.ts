/**
 * Runtime bridge: spawns the rngpui-service GPUI process, streams element trees to
 * it as newline-delimited JSON over stdin, and parses events back over stdout.
 */
import { spawn, ChildProcess } from "child_process";
import { existsSync, writeFileSync } from "fs";
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
};

export type SerializedAccessibility = {
    accessible?: boolean;
    hidden?: boolean;
    label?: string;
    role?: string;
    hint?: string;
    value?: string;
    identifier?: string;
    disabled?: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
    expanded?: boolean;
};

export type BridgeEvent =
    | { type: "ready"; width: number; height: number }
    | { type: "resize"; width: number; height: number }
    | { type: "command"; id: string }
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
          layout?: { x: number; y: number; width: number; height: number };
      };

export interface Bridge {
    update(tree: SerializedNode): void;
    /** send an imperative command (host → frame), e.g. a WebView eval/reload */
    command(cmd: object): void;
    onEvent(cb: (e: BridgeEvent) => void): void;
    close(): void;
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

export function startBridge(initial: SerializedNode): Bridge {
    const bin = findServiceBinary();
    if (!existsSync(bin)) {
        throw new Error(`rngpui-service not found at ${bin}. Build: cd rust && cargo build --release --bin rngpui-service`);
    }

    const proc: ChildProcess = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    const listeners: Array<(e: BridgeEvent) => void> = [];

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
        if (process.env.RNGPUI_DUMP_TREE) {
            writeFileSync(process.env.RNGPUI_DUMP_TREE, JSON.stringify(obj, null, 2));
        }
        if (proc.stdin && proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + "\n");
    };
    writeLine(initial);

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
