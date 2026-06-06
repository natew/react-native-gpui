/**
 * StyleSheet — RN-compatible. `create` is an identity helper; `flatten` collapses
 * arrays; `normalize` expands RN shorthands (paddingHorizontal, shadow*, …) into
 * the flat style the GPUI bridge understands.
 */
import type { ViewStyle, TextStyle, ImageStyle, StyleProp } from "./types";
import { resolveColorValue } from "./colors";

type AnyStyle = Record<string, unknown>;

export const StyleSheet = {
    create<T extends Record<string, ViewStyle | TextStyle | ImageStyle>>(styles: T): T {
        return styles;
    },
    hairlineWidth: 1,
    absoluteFill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as ViewStyle,
    absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as ViewStyle,

    flatten<T>(style?: StyleProp<T>): T {
        if (!style) return {} as T;
        if (!Array.isArray(style)) return style as T;
        const out: AnyStyle = {};
        const walk = (s: unknown) => {
            if (!s) return;
            if (Array.isArray(s)) {
                for (const x of s) walk(x);
            } else if (typeof s === "object") {
                Object.assign(out, s);
            }
        };
        walk(style);
        return out as T;
    },
};

/** Expand RN shorthands → the flat camelCase keys the Rust bridge reads. */
export function normalizeStyle(style: StyleProp<ViewStyle | TextStyle | ImageStyle>): AnyStyle | undefined {
    const s = StyleSheet.flatten(style) as AnyStyle;
    if (!s || Object.keys(s).length === 0) return undefined;
    const out: AnyStyle = { ...s };
    for (const key of Object.keys(out)) {
        out[key] = resolveColorValue(out[key]);
    }
    const backgroundImage = backgroundImageToCss(out.backgroundImage ?? out.experimental_backgroundImage);
    if (backgroundImage) out.backgroundImage = backgroundImage;
    delete out.experimental_backgroundImage;
    const boxShadow = boxShadowToCss(out.boxShadow);
    if (boxShadow) out.boxShadow = boxShadow;

    // axis shorthands → per-side
    const axis = (short: string, a: string, b: string) => {
        if (out[short] !== undefined) {
            if (out[a] === undefined) out[a] = out[short];
            if (out[b] === undefined) out[b] = out[short];
            delete out[short];
        }
    };
    axis("paddingHorizontal", "paddingLeft", "paddingRight");
    axis("paddingVertical", "paddingTop", "paddingBottom");
    axis("marginHorizontal", "marginLeft", "marginRight");
    axis("marginVertical", "marginTop", "marginBottom");
    // start/end → left/right (LTR)
    const alias = (from: string, to: string) => {
        if (out[from] !== undefined && out[to] === undefined) out[to] = out[from];
        delete out[from];
    };
    alias("paddingStart", "paddingLeft");
    alias("paddingEnd", "paddingRight");
    alias("marginStart", "marginLeft");
    alias("marginEnd", "marginRight");
    alias("start", "left");
    alias("end", "right");
    alias("borderStartWidth", "borderLeftWidth");
    alias("borderEndWidth", "borderRightWidth");
    if (out.inset !== undefined) {
        if (out.top === undefined) out.top = out.inset;
        if (out.right === undefined) out.right = out.inset;
        if (out.bottom === undefined) out.bottom = out.inset;
        if (out.left === undefined) out.left = out.inset;
        delete out.inset;
    }
    // RN iOS-style shadow props → CSS boxShadow (if not already set)
    if (out.boxShadow === undefined && (out.shadowColor || out.shadowOpacity || out.shadowRadius || out.shadowOffset)) {
        const off = (out.shadowOffset as { width?: number; height?: number }) || {};
        const x = off.width ?? 0;
        const y = off.height ?? 1;
        const blur = (out.shadowRadius as number) ?? 3;
        const color = colorWithOpacity((out.shadowColor as string) ?? "#000000", (out.shadowOpacity as number) ?? 0.2);
        out.boxShadow = `${x}px ${y}px ${blur}px ${color}`;
    }
    delete out.shadowColor;
    delete out.shadowOpacity;
    delete out.shadowRadius;
    delete out.shadowOffset;
    // android elevation → a soft shadow
    if (out.boxShadow === undefined && typeof out.elevation === "number" && out.elevation > 0) {
        const e = out.elevation as number;
        out.boxShadow = `0px ${Math.round(e / 2)}px ${e}px rgba(0,0,0,0.2)`;
    }
    delete out.elevation;

    return out;
}

function colorWithOpacity(color: string, opacity: number): string {
    // #rrggbb → rgba(...)
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (m) {
        const n = parseInt(m[1], 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
    }
    return color;
}

function backgroundImageToCss(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    const image = Array.isArray(value) ? value[0] : value;
    if (!image || typeof image !== "object") return undefined;
    if ((image as { type?: unknown }).type !== "linear-gradient") return undefined;
    const stops = (image as { colorStops?: unknown }).colorStops;
    if (!Array.isArray(stops) || stops.length < 2) return undefined;
    const colors = stops
        .map((stop) => {
            if (!stop || typeof stop !== "object") return undefined;
            return cssColorString(resolveColorValue((stop as { color?: unknown }).color));
        })
        .filter((color): color is string => !!color);
    if (colors.length < 2) return undefined;
    return `linear-gradient(180deg, ${colors[0]}, ${colors[colors.length - 1]})`;
}

function boxShadowToCss(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    const entries = Array.isArray(value) ? value : value == null ? [] : [value];
    const layers = entries
        .map((entry) => {
            if (!entry || typeof entry !== "object") return undefined;
            const shadow = entry as Record<string, unknown>;
            const x = cssNumber(shadow.offsetX);
            const y = cssNumber(shadow.offsetY);
            if (x == null || y == null) return undefined;
            const blur = cssNumber(shadow.blurRadius) ?? 0;
            const spread = cssNumber(shadow.spreadDistance) ?? cssNumber(shadow.spreadRadius) ?? 0;
            const color = cssColorString(resolveColorValue(shadow.color)) ?? "rgba(0,0,0,0.3)";
            return `${x}px ${y}px ${blur}px ${spread}px ${color}`;
        })
        .filter((layer): layer is string => !!layer);
    return layers.length ? layers.join(", ") : undefined;
}

function cssNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cssColorString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    return value.replace(/\b(rgba?|hsla?)\(([^)]*)\)/gi, (_match, fn, inner) => {
        return `${fn}(${String(inner).replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim()})`;
    });
}
