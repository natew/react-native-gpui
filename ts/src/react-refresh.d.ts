declare module "react-refresh/runtime" {
    const runtime: {
        injectIntoGlobalHook(globalObject: typeof globalThis): void;
        register(type: unknown, id: string): void;
        createSignatureFunctionForTransform(): (type: unknown, key?: string, forceReset?: boolean, getCustomHooks?: () => unknown[]) => unknown;
        performReactRefresh(): unknown;
    };
    export default runtime;
}
