/**
 * Non-component RN APIs: Platform, PixelRatio, useWindowDimensions, useColorScheme.
 */
import { useEffect, useState } from "react";
import { Dimensions, type ScaledSize } from "./Dimensions";

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

/** Desktop has no system dark-mode hook here; reports light. */
export function useColorScheme(): "light" | "dark" | null {
    return "light";
}
