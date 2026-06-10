// virtual module id the bundler plugins map to the esbuild-prebuilt upstream
// reanimated chunk (.reanimated-prebuilt/react-native-reanimated.mjs). Only
// reanimated-host.ts imports it; type-wise it IS upstream reanimated.
declare module 'rngpui-reanimated-prebuilt' {
  export * from 'react-native-reanimated'
  export { default } from 'react-native-reanimated'
}
