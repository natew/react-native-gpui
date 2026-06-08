/**
 * react-native-gpui — write React Native components, render them natively with
 * GPUI (Zed's GPU UI framework) instead of a mobile host.
 *
 *   import { View, Text, StyleSheet, AppRegistry } from "react-native-gpui";
 */
import "./raf";

// render entry points
export { createRoot, render, AppRegistry, type Root, type RootOptions, type DevtoolsOptions, type RunApplicationOptions } from "./render";

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
    Pressable,
    TouchableOpacity,
    TouchableHighlight,
    TouchableWithoutFeedback,
    ListGroup,
    Button,
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
    GhosttyTerminalProps,
    ScrollViewHandle,
    ScrollViewProps,
    PressableProps,
    TouchableProps,
    ListGroupProps,
    ButtonProps,
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
    type ColorSchemeName,
    type DynamicColorIOSTuple,
    type FilePickerOptions,
} from "./apis";
export { Animated, AnimatedValue, Easing } from "./Animated";
export {
    AppCommands,
    NativeLayout,
    type AppCommandBinding,
    type AppCommandConfig,
    type AppCommandMenu,
    type AppCommandMenuItem,
} from "./commands";
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
