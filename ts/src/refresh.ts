import * as React from "react";

declare const __DEV__: boolean | undefined;

type RefreshGlobal = typeof globalThis & {
    $RefreshReg$?: (type: unknown, id: string) => void;
    $RefreshSig$?: () => (type: unknown, key?: string, forceReset?: boolean, getCustomHooks?: () => unknown[]) => unknown;
    __rngpuiBeginHotUpdate?: () => void;
    __rngpuiEndHotUpdate?: () => void;
    __rngpuiHotUpdateDepth?: number;
    __rngpuiPerformReactRefresh?: () => unknown;
    __rngpuiHotModules?: Record<string, unknown>;
};

const g = globalThis as RefreshGlobal;
g.__rngpuiHotModules = { ...(g.__rngpuiHotModules ?? {}), react: React };
const isDev =
    typeof __DEV__ !== "undefined"
        ? __DEV__ === true
        : typeof process !== "undefined" && process.env?.NODE_ENV === "development";
// Name the development build directly, never the `react-refresh/runtime` entry.
// That entry picks its implementation from NODE_ENV, and its production pick is a
// tripwire whose entire body is `throw Error("React Refresh runtime should not be
// included in the production bundle.")`. bun hoists a static require to the top of
// the bundle and evaluates it eagerly, ahead of the `isDev` ternary and immune to
// dead-code elimination, so pointing at the entry made merely importing
// react-native-gpui throw before a line of it ran — `dist/index.js` was unusable
// in any consumer, which is how the file-picker, pane-focus and focus-geometry
// gates failed. Naming the development build is deterministic: it is the same
// implementation a dev bundle would resolve anyway, and it cannot become the
// tripwire under someone else's NODE_ENV. `isDev` still decides whether the
// runtime is INSTALLED, and `build:bundle` folds it to false for the library's
// own dist.
// Keep this a plain static require: an app bundle compiles this file from source
// with its own `__DEV__`, and that is how a dev Hermes bundle gets a real refresh
// runtime inlined.
//
// The library's OWN dist must not inline it, though. bun hoists a static require
// to the top of the bundle and evaluates it eagerly, ahead of this ternary and
// immune to dead-code elimination, and `react-refresh/runtime` picks its
// implementation from NODE_ENV — its production pick being a tripwire whose whole
// body is `throw Error("React Refresh runtime should not be included in the
// production bundle.")`. So `bun build --production` baked that throw into
// dist/index.js and merely importing react-native-gpui threw before a line of it
// ran, which is how the file-picker, pane-focus and focus-geometry gates failed.
// `build:bundle` therefore marks `react-refresh/runtime` external, leaving the
// resolution to whoever consumes the dist. Do not drop that flag.
const RefreshRuntime = isDev ? require("react-refresh/runtime") : undefined;
let installed = false;

export function installRefreshRuntime() {
    if (!RefreshRuntime || installed) return;
    installed = true;
    const runtime = RefreshRuntime as {
        injectIntoGlobalHook(globalObject: typeof globalThis): void;
        register(type: unknown, id: string): void;
        createSignatureFunctionForTransform(): (type: unknown, key?: string, forceReset?: boolean, getCustomHooks?: () => unknown[]) => unknown;
        performReactRefresh(): unknown;
    };
    runtime.injectIntoGlobalHook(globalThis);
    g.$RefreshReg$ = (type, id) => runtime.register(type, id);
    g.$RefreshSig$ = () => runtime.createSignatureFunctionForTransform();
    g.__rngpuiBeginHotUpdate = () => {
        g.__rngpuiHotUpdateDepth = (g.__rngpuiHotUpdateDepth ?? 0) + 1;
    };
    g.__rngpuiEndHotUpdate = () => {
        g.__rngpuiHotUpdateDepth = Math.max(0, (g.__rngpuiHotUpdateDepth ?? 1) - 1);
        if (g.__rngpuiHotUpdateDepth === 0) runtime.performReactRefresh();
    };
    g.__rngpuiPerformReactRefresh = () => runtime.performReactRefresh();
}

export function isHotUpdateEvaluating() {
    return (g.__rngpuiHotUpdateDepth ?? 0) > 0;
}

installRefreshRuntime();
