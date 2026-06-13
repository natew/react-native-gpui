import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { createConnection } from "node:net";
import { relative, resolve } from "node:path";

export type HotReloadOptions = {
    socketPath?: string;
    pidPath?: string;
    roots: string[];
    buildCommand?: string;
    bundlePath?: string;
    ignores?: string[];
    extensions?: string[];
    debounceMs?: number;
    label?: string;
    once?: boolean;
};

const DEFAULT_IGNORES = ["node_modules", ".git", ".gpui-hermes", ".gpui-out", "dist"];
const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];
const SOCKET_READY_TIMEOUT_MS = 5_000;

export async function runHotReload(options: HotReloadOptions): Promise<number> {
    const socketPath = options.socketPath || process.env.RNGPUI_CONTROL_SOCKET;
    if (!socketPath) {
        console.error("  hot-reload needs --socket <control.sock> or RNGPUI_CONTROL_SOCKET");
        return 1;
    }
    if (!options.buildCommand) {
        console.error("  hot-reload needs --build <shell-command>");
        return 1;
    }
    if (!options.bundlePath) {
        console.error("  hot-reload needs --bundle <bundle.js>");
        return 1;
    }

    const label = options.label || "rngpui-hot";
    const run = () => buildAndPush({ ...options, socketPath, label });
    if (options.once) return (await run()) ? 0 : 1;

    const roots = options.roots.map((root) => resolve(root)).filter((root) => existsSync(root) && statSync(root).isDirectory());
    if (roots.length === 0) {
        console.error("  hot-reload needs at least one existing --root <dir>");
        return 1;
    }

    const ignores = [...DEFAULT_IGNORES, ...(options.ignores ?? [])].filter(Boolean);
    const extensions = normalizeExtensions(options.extensions?.length ? options.extensions : DEFAULT_EXTENSIONS);
    const debounceMs = options.debounceMs ?? 220;
    const watchers = new Map<string, FSWatcher>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let building = false;
    let pending = false;
    let lastTrigger = "";

    const ignored = (path: string) => ignores.some((part) => path.includes(part));
    const schedule = (path: string) => {
        if (ignored(path) || !matchesExtension(path, extensions)) return;
        lastTrigger = relative(process.cwd(), path);
        pending = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(runPending, debounceMs);
    };
    const runPending = async () => {
        timer = null;
        if (building || !pending) return;
        pending = false;
        building = true;
        console.log(`[${label}] ${lastTrigger || "source change"} -> hot update`);
        try {
            await run();
        } catch (error) {
            console.error(`[${label}] hot update error: ${error instanceof Error ? error.message : String(error)}`);
            signalFallbackReload(options.pidPath, label);
        } finally {
            building = false;
            if (pending) void runPending();
        }
    };
    const watchDirectory = (dir: string) => {
        if (watchers.has(dir) || ignored(dir)) return;
        const watcher = watch(dir, (_event, file) => {
            const changed = file ? resolve(dir, String(file)) : dir;
            if (isDirectory(changed)) watchTree(changed);
            schedule(changed);
        });
        watcher.on("error", (error) => {
            console.error(`[${label}] watch error ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        });
        watchers.set(dir, watcher);
    };
    const watchTree = (root: string) => {
        if (ignored(root)) return;
        watchDirectory(root);
        for (const entry of readdirSafe(root)) {
            const path = resolve(root, entry.name);
            if (entry.isDirectory()) watchTree(path);
        }
    };

    for (const root of roots) watchTree(root);
    console.log(`[${label}] hot reload armed: ${roots.map((root) => relative(process.cwd(), root) || root).join(", ")}`);
    console.log(`[${label}] control socket: ${socketPath}`);
    process.on("SIGINT", () => closeWatchers(watchers));
    process.on("SIGTERM", () => closeWatchers(watchers));
    await new Promise(() => {});
    return 0;
}

async function buildAndPush(options: HotReloadOptions & { socketPath: string; label: string }) {
    const started = Date.now();
    const build = spawnSync("/bin/sh", ["-lc", options.buildCommand!], {
        cwd: process.cwd(),
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development", RNGPUI_HOT_UPDATE: "1" },
    });
    if (build.status !== 0) {
        console.error(`[${options.label}] build failed with status ${build.status}; keeping current app`);
        return false;
    }
    const bundlePath = resolve(options.bundlePath!);
    const code = readFileSync(bundlePath, "utf8");
    let response: { ok: boolean; error?: string };
    try {
        response = await requestSocketWithRetry<{ ok: boolean; error?: string }>(
            options.socketPath,
            {
                $cmd: "hotEval",
                url: bundlePath,
                code,
            },
            SOCKET_READY_TIMEOUT_MS,
        );
    } catch (error) {
        console.error(`[${options.label}] hot update request failed: ${error instanceof Error ? error.message : String(error)}`);
        signalFallbackReload(options.pidPath, options.label);
        return false;
    }
    if (response.ok) {
        console.log(`[${options.label}] hot update applied in ${Date.now() - started}ms`);
        return true;
    }
    console.error(`[${options.label}] hot update failed: ${response.error || "unknown error"}`);
    signalFallbackReload(options.pidPath, options.label);
    return false;
}

function signalFallbackReload(pidPath: string | undefined, label: string) {
    if (!pidPath) return;
    const pid = readPid(pidPath);
    if (!pid) return;
    process.kill(pid, "SIGUSR2");
    console.log(`[${label}] fallback live reload (SIGUSR2 -> ${pid})`);
}

function requestSocket<T>(socketPath: string, body: object): Promise<T> {
    return new Promise((resolveRequest, reject) => {
        const socket = createConnection(socketPath);
        let buffer = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`control request timed out on ${socketPath}`));
        }, 10_000);
        socket.on("connect", () => {
            socket.write(JSON.stringify(body) + "\n");
        });
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const idx = buffer.indexOf("\n");
            if (idx < 0) return;
            clearTimeout(timer);
            socket.end();
            resolveRequest(JSON.parse(buffer.slice(0, idx)) as T);
        });
        socket.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function requestSocketWithRetry<T>(socketPath: string, body: object, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            return await requestSocket<T>(socketPath, body);
        } catch (error) {
            if (!isTransientSocketError(error)) throw error;
            lastError = error;
            await sleep(50);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`control socket was not ready: ${socketPath}`);
}

function isTransientSocketError(error: unknown): boolean {
    const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
    return code === "ENOENT" || code === "ECONNREFUSED";
}

function sleep(ms: number) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeExtensions(values: string[]): string[] {
    return values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value.startsWith(".") ? value : `.${value}`));
}

function matchesExtension(path: string, extensions: string[]) {
    return extensions.some((extension) => path.endsWith(extension));
}

function readPid(path: string) {
    try {
        const pid = Number(readFileSync(path, "utf8").trim());
        if (!Number.isInteger(pid) || pid <= 0) return 0;
        process.kill(pid, 0);
        return pid;
    } catch {
        return 0;
    }
}

function isDirectory(path: string) {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function readdirSafe(path: string) {
    try {
        return readdirSync(path, { withFileTypes: true });
    } catch {
        return [];
    }
}

function closeWatchers(watchers: Map<string, FSWatcher>) {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    process.exit(0);
}
