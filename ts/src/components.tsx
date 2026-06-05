/**
 * The component surface. Host primitives (View / Text / TextInput / Image / Svg /
 * WebView / ScrollView) are string tags the reconciler maps to GPUI elements;
 * everything else composes them, matching React Native's public components.
 */
import {
    createElement,
    Fragment,
    forwardRef,
    useImperativeHandle,
    useRef,
    useState,
    type ReactNode,
    type FC,
} from "react";
import { sendCommand } from "./commands";
import type { SerializedTerminalFrame } from "./runtime";
import type {
    ViewProps,
    TextStyle,
    ImageStyle,
    StyleProp,
    ViewStyle,
    ColorValue,
    GestureResponderEvent,
    LayoutChangeEvent,
    MouseResponderEvent,
    AccessibilityProps,
} from "./types";

// ── host primitives ─────────────────────────────────────────────────
// At runtime these are tag strings; the FC cast is purely for JSX typing.

export interface TextProps extends AccessibilityProps {
    children?: ReactNode;
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
    onPress?: (event: GestureResponderEvent) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    selectable?: boolean;
}
export const View = "View" as unknown as FC<ViewProps>;
export const Text = "Text" as unknown as FC<TextProps>;

export interface TextInputProps extends AccessibilityProps {
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    placeholderTextColor?: ColorValue;
    onChangeText?: (text: string) => void;
    onChange?: (event: { nativeEvent: { text: string } }) => void;
    onClick?: (event: MouseResponderEvent) => void;
    onMouseDown?: (event: MouseResponderEvent) => void;
    onMouseUp?: (event: MouseResponderEvent) => void;
    onMouseEnter?: (event: MouseResponderEvent) => void;
    onMouseLeave?: (event: MouseResponderEvent) => void;
    onTouchStart?: (event: MouseResponderEvent) => void;
    onTouchMove?: (event: MouseResponderEvent) => void;
    onTouchEnd?: (event: MouseResponderEvent) => void;
    onTouchCancel?: (event: MouseResponderEvent) => void;
    onStartShouldSetResponder?: (event: MouseResponderEvent) => boolean;
    onResponderGrant?: (event: MouseResponderEvent) => void;
    onResponderMove?: (event: MouseResponderEvent) => void;
    onResponderRelease?: (event: MouseResponderEvent) => void;
    onResponderTerminate?: (event: MouseResponderEvent) => void;
    onSubmitEditing?: (event: { nativeEvent: { text: string; value: string } }) => void;
    onKeyPress?: (event: unknown) => void;
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
    hoverStyle?: StyleProp<TextStyle>;
    pressStyle?: StyleProp<TextStyle>;
}
export interface TextInputHandle {
    focus: () => void;
    blur: () => void;
}
export const TextInput = forwardRef<TextInputHandle, TextInputProps>(function TextInput(props, ref) {
    const host = useRef<{ id: number } | null>(null);
    useImperativeHandle(
        ref,
        () => ({
            focus() {
                if (host.current) sendCommand({ $cmd: "focusInput", id: host.current.id });
            },
            blur() {
                if (host.current) sendCommand({ $cmd: "blurInput", id: host.current.id });
            },
        }),
        [],
    );
    return createElement("TextInput" as any, { ...props, ref: host });
});

export interface ImageProps extends AccessibilityProps {
    source: { uri: string } | string | number;
    style?: StyleProp<ImageStyle>;
    resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
    onLoad?: () => void;
    onLayout?: (event: LayoutChangeEvent) => void;
}
export const Image = "Image" as unknown as FC<ImageProps>;

export interface SvgProps extends AccessibilityProps {
    name: string;
    style?: StyleProp<ViewStyle & { color?: ColorValue }>;
}
/** `<Svg name="branch.svg" />` — a monochrome icon tinted by `style.color`. */
export const Svg = "Svg" as unknown as FC<SvgProps>;

export interface WebViewMessageEvent {
    nativeEvent: { data: string };
}
export interface WebViewProps extends AccessibilityProps {
    source: { uri: string } | { html: string };
    style?: StyleProp<ViewStyle>;
    /** the page finished loading */
    onLoad?: () => void;
    /** the page posted a message via `window.ReactNativeWebView.postMessage(data)` */
    onMessage?: (event: WebViewMessageEvent) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
}
/** imperative handle (host → frame) obtained via a `ref` on `<WebView>`. */
export interface WebViewHandle {
    /** run arbitrary JS inside the page */
    injectJavaScript: (js: string) => void;
    /** deliver a message to the page; arrives as a `message` event on window & document */
    postMessage: (data: string) => void;
    /** reload the current document */
    reload: () => void;
}
/**
 * `<WebView source={{ uri | html }} />` — a native WebView child (native web scroll +
 * selection). Two-way messaging: the page calls
 * `window.ReactNativeWebView.postMessage(d)` → `onMessage`; the host calls
 * `ref.injectJavaScript(js)` / `ref.postMessage(d)` / `ref.reload()` → the page.
 */
export const WebView = forwardRef<WebViewHandle, WebViewProps>(function WebView(props, ref) {
    // a ref on the host node resolves to the reconciler Instance (it carries the
    // node id), which is how a host → frame command targets this exact webview.
    const host = useRef<{ id: number } | null>(null);
    useImperativeHandle(
        ref,
        () => ({
            injectJavaScript(js) {
                if (host.current) sendCommand({ $cmd: "eval", id: host.current.id, js });
            },
            postMessage(data) {
                if (host.current) {
                    const js = `(function(){var e=new MessageEvent('message',{data:${JSON.stringify(
                        data,
                    )}});window.dispatchEvent(e);document.dispatchEvent(e);})();`;
                    sendCommand({ $cmd: "eval", id: host.current.id, js });
                }
            },
            reload() {
                if (host.current) sendCommand({ $cmd: "reload", id: host.current.id });
            },
        }),
        [],
    );
    return createElement("WebView" as any, { ...props, ref: host });
});

export type GhosttyTerminalFrame = SerializedTerminalFrame;

export interface GhosttyTerminalProps extends AccessibilityProps {
    style?: StyleProp<ViewStyle>;
    sessionId?: string;
    frames?: GhosttyTerminalFrame[];
    onPress?: (event: unknown) => void;
    onKeyPress?: (event: unknown) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
}

export const GhosttyTerminal = forwardRef<unknown, GhosttyTerminalProps>(function GhosttyTerminal(props, ref) {
    return createElement("GhosttyTerminal" as any, { ...props, ref });
});

// ── ScrollView ──────────────────────────────────────────────────────
export interface ScrollViewProps extends ViewProps {
    horizontal?: boolean;
    contentContainerStyle?: StyleProp<ViewStyle>;
    showsVerticalScrollIndicator?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    onScroll?: (event: unknown) => void;
}
export interface ScrollViewHandle {
    scrollTo: (options?: { x?: number; y?: number; animated?: boolean } | number) => void;
    scrollToEnd: (options?: { animated?: boolean }) => void;
}
export const ScrollView = forwardRef<ScrollViewHandle, ScrollViewProps>(function ScrollView({
    style,
    contentContainerStyle,
    horizontal,
    children,
    ...rest
}, ref) {
    const host = useRef<{ id: number } | null>(null);
    useImperativeHandle(
        ref,
        () => ({
            scrollTo(options) {
                if (!host.current) return;
                const y = typeof options === "number" ? options : options?.y;
                const x = typeof options === "object" ? options.x : undefined;
                sendCommand({ $cmd: "scrollTo", id: host.current.id, x, y });
            },
            scrollToEnd() {
                if (host.current) sendCommand({ $cmd: "scrollToEnd", id: host.current.id });
            },
        }),
        [],
    );
    // a scrolling container holding a content view (RN's contentContainer model).
    return createElement(
        "ScrollView" as any,
        { style, ...rest, ref: host },
        createElement(
            "View" as any,
            { style: [{ flexDirection: horizontal ? "row" : "column" } as ViewStyle, contentContainerStyle] },
            children,
        ),
    );
});

// ── Pressable / Touchables / Button ─────────────────────────────────
type PressableStyle = StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
export interface PressableProps extends AccessibilityProps {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    style?: PressableStyle;
    onPress?: (event: GestureResponderEvent) => void;
    onPressIn?: (event: GestureResponderEvent) => void;
    onPressOut?: (event: GestureResponderEvent) => void;
    onLongPress?: (event: GestureResponderEvent) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    disabled?: boolean;
    hitSlop?: number;
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
    const accessibilityState =
        disabled !== undefined || rest.accessibilityState
            ? { ...rest.accessibilityState, disabled: disabled ?? rest.accessibilityState?.disabled }
            : undefined;
    return createElement("View" as any, { style: resolvedStyle, ...handlers, ...rest, accessibilityState }, content);
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

export interface ButtonProps extends AccessibilityProps {
    title: string;
    onPress?: (event: GestureResponderEvent) => void;
    color?: ColorValue;
    disabled?: boolean;
}
export const Button: FC<ButtonProps> = ({ title, onPress, color = "#2f6fed", disabled, ...rest }) => {
    return createElement(
        Pressable,
        {
            ...rest,
            onPress,
            disabled,
            accessibilityRole: rest.accessibilityRole ?? "button",
            accessibilityLabel: rest.accessibilityLabel ?? title,
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
export interface SwitchProps extends AccessibilityProps {
    value?: boolean;
    onValueChange?: (value: boolean) => void;
    disabled?: boolean;
    trackColor?: { false?: ColorValue; true?: ColorValue };
    thumbColor?: ColorValue;
    style?: StyleProp<ViewStyle>;
}
export const Switch: FC<SwitchProps> = ({
    value,
    onValueChange,
    disabled,
    trackColor,
    thumbColor,
    style,
    ...rest
}) => {
    return createElement(
        Pressable,
        {
            ...rest,
            disabled,
            accessibilityRole: rest.accessibilityRole ?? "switch",
            accessibilityState: { ...rest.accessibilityState, disabled, checked: value },
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

// ── StatusBar (no-op on desktop — there is no OS status bar) ─────────
export interface StatusBarProps {
    barStyle?: "default" | "light-content" | "dark-content";
    hidden?: boolean;
    backgroundColor?: ColorValue;
    translucent?: boolean;
    animated?: boolean;
}
function StatusBarComponent(_props: StatusBarProps) {
    return null;
}
// ── Modal — renders its children inline when visible (no OS modal layer) ─────
export interface ModalProps {
    visible?: boolean;
    transparent?: boolean;
    animationType?: "none" | "slide" | "fade";
    onRequestClose?: () => void;
    onShow?: () => void;
    onDismiss?: () => void;
    children?: ReactNode;
    style?: StyleProp<ViewStyle>;
}
export const Modal: FC<ModalProps> = ({ visible = true, children }) =>
    visible ? createElement(Fragment, null, children as any) : null;

export const StatusBar = Object.assign(StatusBarComponent, {
    currentHeight: 0,
    setBarStyle(_style: string, _animated?: boolean): void {},
    setHidden(_hidden: boolean, _animation?: string): void {},
    setBackgroundColor(_color: ColorValue, _animated?: boolean): void {},
    setTranslucent(_translucent: boolean): void {},
    setNetworkActivityIndicatorVisible(_visible: boolean): void {},
    pushStackEntry(props: StatusBarProps): StatusBarProps {
        return props;
    },
    popStackEntry(_entry: StatusBarProps): void {},
    replaceStackEntry(_entry: StatusBarProps, props: StatusBarProps): StatusBarProps {
        return props;
    },
});

const nativeComponentNameMap: Record<string, string> = {
    PortalHostView: "RNTPortalHostView",
    PortalView: "RNTPortalView",
};

export function requireNativeComponent(name: string) {
    const hostName = nativeComponentNameMap[name] ?? name;
    return forwardRef<unknown, Record<string, unknown>>(function NativeComponent(props, ref) {
        return createElement(hostName as any, { ...props, ref }, props.children as ReactNode);
    });
}

export function codegenNativeComponent(name: string) {
    return requireNativeComponent(name);
}

export function codegenNativeCommands<T extends object = Record<string, never>>(): T {
    return {} as T;
}
