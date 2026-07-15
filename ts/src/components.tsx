/**
 * The component surface. Host primitives (View / Text / TextInput / Image / Svg /
 * WebView / ScrollView) are string tags the reconciler maps to GPUI elements;
 * everything else composes them, matching React Native's public components.
 */
import {
    createElement,
    Fragment,
    forwardRef,
    useEffect,
    useImperativeHandle,
    useId,
    useMemo,
    useRef,
    useState,
    type ReactNode,
    type FC,
    type MutableRefObject,
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
    onContextMenu?: (event: MouseResponderEvent) => void;
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
}
export interface TextInputHandle {
    focus: () => void;
    clear: () => void;
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
            clear() {
                if (host.current) sendCommand({ $cmd: "clearInput", id: host.current.id });
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

/**
 * The classic `NSVisualEffectView` semantic materials (the full AppKit set). Used for
 * a `<SystemView>` backdrop blur on every macOS version.
 */
export type SystemViewMaterial =
    | "titlebar"
    | "selection"
    | "menu"
    | "popover"
    | "sidebar"
    | "headerView"
    | "sheet"
    | "windowBackground"
    | "hudWindow"
    | "fullScreenUI"
    | "toolTip"
    | "contentBackground"
    | "underWindowBackground"
    | "underPageBackground";

/**
 * macOS 26 `NSGlassEffectView` liquid-glass variants (the full set from the
 * liquid-glass plugin's `GlassMaterialVariant`). Falls back to `material` below 26.
 */
export type SystemViewGlassVariant =
    | "regular"
    | "clear"
    | "dock"
    | "appIcons"
    | "widgets"
    | "text"
    | "avplayer"
    | "facetime"
    | "controlCenter"
    | "notificationCenter"
    | "monogram"
    | "bubbles"
    | "identity"
    | "focusBorder"
    | "focusPlatter"
    | "keyboard"
    | "sidebar"
    | "abuttedSidebar"
    | "inspector"
    | "control"
    | "loupe"
    | "slider"
    | "camera"
    | "cartouchePopover";

/** a `<SystemView>` native outer drop shadow (drawn below the surface, spills outward). */
export interface SystemViewShadow {
    /** shadow color — accepts hex `#RRGGBB` / `#RRGGBBAA` (alpha used if `opacity` omitted). */
    color?: ColorValue;
    /** blur radius in px. */
    radius?: number;
    /** horizontal offset in px (+x right). */
    offsetX?: number;
    /** vertical offset in px (+y down). */
    offsetY?: number;
    /** 0..1 shadow opacity (overrides any alpha baked into `color`). */
    opacity?: number;
}

export interface SystemViewProps extends AccessibilityProps {
    children?: ReactNode;
    style?: StyleProp<ViewStyle>;
    /**
     * `NSVisualEffectView` backdrop material (the full AppKit semantic set). When
     * omitted (and no `glassVariant`), the surface carries NO blur — only the optional
     * tint and/or shadow. An unknown value falls back to the HUD material.
     */
    material?: SystemViewMaterial;
    /**
     * macOS 26 `NSGlassEffectView` liquid-glass variant. When set and available
     * (macOS 26+), the surface is a glass view with this variant; otherwise it falls
     * back to `material` (or the HUD material). `blendingMode` is always BehindWindow.
     */
    glassVariant?: SystemViewGlassVariant;
    /** optional tint overlaid on the surface so foreground text stays legible. */
    tint?: ColorValue;
    /** optional native outer drop shadow (spills outside the rounded rect). */
    shadow?: SystemViewShadow;
    /** horizontal native alpha fade at the left/right edges, as a 0..0.5 width fraction. */
    edgeFade?: number;
    /** vertical native alpha fade: full opacity below this 0..1 height fraction, transparent at top. */
    topFadeStart?: number;
    onLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * `<SystemView>` — a native macOS surface parked behind the (transparent) app window
 * within just this element's rounded rect. It can composite a backdrop blur
 * (`material` / `glassVariant`), a `tint`, and a true outer drop `shadow`, any of which
 * are optional. Transparent window regions stay crisp; the surface follows the
 * element's layout bounds and RN opacity animations. Place one absolutely-filling a
 * card's background:
 *
 *   <View style={{ borderRadius: 16, overflow: "hidden" }}>
 *     <SystemView
 *       material="hudWindow"
 *       tint="#ffffff14"
 *       shadow={{ color: "#000000", radius: 24, offsetY: 8, opacity: 0.35 }}
 *       style={[StyleSheet.absoluteFill, { borderRadius: 16 }]}
 *     />
 *     <Text>foreground stays crisp</Text>
 *   </View>
 */
export const SystemView = "SystemView" as unknown as FC<SystemViewProps>;

export interface WebViewMessageEvent {
    nativeEvent: { data: string };
}
export interface WebViewProps extends AccessibilityProps {
    source: { uri: string } | { html: string };
    style?: StyleProp<ViewStyle>;
    boxShadow?: ViewStyle["boxShadow"];
    nativeHandleRef?: MutableRefObject<WebViewHandle | null>;
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

let nextHostCommandId = 1_000_000_000;

function createHostCommandId() {
    return nextHostCommandId++;
}

/**
 * `<WebView source={{ uri | html }} />` — a native WebView child (native web scroll +
 * selection). Two-way messaging: the page calls
 * `window.ReactNativeWebView.postMessage(d)` → `onMessage`; the host calls
 * `ref.injectJavaScript(js)` / `ref.postMessage(d)` / `ref.reload()` → the page.
 */
export const WebView = forwardRef<WebViewHandle, WebViewProps>(function WebView(props, ref) {
    const commandIdRef = useRef<number | null>(null);
    if (commandIdRef.current == null) commandIdRef.current = createHostCommandId();
    const commandId = commandIdRef.current;
    const handle = useMemo<WebViewHandle>(
        () => ({
            injectJavaScript(js) {
                sendCommand({ $cmd: "eval", id: commandId, js });
            },
            postMessage(data) {
                const js = `(function(){var e=new MessageEvent('message',{data:${JSON.stringify(
                    data,
                )}});window.dispatchEvent(e);document.dispatchEvent(e);})();`;
                sendCommand({ $cmd: "eval", id: commandId, js });
            },
            reload() {
                sendCommand({ $cmd: "reload", id: commandId });
            },
        }),
        [commandId],
    );
    useImperativeHandle(ref, () => handle, [handle]);
    if (props.nativeHandleRef) props.nativeHandleRef.current = handle;
    useEffect(() => {
        const nativeHandleRef = props.nativeHandleRef;
        if (!nativeHandleRef) return;
        nativeHandleRef.current = handle;
        return () => {
            if (nativeHandleRef.current === handle) nativeHandleRef.current = null;
        };
    }, [handle, props.nativeHandleRef]);
    const { nativeHandleRef: _nativeHandleRef, ...hostProps } = props;
    return createElement("WebView" as any, { ...hostProps, __rngpuiHostId: commandId });
});

export type GhosttyTerminalFrame = SerializedTerminalFrame;

export interface GhosttyTerminalProps extends AccessibilityProps {
    style?: StyleProp<ViewStyle>;
    boxShadow?: ViewStyle["boxShadow"];
    sessionId?: string;
    frames?: GhosttyTerminalFrame[];
    onPress?: (event: unknown) => void;
    onKeyPress?: (event: unknown) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    // raw text produced natively (clipboard paste, dropped file paths) to write
    // straight to the PTY.
    onInsertText?: (text: string) => void;
    // the grid the element measured from its own painted bounds + real font cell
    // metrics; size the PTY to this so the terminal fits the stage exactly.
    onMeasureViewport?: (viewport: { cols: number; rows: number }) => void;
}

export interface GhosttyTerminalHandle extends NativeHostHandle {
    showSession: (sessionId: string, frames: GhosttyTerminalFrame[]) => void;
}

export const GhosttyTerminal = forwardRef<GhosttyTerminalHandle, GhosttyTerminalProps>(function GhosttyTerminal(props, ref) {
    const host = useRef<NativeHostHandle | null>(null);
    const commandIdRef = useRef<number | null>(null);
    if (commandIdRef.current == null) commandIdRef.current = createHostCommandId();
    const commandId = commandIdRef.current;
    const handle = useMemo<GhosttyTerminalHandle>(
        () => ({
            id: commandId,
            measure(callback) {
                host.current?.measure?.(callback);
            },
            measureInWindow(callback) {
                host.current?.measureInWindow?.(callback);
            },
            measureLayout(relativeToNativeNode, onSuccess, onFail) {
                host.current?.measureLayout?.(relativeToNativeNode, onSuccess, onFail);
            },
            showSession(sessionId, frames) {
                sendCommand({ $cmd: "terminalSession", id: commandId, sessionId, frames });
            },
        }),
        [commandId],
    );
    useImperativeHandle(ref, () => handle, [handle]);
    return createElement("GhosttyTerminal" as any, {
        ...props,
        ref: host,
        __rngpuiHostId: commandId,
    });
});

// ── ScrollView ──────────────────────────────────────────────────────
export interface ScrollViewProps extends ViewProps {
    horizontal?: boolean;
    contentContainerStyle?: StyleProp<ViewStyle>;
    showsVerticalScrollIndicator?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    onScroll?: (event: unknown) => void;
}
export interface NativeHostHandle {
    id?: number;
    measure?: (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => void;
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    measureLayout?: (
        relativeToNativeNode: unknown,
        onSuccess: (left: number, top: number, width: number, height: number) => void,
        onFail?: () => void,
    ) => void;
}
export interface ScrollViewHandle extends NativeHostHandle {
    scrollTo: (options?: { x?: number; y?: number; animated?: boolean } | number) => void;
    scrollToEnd: (options?: { animated?: boolean }) => void;
    // RN's scroll-ref accessors. reanimated's findHostInstance fast path probes
    // getNativeScrollRef()/getScrollableNode() before falling back to the throwing
    // findHostInstance_DEPRECATED shim, so createAnimatedComponent(ScrollView) (and
    // useAnimatedScrollHandler) need these to resolve to the inner host node — which
    // carries __nativeTag/__internalInstanceHandle/_viewConfig (see reconciler).
    getNativeScrollRef: () => NativeHostHandle | null;
    getScrollableNode: () => NativeHostHandle | null;
}
export const ScrollView = forwardRef<ScrollViewHandle, ScrollViewProps>(function ScrollView({
    style,
    contentContainerStyle,
    horizontal,
    children,
    ...rest
}, ref) {
    const host = useRef<NativeHostHandle | null>(null);
    useImperativeHandle(
        ref,
        () => ({
            get id() {
                return host.current?.id;
            },
            measure(callback) {
                host.current?.measure?.(callback);
            },
            measureInWindow(callback) {
                host.current?.measureInWindow?.(callback);
            },
            measureLayout(relativeToNativeNode, onSuccess, onFail) {
                host.current?.measureLayout?.(relativeToNativeNode, onSuccess, onFail);
            },
            scrollTo(options) {
                const id = host.current?.id;
                if (!id) return;
                const y = typeof options === "number" ? options : options?.y;
                const x = typeof options === "object" ? options.x : undefined;
                sendCommand({
                    $cmd: "scrollTo",
                    id,
                    ...(x === undefined ? {} : { x }),
                    ...(y === undefined ? {} : { y }),
                });
            },
            scrollToEnd() {
                const id = host.current?.id;
                if (id) sendCommand({ $cmd: "scrollToEnd", id });
            },
            // the inner host node IS the scrollable node here (the reconciler tags
            // every instance), so both RN accessors return it. without these,
            // reanimated can't find the host instance and throws on mount.
            getNativeScrollRef() {
                return host.current;
            },
            getScrollableNode() {
                return host.current;
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

export interface RefreshControlProps {
    refreshing: boolean;
    onRefresh?: () => void;
    progressViewOffset?: number;
    tintColor?: ColorValue;
    title?: string;
    titleColor?: ColorValue;
    colors?: ColorValue[];
    enabled?: boolean;
    style?: StyleProp<ViewStyle>;
}
export function RefreshControl(_props: RefreshControlProps) {
    return null;
}

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
    nativeListGroup?: string;
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

export interface ListGroupProps extends ViewProps {
    id?: string;
    disabled?: boolean;
}
export const ListGroup: FC<ListGroupProps> = ({ id, disabled, ...props }) => {
    const generated = useId();
    return createElement(View, {
        ...props,
        nativeListGroup: disabled ? undefined : (id ?? generated),
    });
};

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

// ── native AppKit controls ──────────────────────────────────────────
// Real NSButton / NSTextField hole-punched through the gpui Metal layer (the same
// native-underlay pattern WebView uses), so they get the genuine macOS bezel, focus ring,
// accent color, and IME. Tradeoff (shared with WebView): the control tracks layout bounds
// but is a separate layer, so it doesn't ride gpui's transform/animation stack and isn't
// clipped by an ancestor's rounded/overflow clip. Best for chrome/forms; for in-content
// (scrolling lists, animated) use the gpui-drawn <Button>/<TextInput>. Native controls
// currently need explicit sizing via `style` — gpui can't measure the AppKit intrinsic size.
// macOS only; on other platforms the element lays out but paints nothing (native backends
// for Windows/Linux land later).

export interface NativeButtonProps extends AccessibilityProps {
    title: string;
    onPress?: (event: GestureResponderEvent) => void;
    disabled?: boolean;
    style?: StyleProp<ViewStyle>;
}
/** `<NativeButton>` — a real AppKit `NSButton`. See note above on the chrome/forms tradeoff. */
export const NativeButton: FC<NativeButtonProps> = ({ title, ...rest }) =>
    createElement("NativeButton" as any, {
        ...rest,
        title,
        accessibilityRole: rest.accessibilityRole ?? "button",
        accessibilityLabel: rest.accessibilityLabel ?? title,
    });

/** `<NativeTextInput>` — a real AppKit `NSTextField`/`NSSecureTextField`. See note above. */
export const NativeTextInput: FC<TextInputProps> = (props) =>
    createElement("NativeTextInput" as any, props);

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
