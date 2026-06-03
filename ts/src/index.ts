/**
 * react-native-gpui — write React Native components, render them natively with
 * GPUI (Zed's GPU UI framework) instead of a mobile host.
 *
 *   import { View, Text, StyleSheet, AppRegistry } from "react-native-gpui";
 */

// render entry points
export { createRoot, render, AppRegistry, type Root, type RootOptions } from "./render";

// components
export {
    View,
    Text,
    TextInput,
    Image,
    Svg,
    WebView,
    ScrollView,
    Pressable,
    TouchableOpacity,
    TouchableHighlight,
    TouchableWithoutFeedback,
    Button,
    SafeAreaView,
    KeyboardAvoidingView,
    Switch,
    FlatList,
    SectionList,
    ActivityIndicator,
} from "./components";
export type {
    TextProps,
    TextInputProps,
    ImageProps,
    SvgProps,
    WebViewProps,
    ScrollViewProps,
    PressableProps,
    TouchableProps,
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
} from "./types";

// dimensions + platform APIs
export { Dimensions, type ScaledSize } from "./Dimensions";
export { useWindowDimensions, Platform, PixelRatio, useColorScheme } from "./apis";

// low-level bridge (escape hatch)
export { startBridge, type Bridge, type BridgeEvent, type SerializedNode } from "./runtime";
