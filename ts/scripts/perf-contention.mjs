import { execFileSync, spawn } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const burnerFlag = "--rngpui-cpu-burner";
const helperPath = fileURLToPath(import.meta.url);

if (process.argv.includes(burnerFlag)) {
    const durationMs = Number(process.argv[process.argv.indexOf(burnerFlag) + 1]);
    burnCpu(durationMs);
}

export function hasContentionFlag(args = process.argv.slice(2)) {
    return args.includes("--contention");
}

export async function startPerfContention(enabled, options = {}) {
    const cpuCount = cpus().length;
    // keep the shared workstation responsive: two low-priority owned burners are
    // enough to prove the loaded lane without recreating the compile storm this gate
    // is meant to survive.
    const burnerCount = enabled ? (options.burnerCount ?? Math.max(1, Math.min(2, cpuCount - 2))) : 0;
    const maxDurationMs = options.maxDurationMs ?? 120_000;
    const warmupMs = options.warmupMs ?? 250;
    const loadAverageBefore = loadSnapshot();
    const burners = [];
    const spawnErrors = [];

    for (let index = 0; index < burnerCount; index += 1) {
        const burner = spawn(
            "/usr/bin/nice",
            ["-n", "15", process.execPath, helperPath, burnerFlag, String(maxDurationMs)],
            { stdio: "ignore" },
        );
        burner.once("error", (error) => spawnErrors.push({ index, error }));
        burners.push(burner);
    }

    if (burners.length > 0) await sleep(warmupMs);
    const stoppedEarly = burners.filter((burner) => burner.exitCode !== null || burner.signalCode !== null);
    if (spawnErrors.length > 0 || stoppedEarly.length > 0) {
        await stopBurners(burners);
        const detail = spawnErrors[0]?.error?.message ?? `${stoppedEarly.length} burner(s) exited during warmup`;
        throw new Error(`failed to establish owned CPU contention: ${detail}`);
    }
    const burnerNiceValues = burners.map(({ pid }) =>
        Number(execFileSync("/bin/ps", ["-o", "ni=", "-p", String(pid)], { encoding: "utf8" }).trim()),
    );
    if (burnerNiceValues.some((value) => !Number.isFinite(value) || value < 15)) {
        await stopBurners(burners);
        throw new Error(`owned CPU burners were not low priority: nice=${burnerNiceValues.join(",")}`);
    }

    return {
        enabled,
        burnerCount,
        burnerPids: burners.map(({ pid }) => pid),
        burnerNiceValues,
        cpuCount,
        maxDurationMs,
        niceIncrement: 15,
        loadAverageBefore,
        loadAverageAfterWarmup: loadSnapshot(),
        snapshot() {
            return loadSnapshot();
        },
        async stop() {
            await stopBurners(burners);
        },
    };
}

function burnCpu(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) process.exit(2);
    const deadline = Date.now() + durationMs;
    let value = 0.61803398875;
    while (Date.now() < deadline) {
        for (let index = 0; index < 100_000; index += 1) {
            value = Math.sin(value + index) ** 2 + Math.cos(value - index) ** 2;
        }
    }
    if (!Number.isFinite(value)) process.exit(3);
    process.exit(0);
}

async function stopBurners(burners) {
    for (const burner of burners) {
        if (burner.exitCode === null && burner.signalCode === null) burner.kill("SIGTERM");
    }
    let alive = await waitForBurners(burners, 2_000);
    for (const burner of alive) burner.kill("SIGKILL");
    alive = await waitForBurners(alive, 2_000);
    if (alive.length > 0) {
        throw new Error(`failed to stop owned contention burner pid(s): ${alive.map(({ pid }) => pid).join(",")}`);
    }
}

async function waitForBurners(burners, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    let alive = burners.filter(isAlive);
    while (alive.length > 0 && performance.now() < deadline) {
        await sleep(20);
        alive = alive.filter(isAlive);
    }
    return alive;
}

function isAlive(child) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return false;
    try {
        process.kill(child.pid, 0);
        return true;
    } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
    }
}

function loadSnapshot() {
    const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
    return { oneMinute, fiveMinutes, fifteenMinutes };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
