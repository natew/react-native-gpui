import { Fragment, createElement, type ReactNode } from "react";
import type { ViewStyle } from "./types";

export type PortalProviderProps = {
    children?: ReactNode;
};

export type PortalHostProps = {
    name?: string;
    style?: ViewStyle;
    children?: ReactNode;
};

export type PortalProps = {
    hostName?: string;
    name?: string;
    style?: ViewStyle;
    children?: ReactNode;
};

const ROOT_HOST_STYLE: ViewStyle = {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
};

export function PortalProvider({ children }: PortalProviderProps) {
    return createElement(
        Fragment,
        null,
        children ?? null,
        createElement(PortalHost, { name: "root", style: ROOT_HOST_STYLE }),
    );
}

export function PortalHost({ name = "root", style, children }: PortalHostProps) {
    return createElement(
        "RNTPortalHostView",
        {
            name,
            pointerEvents: "box-none",
            style,
        },
        children ?? null,
    );
}

export function Portal({ children, hostName = "root", name, style }: PortalProps) {
    return createElement(
        "RNTPortalView",
        {
            hostName,
            name,
            pointerEvents: "box-none",
            style,
        },
        children ?? null,
    );
}

export const NativePortal = Portal;
export const NativePortalHost = PortalHost;

export function usePortal(_hostName = "root") {
    return {
        isHostAvailable: true,
        removePortal(_name: string) {},
    };
}

type TamaguiPortalAccessor = {
    set: (state: { enabled: boolean; type: "teleport" }) => void;
};

type TamaguiGetPortal = (() => TamaguiPortalAccessor) | TamaguiPortalAccessor | undefined;

export function setupTamaguiNativePortal(getPortal?: TamaguiGetPortal) {
    const teleport = {
        Portal,
        PortalHost,
        PortalProvider,
        NativePortal,
        NativePortalHost,
        usePortal,
    };
    const global = globalThis as typeof globalThis & {
        __tamagui_teleport?: typeof teleport;
        __tamagui_native_portal_setup?: boolean;
    };

    global.__tamagui_teleport = teleport;
    global.__tamagui_native_portal_setup = true;

    const portal = typeof getPortal === "function" ? getPortal() : getPortal;
    portal?.set({ enabled: true, type: "teleport" });
}
