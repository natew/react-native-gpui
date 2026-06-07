// Launch / attach plumbing for the `rngpui` developer CLI.
//
// Two target modes, exactly like sootsim's open-vs-capture split:
//   --launch <entry.tsx>  spawn an offscreen, non-activating host that runs the entry,
//                         own its control channel, and drive + dump it on demand.
//   --attach              find the running rngpui-service window and capture its pixels
//                         read-only (no driving, no on-demand dump — we don't own its
//                         stdin). describe/color still work off a fresh window capture.
//
// All launches are forced offscreen + non-activating per repo policy: no foreground GUI.

import { spawn, type ChildProcess } from "node:child_process";
import {
    closeSync,
    copyFileSync,
    existsSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
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
    appName: string;
    /** send one JSON command to the running service via the control fifo */
    send(cmd: object): void;
    /** request a fresh annotated dump (authored facts + computed bounds) and read it */
    dump(): Promise<DumpNode>;
    /** capture the window to a PNG path */
    capture(path: string): void;
    close(): void;
}

export interface AttachedHost {
    mode: "attach";
    servicePid: number;
    window: GpuiWindow;
    /** capture the window to a PNG path */
    capture(path: string): void;
    /** the most recent JS-side RNGPUI_DUMP_TREE if one is discoverable, else null */
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

function makeFifo(path: string) {
    rmSync(path, { force: true });
    execFileSync("mkfifo", [path]);
}

// Launch an offscreen host running `entry`, own its control channel, wait for the
// window + service to come up.
export async function launchHost(
    entry: string,
    opts: { size?: string; launchCmd?: string; cwd?: string } = {},
): Promise<LaunchedHost> {
    // --launch-cmd lets the CLI drive ANY rngpui app via its own bundler/launcher
    // (e.g. agentbus' open-gpui), as long as that launcher forwards the control env
    // (RNGPUI_CONTROL_FIFO/EVENTS/SERVICE_PID_FILE) to the shared runtime. Plain
    // entries still use `bun run` from tsRoot.
    const launchCwd = opts.cwd ? resolve(opts.cwd) : tsRoot;
    const entryPath = opts.launchCmd ? "" : resolve(entry);
    if (!opts.launchCmd && !existsSync(entryPath)) throw new Error(`entry not found: ${entryPath}`);

    const stamp = `${process.pid}-${Date.now().toString(36)}`;
    const appName = `rngpui-cli-${stamp}`;
    const workdir = mkdtempSync(join(tmpdir(), "rngpui-cli-"));
    const pidPath = join(workdir, "service.pid");
    const fifoPath = join(workdir, "control.fifo");
    const eventsPath = join(workdir, "events.ndjson");
    const dumpPath = join(workdir, "dump.json");
    // In-service full-opacity capture: the service writes this PNG every ~250ms via
    // CGWindowListCreateImage + divide-out-alpha (the only path that recovers the real
    // rendered chrome from an invisible non-activating window — cua-driver's grab of
    // the alpha~0 window comes back transparent). See rust/src/capture_png.rs.
    const capturePath = join(workdir, "frame.png");
    makeFifo(fifoPath);
    writeFileSync(eventsPath, "");

    const size = opts.size ?? "1280x860";
    const [w, h] = size.split("x").map((n) => parseInt(n, 10));

    const spawnEnv = {
            ...process.env,
            RNGPUI_NO_ACTIVATE: "1",
            RNGPUI_TEST_MODE: "1",
            // capture mode keeps the window on-screen-but-invisible so the WindowServer
            // composites it and pixel capture reads a full-opacity surface (no flash,
            // no focus theft). Same path the parity/capture harness uses.
            RNGPUI_CAPTURE_ONSCREEN: "1",
            RNGPUI_OPAQUE_WINDOW: "1",
            // capture math is `out = chrome * alpha`, divided back out per-pixel. The
            // 0.02 default keeps the window imperceptible but leaves only ~5 levels of
            // precision per channel, drifting sampled colors badly. 0.2 stays
            // imperceptible-class (offscreen + non-activating, never brought to front)
            // while giving ~50 levels, so sampled colors track the authored ones
            // closely enough to diagnose occlusion. Overridable.
            RNGPUI_CAPTURE_ALPHA: process.env.RNGPUI_CAPTURE_ALPHA || "0.2",
            RNGPUI_WINDOW_SIZE: `${w},${h}`,
            RNGPUI_CAPTURE_PNG: capturePath,
            RNGPUI_SERVICE_PID_FILE: pidPath,
            RNGPUI_CONTROL_FIFO: fifoPath,
            RNGPUI_CONTROL_EVENTS: eventsPath,
            RNGPUI_APP_NAME: appName,
    };
    const child: ChildProcess = opts.launchCmd
        ? spawn("sh", ["-c", opts.launchCmd], { cwd: launchCwd, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("bun", ["run", entryPath], { cwd: launchCwd, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout?.on("data", (c) => (log += c));
    child.stderr?.on("data", (c) => (log += c));

    const fail = (msg: string): never => {
        try {
            child.kill("SIGTERM");
        } catch {
            /* already gone */
        }
        // the detached service may have already written its pid before we gave up
        // (e.g. window-detect timeout on the launcher path) — kill it too, else it
        // orphans (ppid=1) and piles up into a focus-stealing window storm.
        try {
            const p = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
            if (p > 0) process.kill(p, "SIGTERM");
        } catch {
            /* no pid yet / already gone */
        }
        rmSync(workdir, { recursive: true, force: true });
        throw new Error(`${msg}\n--- host log tail ---\n${log.split("\n").slice(-20).join("\n")}`);
    };

    // With --launch-cmd the spawned process is an external launcher (e.g. agentbus'
    // open-gpui) that EXITS 0 after handing off to a detached app — so a clean exit is
    // success, only a non-zero exit is failure. With a plain `bun run` entry the child
    // IS the app, so any exit means it died. Also: the agentbus app's cold bundle build
    // can take far longer than the 20s a plain example needs, so give the launcher path
    // generous timeouts (timing out early rm'd the workdir out from under the late
    // service, which then crashed writing its pid → ENOENT).
    const launcherDied = () =>
        opts.launchCmd ? child.exitCode != null && child.exitCode !== 0 : child.exitCode != null;
    let servicePid = 0;
    try {
        servicePid = await waitForServicePid(pidPath, {
            timeoutMs: opts.launchCmd ? 120_000 : 20_000,
            isFixtureExited: launcherDied,
        });
    } catch (err) {
        fail(`service did not start: ${(err as Error).message}`);
    }

    let window: GpuiWindow;
    try {
        window = (await waitForWindow((win: GpuiWindow) => win.pid === servicePid && win.title === "react-native-gpui", {
            timeoutMs: opts.launchCmd ? 30_000 : 15_000,
            isFixtureExited: launcherDied,
        })) as GpuiWindow;
    } catch (err) {
        fail(`window did not appear: ${(err as Error).message}`);
    }

    // give the first React commit + a paint pass time to land so bounds are populated.
    await sleep(700);

    const send = (cmd: object) => {
        const fd = openSync(fifoPath, "a");
        try {
            writeSync(fd, JSON.stringify(cmd) + "\n");
        } finally {
            closeSync(fd);
        }
    };

    let reqSeq = 1;
    const dump = async (): Promise<DumpNode> => {
        const reqId = reqSeq++;
        rmSync(dumpPath, { force: true });
        // truncate the events file so we only see acks for THIS request.
        writeFileSync(eventsPath, "");
        send({ $cmd: "dump", reqId, path: dumpPath });
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
            if (existsSync(eventsPath)) {
                const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
                for (const line of lines) {
                    try {
                        const evt = JSON.parse(line);
                        if (evt.type === "dumpReady" && evt.reqId === reqId) {
                            return JSON.parse(readFileSync(dumpPath, "utf8")) as DumpNode;
                        }
                    } catch {
                        /* partial line */
                    }
                }
            }
            await sleep(40);
        }
        throw new Error("dump request timed out (no dumpReady ack)");
    };

    return {
        mode: "launch",
        pid: child.pid ?? 0,
        servicePid,
        window: window!,
        appName,
        send,
        dump,
        capture(path: string) {
            // The service writes a fresh full-opacity frame to RNGPUI_CAPTURE_PNG on a
            // ~250ms timer. Wait for one, then copy it to the caller's path. A pump tick
            // is forced first so the just-applied tap/scroll is reflected in the frame.
            const deadline = Date.now() + 4_000;
            while (Date.now() < deadline) {
                if (existsSync(capturePath) && statSync(capturePath).size > 0) {
                    // give the timer one more tick so the frame reflects the latest state
                    execSyncSleep(300);
                    copyFileSync(capturePath, path);
                    return;
                }
                execSyncSleep(120);
            }
            throw new Error("in-service capture produced no frame (RNGPUI_CAPTURE_PNG)");
        },
        close() {
            try {
                child.kill("SIGTERM");
            } catch {
                /* already gone */
            }
            // CRITICAL: the `bun run <entry>` parent spawns the rngpui-service as a
            // detached grandchild — SIGTERM to the parent leaves the service orphaned
            // (ppid=1), and these pile up across launches (focus-stealing window storm).
            // Kill the service explicitly by the pid it wrote to RNGPUI_SERVICE_PID_FILE.
            if (servicePid > 0) {
                try {
                    process.kill(servicePid, "SIGTERM");
                } catch {
                    /* already gone */
                }
            }
            rmSync(workdir, { recursive: true, force: true });
        },
    };
}

function execSyncSleep(ms: number) {
    // synchronous sleep so capture() (called from sync sample paths) can wait for a
    // fresh in-service frame without restructuring every caller as async.
    try {
        execFileSync("sleep", [String(ms / 1000)]);
    } catch {
        /* ignore */
    }
}

// Attach read-only to the most recently-opened rngpui-service window (capture +
// describe only — we don't own its stdin so we cannot drive it or request a dump).
export async function attachHost(): Promise<AttachedHost> {
    const candidates = listWindows()
        .filter((w: GpuiWindow) => w.title === "react-native-gpui" && w.owner !== "agentbus-gpui-user")
        .sort((a: GpuiWindow, b: GpuiWindow) => b.width * b.height - a.width * a.height);
    if (candidates.length === 0) {
        throw new Error("no running rngpui window found to attach to (launch one with --launch <entry.tsx>)");
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
            // best-effort: an attached process may have written a JS-side tree dump.
            const guess = process.env.RNGPUI_DUMP_TREE;
            if (guess && existsSync(guess) && statSync(guess).size > 0) {
                return JSON.parse(readFileSync(guess, "utf8")) as DumpNode;
            }
            return null;
        },
        close() {
            /* read-only: never touch a process we don't own */
        },
    };
}

export function currentWindow(servicePid: number): GpuiWindow | null {
    return (
        (listWindows() as GpuiWindow[])
            .filter((w) => w.pid === servicePid && w.title === "react-native-gpui")
            .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
    );
}
