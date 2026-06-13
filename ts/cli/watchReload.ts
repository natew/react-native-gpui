import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";

export type WatchReloadOptions = {
    pidPath?: string;
    roots: string[];
    ignores?: string[];
    extensions?: string[];
    debounceMs?: number;
    label?: string;
};

const DEFAULT_IGNORES = ["node_modules", ".git", ".gpui-hermes", ".gpui-out", "dist"];
const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];

export async function runWatchReload(options: WatchReloadOptions): Promise<number> {
    const pidPath = options.pidPath || process.env.RNGPUI_PID_PATH;
    if (!pidPath) {
        console.error("  watch-reload needs --pid <pid-file> or RNGPUI_PID_PATH");
        return 1;
    }

    const roots = options.roots.map((root) => resolve(root)).filter((root) => existsSync(root) && statSync(root).isDirectory());
    if (roots.length === 0) {
        console.error("  watch-reload needs at least one existing --root <dir>");
        return 1;
    }

    const label = options.label || "rngpui";
    const ignores = [...DEFAULT_IGNORES, ...(options.ignores ?? [])].filter(Boolean);
    const extensions = normalizeExtensions(options.extensions?.length ? options.extensions : DEFAULT_EXTENSIONS);
    const debounceMs = options.debounceMs ?? 300;
    const watchers = new Map<string, FSWatcher>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastTrigger = "";

    const ignored = (path: string) => ignores.some((part) => path.includes(part));
    const watchDirectory = (dir: string) => {
        if (watchers.has(dir) || ignored(dir)) return;
        try {
            const watcher = watch(dir, (_event, file) => {
                const changed = file ? resolve(dir, String(file)) : dir;
                if (ignored(changed)) return;
                if (isDirectory(changed)) watchTree(changed);
                if (!matchesExtension(changed, extensions)) return;
                lastTrigger = relative(process.cwd(), changed);
                scheduleReload();
            });
            watcher.on("error", (error) => {
                console.error(`[${label}] watch error ${dir}: ${error instanceof Error ? error.message : String(error)}`);
            });
            watchers.set(dir, watcher);
        } catch (error) {
            console.error(`[${label}] cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const watchTree = (root: string) => {
        if (ignored(root)) return;
        watchDirectory(root);
        for (const entry of readdirSafe(root)) {
            const path = resolve(root, entry.name);
            if (entry.isDirectory()) watchTree(path);
        }
    };

    const signalReload = () => {
        timer = null;
        const pid = readPid(pidPath);
        if (!pid) {
            console.log(`[${label}] no live pid at ${pidPath}; skipping reload`);
            return;
        }
        try {
            process.kill(pid, "SIGUSR2");
            console.log(`[${label}] ${lastTrigger || "source change"} -> reload (SIGUSR2 -> ${pid})`);
        } catch (error) {
            console.log(`[${label}] reload signal failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const scheduleReload = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(signalReload, debounceMs);
    };

    for (const root of roots) watchTree(root);

    const shownRoots = roots.map((root) => relative(process.cwd(), root) || root).join(", ");
    console.log(`[${label}] live reload armed: ${shownRoots}`);
    console.log(`[${label}] pid: ${pidPath}`);

    process.on("SIGINT", () => closeWatchers(watchers));
    process.on("SIGTERM", () => closeWatchers(watchers));
    await new Promise(() => {});
    return 0;
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
