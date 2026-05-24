import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Element tree types ──────────────────────────────────────────────

export type ElementNode = {
    globalId: number;
    type: "div" | "text";
    style?: Record<string, unknown>;
    text?: string;
    children?: ElementNode[];
};

// ── Runtime bridge: spawns rngpui-service ───────────────────────────

let serviceProcess: ChildProcess | null = null;

/**
 * Locate the rngpui-service binary.
 */
function findServiceBinary(): string {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(__dirname, "..", "..", "rust", "target", "release", "rngpui-service"),
        join(__dirname, "..", "..", "rust", "target", "debug", "rngpui-service"),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return join(__dirname, "..", "..", "rust", "target", "release", "rngpui-service");
}

/**
 * Spawn the GPUI service process with the given element tree.
 * The tree is serialized as JSON and piped to the process's stdin.
 */
export async function launchWindow(
    tree: ElementNode | ElementNode[],
    options?: { width?: number; height?: number }
): Promise<{ close: () => void; onEvent: (cb: (event: unknown) => void) => void }> {
    const binaryPath = findServiceBinary();

    if (!existsSync(binaryPath)) {
        throw new Error(
            `rngpui-service not found at ${binaryPath}. ` +
                "Build it first: cd rust && cargo build --release --bin rngpui-service"
        );
    }

    const rootArray: ElementNode[] = Array.isArray(tree) ? tree : [tree];
    const jsonPayload = JSON.stringify(rootArray.length === 1 ? rootArray[0] : {
        type: "div",
        globalId: 0,
        style: { width: options?.width ?? 720, height: options?.height ?? 800, backgroundColor: "#1e1e2e" },
        children: rootArray,
    });

    serviceProcess = spawn(binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    const eventCallbacks: Array<(event: unknown) => void> = [];
    const onEvent = (cb: (event: unknown) => void) => {
        eventCallbacks.push(cb);
    };

    if (serviceProcess.stdout) {
        let buffer = "";
        serviceProcess.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line);
                    for (const cb of eventCallbacks) {
                        cb(evt);
                    }
                } catch {}
            }
        });
    }

    if (serviceProcess.stderr) {
        serviceProcess.stderr.on("data", (chunk: Buffer) => {
            console.error("[rngpui]", chunk.toString().trimEnd());
        });
    }

    // Write initial tree to stdin and close it (single-render mode)
    if (serviceProcess.stdin) {
        serviceProcess.stdin.write(jsonPayload + "\n");
        serviceProcess.stdin.end();
    }

    const close = () => {
        if (serviceProcess) {
            serviceProcess.kill();
            serviceProcess = null;
        }
    };

    return { close, onEvent };
}
