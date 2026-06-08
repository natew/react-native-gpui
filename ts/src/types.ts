/**
 * React-Native-compatible style + prop types for react-native-gpui.
 * Mirrors the shapes of `react-native`'s public types closely enough that RN
 * code (and RN muscle memory) transfers, scoped to what the GPUI bridge renders.
 */

import type { ReactNode } from "react";

// ── primitives ──────────────────────────────────────────────────────
export type DynamicColorIOSValue = {
    dynamic: {
        light?: ColorValue | null;
        dark?: ColorValue | null;
        highContrastLight?: ColorValue | null;
        highContrastDark?: ColorValue | null;
    };
};
export type PlatformColorValue = { semantic: string[] };
export type OpaqueColorValue = DynamicColorIOSValue | PlatformColorValue;
export type ColorValue = string | OpaqueColorValue;
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
    inset?: DimensionValue;
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
    /** React Native/Tamagui gradient payload emitted by the native style layer. */
    experimental_backgroundImage?: unknown;
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
    cursor?:
        | "auto"
        | "default"
        | "none"
        | "pointer"
        | "text"
        | "vertical-text"
        | "crosshair"
        | "grab"
        | "grabbing"
        | "w-resize"
        | "e-resize"
        | "ew-resize"
        | "n-resize"
        | "s-resize"
        | "ns-resize"
        | "nwse-resize"
        | "nesw-resize"
        | "col-resize"
        | "row-resize"
        | "not-allowed"
        | "alias"
        | "copy"
        | "context-menu";
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
    nativeEvent: {
        locationX: number;
        locationY: number;
        pageX: number;
        pageY: number;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
        pressDrag?: boolean;
    };
}
export interface MouseResponderEvent extends GestureResponderEvent {
    type?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    pressDrag?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
    isDefaultPrevented?: () => boolean;
    isPropagationStopped?: () => boolean;
}

// ── common view props ───────────────────────────────────────────────
export type AccessibilityRole =
    | "none"
    | "button"
    | "link"
    | "search"
    | "image"
    | "keyboardkey"
    | "text"
    | "adjustable"
    | "imagebutton"
    | "header"
    | "summary"
    | "alert"
    | "checkbox"
    | "combobox"
    | "menu"
    | "menubar"
    | "menuitem"
    | "progressbar"
    | "radio"
    | "radiogroup"
    | "scrollbar"
    | "spinbutton"
    | "switch"
    | "tab"
    | "tablist"
    | "timer"
    | "toolbar";

export interface AccessibilityState {
    disabled?: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
    busy?: boolean;
    expanded?: boolean;
}

export interface AccessibilityValue {
    min?: number;
    max?: number;
    now?: number;
    text?: string;
}

export interface AccessibilityProps {
    accessible?: boolean;
    accessibilityElementsHidden?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: AccessibilityRole;
    accessibilityHint?: string;
    accessibilityState?: AccessibilityState;
    accessibilityValue?: AccessibilityValue | string | number;
    importantForAccessibility?: "auto" | "yes" | "no" | "no-hide-descendants";
    "aria-label"?: string;
    "aria-description"?: string;
    "aria-hidden"?: boolean;
    role?: AccessibilityRole;
    testID?: string;
    nativeID?: string;
}

export interface ViewProps extends AccessibilityProps, ViewStyle {
    children?: ReactNode;
    style?: StyleProp<ViewStyle>;
    hoverStyle?: StyleProp<ViewStyle>;
    pressStyle?: StyleProp<ViewStyle>;
    onClick?: (event: MouseResponderEvent) => void;
    onMouseDown?: (event: MouseResponderEvent) => void;
    onMouseUp?: (event: MouseResponderEvent) => void;
    onMouseEnter?: (event: MouseResponderEvent) => void;
    onMouseLeave?: (event: MouseResponderEvent) => void;
    onMouseOver?: (event: MouseResponderEvent) => void;
    onMouseOut?: (event: MouseResponderEvent) => void;
    onMouseMove?: (event: MouseResponderEvent) => void;
    onPointerDown?: (event: MouseResponderEvent) => void;
    onPointerUp?: (event: MouseResponderEvent) => void;
    onPointerEnter?: (event: MouseResponderEvent) => void;
    onPointerLeave?: (event: MouseResponderEvent) => void;
    onPointerMove?: (event: MouseResponderEvent) => void;
    onTouchStart?: (event: MouseResponderEvent) => void;
    onTouchMove?: (event: MouseResponderEvent) => void;
    onTouchEnd?: (event: MouseResponderEvent) => void;
    onTouchCancel?: (event: MouseResponderEvent) => void;
    onStartShouldSetResponder?: (event: MouseResponderEvent) => boolean;
    onStartShouldSetResponderCapture?: (event: MouseResponderEvent) => boolean;
    onResponderGrant?: (event: MouseResponderEvent) => void;
    onResponderMove?: (event: MouseResponderEvent) => void;
    onResponderRelease?: (event: MouseResponderEvent) => void;
    onResponderStart?: (event: MouseResponderEvent) => void;
    onResponderEnd?: (event: MouseResponderEvent) => void;
    onResponderTerminate?: (event: MouseResponderEvent) => void;
    onResponderTerminationRequest?: (event: MouseResponderEvent) => boolean;
    onHoverIn?: (event: MouseResponderEvent) => void;
    onHoverOut?: (event: MouseResponderEvent) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    pointerEvents?: "auto" | "none" | "box-none" | "box-only";
    /** gpui-only: stable key whose width/height may be changed by native runtime commands. */
    nativeLayoutKey?: string;
    /** gpui-only: drag this view to resize a keyed native layout target without React commits. */
    nativeResize?: NativeResizeSpec;
    /** gpui-only: scope press-drag activation to descendants with the same group. */
    nativeListGroup?: string;
}

export type NativeResizeEdge = "left" | "right" | "top" | "bottom";

export interface NativeResizeSpec {
    target: string;
    edge: NativeResizeEdge;
    min?: number;
    max?: number;
}
