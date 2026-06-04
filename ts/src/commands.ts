// Host → frame imperative commands (e.g. WebView.injectJavaScript / reload). These
// don't go through the React commit/tree; they're sent straight to the service over
// stdin and applied to a live native view by id. The render layer wires the sink to
// the bridge; components call `sendCommand`.
export type Command =
    | { $cmd: "eval"; id: number; js: string }
    | { $cmd: "reload"; id: number };

let sink: ((cmd: Command) => void) | null = null;

export function setCommandSink(fn: (cmd: Command) => void) {
    sink = fn;
}

export function sendCommand(cmd: Command) {
    sink?.(cmd);
}
