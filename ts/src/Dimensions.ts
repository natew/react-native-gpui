/**
 * RN-compatible Dimensions API, backed by the GPUI window's real size.
 *
 * The service emits a `{type:"resize",width,height}` event whenever the window
 * content box changes; the runtime calls `_setWindow(...)`, which updates the
 * cached size and fires every `change` listener — exactly like RN's Dimensions.
 */

export type ScaledSize = {
    width: number;
    height: number;
    scale: number;
    fontScale: number;
};

type ChangeHandler = (dims: { window: ScaledSize; screen: ScaledSize }) => void;

// initial guess; overwritten by the first `resize`/`ready` event from the window
let windowDims: ScaledSize = { width: 1180, height: 760, scale: 2, fontScale: 1 };
let screenDims: ScaledSize = { width: 1180, height: 760, scale: 2, fontScale: 1 };

const listeners = new Set<ChangeHandler>();

export const Dimensions = {
    get(dim: "window" | "screen"): ScaledSize {
        return dim === "screen" ? screenDims : windowDims;
    },

    set(_dims: Record<string, ScaledSize>): void {
        // RN allows native to seed dimensions; no-op here (the window owns size).
    },

    addEventListener(type: "change", handler: ChangeHandler): { remove: () => void } {
        if (type === "change") listeners.add(handler);
        return { remove: () => listeners.delete(handler) };
    },

    removeEventListener(type: "change", handler: ChangeHandler): void {
        if (type === "change") listeners.delete(handler);
    },

    /** internal: called by the runtime when the window reports a new size.
     *  Returns true if the size actually changed. */
    _setWindow(width: number, height: number): boolean {
        if (width === windowDims.width && height === windowDims.height) return false;
        windowDims = { ...windowDims, width, height };
        screenDims = { ...screenDims, width, height };
        const payload = { window: windowDims, screen: screenDims };
        for (const cb of listeners) cb(payload);
        return true;
    },
};
