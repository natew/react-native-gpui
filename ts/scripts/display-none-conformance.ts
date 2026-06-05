import { spawn } from "child_process";
import { fileURLToPath } from "url";

const child = spawn("bun", ["run", "examples/display-none-conformance.tsx"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
        ...process.env,
        RNGPUI_NO_ACTIVATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let exited = false;

child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
});

child.on("exit", (code, signal) => {
    exited = true;
    if (signal === "SIGTERM") return;
    fail(`renderer exited early code=${code ?? "null"} signal=${signal ?? "null"}`);
});

setTimeout(() => {
    if (exited) return;
    const combined = `${stdout}\n${stderr}`;
    if (combined.includes("measurement has not been performed") || combined.includes("panicked at")) {
        child.kill("SIGTERM");
        fail("hidden text triggered a GPUI measurement panic");
    }
    child.kill("SIGTERM");
    console.log("DISPLAY_NONE_CONFORMANCE_PASS");
}, 2200);

function fail(message: string): never {
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    console.error(`DISPLAY_NONE_CONFORMANCE_FAIL ${message}`);
    process.exit(1);
}
