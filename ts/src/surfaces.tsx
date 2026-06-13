import { Fragment, type ReactNode } from "react";
import { cssColorString } from "./StyleSheet";
import { resolveColorValue } from "./colors";
import { SystemView, View, type SystemViewGlassVariant, type SystemViewMaterial, type SystemViewShadow } from "./components";
import type { ColorValue, StyleProp, ViewProps, ViewStyle } from "./types";

export type LiquidGlassChrome =
    | false
    | {
          fill?: ColorValue;
          borderColor?: ColorValue;
          borderWidth?: number;
      };

export interface LiquidGlassBackgroundProps {
    radius?: number;
    material?: SystemViewMaterial;
    glassVariant?: SystemViewGlassVariant;
    tint?: ColorValue;
    shadow?: SystemViewShadow;
    edgeFade?: number;
    topFadeStart?: number;
    chrome?: LiquidGlassChrome;
    style?: StyleProp<ViewStyle>;
}

export interface LiquidGlassViewProps
    extends Omit<ViewProps, "style">,
        Omit<LiquidGlassBackgroundProps, "style"> {
    style?: StyleProp<ViewStyle>;
    backgroundStyle?: StyleProp<ViewStyle>;
    children?: ReactNode;
}

export type SmokeEffect = {
    type: "smoke";
    color?: ColorValue;
    fadedColor?: ColorValue;
    alpha?: number;
    reach?: number;
    topClear?: number;
};

export type BackgroundImageEffect = {
    type: "backgroundImage";
    backgroundImage: string;
};

export type EffectSurfaceEffect = SmokeEffect | BackgroundImageEffect;

export interface EffectSurfaceProps extends Omit<ViewProps, "style" | "backgroundImage" | "experimental_backgroundImage"> {
    effect: EffectSurfaceEffect;
    radius?: number;
    style?: StyleProp<ViewStyle>;
    children?: ReactNode;
}

export interface SmokeEffectSurfaceProps extends Omit<EffectSurfaceProps, "effect">, Omit<SmokeEffect, "type"> {}

const absoluteFill = (radius?: number): ViewStyle => ({
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    ...(radius != null ? { borderRadius: radius } : null),
});

export function LiquidGlassBackground({
    radius,
    material = "hudWindow",
    glassVariant = "controlCenter",
    tint,
    shadow,
    edgeFade,
    topFadeStart,
    chrome = false,
    style,
}: LiquidGlassBackgroundProps) {
    const chromeStyle = chrome === false ? null : chrome;
    return (
        <Fragment>
            <SystemView
                material={material}
                glassVariant={glassVariant}
                tint={tint}
                shadow={shadow}
                edgeFade={edgeFade}
                topFadeStart={topFadeStart}
                style={[absoluteFill(radius), style]}
            />
            {chromeStyle ? (
                <View
                    pointerEvents="none"
                    style={[
                        absoluteFill(radius),
                        {
                            borderWidth: chromeStyle.borderWidth ?? 1,
                            borderColor: chromeStyle.borderColor,
                            backgroundColor: chromeStyle.fill,
                        },
                    ]}
                />
            ) : null}
        </Fragment>
    );
}

export function LiquidGlassView({
    children,
    style,
    backgroundStyle,
    radius,
    material,
    glassVariant,
    tint,
    shadow,
    edgeFade,
    topFadeStart,
    chrome,
    ...viewProps
}: LiquidGlassViewProps) {
    return (
        <View {...viewProps} style={style}>
            <LiquidGlassBackground
                radius={radius}
                material={material}
                glassVariant={glassVariant}
                tint={tint}
                shadow={shadow}
                edgeFade={edgeFade}
                topFadeStart={topFadeStart}
                chrome={chrome}
                style={backgroundStyle}
            />
            {children}
        </View>
    );
}

export function EffectSurface({ effect, radius, style, children, ...viewProps }: EffectSurfaceProps) {
    return (
        <View
            {...viewProps}
            style={[
                absoluteFill(radius),
                style,
                {
                    backgroundImage: effectBackgroundImage(effect),
                },
            ]}
        >
            {children}
        </View>
    );
}

export function SmokeEffectSurface({ color, fadedColor, alpha, reach, topClear, ...props }: SmokeEffectSurfaceProps) {
    return (
        <EffectSurface
            {...props}
            effect={{
                type: "smoke",
                color,
                fadedColor,
                alpha,
                reach,
                topClear,
            }}
        />
    );
}

export function effectBackgroundImage(effect: EffectSurfaceEffect): string {
    if (effect.type === "backgroundImage") return effect.backgroundImage;
    return smokeEffectBackgroundImage(effect);
}

export function smokeEffectBackgroundImage(effect: Omit<SmokeEffect, "type">): string {
    const dense = colorString(effect.color) ?? `rgba(0,0,0,${formatAlpha(effect.alpha ?? 1)})`;
    const faded = colorString(effect.fadedColor) ?? "rgba(0,0,0,0)";
    return `smoke(${dense} ${formatPercent(effect.reach ?? 0.58)}, ${faded} ${formatPercent(effect.topClear ?? 0.34)})`;
}

function colorString(value: ColorValue | undefined): string | undefined {
    return cssColorString(resolveColorValue(value));
}

function formatAlpha(value: number): string {
    return trimNumber(clamp(value, 0, 1));
}

function formatPercent(value: number): string {
    return `${trimNumber(clamp(value, 0, 1) * 100)}%`;
}

function trimNumber(value: number): string {
    return Number(value.toFixed(3)).toString();
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
