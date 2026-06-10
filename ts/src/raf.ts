// requestAnimationFrame riding the host's real vsync (frame_clock.rs / CVDisplayLink).
//
// JS arms the clock via __rngpui_requestFrame whenever callbacks are pending; the
// host posts ONE __rngpui_fireFrame per display refresh while armed. At most one
// fire is ever in flight: the host only fires when armed, and we only re-arm after
// running callbacks. This replaces the old free-running setTimeout(16) shim, which
// capped animation at ~60Hz and beat against the display-linked render thread.
//
// Outside the gpui host (bun unit tests), the host fn doesn't exist and the timer
// shim below keeps rAF available.

const root = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
    __rngpui_fireFrame?: () => void;
};

declare const __rngpui_requestFrame: ((arg: string) => void) | undefined;

if (typeof __rngpui_requestFrame === "function") {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;

    root.requestAnimationFrame = (callback) => {
        const id = nextId++;
        callbacks.set(id, callback);
        if (callbacks.size === 1) __rngpui_requestFrame("");
        return id;
    };

    root.cancelAnimationFrame = (id) => {
        callbacks.delete(id);
    };

    root.__rngpui_fireFrame = () => {
        if (callbacks.size === 0) return;
        // snapshot ids: callbacks registered DURING this frame run next frame, and a
        // callback cancelling a same-frame sibling must win (browser semantics).
        const ids = [...callbacks.keys()];
        const timestamp = performance.now();
        for (const id of ids) {
            const callback = callbacks.get(id);
            if (!callback) continue;
            callbacks.delete(id);
            try {
                callback(timestamp);
            } catch (error) {
                console.error("[raf] frame callback threw:", error);
            }
        }
        // registrations made while firing may not have crossed size 0→1; re-arm.
        if (callbacks.size > 0) __rngpui_requestFrame("");
    };
} else if (typeof root.requestAnimationFrame !== "function") {
    root.requestAnimationFrame = (callback) =>
        setTimeout(() => callback(typeof performance !== "undefined" ? performance.now() : Date.now()), 16) as unknown as number;
    root.cancelAnimationFrame = (id) => clearTimeout(id);
}
