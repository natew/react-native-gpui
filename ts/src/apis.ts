/**
 * Non-component RN APIs: Platform, PixelRatio, useWindowDimensions.
 */
import { useEffect, useState } from "react";
import { Dimensions, type ScaledSize } from "./Dimensions";
import {
    findHostNodeId,
    measureHostNode,
    measureHostNodeInWindow,
    measureHostNodeLayout,
} from "./reconciler";
export {
    Appearance,
    DynamicColorIOS,
    PlatformColor,
    processColor,
    resolveColorValue,
    useColorScheme,
    type ColorSchemeName,
    type DynamicColorIOSTuple,
} from "./colors";

export function useWindowDimensions(): ScaledSize {
    const [dims, setDims] = useState<ScaledSize>(() => Dimensions.get("window"));
    useEffect(() => {
        const sub = Dimensions.addEventListener("change", ({ window }) => setDims(window));
        return () => sub.remove();
    }, []);
    return dims;
}

type PlatformOSType = "ios" | "android" | "macos" | "windows" | "web";

export const Platform = {
    OS: "macos" as PlatformOSType,
    Version: 0 as number | string,
    isPad: false,
    isTV: false,
    isTesting: false,
    select<T>(spec: { [k in PlatformOSType | "native" | "default"]?: T }): T | undefined {
        if ("macos" in spec) return spec.macos;
        if ("native" in spec) return spec.native;
        return spec.default;
    },
};

export const PixelRatio = {
    get(): number {
        return Dimensions.get("window").scale;
    },
    getFontScale(): number {
        return Dimensions.get("window").fontScale ?? 1;
    },
    getPixelSizeForLayoutSize(layoutSize: number): number {
        return Math.round(layoutSize * PixelRatio.get());
    },
    roundToNearestPixel(layoutSize: number): number {
        const ratio = PixelRatio.get();
        return Math.round(layoutSize * ratio) / ratio;
    },
};

/** RN's I18nManager. LTR on desktop. */
export const I18nManager = {
    isRTL: false,
    doLeftAndRightSwapInRTL: true,
    allowRTL(_: boolean): void {},
    forceRTL(_: boolean): void {},
    swapLeftAndRightInRTL(_: boolean): void {},
};

// ── desktop implementations of the rest of the common RN surface ────────────
// these let RN-targeting libraries (e.g. tamagui's full component set) bundle
// and run on gpui. behaviors are the sensible desktop defaults (mostly no-ops).

type AlertButton = { text?: string; onPress?: () => void; style?: string };
export const Alert = {
    alert(title: string, message?: string, buttons?: AlertButton[]): void {
        console.log(`[Alert] ${title}${message ? `: ${message}` : ""}`);
        buttons?.find((b) => b.style !== "cancel")?.onPress?.();
    },
    prompt(title: string, message?: string): void {
        console.log(`[Alert.prompt] ${title}${message ? `: ${message}` : ""}`);
    },
};

type Sub = { remove(): void };
const noopSub = (): Sub => ({ remove() {} });

export const Keyboard = {
    addListener: noopSub,
    removeAllListeners(_event?: string): void {},
    dismiss(): void {},
    isVisible(): boolean {
        return false;
    },
    scheduleLayoutAnimation(): void {},
};

export const BackHandler = {
    addEventListener: noopSub,
    removeEventListener(_handler: () => boolean): void {},
    exitApp(): void {},
};

export const AppState = {
    currentState: "active" as "active" | "background" | "inactive",
    addEventListener: noopSub,
    removeEventListener(): void {},
};

export const Linking = {
    addEventListener: noopSub,
    async openURL(_url: string): Promise<void> {},
    async canOpenURL(_url: string): Promise<boolean> {
        return false;
    },
    async getInitialURL(): Promise<string | null> {
        return null;
    },
};

export const InteractionManager = {
    runAfterInteractions(task?: () => void): { then: (cb: () => void) => void; done: () => void; cancel: () => void } {
        task?.();
        return { then: (cb) => cb(), done() {}, cancel() {} };
    },
    createInteractionHandle(): number {
        return 0;
    },
    clearInteractionHandle(_handle: number): void {},
    setDeadline(_deadline: number): void {},
};

export const LayoutAnimation = {
    configureNext(_config: unknown, onAnimationDidEnd?: () => void): void {
        onAnimationDidEnd?.();
    },
    create(_duration: number, _type?: unknown, _creationProp?: unknown): unknown {
        return {};
    },
    Types: {} as Record<string, string>,
    Properties: {} as Record<string, string>,
    Presets: { easeInEaseOut: {}, linear: {}, spring: {} },
    easeInEaseOut(): void {},
    linear(): void {},
    spring(): void {},
};

export const UIManager = {
    measure(node: unknown, callback: (x: number, y: number, w: number, h: number, px: number, py: number) => void): void {
        measureHostNode(node as never, callback);
    },
    measureInWindow(node: unknown, callback: (x: number, y: number, w: number, h: number) => void): void {
        measureHostNodeInWindow(node as never, callback);
    },
    measureLayout(
        node: unknown,
        relativeToNativeNode: unknown,
        onFail: () => void,
        onSuccess: (left: number, top: number, width: number, height: number) => void,
    ): void {
        measureHostNodeLayout(node as never, relativeToNativeNode as never, onSuccess, onFail);
    },
    getViewManagerConfig(_name: string): unknown {
        return null;
    },
    hasViewManagerConfig(_name: string): boolean {
        return false;
    },
    setLayoutAnimationEnabledExperimental(_enabled: boolean): void {},
};

export const NativeModules: Record<string, unknown> = {};

export type FilePickerOptions = {
    multiple?: boolean;
    files?: boolean;
    directories?: boolean;
    prompt?: string;
};

type FilePickerRequest = Required<FilePickerOptions> & { id: number };
type FilePickerResponse = { id: number; ok?: boolean; paths?: unknown; error?: string };

declare global {
    var __rngpui_pickPaths: ((json: string) => void) | undefined;
    var __rngpui_filePickerDone: ((json: string) => void) | undefined;
}

let filePickerSeq = 1;
const pendingFilePickers = new Map<number, { resolve(paths: string[]): void; reject(error: Error): void }>();

globalThis.__rngpui_filePickerDone = (json: string) => {
    let response: FilePickerResponse;
    try {
        response = JSON.parse(json) as FilePickerResponse;
    } catch (error) {
        return;
    }
    const pending = pendingFilePickers.get(response.id);
    if (!pending) return;
    pendingFilePickers.delete(response.id);
    if (response.ok === false) {
        pending.reject(new Error(response.error || "native file picker failed"));
        return;
    }
    pending.resolve(parseFilePickerPaths(response.paths));
};

export const FilePicker = {
    async pickPaths(options: FilePickerOptions = {}): Promise<string[]> {
        const pickPaths = globalThis.__rngpui_pickPaths;
        if (typeof pickPaths !== "function") {
            throw new Error("native file picker host is not available");
        }
        const request: FilePickerRequest = {
            id: filePickerSeq++,
            files: options.files !== false,
            directories: !!options.directories,
            multiple: !!options.multiple,
            prompt: options.prompt || "Choose file",
        };
        return new Promise((resolve, reject) => {
            pendingFilePickers.set(request.id, { resolve, reject });
            try {
                pickPaths(JSON.stringify(request));
            } catch (error) {
                pendingFilePickers.delete(request.id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    },
    _parse: parseFilePickerPaths,
};

export function findNodeHandle(ref: unknown): number | null {
    return findHostNodeId(ref);
}

export const PanResponder = {
    create(_config: unknown): { panHandlers: Record<string, unknown> } {
        return { panHandlers: {} };
    },
};

export const Vibration = {
    vibrate(_pattern?: number | number[], _repeat?: boolean): void {},
    cancel(): void {},
};

class EventEmitterStub {
    addListener(_event: string, _cb: (...args: unknown[]) => void): Sub {
        return { remove() {} };
    }
    removeAllListeners(_event?: string): void {}
    removeSubscription(_sub: unknown): void {}
    emit(_event: string, ..._args: unknown[]): void {}
    listenerCount(_event: string): number {
        return 0;
    }
}
export const DeviceEventEmitter = new EventEmitterStub();
export class NativeEventEmitter extends EventEmitterStub {
    constructor(_nativeModule?: unknown) {
        super();
    }
}

export const AccessibilityInfo = {
    addEventListener: noopSub,
    removeEventListener(): void {},
    async isScreenReaderEnabled(): Promise<boolean> {
        return false;
    },
    async isReduceMotionEnabled(): Promise<boolean> {
        return false;
    },
    announceForAccessibility(_message: string): void {},
    setAccessibilityFocus(_reactTag: number): void {},
};

function parseFilePickerPaths(value: unknown): string[] {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
}
