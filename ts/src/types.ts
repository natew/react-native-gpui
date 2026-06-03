/**
 * React-Native-compatible style + prop types for react-native-gpui.
 * Mirrors the shapes of `react-native`'s public types closely enough that RN
 * code (and RN muscle memory) transfers, scoped to what the GPUI bridge renders.
 */

import type { ReactNode } from "react";

// ── primitives ──────────────────────────────────────────────────────
export type ColorValue = string;
export type DimensionValue = number | `${number}%` | "auto";
export type FlexAlignType = "flex-start" | "flex-end" | "center" | "stretch" | "baseline";

// ── flexbox / layout ────────────────────────────────────────────────
export interface FlexStyle {
    alignContent?: "flex-start" | "flex-end" | "center" | "stretch" | "space-between" | "space-around" | "space-evenly";
    alignItems?: FlexAlignType;
    alignSelf?: "auto" | FlexAlignType;
    aspectRatio?: number | string;
    borderBottomWidth?: number;
    borderEndWidth?: number;
    borderLeftWidth?: number;
    borderRightWidth?: number;
    borderStartWidth?: number;
    borderTopWidth?: number;
    borderWidth?: number;
    bottom?: DimensionValue;
    columnGap?: number;
    display?: "none" | "flex";
    end?: DimensionValue;
    flex?: number;
    flexBasis?: DimensionValue;
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    flexGrow?: number;
    flexShrink?: number;
    flexWrap?: "wrap" | "nowrap" | "wrap-reverse";
    gap?: number;
    height?: DimensionValue;
    justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around" | "space-evenly";
    left?: DimensionValue;
    margin?: DimensionValue;
    marginBottom?: DimensionValue;
    marginEnd?: DimensionValue;
    marginHorizontal?: DimensionValue;
    marginLeft?: DimensionValue;
    marginRight?: DimensionValue;
    marginStart?: DimensionValue;
    marginTop?: DimensionValue;
    marginVertical?: DimensionValue;
    maxHeight?: DimensionValue;
    maxWidth?: DimensionValue;
    minHeight?: DimensionValue;
    minWidth?: DimensionValue;
    overflow?: "visible" | "hidden" | "scroll";
    padding?: DimensionValue;
    paddingBottom?: DimensionValue;
    paddingEnd?: DimensionValue;
    paddingHorizontal?: DimensionValue;
    paddingLeft?: DimensionValue;
    paddingRight?: DimensionValue;
    paddingStart?: DimensionValue;
    paddingTop?: DimensionValue;
    paddingVertical?: DimensionValue;
    position?: "absolute" | "relative";
    right?: DimensionValue;
    rowGap?: number;
    start?: DimensionValue;
    top?: DimensionValue;
    width?: DimensionValue;
    zIndex?: number;
}

// ── shadows ─────────────────────────────────────────────────────────
export interface ShadowStyleIOS {
    shadowColor?: ColorValue;
    shadowOffset?: { width: number; height: number };
    shadowOpacity?: number;
    shadowRadius?: number;
}

// ── view style ──────────────────────────────────────────────────────
export interface ViewStyle extends FlexStyle, ShadowStyleIOS {
    backgroundColor?: ColorValue;
    /** CSS gradient string, e.g. "linear-gradient(135deg,#a,#b)" — gpui extension */
    backgroundImage?: string;
    /** CSS box-shadow string (RN 0.76+) */
    boxShadow?: string;
    borderColor?: ColorValue;
    borderTopColor?: ColorValue;
    borderRightColor?: ColorValue;
    borderBottomColor?: ColorValue;
    borderLeftColor?: ColorValue;
    borderRadius?: number;
    borderTopLeftRadius?: number;
    borderTopRightRadius?: number;
    borderBottomLeftRadius?: number;
    borderBottomRightRadius?: number;
    borderStyle?: "solid" | "dotted" | "dashed";
    borderWidth?: number;
    elevation?: number;
    opacity?: number;
}

// ── text style ──────────────────────────────────────────────────────
export interface TextStyle extends ViewStyle {
    color?: ColorValue;
    fontFamily?: string;
    fontSize?: number;
    fontStyle?: "normal" | "italic";
    fontWeight?: "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900" | number;
    letterSpacing?: number;
    lineHeight?: number;
    textAlign?: "auto" | "left" | "right" | "center" | "justify";
    textDecorationLine?: "none" | "underline" | "line-through" | "underline line-through";
    textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
}

export interface ImageStyle extends ViewStyle {
    resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
    tintColor?: ColorValue;
}

// allow arrays / falsy entries like RN's StyleProp
export type StyleProp<T> = T | RegisteredStyle<T> | RecursiveArray<T | RegisteredStyle<T> | Falsy> | Falsy;
export type Falsy = undefined | null | false;
export interface RecursiveArray<T> extends Array<T | ReadonlyArray<T> | RecursiveArray<T>> {}
export type RegisteredStyle<T> = T & { __registered?: true };

// ── layout / events ─────────────────────────────────────────────────
export interface LayoutRectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface LayoutChangeEvent {
    nativeEvent: { layout: LayoutRectangle };
}
export interface GestureResponderEvent {
    nativeEvent: { locationX: number; locationY: number; pageX: number; pageY: number };
}

// ── common view props ───────────────────────────────────────────────
export interface ViewProps {
    children?: ReactNode;
    style?: StyleProp<ViewStyle>;
    onLayout?: (event: LayoutChangeEvent) => void;
    pointerEvents?: "auto" | "none" | "box-none" | "box-only";
    testID?: string;
    accessible?: boolean;
    accessibilityLabel?: string;
    nativeID?: string;
}
