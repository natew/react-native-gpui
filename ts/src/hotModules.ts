import * as React from "react";
import * as JSXRuntime from "react/jsx-runtime";
import * as JSXDevRuntime from "react/jsx-dev-runtime";
import * as Render from "./render";
import * as Components from "./components";
import * as Style from "./StyleSheet";
import * as Surfaces from "./surfaces";
import * as DimensionsModule from "./Dimensions";
import * as Apis from "./apis";
import * as AnimatedModule from "./Animated";
import * as Commands from "./commands";
import * as KeyboardNavigation from "./keyboard";
import * as Portal from "./portal";
import * as Runtime from "./runtime";
import * as PlatformDriver from "./platform-driver";

const nativeModule = Object.assign(
    {},
    Render,
    Components,
    Style,
    Surfaces,
    DimensionsModule,
    Apis,
    AnimatedModule,
    Commands,
    KeyboardNavigation,
    Portal,
    Runtime,
    PlatformDriver,
);

const globalObject = globalThis as typeof globalThis & { __rngpuiHotModules?: Record<string, unknown> };
const hotModules = globalObject.__rngpuiHotModules ?? {};
hotModules.react = React;
hotModules["react/jsx-runtime"] = JSXRuntime;
hotModules["react/jsx-dev-runtime"] = JSXDevRuntime;
hotModules["react-native-gpui"] = nativeModule;
hotModules["react-native"] = nativeModule;
globalObject.__rngpuiHotModules = hotModules;
