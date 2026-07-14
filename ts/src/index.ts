/**
 * react-native-gpui — write React Native components, render them natively with
 * GPUI (Zed's GPU UI framework) instead of a mobile host.
 *
 *   import { View, Text, StyleSheet, AppRegistry } from "react-native-gpui";
 */
import "./raf";
import "./hotModules";

// render entry points
export {
    createRoot,
    render,
    AppRegistry,
    unstable_batchedUpdates,
    type Root,
    type RootOptions,
    type DevtoolsOptions,
    type RunApplicationOptions,
} from "./render";

// components
export {
    View,
    Text,
    TextInput,
    Image,
    Svg,
    WebView,
    SystemView,
    GhosttyTerminal,
    ScrollView,
    RefreshControl,
    Pressable,
    TouchableOpacity,
    TouchableHighlight,
    TouchableWithoutFeedback,
    ListGroup,
    Button,
    NativeButton,
    NativeTextInput,
    SafeAreaView,
    KeyboardAvoidingView,
    Switch,
    FlatList,
    SectionList,
    ActivityIndicator,
    StatusBar,
    Modal,
    requireNativeComponent,
    codegenNativeComponent,
    codegenNativeCommands,
} from "./components";
export type {
    TextProps,
    TextInputProps,
    TextInputHandle,
    ImageProps,
    SvgProps,
    WebViewProps,
    WebViewHandle,
    WebViewMessageEvent,
    SystemViewProps,
    SystemViewMaterial,
    SystemViewGlassVariant,
    SystemViewShadow,
    GhosttyTerminalFrame,
    GhosttyTerminalHandle,
    GhosttyTerminalProps,
    ScrollViewHandle,
    ScrollViewProps,
    RefreshControlProps,
    PressableProps,
    TouchableProps,
    ListGroupProps,
    ButtonProps,
    NativeButtonProps,
    SwitchProps,
    FlatListProps,
    SectionListProps,
    KeyboardAvoidingViewProps,
    ActivityIndicatorProps,
} from "./components";

// stylesheet + style types
export { StyleSheet, normalizeStyle } from "./StyleSheet";
export type {
    ColorValue,
    DimensionValue,
    FlexStyle,
    ShadowStyleIOS,
    ViewStyle,
    TextStyle,
    ImageStyle,
    StyleProp,
    ViewProps,
    LayoutRectangle,
    LayoutChangeEvent,
    GestureResponderEvent,
    MouseResponderEvent,
    NativeResizeEdge,
    NativeResizeSpec,
} from "./types";
export {
    LiquidGlassBackground,
    LiquidGlassView,
    EffectSurface,
    SmokeEffectSurface,
    effectBackgroundImage,
    smokeEffectBackgroundImage,
} from "./surfaces";
export type {
    LiquidGlassBackgroundProps,
    LiquidGlassChrome,
    LiquidGlassViewProps,
    EffectSurfaceEffect,
    EffectSurfaceProps,
    SmokeEffect,
    SmokeEffectSurfaceProps,
} from "./surfaces";

// dimensions + platform APIs
export { Dimensions, type ScaledSize } from "./Dimensions";
export {
    useWindowDimensions,
    Platform,
    PixelRatio,
    useColorScheme,
    Appearance,
    DynamicColorIOS,
    PlatformColor,
    I18nManager,
    Alert,
    Keyboard,
    BackHandler,
    AppState,
    Linking,
    InteractionManager,
    LayoutAnimation,
    UIManager,
    NativeModules,
    findNodeHandle,
    processColor,
    resolveColorValue,
    PanResponder,
    Vibration,
    DeviceEventEmitter,
    NativeEventEmitter,
    AccessibilityInfo,
    FilePicker,
    VoiceRecorder,
    type ColorSchemeName,
    type DynamicColorIOSTuple,
    type FilePickerOptions,
    type VoiceRecording,
} from "./apis";
export { Animated, AnimatedValue, Easing } from "./Animated";
export {
    AppCommands,
    Dock,
    NativeClipboard,
    NativeLayout,
    NativeMenus,
    NativeWindow,
    type AppCommandBinding,
    type AppCommandConfig,
    type AppCommandMenu,
    type AppCommandMenuItem,
    type NativeMenuCommandItem,
} from "./commands";
export { setupTamaguiNativeMenus } from "./native-menu";
export {
    KeyboardNavigationProvider,
    useKeyboardNavigation,
    useKeyboardNavigationController,
    useKeyboardNavigationState,
    useKeyboardNavigationTarget,
    useKeyboardNavigationKeyPress,
    useKeyboardNavigationWindowKeyboard,
    mergeRefs,
    enabledKeyboardNavigationTargets,
    firstKeyboardNavigationTarget,
    hasKeyboardNavigationModifier,
    nextKeyboardNavigationTarget,
    nextSequentialKeyboardNavigationTarget,
} from "./keyboard";
export type {
    KeyboardNavigationChange,
    KeyboardNavigationController,
    KeyboardNavigationControllerOptions,
    KeyboardNavigationDirection,
    KeyboardNavigationEventLike,
    KeyboardNavigationFocusOptions,
    KeyboardNavigationKeyPressOptions,
    KeyboardNavigationModelOptions,
    KeyboardNavigationReason,
    KeyboardNavigationRect,
    KeyboardNavigationSequentialDirection,
    KeyboardNavigationState,
    KeyboardNavigationTarget,
    KeyboardNavigationTargetModel,
    KeyboardNavigationVerticalScope,
} from "./keyboard";
export {
    Portal,
    PortalHost,
    PortalProvider,
    NativePortal,
    NativePortalHost,
    usePortal,
    setupTamaguiNativePortal,
    type PortalProps,
    type PortalHostProps,
    type PortalProviderProps,
} from "./portal";

// low-level bridge (escape hatch)
export { startBridge, type Bridge, type BridgeEvent, type BridgeOptions, type SerializedNode } from "./runtime";

// renderer platform driver — tamagui's @tamagui/core setupPlatformDriver(platformDriver)
// consumes this for renderer-owned pseudo (hover/press) states. See platform-driver.ts.
export { platformDriver, registerPseudoListener, type PseudoState, type PseudoListener } from "./platform-driver";

// no-op stubs for native modules that some libraries expect from
// react-native (TurboModule etc.). On desktop these have no real
// counterpart — they exist to satisfy import resolution so e.g.
// expo-clipboard can bundle even when its native code is never called.
export const TurboModuleRegistry = {
    get: <T>(_name: string): T | null => null,
    getEnforcing: <T>(_name: string): T => {
        throw new Error(`TurboModule "${_name}" not available on desktop`)
    },
}
