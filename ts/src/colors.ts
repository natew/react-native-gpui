import { spawnSync } from "child_process";
import { useSyncExternalStore } from "react";
import type { ColorValue, DynamicColorIOSValue, PlatformColorValue } from "./types";

export type ColorSchemeName = "light" | "dark" | null;

export type DynamicColorIOSTuple = {
    light: ColorValue;
    dark: ColorValue;
    highContrastLight?: ColorValue;
    highContrastDark?: ColorValue;
};

type AppearanceListener = (prefs: { colorScheme: ColorSchemeName }) => void;

const listeners = new Set<AppearanceListener>();
let systemColorScheme: Exclude<ColorSchemeName, null> = readSystemColorScheme();
let colorSchemeOverride: ColorSchemeName | undefined;
let appearanceUpdateSink: (() => void) | undefined;

function readSystemColorScheme(): Exclude<ColorSchemeName, null> {
    const result = spawnSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    return result.stdout.trim() === "Dark" ? "dark" : "light";
}

function getEffectiveColorScheme(): Exclude<ColorSchemeName, null> {
    if (colorSchemeOverride === "light" || colorSchemeOverride === "dark") {
        return colorSchemeOverride;
    }
    return systemColorScheme;
}

function emitAppearanceChange() {
    const prefs = { colorScheme: Appearance.getColorScheme() };
    for (const listener of Array.from(listeners)) listener(prefs);
    appearanceUpdateSink?.();
}

export function setAppearanceUpdateSink(sink: (() => void) | undefined): void {
    appearanceUpdateSink = sink;
}

/**
 * Native pushed the system color scheme — the initial value when the window opens,
 * then again whenever macOS toggles light/dark. Updates the system value and
 * re-themes, unless a manual `setColorScheme` override is currently masking it.
 */
export function applyNativeColorScheme(scheme: ColorSchemeName): void {
    if (scheme !== "light" && scheme !== "dark") return;
    if (systemColorScheme === scheme) return;
    systemColorScheme = scheme;
    if (colorSchemeOverride == null) emitAppearanceChange();
}

export const Appearance = {
    getColorScheme(): ColorSchemeName {
        return getEffectiveColorScheme();
    },
    setColorScheme(scheme: ColorSchemeName): void {
        colorSchemeOverride = scheme ?? undefined;
        if (scheme == null) systemColorScheme = readSystemColorScheme();
        emitAppearanceChange();
    },
    addChangeListener(listener: AppearanceListener): { remove(): void } {
        listeners.add(listener);
        return {
            remove() {
                listeners.delete(listener);
            },
        };
    },
    removeChangeListener(listener: unknown): void {
        if (typeof listener === "function") listeners.delete(listener as AppearanceListener);
    },
};

const subscribeColorScheme = (onStoreChange: () => void) => {
    const subscription = Appearance.addChangeListener(onStoreChange);
    return () => subscription.remove();
};

export function useColorScheme(): ColorSchemeName {
    return useSyncExternalStore(
        subscribeColorScheme,
        () => Appearance.getColorScheme(),
        () => "light",
    );
}

export function DynamicColorIOS(tuple: DynamicColorIOSTuple): DynamicColorIOSValue {
    return {
        dynamic: {
            light: tuple.light,
            dark: tuple.dark,
            highContrastLight: tuple.highContrastLight,
            highContrastDark: tuple.highContrastDark,
        },
    };
}

export function PlatformColor(...names: string[]): PlatformColorValue {
    return { semantic: names };
}

export function resolveColorValue(color: unknown): unknown {
    if (!color || typeof color !== "object") return color;

    const variable = color as { isVar?: unknown; val?: unknown };
    if (variable.isVar === true && "val" in variable) {
        return resolveColorValue(variable.val);
    }

    const tuple = color as Partial<DynamicColorIOSTuple>;
    if ("light" in tuple || "dark" in tuple) {
        const scheme = Appearance.getColorScheme() ?? "light";
        const next = scheme === "dark" ? tuple.dark ?? tuple.light : tuple.light ?? tuple.dark;
        return resolveColorValue(next);
    }

    const dynamic = (color as DynamicColorIOSValue).dynamic;
    if (dynamic && typeof dynamic === "object") {
        const scheme = Appearance.getColorScheme() ?? "light";
        const next = scheme === "dark" ? dynamic.dark ?? dynamic.light : dynamic.light ?? dynamic.dark;
        return resolveColorValue(next);
    }

    const semantic = (color as PlatformColorValue).semantic;
    if (Array.isArray(semantic)) {
        return semantic[0];
    }

    return color;
}

export function processColor(color: unknown): unknown {
    return resolveColorValue(color);
}
