/**
 * The component surface. Host primitives (View / Text / TextInput / Image / Svg /
 * WebView / ScrollView) are string tags the reconciler maps to GPUI elements;
 * everything else composes them, matching React Native's public components.
 */
import { createElement, Fragment, useState, type ReactNode, type FC } from "react";
import type {
    ViewProps,
    TextStyle,
    ImageStyle,
    StyleProp,
    ViewStyle,
    ColorValue,
    GestureResponderEvent,
    LayoutChangeEvent,
} from "./types";

// ── host primitives ─────────────────────────────────────────────────
// At runtime these are tag strings; the FC cast is purely for JSX typing.

export interface TextProps {
    children?: ReactNode;
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
    onPress?: (event: GestureResponderEvent) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    selectable?: boolean;
    testID?: string;
}
export const View = "View" as unknown as FC<ViewProps>;
export const Text = "Text" as unknown as FC<TextProps>;

export interface TextInputProps {
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    placeholderTextColor?: ColorValue;
    onChangeText?: (text: string) => void;
    onChange?: (event: { nativeEvent: { text: string } }) => void;
    onSubmitEditing?: (event: unknown) => void;
    onFocus?: (event: unknown) => void;
    onBlur?: (event: unknown) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    multiline?: boolean;
    secureTextEntry?: boolean;
    editable?: boolean;
    autoFocus?: boolean;
    keyboardType?: "default" | "number-pad" | "decimal-pad" | "numeric" | "email-address" | "phone-pad";
    returnKeyType?: string;
    maxLength?: number;
    style?: StyleProp<TextStyle>;
    testID?: string;
}
export const TextInput = "TextInput" as unknown as FC<TextInputProps>;

export interface ImageProps {
    source: { uri: string } | string | number;
    style?: StyleProp<ImageStyle>;
    resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
    onLoad?: () => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    testID?: string;
}
export const Image = "Image" as unknown as FC<ImageProps>;

export interface SvgProps {
    name: string;
    style?: StyleProp<ViewStyle & { color?: ColorValue }>;
}
/** `<Svg name="branch.svg" />` — a monochrome icon tinted by `style.color`. */
export const Svg = "Svg" as unknown as FC<SvgProps>;

export interface WebViewProps {
    source: { uri: string } | { html: string };
    style?: StyleProp<ViewStyle>;
    onLoad?: () => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    testID?: string;
}
/** `<WebView source={{ uri }} />` — a native WebView child (native web scroll). */
export const WebView = "WebView" as unknown as FC<WebViewProps>;

// ── ScrollView ──────────────────────────────────────────────────────
export interface ScrollViewProps extends ViewProps {
    horizontal?: boolean;
    contentContainerStyle?: StyleProp<ViewStyle>;
    showsVerticalScrollIndicator?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    onScroll?: (event: unknown) => void;
}
export const ScrollView: FC<ScrollViewProps> = ({
    style,
    contentContainerStyle,
    horizontal,
    children,
    ...rest
}) => {
    // a scrolling container holding a content view (RN's contentContainer model).
    return createElement(
        "ScrollView" as any,
        { style, ...rest },
        createElement(
            "View" as any,
            { style: [{ flexDirection: horizontal ? "row" : "column" } as ViewStyle, contentContainerStyle] },
            children,
        ),
    );
};

// ── Pressable / Touchables / Button ─────────────────────────────────
type PressableStyle = StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
export interface PressableProps {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    style?: PressableStyle;
    onPress?: (event: GestureResponderEvent) => void;
    onPressIn?: (event: GestureResponderEvent) => void;
    onPressOut?: (event: GestureResponderEvent) => void;
    onLongPress?: (event: GestureResponderEvent) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    disabled?: boolean;
    hitSlop?: number;
    testID?: string;
}
export const Pressable: FC<PressableProps> = ({
    children,
    style,
    onPress,
    onPressIn,
    onPressOut,
    onLongPress,
    disabled,
    ...rest
}) => {
    const [pressed, setPressed] = useState(false);
    const handlers = disabled
        ? {}
        : {
              onPress,
              onLongPress,
              onPressIn: (e: GestureResponderEvent) => {
                  setPressed(true);
                  onPressIn?.(e);
              },
              onPressOut: (e: GestureResponderEvent) => {
                  setPressed(false);
                  onPressOut?.(e);
              },
          };
    const resolvedStyle = typeof style === "function" ? style({ pressed }) : style;
    const content = typeof children === "function" ? children({ pressed }) : children;
    return createElement("View" as any, { style: resolvedStyle, ...handlers, ...rest }, content);
};

export interface TouchableProps extends PressableProps {
    activeOpacity?: number;
}
export const TouchableOpacity: FC<TouchableProps> = ({ activeOpacity = 0.2, style, ...rest }) => {
    return createElement(Pressable, {
        ...rest,
        style: ({ pressed }: { pressed: boolean }) => [style as any, pressed && { opacity: activeOpacity }],
    });
};
export const TouchableHighlight: FC<TouchableProps & { underlayColor?: ColorValue }> = ({
    underlayColor = "#00000022",
    style,
    ...rest
}) => {
    return createElement(Pressable, {
        ...rest,
        style: ({ pressed }: { pressed: boolean }) => [style as any, pressed && { backgroundColor: underlayColor }],
    });
};
export const TouchableWithoutFeedback: FC<PressableProps> = (props) => createElement(Pressable, props);

export interface ButtonProps {
    title: string;
    onPress?: (event: GestureResponderEvent) => void;
    color?: ColorValue;
    disabled?: boolean;
    testID?: string;
}
export const Button: FC<ButtonProps> = ({ title, onPress, color = "#2f6fed", disabled }) => {
    return createElement(
        Pressable,
        {
            onPress,
            disabled,
            style: ({ pressed }: { pressed: boolean }) =>
                ({
                    backgroundColor: color,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderRadius: 8,
                    alignItems: "center",
                    opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
                }) as ViewStyle,
        },
        createElement(Text, { style: { color: "#ffffff", fontSize: 15, fontWeight: "600" } }, title),
    );
};

// ── layout passthroughs (no insets / keyboard on desktop) ───────────
export const SafeAreaView: FC<ViewProps> = (props) => createElement(View, props);
export interface KeyboardAvoidingViewProps extends ViewProps {
    behavior?: "height" | "position" | "padding";
    keyboardVerticalOffset?: number;
}
export const KeyboardAvoidingView: FC<KeyboardAvoidingViewProps> = ({
    behavior: _b,
    keyboardVerticalOffset: _o,
    ...props
}) => createElement(View, props);

// ── Switch ──────────────────────────────────────────────────────────
export interface SwitchProps {
    value?: boolean;
    onValueChange?: (value: boolean) => void;
    disabled?: boolean;
    trackColor?: { false?: ColorValue; true?: ColorValue };
    thumbColor?: ColorValue;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}
export const Switch: FC<SwitchProps> = ({ value, onValueChange, disabled, trackColor, thumbColor, style }) => {
    return createElement(
        Pressable,
        {
            disabled,
            onPress: () => onValueChange?.(!value),
            style: [
                {
                    width: 51,
                    height: 31,
                    borderRadius: 16,
                    padding: 2,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: value ? "flex-end" : "flex-start",
                    backgroundColor: value ? trackColor?.true ?? "#34c759" : trackColor?.false ?? "#e9e9ea",
                    opacity: disabled ? 0.5 : 1,
                } as ViewStyle,
                style,
            ],
        },
        createElement(View, {
            style: { width: 27, height: 27, borderRadius: 14, backgroundColor: thumbColor ?? "#ffffff" },
        }),
    );
};

// ── FlatList / SectionList ──────────────────────────────────────────
export interface FlatListProps<T> {
    data?: ReadonlyArray<T>;
    renderItem: (info: { item: T; index: number }) => ReactNode;
    keyExtractor?: (item: T, index: number) => string;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ItemSeparatorComponent?: FC<any>;
    horizontal?: boolean;
    numColumns?: number;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    onLayout?: (event: LayoutChangeEvent) => void;
}
export function FlatList<T>({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    ItemSeparatorComponent,
    horizontal,
    style,
    contentContainerStyle,
    ...rest
}: FlatListProps<T>) {
    const rows = data ?? [];
    const children: ReactNode[] = [];
    if (ListHeaderComponent) children.push(createElement(Fragment, { key: "h" }, ListHeaderComponent as any));
    if (rows.length === 0 && ListEmptyComponent) {
        children.push(createElement(Fragment, { key: "e" }, ListEmptyComponent as any));
    }
    rows.forEach((item, index) => {
        const key = keyExtractor ? keyExtractor(item, index) : String(index);
        children.push(createElement(Fragment, { key }, renderItem({ item, index }) as any));
        if (ItemSeparatorComponent && index < rows.length - 1) {
            children.push(createElement(ItemSeparatorComponent, { key: `${key}-sep` }));
        }
    });
    if (ListFooterComponent) children.push(createElement(Fragment, { key: "f" }, ListFooterComponent as any));
    return createElement(
        ScrollView,
        { horizontal, style, contentContainerStyle, ...rest },
        children,
    );
}

export interface SectionListData<T> {
    title?: string;
    data: ReadonlyArray<T>;
}
export interface SectionListProps<T> {
    sections: ReadonlyArray<SectionListData<T>>;
    renderItem: (info: { item: T; index: number; section: SectionListData<T> }) => ReactNode;
    renderSectionHeader?: (info: { section: SectionListData<T> }) => ReactNode;
    keyExtractor?: (item: T, index: number) => string;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
}
export function SectionList<T>({
    sections,
    renderItem,
    renderSectionHeader,
    keyExtractor,
    style,
    contentContainerStyle,
}: SectionListProps<T>) {
    const children: ReactNode[] = [];
    sections.forEach((section, si) => {
        if (renderSectionHeader) {
            children.push(createElement(Fragment, { key: `s${si}` }, renderSectionHeader({ section }) as any));
        }
        section.data.forEach((item, index) => {
            const key = keyExtractor ? keyExtractor(item, index) : `s${si}-${index}`;
            children.push(createElement(Fragment, { key }, renderItem({ item, index, section }) as any));
        });
    });
    return createElement(ScrollView, { style, contentContainerStyle }, children);
}

// ── ActivityIndicator (minimal — kept tiny on purpose) ──────────────
export interface ActivityIndicatorProps {
    size?: "small" | "large" | number;
    color?: ColorValue;
    style?: StyleProp<ViewStyle>;
}
export const ActivityIndicator: FC<ActivityIndicatorProps> = ({ color = "#888", size = "small", style }) => {
    const dim = size === "large" ? 28 : typeof size === "number" ? size : 18;
    return createElement(
        View,
        { style: [{ alignItems: "center", justifyContent: "center" }, style] },
        createElement(Text, { style: { color, fontSize: dim } }, "◌"),
    );
};
