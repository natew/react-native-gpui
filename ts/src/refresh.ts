import RefreshRuntime from "react-refresh/runtime";

type RefreshGlobal = typeof globalThis & {
    $RefreshReg$?: (type: unknown, id: string) => void;
    $RefreshSig$?: () => (type: unknown, key?: string, forceReset?: boolean, getCustomHooks?: () => unknown[]) => unknown;
    __rngpuiBeginHotUpdate?: () => void;
    __rngpuiEndHotUpdate?: () => void;
    __rngpuiHotUpdateDepth?: number;
    __rngpuiPerformReactRefresh?: () => unknown;
    __rngpuiRefreshReady?: boolean;
};

const g = globalThis as RefreshGlobal;
let installed = false;

export function installRefreshRuntime() {
    if (installed) return;
    RefreshRuntime.injectIntoGlobalHook(globalThis);
    g.$RefreshReg$ = (type, id) => RefreshRuntime.register(type, id);
    g.$RefreshSig$ = () => RefreshRuntime.createSignatureFunctionForTransform();
    g.__rngpuiBeginHotUpdate = () => {
        g.__rngpuiHotUpdateDepth = (g.__rngpuiHotUpdateDepth ?? 0) + 1;
    };
    g.__rngpuiEndHotUpdate = () => {
        g.__rngpuiHotUpdateDepth = Math.max(0, (g.__rngpuiHotUpdateDepth ?? 1) - 1);
        if (g.__rngpuiHotUpdateDepth === 0) RefreshRuntime.performReactRefresh();
    };
    g.__rngpuiPerformReactRefresh = () => RefreshRuntime.performReactRefresh();
    installed = true;
    g.__rngpuiRefreshReady = true;
}

installRefreshRuntime();
