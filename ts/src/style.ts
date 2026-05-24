// ── CSS-like color parsing ──────────────────────────────────────────

function parseColor(color: unknown): string | undefined {
    if (typeof color === "number") {
        return "#" + color.toString(16).padStart(6, "0");
    }
    if (typeof color === "string") {
        return color;
    }
    return undefined;
}

// ── RN StyleSheet-like prop conversion ──────────────────────────────

export type RNStyle = {
    width?: number;
    height?: number;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    flex?: number;
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: number;
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    flexWrap?: "wrap" | "nowrap" | "wrap-reverse";
    justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around" | "space-evenly";
    alignItems?: "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    alignSelf?: "auto" | "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    gap?: number;
    position?: "relative" | "absolute";
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
    margin?: number;
    marginTop?: number;
    marginRight?: number;
    marginBottom?: number;
    marginLeft?: number;
    padding?: number;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    borderWidth?: number;
    borderColor?: string;
    borderRadius?: number;
    backgroundColor?: string;
    color?: string;
    fontSize?: number;
    fontWeight?: string;
    textAlign?: "auto" | "left" | "right" | "center" | "justify";
    lineHeight?: number;
    opacity?: number;
    overflow?: "visible" | "hidden" | "scroll";
    zIndex?: number;
};

/**
 * StyleSheet — RN-compatible style utility.
 */
export const StyleSheet = {
    create<T extends Record<string, RNStyle>>(styles: T): T {
        return styles;
    },
    hairlineWidth: 1 / (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 2),
    absoluteFill: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    } as RNStyle,
    absoluteFillObject: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    } as RNStyle,
    flatten<T extends RNStyle>(style: T | T[]): T {
        if (Array.isArray(style)) {
            return Object.assign({}, ...style) as T;
        }
        return style;
    },
};

type GpuiJsonStyle = Record<string, unknown>;

/**
 * Convert an RN-like style object to the JSON format the Rust runtime expects.
 */
export function rnStyleToJson(style?: RNStyle | number | Array<RNStyle | undefined | null>): GpuiJsonStyle | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        return mergeStyles(style.filter(Boolean) as RNStyle[]);
    }
    return convertStyle(style as RNStyle);
}

function mergeStyles(styles: RNStyle[]): GpuiJsonStyle {
    const result: GpuiJsonStyle = {};
    for (const s of styles) {
        Object.assign(result, convertStyle(s));
    }
    return result;
}

function convertStyle(s: RNStyle): GpuiJsonStyle {
    const out: GpuiJsonStyle = {};

    if (s.width !== undefined) out.width = s.width;
    if (s.height !== undefined) out.height = s.height;
    if (s.minWidth !== undefined) out.minWidth = s.minWidth;
    if (s.maxWidth !== undefined) out.maxWidth = s.maxWidth;
    if (s.minHeight !== undefined) out.minHeight = s.minHeight;
    if (s.maxHeight !== undefined) out.maxHeight = s.maxHeight;
    if (s.flex !== undefined) out.flex = s.flex;
    if (s.flexGrow !== undefined) out.flexGrow = s.flexGrow;
    if (s.flexShrink !== undefined) out.flexShrink = s.flexShrink;
    if (s.flexBasis !== undefined) out.flexBasis = s.flexBasis;
    if (s.flexDirection !== undefined) out.flexDirection = s.flexDirection;
    if (s.flexWrap !== undefined) out.flexWrap = s.flexWrap;
    if (s.justifyContent !== undefined) out.justifyContent = s.justifyContent;
    if (s.alignItems !== undefined) out.alignItems = s.alignItems;
    if (s.alignSelf !== undefined) out.alignSelf = s.alignSelf;
    if (s.gap !== undefined) out.gap = s.gap;
    if (s.position !== undefined) out.position = s.position;
    if (s.top !== undefined) out.top = s.top;
    if (s.right !== undefined) out.right = s.right;
    if (s.bottom !== undefined) out.bottom = s.bottom;
    if (s.left !== undefined) out.left = s.left;
    if (s.margin !== undefined) out.margin = s.margin;
    if (s.marginTop !== undefined) out.marginTop = s.marginTop;
    if (s.marginRight !== undefined) out.marginRight = s.marginRight;
    if (s.marginBottom !== undefined) out.marginBottom = s.marginBottom;
    if (s.marginLeft !== undefined) out.marginLeft = s.marginLeft;
    if (s.padding !== undefined) out.padding = s.padding;
    if (s.paddingTop !== undefined) out.paddingTop = s.paddingTop;
    if (s.paddingRight !== undefined) out.paddingRight = s.paddingRight;
    if (s.paddingBottom !== undefined) out.paddingBottom = s.paddingBottom;
    if (s.paddingLeft !== undefined) out.paddingLeft = s.paddingLeft;
    if (s.borderWidth !== undefined) out.borderWidth = s.borderWidth;
    if (s.borderColor !== undefined) out.borderColor = s.borderColor;
    if (s.borderRadius !== undefined) out.borderRadius = s.borderRadius;
    if (s.backgroundColor !== undefined) out.backgroundColor = s.backgroundColor;
    if (s.color !== undefined) out.color = s.color;
    if (s.fontSize !== undefined) out.fontSize = s.fontSize;
    if (s.fontWeight !== undefined) out.fontWeight = s.fontWeight;
    if (s.textAlign !== undefined) out.textAlign = s.textAlign;
    if (s.lineHeight !== undefined) out.lineHeight = s.lineHeight;
    if (s.opacity !== undefined) out.opacity = s.opacity;
    if (s.overflow !== undefined) out.overflow = s.overflow;
    if (s.zIndex !== undefined) out.zIndex = s.zIndex;

    return out;
}

export { parseColor };
