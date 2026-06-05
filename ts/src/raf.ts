const root = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
};

if (typeof root.requestAnimationFrame !== "function") {
    root.requestAnimationFrame = (callback) =>
        setTimeout(() => callback(typeof performance !== "undefined" ? performance.now() : Date.now()), 16) as unknown as number;
}

if (typeof root.cancelAnimationFrame !== "function") {
    root.cancelAnimationFrame = (id) => clearTimeout(id);
}
