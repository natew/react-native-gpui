declare module "react-refresh/runtime" {
    export function injectIntoGlobalHook(globalObject: typeof globalThis): void;
    export function register(type: unknown, id: string): void;
    export function createSignatureFunctionForTransform(): (type: unknown, key?: string, forceReset?: boolean, getCustomHooks?: () => unknown[]) => unknown;
    export function performReactRefresh(): unknown;
}
