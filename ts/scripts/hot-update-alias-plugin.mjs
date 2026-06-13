const REACT_EXPORTS = [
  'Children', 'Component', 'Fragment', 'Profiler', 'PureComponent', 'StrictMode', 'Suspense',
  'cloneElement', 'createContext', 'createElement', 'createRef', 'forwardRef', 'isValidElement',
  'lazy', 'memo', 'startTransition', 'use', 'useActionState', 'useCallback', 'useContext',
  'useDebugValue', 'useDeferredValue', 'useEffect', 'useId', 'useImperativeHandle',
  'useInsertionEffect', 'useLayoutEffect', 'useMemo', 'useOptimistic', 'useReducer', 'useRef',
  'useState', 'useSyncExternalStore', 'useTransition', 'version',
]

const RNGPUI_EXPORTS = [
  'createRoot', 'render', 'AppRegistry', 'View', 'Text', 'TextInput', 'Image', 'Svg', 'WebView',
  'SystemView', 'GhosttyTerminal', 'ScrollView', 'Pressable', 'TouchableOpacity',
  'TouchableHighlight', 'TouchableWithoutFeedback', 'ListGroup', 'Button', 'SafeAreaView',
  'KeyboardAvoidingView', 'Switch', 'FlatList', 'SectionList', 'ActivityIndicator', 'StatusBar',
  'Modal', 'requireNativeComponent', 'codegenNativeComponent', 'codegenNativeCommands',
  'StyleSheet', 'normalizeStyle', 'LiquidGlassBackground', 'LiquidGlassView', 'EffectSurface',
  'SmokeEffectSurface', 'effectBackgroundImage', 'smokeEffectBackgroundImage', 'Dimensions',
  'useWindowDimensions', 'Platform', 'PixelRatio', 'useColorScheme', 'Appearance',
  'DynamicColorIOS', 'PlatformColor', 'I18nManager', 'Alert', 'Keyboard', 'BackHandler',
  'AppState', 'Linking', 'InteractionManager', 'LayoutAnimation', 'UIManager', 'NativeModules',
  'findNodeHandle', 'processColor', 'resolveColorValue', 'PanResponder', 'Vibration',
  'DeviceEventEmitter', 'NativeEventEmitter', 'AccessibilityInfo', 'FilePicker', 'VoiceRecorder',
  'Animated', 'AnimatedValue', 'Easing', 'AppCommands', 'Dock', 'NativeLayout',
  'KeyboardNavigationProvider', 'useKeyboardNavigation', 'useKeyboardNavigationController',
  'useKeyboardNavigationState', 'useKeyboardNavigationTarget', 'useKeyboardNavigationKeyPress',
  'useKeyboardNavigationWindowKeyboard', 'mergeRefs', 'enabledKeyboardNavigationTargets',
  'firstKeyboardNavigationTarget', 'nextKeyboardNavigationTarget', 'nextSequentialKeyboardNavigationTarget',
  'Portal', 'PortalHost', 'PortalProvider', 'NativePortal', 'NativePortalHost', 'usePortal',
  'setupTamaguiNativePortal', 'startBridge', 'platformDriver', 'registerPseudoListener',
]

export function rngpuiHotUpdateAliasPlugin() {
  return {
    name: 'rngpui-hot-update-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'rngpui-hot:react', namespace: 'rngpui-hot' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'rngpui-hot:react/jsx-runtime', namespace: 'rngpui-hot' }))
      build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: 'rngpui-hot:react/jsx-dev-runtime', namespace: 'rngpui-hot' }))
      build.onResolve({ filter: /^react\/compiler-runtime$/ }, () => ({ path: 'rngpui-hot:react/compiler-runtime', namespace: 'rngpui-hot' }))
      build.onResolve({ filter: /^react-native-gpui$/ }, () => ({ path: 'rngpui-hot:react-native-gpui', namespace: 'rngpui-hot' }))
      build.onResolve({ filter: /^react-native$/ }, () => ({ path: 'rngpui-hot:react-native', namespace: 'rngpui-hot' }))

      build.onLoad({ filter: /^rngpui-hot:react$/, namespace: 'rngpui-hot' }, () => ({
        loader: 'js',
        contents: moduleShim('react', REACT_EXPORTS, true),
      }))
      build.onLoad({ filter: /^rngpui-hot:react\/jsx-runtime$/, namespace: 'rngpui-hot' }, () => ({
        loader: 'js',
        contents: moduleShim('react/jsx-runtime', ['Fragment', 'jsx', 'jsxs'], true),
      }))
      build.onLoad({ filter: /^rngpui-hot:react\/jsx-dev-runtime$/, namespace: 'rngpui-hot' }, () => ({
        loader: 'js',
        contents: moduleShim('react/jsx-dev-runtime', ['Fragment', 'jsxDEV'], true),
      }))
      build.onLoad({ filter: /^rngpui-hot:react\/compiler-runtime$/, namespace: 'rngpui-hot' }, () => ({
        loader: 'js',
        contents: `const mod = globalThis.__rngpuiHotModules.react; export const c = mod.__COMPILER_RUNTIME?.c || function(size){ return new Array(size); };`,
      }))
      build.onLoad({ filter: /^rngpui-hot:react-native-gpui$/, namespace: 'rngpui-hot' }, () => ({
        loader: 'js',
        contents: moduleShim('react-native-gpui', RNGPUI_EXPORTS, true),
      }))
      build.onLoad({ filter: /^rngpui-hot:react-native$/, namespace: 'rngpui-hot' }, () => ({
        loader: 'js',
        contents: moduleShim('react-native', RNGPUI_EXPORTS, true),
      }))
    },
  }
}

function moduleShim(name, exports, defaultExport) {
  const lines = [`const mod = globalThis.__rngpuiHotModules[${JSON.stringify(name)}];`]
  if (defaultExport) lines.push('export default (mod.default || mod);')
  for (const key of exports) lines.push(`export const ${key} = mod[${JSON.stringify(key)}];`)
  return lines.join('\n')
}
