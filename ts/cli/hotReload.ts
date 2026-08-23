import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { createConnection } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";

export type HotReloadOptions = {
    socketPath?: string;
    roots: string[];
    entryPath?: string;
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
const BUNDLE_SCRIPT = join(import.meta.dirname, "..", "scripts", "bundle-hermes.mjs");

export async function runHotReload(options: HotReloadOptions): Promise<number> {
    const socketPath = options.socketPath || process.env.RNGPUI_CONTROL_SOCKET;
    if (!socketPath) {
        console.error("  dev needs --socket <control.sock> or RNGPUI_CONTROL_SOCKET");
        return 1;
    }
    if (!options.buildCommand && !options.entryPath) {
        console.error("  dev needs --launch <entry.tsx> or --build <shell-command>");
        return 1;
    }
    if (!options.bundlePath) {
        console.error("  dev needs --bundle <bundle.js>");
        return 1;
    }

    const label = options.label || "rngpui-hot";
    const run = () => buildAndPush({ ...options, socketPath, label });
    if (options.once) return (await run()) ? 0 : 1;

    const roots = [
        ...new Set(options.roots.map((root) => resolve(root)).filter((root) => existsSync(root) && statSync(root).isDirectory())),
    ];
    if (roots.length === 0) {
        console.error("  dev needs at least one existing --root <dir>");
        return 1;
    }

    const ignores = new Set([...DEFAULT_IGNORES, ...(options.ignores ?? [])].filter(Boolean));
    const extensions = new Set(normalizeExtensions(options.extensions?.length ? options.extensions : DEFAULT_EXTENSIONS));
    const debounceMs = options.debounceMs ?? 80;
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let building = false;
    let pending = false;
    let lastTrigger = "";

    const ignored = (path: string) => path.split(sep).some((part) => ignores.has(part));
    const schedule = (path: string) => {
        if (ignored(path) || !extensions.has(extname(path))) return;
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
        } finally {
            building = false;
            if (pending) void runPending();
        }
    };
    for (const root of roots) {
        const watcher = watch(root, { recursive: true }, (_event, file) => {
            if (file) schedule(resolve(root, String(file)));
        });
        watcher.on("error", (error) => {
            console.error(`[${label}] watch error ${root}: ${error instanceof Error ? error.message : String(error)}`);
        });
        watchers.push(watcher);
    }

    console.log(`[${label}] Fast Refresh armed: ${roots.map((root) => relative(process.cwd(), root) || root).join(", ")}`);
    console.log(`[${label}] control socket: ${socketPath}`);
    await new Promise<void>((resolveDone) => {
        const close = () => {
            closeWatchers(watchers);
            resolveDone();
        };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
    });
    return 0;
}

async function buildAndPush(options: HotReloadOptions & { socketPath: string; label: string }) {
    const started = Date.now();
    const env = { ...process.env, NODE_ENV: "development", RNGPUI_HOT_UPDATE: "1" };
    const status = options.entryPath
        ? await runProcess(process.execPath, [BUNDLE_SCRIPT, resolve(options.entryPath), resolve(options.bundlePath!)], env)
        : await runProcess("/bin/sh", ["-lc", options.buildCommand!], env);
    if (status !== 0) {
        console.error(`[${options.label}] build failed with status ${status}; current app remains active`);
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
        return false;
    }
    if (response.ok) {
        console.log(`[${options.label}] hot update applied in ${Date.now() - started}ms`);
        return true;
    }
    console.error(`[${options.label}] hot update failed: ${response.error || "unknown error"}`);
    return false;
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolveStatus, reject) => {
        const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit", env });
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveStatus(code ?? (signal ? 1 : 0)));
    });
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

function closeWatchers(watchers: FSWatcher[]) {
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
}
