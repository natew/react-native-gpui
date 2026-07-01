import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { NativeMenus, type NativeMenuCommandItem } from "./commands";

type MenuKind = "ContextMenu" | "Menu";
type MenuPart =
    | "Content"
    | "Group"
    | "Item"
    | "CheckboxItem"
    | "ItemTitle"
    | "ItemSubtitle"
    | "Label"
    | "Separator"
    | "Sub"
    | "SubTrigger"
    | "SubContent";

type MenuNode =
    | {
          kind: "action";
          label: string;
          disabled?: boolean;
          hidden?: boolean;
          destructive?: boolean;
          checked?: boolean;
          onSelect?: (event?: Event) => void;
          onValueChange?: (next: "mixed" | "on" | "off", prev: "mixed" | "on" | "off") => void;
      }
    | { kind: "label"; label: string }
    | { kind: "separator" }
    | { kind: "submenu"; label: string; disabled?: boolean; hidden?: boolean; items: MenuNode[] };

type MenuContextValue = {
    kind: MenuKind;
    itemsRef: React.MutableRefObject<MenuNode[]>;
    openAt: (x: number, y: number) => void;
};

type NativeMenuAccessor = {
    set(state: { enabled: boolean; DropdownMenu: unknown; ContextMenu: unknown }): void;
};

type GetNativeMenuAccessor = () => NativeMenuAccessor;

const MenuContext = createContext<MenuContextValue | null>(null);

function markPart<T extends React.FC<any>>(component: T, part: MenuPart, displayName = part): T {
    (component as T & { __gpuiMenuPart?: MenuPart; displayName?: string }).__gpuiMenuPart = part;
    component.displayName = displayName;
    return component;
}

function getPart(type: unknown): MenuPart | null {
    const component = type as { __gpuiMenuPart?: MenuPart; displayName?: string } | null;
    const tagged = component?.__gpuiMenuPart;
    if (tagged) return tagged;
    const displayName = component?.displayName ?? "";
    if (displayName.includes("ItemSubtitle") || displayName.includes("MenuSubTitle")) {
        return "ItemSubtitle";
    }
    if (displayName.includes("ItemTitle") || displayName.includes("MenuTitle")) {
        return "ItemTitle";
    }
    if (
        displayName.includes("ItemIndicator") ||
        displayName.includes("ItemIcon") ||
        displayName.includes("ItemImage") ||
        displayName.includes("Arrow")
    ) {
        return null;
    }
    for (const part of [
        "SubContent",
        "SubTrigger",
        "Content",
        "Group",
        "CheckboxItem",
        "Separator",
        "Label",
        "Item",
        "Sub",
    ] as const) {
        if (displayName === part || displayName.includes(`(${part})`) || displayName.includes(part)) {
            return part;
        }
    }
    return null;
}

function composeHandlers<T extends (...args: any[]) => void>(first?: T, second?: T) {
    return (...args: Parameters<T>) => {
        first?.(...args);
        second?.(...args);
    };
}

function textFromChildren(children: React.ReactNode): string {
    let out = "";
    React.Children.forEach(children, (child) => {
        if (typeof child === "string" || typeof child === "number") {
            out += String(child);
            return;
        }
        if (!React.isValidElement(child)) return;
        out += textFromChildren((child.props as { children?: React.ReactNode }).children);
    });
    return out.trim();
}

function textFromPart(children: React.ReactNode, part: MenuPart): string {
    let found = "";
    React.Children.forEach(children, (child) => {
        if (found || !React.isValidElement(child)) return;
        if (getPart(child.type) === part) {
            found = textFromChildren((child.props as { children?: React.ReactNode }).children);
            return;
        }
        found = textFromPart((child.props as { children?: React.ReactNode }).children, part);
    });
    return found;
}

function itemLabel(props: Record<string, any>, fallback = "Item"): string {
    return (
        textFromPart(props.children as React.ReactNode, "ItemTitle") ||
        (typeof props.textValue === "string" ? props.textValue : "") ||
        textFromChildren(props.children as React.ReactNode) ||
        fallback
    );
}

function checkboxValue(value: unknown, checked: unknown): "mixed" | "on" | "off" {
    if (value === "mixed") return "mixed";
    if (value === "on" || value === true || checked === true) return "on";
    return "off";
}

function nextCheckboxValue(value: "mixed" | "on" | "off"): "on" | "off" {
    return value === "on" ? "off" : "on";
}

function collectMenuNodes(children: React.ReactNode): MenuNode[] {
    const nodes: MenuNode[] = [];

    React.Children.forEach(children, (child) => {
        if (!React.isValidElement(child)) return;
        const props = child.props as Record<string, any>;

        switch (getPart(child.type)) {
            case "Content":
            case "Group":
            case "SubContent":
                nodes.push(...collectMenuNodes(props.children as React.ReactNode));
                break;
            case "Label": {
                const label =
                    (typeof props.textValue === "string" ? props.textValue : "") ||
                    textFromChildren(props.children as React.ReactNode);
                if (label) nodes.push({ kind: "label", label });
                break;
            }
            case "Separator":
                nodes.push({ kind: "separator" });
                break;
            case "CheckboxItem": {
                const value = checkboxValue(props.value, props.checked);
                nodes.push({
                    kind: "action",
                    label: itemLabel(props),
                    disabled: !!props.disabled,
                    hidden: !!props.hidden,
                    destructive: !!props.destructive,
                    checked: value === "on" || value === "mixed",
                    onValueChange: () => {
                        const next = nextCheckboxValue(value);
                        props.onValueChange?.(next, value);
                        props.onCheckedChange?.(next === "on");
                    },
                });
                break;
            }
            case "Item":
                nodes.push({
                    kind: "action",
                    label: itemLabel(props),
                    disabled: !!props.disabled,
                    hidden: !!props.hidden,
                    destructive: !!props.destructive,
                    onSelect: props.onSelect,
                });
                break;
            case "Sub": {
                let label = "";
                let disabled = false;
                let hidden = false;
                let items: MenuNode[] = [];
                React.Children.forEach(props.children as React.ReactNode, (subChild) => {
                    if (!React.isValidElement(subChild)) return;
                    const subProps = subChild.props as Record<string, any>;
                    const subPart = getPart(subChild.type);
                    if (subPart === "SubTrigger") {
                        label = itemLabel(subProps, "Submenu");
                        disabled = !!subProps.disabled;
                        hidden = !!subProps.hidden;
                    } else if (subPart === "SubContent") {
                        items = collectMenuNodes(subProps.children as React.ReactNode);
                    }
                });
                if (label) nodes.push({ kind: "submenu", label, disabled, hidden, items });
                break;
            }
        }
    });

    return nodes;
}

function commandItemsFromNodes(nodes: MenuNode[], cleanupIds: string[]): NativeMenuCommandItem[] {
    const items: NativeMenuCommandItem[] = [];

    for (const node of nodes) {
        if ("hidden" in node && node.hidden) continue;
        if (node.kind === "separator") {
            items.push({ kind: "separator" });
            continue;
        }
        if (node.kind === "label") {
            items.push({ kind: "label", label: node.label });
            continue;
        }
        if (node.kind === "submenu") {
            items.push({
                kind: "submenu",
                label: node.label,
                disabled: node.disabled,
                items: commandItemsFromNodes(node.items, cleanupIds),
            });
            continue;
        }

        const id = NativeMenus.registerCallback(() => {
            if (node.onValueChange) {
                node.onValueChange("on", "off");
            } else {
                node.onSelect?.();
            }
        });
        cleanupIds.push(id);
        items.push({
            kind: "action",
            id,
            label: node.label,
            disabled: node.disabled,
            checked: node.checked,
            destructive: node.destructive,
        });
    }

    return items;
}

function eventPoint(event: any): { x: number; y: number } {
    const source = event?.nativeEvent ?? event ?? {};
    return {
        x: typeof source.pageX === "number" ? source.pageX : 0,
        y: typeof source.pageY === "number" ? source.pageY : 0,
    };
}

function createGpuiNativeMenu(kind: MenuKind) {
    const Root: React.FC<{
        children?: React.ReactNode;
        onOpenChange?: (open: boolean) => void;
        onOpenWillChange?: (open: boolean) => void;
    }> = ({ children, onOpenChange, onOpenWillChange }) => {
        const itemsRef = useRef<MenuNode[]>([]);
        const cleanupRef = useRef<string[]>([]);

        const cleanup = useCallback(() => {
            for (const id of cleanupRef.current) NativeMenus.unregisterCallback(id);
            cleanupRef.current = [];
        }, []);

        const openAt = useCallback(
            (x: number, y: number) => {
                cleanup();
                const cleanupIds: string[] = [];
                const items = commandItemsFromNodes(itemsRef.current, cleanupIds);
                if (items.length === 0) return;

                let closeId = "";
                closeId = NativeMenus.registerCallback(() => {
                    NativeMenus.unregisterCallback(closeId);
                    cleanup();
                    onOpenWillChange?.(false);
                    onOpenChange?.(false);
                });
                cleanupRef.current = [...cleanupIds, closeId];

                onOpenWillChange?.(true);
                onOpenChange?.(true);
                NativeMenus.showContextMenu({ x, y, items, closeId });
            },
            [cleanup, onOpenChange, onOpenWillChange],
        );

        useEffect(() => cleanup, [cleanup]);

        const value = useMemo<MenuContextValue>(
            () => ({ kind, itemsRef, openAt }),
            [itemsRef, openAt],
        );

        return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
    };
    Root.displayName = `${kind}Root`;

    const Trigger: React.FC<{ children: React.ReactElement; asChild?: boolean; action?: string } & Record<string, any>> = ({
        children,
        action: _action,
        asChild: _asChild,
        ...triggerProps
    }) => {
        const context = useContext(MenuContext);
        if (!context || !React.isValidElement(children)) return children;

        const eventName = context.kind === "ContextMenu" ? "onContextMenu" : "onPress";
        const childProps = children.props as Record<string, any>;
        const nextProps: Record<string, any> = {};

        for (const [key, value] of Object.entries(triggerProps)) {
            if (typeof value === "function" && typeof childProps[key] === "function") {
                nextProps[key] = composeHandlers(childProps[key], value as (...args: any[]) => void);
            } else {
                nextProps[key] = value;
            }
        }

        const open = (event: any) => {
            const point = eventPoint(event);
            if (context.kind === "ContextMenu") event?.preventDefault?.();
            context.openAt(point.x, point.y);
        };
        nextProps[eventName] =
            context.kind === "ContextMenu" ? composeHandlers(childProps[eventName], open) : open;

        return React.cloneElement(children, nextProps);
    };
    Trigger.displayName = "Trigger";

    const Content = markPart<React.FC<{ children?: React.ReactNode }>>(({ children }) => {
        const context = useContext(MenuContext);
        const nodes = useMemo(() => collectMenuNodes(children), [children]);
        if (context) context.itemsRef.current = nodes;
        return null;
    }, "Content");

    const Item = markPart<React.FC<Record<string, any>>>(() => null, "Item");
    const CheckboxItem = markPart<React.FC<Record<string, any>>>(() => null, "CheckboxItem");
    const ItemTitle = markPart<React.FC<{ children?: React.ReactNode }>>(() => null, "ItemTitle");
    const ItemSubtitle = markPart<React.FC<{ children?: React.ReactNode }>>(
        () => null,
        "ItemSubtitle",
    );
    const Label = markPart<React.FC<Record<string, any>>>(() => null, "Label");
    const Separator = markPart<React.FC<Record<string, any>>>(() => null, "Separator");
    const Group = markPart<React.FC<{ children?: React.ReactNode }>>(() => null, "Group");
    const Sub = markPart<React.FC<{ children?: React.ReactNode }>>(() => null, "Sub");
    const SubTrigger = markPart<React.FC<Record<string, any>>>(() => null, "SubTrigger");
    const SubContent = markPart<React.FC<{ children?: React.ReactNode }>>(() => null, "SubContent");

    const passthrough = (name: string) => {
        const Component: React.FC<{ children?: React.ReactNode }> = ({ children }) => <>{children}</>;
        Component.displayName = name;
        return Component;
    };
    const Empty: React.FC = () => null;

    return {
        Root,
        Trigger,
        Content,
        Item,
        ItemTitle,
        ItemSubtitle,
        ItemIcon: Empty,
        ItemImage: Empty,
        ItemIndicator: Empty,
        Arrow: Empty,
        Group,
        Label,
        Separator,
        Sub,
        SubTrigger,
        SubContent,
        CheckboxItem,
        Preview: Empty,
        Auxiliary: Empty,
        Portal: passthrough("Portal"),
        RadioGroup: passthrough(`${kind}RadioGroup`),
        RadioItem: passthrough(`${kind}RadioItem`),
    };
}

let didSetup = false;

export function setupTamaguiNativeMenus(getNativeMenuAccessor: GetNativeMenuAccessor) {
    if (didSetup) return;
    didSetup = true;
    getNativeMenuAccessor().set({
        enabled: true,
        DropdownMenu: createGpuiNativeMenu("Menu"),
        ContextMenu: createGpuiNativeMenu("ContextMenu"),
    });
}
