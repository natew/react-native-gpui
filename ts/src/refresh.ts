import * as React from "react";

declare const __DEV__: boolean | undefined;
declare const require: (id: string) => unknown;

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
let installed = false;

export function installRefreshRuntime() {
    if (!isDev || installed) return;
    installed = true;
    const RefreshRuntime = require("react-refresh/runtime");
    const runtime = RefreshRuntime as unknown as {
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
