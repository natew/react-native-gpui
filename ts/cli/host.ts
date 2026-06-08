// Launch / attach plumbing for the `rngpui` developer CLI.
//
// The only launch model is the Hermes one-process host:
//   entry.tsx -> bundle-hermes.mjs -> app.hbc -> rngpui-service
//
// Bun is used as a compiler only. The app runtime is always the Rust service with
// embedded Hermes, and debug commands go over RNGPUI_CONTROL_SOCKET.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { captureWindow, listWindows, sleep, waitForServicePid, waitForWindow } from "../scripts/conformance-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const tsRoot = resolve(here, "..");

export interface GpuiWindow {
    id: number;
    window_id: number;
    pid: number;
    owner: string;
    title: string;
    layer: number;
    x: number;
    y: number;
    width: number;
    height: number;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface LaunchedHost {
    mode: "launch";
    pid: number;
    servicePid: number;
    window: GpuiWindow;
    sessionDir: string;
    appName: string;
    request<T = unknown>(cmd: object): Promise<T>;
    dump(): Promise<DumpNode>;
    capture(path: string): void;
    close(): void;
}

export interface AttachedHost {
    mode: "attach";
    servicePid: number;
    window: GpuiWindow;
    capture(path: string): void;
    dump(): Promise<DumpNode | null>;
    close(): void;
}

export type DumpNode = {
    globalId: number;
    type: string;
    text?: string;
    value?: string;
    src?: string;
    events?: string[];
    accessibility?: {
        identifier?: string;
        testID?: string;
        nativeID?: string;
        label?: string;
        role?: string;
    };
    bounds?: { x: number; y: number; width: number; height: number };
    style?: Record<string, unknown>;
    children?: DumpNode[];
    nativeListGroup?: string;
};

type SessionMeta = {
    version: 1;
    servicePid: number;
    socketPath: string;
    capturePath: string;
    bundlePath: string;
    appName: string;
    size: string;
};

type LaunchOptions = {
    size?: string;
    bundle?: string;
    keep?: boolean;
};

function serviceBinary() {
    const binary = resolve(process.env.RNGPUI_SERVICE || resolve(tsRoot, "..", "rust", "target", "release", "rngpui-service"));
    if (!existsSync(binary)) throw new Error(`rngpui-service not found: ${binary}`);
    stageServiceDylibs(binary);
    return binary;
}

function stageServiceDylibs(binary: string) {
    const releaseDir = dirname(binary);
    const hermesRoot = resolve(process.env.HERMES_ROOT || "/Users/n8/github/hermes");
    const hermesDylib = resolve(hermesRoot, "build", "lib", "libhermesvm.dylib");
    if (!existsSync(hermesDylib)) throw new Error(`libhermesvm.dylib not found: ${hermesDylib}`);
    copyFileSync(hermesDylib, join(releaseDir, "libhermesvm.dylib"));

    const ghostty = findDylibs(resolve(tsRoot, "..", "rust", "target", "release", "build"), "libghostty-vt");
    if (ghostty.length === 0) throw new Error("libghostty-vt dylib not found under rust/target/release/build");
    for (const dylib of ghostty) copyFileSync(dylib, join(releaseDir, dylib.split("/").pop() || "libghostty-vt.dylib"));
}

function findDylibs(dir: string, prefix: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop()!;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) stack.push(path);
            else if (entry.name.endsWith(".dylib") && entry.name.startsWith(prefix)) out.push(path);
        }
    }
    return out;
}

function bundleEntry(entry: string, workdir: string) {
    const entryPath = resolve(entry);
    if (!existsSync(entryPath)) throw new Error(`entry not found: ${entryPath}`);
    const outJs = join(workdir, "app.js");
    const result = spawnSync("bun", ["scripts/bundle-hermes.mjs", entryPath, outJs, "--bytecode"], {
        cwd: tsRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
    });
    if (result.status !== 0) {
        throw new Error(`bundle-hermes failed\n${result.stdout}\n${result.stderr}`);
    }
    const outHbc = outJs.replace(/\.js$/, ".hbc");
    if (!existsSync(outHbc)) throw new Error(`bundle-hermes did not write ${outHbc}`);
    return outHbc;
}

function writeSession(dir: string, meta: SessionMeta) {
    writeFileSync(join(dir, "session.json"), JSON.stringify(meta, null, 2));
}

function readSession(dir: string): SessionMeta {
    const path = join(resolve(dir), "session.json");
    if (!existsSync(path)) throw new Error(`session metadata not found: ${path}`);
    return JSON.parse(readFileSync(path, "utf8")) as SessionMeta;
}

function assertAlive(pid: number) {
    try {
        process.kill(pid, 0);
    } catch {
        throw new Error(`rngpui service pid ${pid} is not running`);
    }
}

export async function launchHost(entry: string, opts: LaunchOptions = {}): Promise<LaunchedHost> {
    const workdir = mkdtempSync(join(tmpdir(), "rngpui-cli-"));
    const stamp = `${process.pid}-${Date.now().toString(36)}`;
    const appName = `rngpui-cli-${stamp}`;
    const pidPath = join(workdir, "service.pid");
    const socketPath = join(workdir, "control.sock");
    const capturePath = join(workdir, "frame.png");
    const size = opts.size ?? "1280x860";
    const [w, h] = size.split("x").map((value) => parseInt(value, 10));
    const bundlePath = opts.bundle ? resolve(opts.bundle) : bundleEntry(entry, workdir);
    if (!existsSync(bundlePath)) throw new Error(`bundle not found: ${bundlePath}`);

    const child = spawn(serviceBinary(), [], {
        cwd: tsRoot,
        env: {
            ...process.env,
            RNGPUI_BUNDLE: bundlePath,
            RNGPUI_NO_ACTIVATE: "1",
            RNGPUI_TEST_MODE: "1",
            RNGPUI_CAPTURE_ONSCREEN: "1",
            RNGPUI_OPAQUE_WINDOW: "1",
            RNGPUI_CAPTURE_ALPHA: process.env.RNGPUI_CAPTURE_ALPHA || "0.2",
            RNGPUI_WINDOW_SIZE: `${w},${h}`,
            RNGPUI_CAPTURE_PNG: capturePath,
            RNGPUI_SERVICE_PID_FILE: pidPath,
            RNGPUI_CONTROL_SOCKET: socketPath,
            RNGPUI_APP_NAME: appName,
        },
        stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr?.on("data", (chunk) => (log += chunk));

    const fail = (message: string): never => {
        killPidFile(pidPath);
        try {
            child.kill("SIGTERM");
        } catch {
            /* already gone */
        }
        rmSync(workdir, { recursive: true, force: true });
        throw new Error(`${message}\n--- host log tail ---\n${log.split("\n").slice(-30).join("\n")}`);
    };

    let servicePid = 0;
    try {
        servicePid = await waitForServicePid(pidPath, {
            timeoutMs: 20_000,
            isFixtureExited: () => child.exitCode != null,
        });
    } catch (error) {
        fail(`service did not start: ${(error as Error).message}`);
    }

    let window: GpuiWindow;
    try {
        window = (await waitForWindow((win: GpuiWindow) => win.pid === servicePid && win.title === "react-native-gpui", {
            timeoutMs: 15_000,
            isFixtureExited: () => child.exitCode != null,
        })) as GpuiWindow;
    } catch (error) {
        const seen = (listWindows() as GpuiWindow[])
            .map((win) => `${win.owner}/"${win.title}"/pid${win.pid}/${win.width}x${win.height}`)
            .join("  ");
        fail(`window did not appear: ${(error as Error).message} [wanted pid ${servicePid}; saw: ${seen}]`);
    }

    await waitForSocket(socketPath, () => child.exitCode != null);
    await sleep(500);

    const meta: SessionMeta = {
        version: 1,
        servicePid,
        socketPath,
        capturePath,
        bundlePath,
        appName,
        size,
    };
    writeSession(workdir, meta);
    return makeLaunchedHost({
        child,
        meta,
        sessionDir: workdir,
        window,
        ownsProcess: true,
        keepOnClose: opts.keep === true,
    });
}

export async function attachSession(sessionDir: string): Promise<LaunchedHost> {
    const meta = readSession(sessionDir);
    assertAlive(meta.servicePid);
    await waitForSocket(meta.socketPath);
    const window = (currentWindow(meta.servicePid) ??
        ((await waitForWindow((win: GpuiWindow) => win.pid === meta.servicePid && win.title === "react-native-gpui", {
            timeoutMs: 5_000,
        })) as GpuiWindow)) as GpuiWindow;
    return makeLaunchedHost({
        child: null,
        meta,
        sessionDir: resolve(sessionDir),
        window,
        ownsProcess: false,
        keepOnClose: true,
    });
}

export function closeSession(sessionDir: string) {
    const dir = resolve(sessionDir);
    const meta = readSession(dir);
    killPid(meta.servicePid);
    rmSync(dir, { recursive: true, force: true });
}

function makeLaunchedHost({
    child,
    meta,
    sessionDir,
    window,
    ownsProcess,
    keepOnClose,
}: {
    child: ChildProcess | null;
    meta: SessionMeta;
    sessionDir: string;
    window: GpuiWindow;
    ownsProcess: boolean;
    keepOnClose: boolean;
}): LaunchedHost {
    return {
        mode: "launch",
        pid: child?.pid ?? meta.servicePid,
        servicePid: meta.servicePid,
        window,
        sessionDir,
        appName: meta.appName,
        request<T = unknown>(cmd: object) {
            return requestSocket<T>(meta.socketPath, cmd);
        },
        async dump() {
            const response = await requestSocket<{ ok: boolean; tree?: DumpNode; error?: string }>(meta.socketPath, { $cmd: "dump" });
            if (!response.ok || !response.tree) throw new Error(response.error || "dump failed");
            return response.tree;
        },
        capture(path: string) {
            waitForCapture(meta.capturePath, path);
        },
        close() {
            if (keepOnClose) return;
            if (ownsProcess) killPid(meta.servicePid);
            try {
                child?.kill("SIGTERM");
            } catch {
                /* already gone */
            }
            rmSync(sessionDir, { recursive: true, force: true });
        },
    };
}

export async function attachHost(): Promise<AttachedHost> {
    const candidates = listWindows()
        .filter((window: GpuiWindow) => window.title === "react-native-gpui" && window.owner !== "agentbus-gpui-user")
        .sort((a: GpuiWindow, b: GpuiWindow) => b.width * b.height - a.width * a.height);
    if (candidates.length === 0) {
        throw new Error("no running rngpui window found; launch one with --launch <entry.tsx> or --bundle <app.hbc>");
    }
    const window = candidates[0];
    return {
        mode: "attach",
        servicePid: window.pid,
        window,
        capture(path: string) {
            const fresh = currentWindow(window.pid) ?? window;
            captureWindow(fresh, path);
        },
        async dump() {
            return null;
        },
        close() {
            /* read-only: never touch a process we do not own */
        },
    };
}

export function currentWindow(servicePid: number): GpuiWindow | null {
    return (
        (listWindows() as GpuiWindow[])
            .filter((window) => window.pid === servicePid && window.title === "react-native-gpui")
            .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
    );
}

function requestSocket<T>(socketPath: string, cmd: object): Promise<T> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`debug command timed out on ${socketPath}`));
        }, 10_000);
        socket.on("connect", () => {
            socket.write(JSON.stringify(cmd) + "\n");
        });
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const idx = buffer.indexOf("\n");
            if (idx >= 0) {
                clearTimeout(timer);
                socket.end();
                try {
                    resolve(JSON.parse(buffer.slice(0, idx)) as T);
                } catch (error) {
                    reject(error);
                }
            }
        });
        socket.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.on("end", () => {
            if (!buffer.trim()) {
                clearTimeout(timer);
                reject(new Error("debug socket closed without a response"));
            }
        });
    });
}

async function waitForSocket(path: string, exited?: () => boolean) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        if (existsSync(path)) return;
        if (exited?.()) break;
        await sleep(25);
    }
    throw new Error(`timed out waiting for control socket at ${path}`);
}

function waitForCapture(source: string, target: string) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
        if (existsSync(source) && statSync(source).size > 0) {
            execSyncSleep(300);
            mkdirSync(dirname(target), { recursive: true });
            copyFileSync(source, target);
            return;
        }
        execSyncSleep(120);
    }
    throw new Error("in-service capture produced no frame (RNGPUI_CAPTURE_PNG)");
}

function execSyncSleep(ms: number) {
    try {
        execFileSync("sleep", [String(ms / 1000)]);
    } catch {
        /* ignore */
    }
}

function killPidFile(path: string) {
    try {
        const pid = Number(readFileSync(path, "utf8").trim());
        if (Number.isFinite(pid) && pid > 0) killPid(pid);
    } catch {
        /* no pid yet */
    }
}

function killPid(pid: number) {
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        /* already gone */
    }
}
