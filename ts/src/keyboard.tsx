import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
    type Ref,
    type RefCallback,
} from "react";
import { Dimensions } from "./Dimensions";
import type { ViewProps } from "./types";

export type KeyboardNavigationDirection = "up" | "down" | "left" | "right";
export type KeyboardNavigationSequentialDirection = 1 | -1;
export type KeyboardNavigationReason = "keyboard" | "pointer" | "programmatic";
export type KeyboardNavigationVerticalScope = "group" | "all";
export type KeyboardNavigationRect = { x: number; y: number; width: number; height: number };

export type KeyboardNavigationTargetModel = {
    id: string;
    group?: string;
    disabled?: boolean;
    rect?: KeyboardNavigationRect;
};

export type KeyboardNavigationModelOptions = {
    groupOrder?: readonly string[];
    verticalScope?: KeyboardNavigationVerticalScope;
};

export type KeyboardNavigationFocusOptions = {
    focusVisible?: boolean;
    reason?: KeyboardNavigationReason;
    direction?: KeyboardNavigationDirection | "next" | "previous";
};

export type KeyboardNavigationChange = {
    previousId: string;
    id: string;
    previousTarget?: KeyboardNavigationTargetModel;
    target: KeyboardNavigationTargetModel;
    reason: KeyboardNavigationReason;
    direction?: KeyboardNavigationDirection | "next" | "previous";
};

export type KeyboardNavigationTarget = KeyboardNavigationTargetModel & {
    textEntry?: boolean;
    activateOnArrow?: boolean;
    onActivate?: (event?: unknown) => void;
    onFocus?: (change: KeyboardNavigationChange) => void;
    onBlur?: (change: KeyboardNavigationChange) => void;
    onDismiss?: () => boolean;
    onMove?: (direction: KeyboardNavigationDirection) => boolean;
    onPreviewMove?: (direction: KeyboardNavigationDirection) => boolean;
    onUnhandledMove?: (direction: KeyboardNavigationDirection) => boolean;
    onSequentialMove?: (direction: KeyboardNavigationSequentialDirection) => boolean;
    pressToActivate?: boolean;
    composeRef?: Ref<unknown>;
};

export type KeyboardNavigationState = {
    focusedId: string;
    focusedGroup: string;
    focusVisible: boolean;
    focusedTextEntry: boolean;
};

export type KeyboardNavigationController = {
    focusedId: string;
    focusedGroup: string;
    focusVisible: boolean;
    focusedTextEntry: boolean;
    focusTarget: (id: string, options?: KeyboardNavigationFocusOptions) => boolean;
    reportRect: (id: string, rect: KeyboardNavigationRect) => void;
    focusFirstInGroup: (group: string) => boolean;
    moveFocus: (direction: KeyboardNavigationDirection, mode?: "preview" | "immediate") => boolean;
    moveSequentialFocus: (
        direction: KeyboardNavigationSequentialDirection,
        options?: { allowTextEntry?: boolean },
    ) => boolean;
    activateFocused: () => boolean;
    dismissFocused: () => boolean;
    restoreLastNonTextFocus: () => boolean;
    registerTarget: (target: KeyboardNavigationTarget) => () => void;
    subscribeState: (listener: () => void) => () => void;
    stateSnapshot: () => KeyboardNavigationState;
    subscribeTarget: (id: string, listener: () => void) => () => void;
    targetSnapshot: (id: string) => string;
    debugTargets: () => KeyboardNavigationTargetModel[];
    idPrefix: string;
};

export type KeyboardNavigationControllerOptions = KeyboardNavigationModelOptions & {
    initialId: string;
    initialGroup?: string;
    initialFocusVisible?: boolean;
    idPrefix?: string;
    onFocusChange?: (change: KeyboardNavigationChange) => void;
};

export type KeyboardNavigationKeyPressOptions = {
    enabled?: boolean;
    allowTextEntryTab?: boolean;
    onEscape?: () => void;
    shouldHandleEvent?: (event: unknown) => boolean;
};

export type KeyboardNavigationEventLike = {
    nativeEvent?: {
        key?: string;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
        isComposing?: boolean;
    };
    key?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
};

type MeasurableNode = {
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
};

const DEFAULT_ID_PREFIX = "rngpui-keyboard-";
const RESIZE_SETTLE_MS = 120;

const KeyboardNavigationContext = createContext<KeyboardNavigationController | null>(null);

export function KeyboardNavigationProvider({
    controller,
    children,
}: {
    controller: KeyboardNavigationController;
    children: ReactNode;
}) {
    return <KeyboardNavigationContext.Provider value={controller}>{children}</KeyboardNavigationContext.Provider>;
}

export function useKeyboardNavigation() {
    return useContext(KeyboardNavigationContext);
}

export function mergeRefs<T>(...refs: Array<Ref<T> | undefined | null>): RefCallback<T> {
    return (value: T | null) => {
        for (const ref of refs) {
            if (!ref) continue;
            if (typeof ref === "function") ref(value);
            else (ref as { current: T | null }).current = value;
        }
    };
}

export function enabledKeyboardNavigationTargets(targets: KeyboardNavigationTargetModel[]) {
    return targets.filter((target) => !target.disabled);
}

export function firstKeyboardNavigationTarget(
    targets: KeyboardNavigationTargetModel[],
    options: KeyboardNavigationModelOptions = {},
) {
    return enabledKeyboardNavigationTargets(targets).sort((a, b) => compareSequential(a, b, options))[0]?.id ?? "";
}

export function nextKeyboardNavigationTarget(
    targets: KeyboardNavigationTargetModel[],
    currentId: string,
    direction: KeyboardNavigationDirection,
    options: KeyboardNavigationModelOptions = {},
) {
    const enabled = enabledKeyboardNavigationTargets(targets);
    const current = enabled.find((target) => target.id === currentId);
    if (!current || !current.rect) return current ? current.id : "";
    const vertical = direction === "up" || direction === "down";
    const verticalScope = options.verticalScope ?? "all";
    const scope =
        vertical && verticalScope === "group" && current.group
            ? enabled.filter((target) => target.group === current.group)
            : enabled;
    const measured = scope.filter((target) => !!target.rect);
    return bestDirectionalTarget(measured, current, direction, options) || current.id;
}

export function nextSequentialKeyboardNavigationTarget(
    targets: KeyboardNavigationTargetModel[],
    currentId: string,
    direction: KeyboardNavigationSequentialDirection,
    options: KeyboardNavigationModelOptions = {},
) {
    const enabled = enabledKeyboardNavigationTargets(targets).sort((a, b) => compareSequential(a, b, options));
    if (!enabled.length) return "";
    const index = enabled.findIndex((target) => target.id === currentId);
    const start = index >= 0 ? index : direction > 0 ? -1 : 0;
    return enabled[(start + direction + enabled.length) % enabled.length].id;
}

export function useKeyboardNavigationController(
    optionsOrInitialId: KeyboardNavigationControllerOptions | string,
): KeyboardNavigationController {
    const options =
        typeof optionsOrInitialId === "string" ? { initialId: optionsOrInitialId } : optionsOrInitialId;
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const focusStateRef = useRef<KeyboardNavigationState>({
        focusedId: options.initialId,
        focusedGroup: options.initialGroup ?? "",
        focusVisible: options.initialFocusVisible ?? true,
        focusedTextEntry: false,
    });
    const registryRef = useRef(new Map<string, KeyboardNavigationTarget>());
    const rectsRef = useRef(new Map<string, KeyboardNavigationRect>());
    const stateListenersRef = useRef(new Set<() => void>());
    const targetListenersRef = useRef(new Map<string, Set<() => void>>());
    const focusedIdRef = useRef(options.initialId);
    const focusVisibleRef = useRef(options.initialFocusVisible ?? true);
    const lastNonTextFocusRef = useRef(options.initialId);

    const emitTarget = useCallback((id: string) => {
        const listeners = targetListenersRef.current.get(id);
        if (!listeners) return;
        for (const listener of listeners) listener();
    }, []);

    const commitFocusState = useCallback(
        (next: KeyboardNavigationState) => {
            const previous = focusStateRef.current;
            focusStateRef.current = next;
            focusedIdRef.current = next.focusedId;
            focusVisibleRef.current = next.focusVisible;
            if (
                previous.focusedId !== next.focusedId ||
                previous.focusVisible !== next.focusVisible ||
                previous.focusedGroup !== next.focusedGroup ||
                previous.focusedTextEntry !== next.focusedTextEntry
            ) {
                for (const listener of stateListenersRef.current) listener();
            }
            emitTarget(previous.focusedId);
            if (previous.focusedId !== next.focusedId) emitTarget(next.focusedId);
        },
        [emitTarget],
    );

    const modelOptions = useCallback<() => KeyboardNavigationModelOptions>(() => {
        const current = optionsRef.current;
        return {
            groupOrder: current.groupOrder,
            verticalScope: current.verticalScope,
        };
    }, []);

    const focusTargets = useCallback(() => {
        const all = [...registryRef.current.values()].map((target) => {
            const rect = rectsRef.current.get(target.id);
            return rect ? { ...target, rect } : target;
        });
        return { all, nonText: all.filter((target) => !target.textEntry) };
    }, []);

    const measuredTargetModel = useCallback((target: KeyboardNavigationTarget): KeyboardNavigationTargetModel => {
        const rect = rectsRef.current.get(target.id) ?? target.rect;
        return {
            id: target.id,
            group: target.group,
            disabled: target.disabled,
            rect,
        };
    }, []);

    const reportRect = useCallback((id: string, rect: KeyboardNavigationRect) => {
        const prev = rectsRef.current.get(id);
        if (
            prev &&
            Math.abs(prev.x - rect.x) < 0.5 &&
            Math.abs(prev.y - rect.y) < 0.5 &&
            Math.abs(prev.width - rect.width) < 0.5 &&
            Math.abs(prev.height - rect.height) < 0.5
        ) {
            return;
        }
        rectsRef.current.set(id, rect);
    }, []);

    const focusTarget = useCallback(
        (id: string, focusOptions: KeyboardNavigationFocusOptions = {}) => {
            const target = registryRef.current.get(id);
            if (!target || target.disabled) return false;
            const nextFocusVisible = focusOptions.focusVisible ?? focusVisibleRef.current;
            const previousTarget = registryRef.current.get(focusedIdRef.current);
            const previousId = focusedIdRef.current;
            if (previousId === target.id && focusVisibleRef.current === nextFocusVisible) {
                return true;
            }
            if (target.textEntry) {
                if (previousTarget && !previousTarget.textEntry) lastNonTextFocusRef.current = previousTarget.id;
            } else {
                lastNonTextFocusRef.current = target.id;
                if (previousTarget?.textEntry) blurActiveDomTextEntry();
            }

            const change: KeyboardNavigationChange = {
                previousId,
                id: target.id,
                previousTarget: previousTarget ? measuredTargetModel(previousTarget) : undefined,
                target: measuredTargetModel(target),
                reason: focusOptions.reason ?? "programmatic",
                direction: focusOptions.direction,
            };
            if (previousTarget && previousTarget.id !== target.id) previousTarget.onBlur?.(change);
            commitFocusState({
                focusedId: target.id,
                focusedGroup: target.group ?? "",
                focusVisible: nextFocusVisible,
                focusedTextEntry: !!target.textEntry,
            });
            if (previousId !== target.id) {
                target.onFocus?.(change);
                optionsRef.current.onFocusChange?.(change);
            }
            focusDomTargetElement(domIdForTarget(optionsRef.current.idPrefix, target.id));
            return true;
        },
        [commitFocusState, measuredTargetModel],
    );

    const showCurrentFocus = useCallback(() => {
        if (focusVisibleRef.current) return;
        commitFocusState({
            ...focusStateRef.current,
            focusVisible: true,
        });
    }, [commitFocusState]);

    const restoreLastNonTextFocus = useCallback(() => {
        const last = registryRef.current.get(lastNonTextFocusRef.current);
        if (last && !last.disabled && !last.textEntry) return focusTarget(last.id);
        const fallback = firstKeyboardNavigationTarget(focusTargets().nonText, modelOptions());
        return fallback ? focusTarget(fallback) : false;
    }, [focusTarget, focusTargets, modelOptions]);

    const focusFirstInGroup = useCallback(
        (group: string) => {
            const first = firstKeyboardNavigationTarget(
                focusTargets().all.filter((target) => target.group === group),
                modelOptions(),
            );
            return first ? focusTarget(first) : false;
        },
        [focusTarget, focusTargets, modelOptions],
    );

    const moveFocus = useCallback(
        (direction: KeyboardNavigationDirection, mode: "preview" | "immediate" = "preview") => {
            const current = registryRef.current.get(focusedIdRef.current);
            if (current?.textEntry) return false;
            const currentHandled =
                mode === "preview" ? current?.onPreviewMove?.(direction) : current?.onMove?.(direction);
            if (currentHandled) {
                showCurrentFocus();
                return true;
            }
            const nextId = nextKeyboardNavigationTarget(
                focusTargets().nonText,
                focusedIdRef.current,
                direction,
                modelOptions(),
            );
            if (nextId === current?.id && current.onUnhandledMove?.(direction)) {
                showCurrentFocus();
                return true;
            }
            if (!nextId || !focusTarget(nextId, { focusVisible: true, reason: "keyboard", direction })) {
                return false;
            }
            const next = registryRef.current.get(nextId);
            if (mode === "immediate" && next?.activateOnArrow) next.onActivate?.();
            return true;
        },
        [focusTarget, focusTargets, modelOptions, showCurrentFocus],
    );

    const moveSequentialFocus = useCallback(
        (
            direction: KeyboardNavigationSequentialDirection,
            moveOptions: { allowTextEntry?: boolean } = {},
        ) => {
            const current = registryRef.current.get(focusedIdRef.current);
            if (current?.textEntry && !moveOptions.allowTextEntry) return false;
            if (current?.onSequentialMove?.(direction)) {
                showCurrentFocus();
                return true;
            }
            const nextId = nextSequentialKeyboardNavigationTarget(
                focusTargets().all,
                focusedIdRef.current,
                direction,
                modelOptions(),
            );
            return nextId
                ? focusTarget(nextId, {
                      focusVisible: true,
                      reason: "keyboard",
                      direction: direction > 0 ? "next" : "previous",
                  })
                : false;
        },
        [focusTarget, focusTargets, modelOptions, showCurrentFocus],
    );

    const activateFocused = useCallback(() => {
        const target = registryRef.current.get(focusedIdRef.current);
        if (!target || target.disabled || target.textEntry) return false;
        showCurrentFocus();
        target.onActivate?.();
        return !!target.onActivate;
    }, [showCurrentFocus]);

    const dismissFocused = useCallback(() => {
        const target = registryRef.current.get(focusedIdRef.current);
        if (!target || target.disabled) return false;
        return target.onDismiss?.() ?? false;
    }, []);

    const registerTarget = useCallback(
        (target: KeyboardNavigationTarget) => {
            registryRef.current.set(target.id, target);
            if (target.id === focusedIdRef.current && target.disabled) {
                const fallback = firstKeyboardNavigationTarget(
                    focusTargets().all.filter((item) => item.id !== target.id),
                    modelOptions(),
                );
                if (fallback) {
                    focusTarget(fallback);
                } else {
                    commitFocusState({
                        ...focusStateRef.current,
                        focusedTextEntry: false,
                    });
                }
            } else if (target.id === focusedIdRef.current) {
                const previous = focusStateRef.current;
                commitFocusState({
                    ...previous,
                    focusedGroup: target.group ?? "",
                    focusedTextEntry: !!target.textEntry,
                });
                target.onFocus?.({
                    previousId: target.id,
                    id: target.id,
                    previousTarget: measuredTargetModel(target),
                    target: measuredTargetModel(target),
                    reason: "programmatic",
                });
            }
            return () => {
                const current = registryRef.current.get(target.id);
                if (current !== target) return;
                registryRef.current.delete(target.id);
                rectsRef.current.delete(target.id);
                if (focusedIdRef.current !== target.id) return;
                const fallback = firstKeyboardNavigationTarget(focusTargets().all, modelOptions());
                if (fallback) focusTarget(fallback);
            };
        },
        [commitFocusState, focusTarget, focusTargets, measuredTargetModel, modelOptions],
    );

    const subscribeTarget = useCallback((id: string, listener: () => void) => {
        let listeners = targetListenersRef.current.get(id);
        if (!listeners) {
            listeners = new Set();
            targetListenersRef.current.set(id, listeners);
        }
        listeners.add(listener);
        return () => {
            const current = targetListenersRef.current.get(id);
            if (!current) return;
            current.delete(listener);
            if (!current.size) targetListenersRef.current.delete(id);
        };
    }, []);

    const subscribeState = useCallback((listener: () => void) => {
        stateListenersRef.current.add(listener);
        return () => {
            stateListenersRef.current.delete(listener);
        };
    }, []);

    const stateSnapshot = useCallback(() => focusStateRef.current, []);
    const debugTargets = useCallback(() => focusTargets().all, [focusTargets]);
    const targetSnapshot = useCallback((id: string) => {
        if (focusedIdRef.current !== id) return "";
        return focusVisibleRef.current ? "visible" : "focused";
    }, []);

    return useMemo(
        () => ({
            get focusedId() {
                return focusStateRef.current.focusedId;
            },
            get focusedGroup() {
                return focusStateRef.current.focusedGroup;
            },
            get focusVisible() {
                return focusStateRef.current.focusVisible;
            },
            get focusedTextEntry() {
                return focusStateRef.current.focusedTextEntry;
            },
            focusTarget,
            reportRect,
            focusFirstInGroup,
            moveFocus,
            moveSequentialFocus,
            activateFocused,
            dismissFocused,
            restoreLastNonTextFocus,
            registerTarget,
            subscribeState,
            stateSnapshot,
            subscribeTarget,
            targetSnapshot,
            debugTargets,
            idPrefix: options.idPrefix ?? DEFAULT_ID_PREFIX,
        }),
        [
            activateFocused,
            debugTargets,
            dismissFocused,
            focusFirstInGroup,
            focusTarget,
            moveFocus,
            moveSequentialFocus,
            registerTarget,
            reportRect,
            restoreLastNonTextFocus,
            stateSnapshot,
            subscribeState,
            subscribeTarget,
            targetSnapshot,
            options.idPrefix,
        ],
    );
}

export function useKeyboardNavigationState(controller: KeyboardNavigationController) {
    return useSyncExternalStore(controller.subscribeState, controller.stateSnapshot, controller.stateSnapshot);
}

export function useKeyboardNavigationTarget(target: KeyboardNavigationTarget) {
    const controller = useContext(KeyboardNavigationContext);
    const registerTarget = controller?.registerTarget;
    const focusTarget = controller?.focusTarget;
    const reportRect = controller?.reportRect;
    const moveSequentialFocus = controller?.moveSequentialFocus;
    const subscribeTarget = controller?.subscribeTarget;
    const targetSnapshot = controller?.targetSnapshot;
    const targetRef = useRef(target);
    const pointerFocusRef = useRef(false);
    const pointerFocusClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    targetRef.current = target;

    const nodeRef = useRef<MeasurableNode | null>(null);
    const setNode = useCallback((node: unknown) => {
        nodeRef.current = (node as MeasurableNode | null) ?? null;
    }, []);
    const composeRef = target.composeRef;
    const composedRef = useMemo<RefCallback<unknown>>(
        () => (composeRef ? mergeRefs(composeRef, setNode) : setNode),
        [composeRef, setNode],
    );
    const measureSignal = useKeyboardNavigationMeasureSignal();
    const idPrefix = controller?.idPrefix ?? DEFAULT_ID_PREFIX;

    const focusSnapshot = useSyncExternalStore(
        useCallback((listener) => subscribeTarget?.(target.id, listener) ?? (() => {}), [subscribeTarget, target.id]),
        useCallback(() => targetSnapshot?.(target.id) ?? "", [targetSnapshot, target.id]),
        () => "",
    );

    useEffect(() => {
        if (!registerTarget) return;
        return registerTarget({
            ...target,
            onActivate: (event?: unknown) => targetRef.current.onActivate?.(event),
            onBlur: (change) => targetRef.current.onBlur?.(change),
            onDismiss: () => targetRef.current.onDismiss?.() ?? false,
            onFocus: (change) => targetRef.current.onFocus?.(change),
            onMove: (direction) => targetRef.current.onMove?.(direction) ?? false,
            onPreviewMove: (direction) => targetRef.current.onPreviewMove?.(direction) ?? false,
            onUnhandledMove: (direction) => targetRef.current.onUnhandledMove?.(direction) ?? false,
            onSequentialMove: (direction) => targetRef.current.onSequentialMove?.(direction) ?? false,
        });
    }, [registerTarget, target.activateOnArrow, target.disabled, target.group, target.id, target.textEntry]);

    const focus = useCallback(() => {
        if (!focusTarget) return false;
        return focusTarget(target.id, { focusVisible: true, reason: "programmatic" });
    }, [focusTarget, target.id]);

    const activate = useCallback(
        (event?: unknown) => {
            const current = targetRef.current;
            if (current.disabled) return;
            focusTarget?.(current.id, { focusVisible: false, reason: "pointer" });
            current.onActivate?.(event);
        },
        [focusTarget],
    );

    useEffect(() => {
        if (!focusTarget || !hasDom() || target.disabled || typeof document === "undefined") return;
        const node = document.getElementById(domIdForTarget(idPrefix, target.id));
        if (!node) return;
        let measureFrame = 0;
        const measure = () => {
            if (!reportRect) return;
            const current = targetRef.current;
            if (current.disabled) return;
            const rect = node.getBoundingClientRect();
            if (rect.width || rect.height) {
                reportRect(current.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            }
        };
        const scheduleMeasure = () => {
            if (measureFrame) return;
            measureFrame = window.requestAnimationFrame(() => {
                measureFrame = 0;
                measure();
            });
        };
        ensureKeyboardIntentTracker();
        ensureFocusOutlineSuppressed(idPrefix);
        measure();
        scheduleMeasure();
        window.addEventListener("resize", scheduleMeasure);
        const onFocus = () => {
            const current = targetRef.current;
            measure();
            if (!current.disabled) {
                focusTarget(current.id, {
                    focusVisible: keyboardFocusIntent && !pointerFocusRef.current,
                    reason: keyboardFocusIntent ? "keyboard" : "programmatic",
                });
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            const current = targetRef.current;
            if (event.defaultPrevented || !current.textEntry || current.disabled || event.key !== "Tab" || event.isComposing) {
                return;
            }
            if (hasKeyboardNavigationModifier(event, { allowShift: true })) return;
            const handled = moveSequentialFocus?.(event.shiftKey ? -1 : 1, { allowTextEntry: true });
            if (handled) event.preventDefault();
        };
        const clearPointerFocus = () => {
            if (pointerFocusClearTimerRef.current != null) clearTimeout(pointerFocusClearTimerRef.current);
            pointerFocusClearTimerRef.current = setTimeout(() => {
                pointerFocusRef.current = false;
                pointerFocusClearTimerRef.current = null;
            }, 80);
        };
        const onPointerDown = () => {
            pointerFocusRef.current = true;
            const current = targetRef.current;
            if (!current.disabled) focusTarget(current.id, { focusVisible: false, reason: "pointer" });
            clearPointerFocus();
        };
        const onMouseDown = (event: MouseEvent) => {
            const current = targetRef.current;
            pointerFocusRef.current = true;
            if (current.disabled) {
                clearPointerFocus();
                return;
            }
            focusTarget(current.id, { focusVisible: false, reason: "pointer" });
            current.onActivate?.(event);
            clearPointerFocus();
        };
        node.addEventListener("focus", onFocus);
        node.addEventListener("keydown", onKeyDown);
        node.addEventListener("pointerdown", onPointerDown);
        node.addEventListener("mousedown", onMouseDown);
        return () => {
            if (pointerFocusClearTimerRef.current != null) {
                clearTimeout(pointerFocusClearTimerRef.current);
                pointerFocusClearTimerRef.current = null;
            }
            if (measureFrame) window.cancelAnimationFrame(measureFrame);
            window.removeEventListener("resize", scheduleMeasure);
            node.removeEventListener("focus", onFocus);
            node.removeEventListener("keydown", onKeyDown);
            node.removeEventListener("pointerdown", onPointerDown);
            node.removeEventListener("mousedown", onMouseDown);
        };
    }, [focusTarget, idPrefix, moveSequentialFocus, reportRect, target.disabled, target.id]);

    useEffect(() => {
        if (hasDom() || !reportRect || target.disabled) return;
        const node = nodeRef.current;
        if (!node || typeof node.measureInWindow !== "function") return;
        let cancelled = false;
        node.measureInWindow((x, y, width, height) => {
            if (cancelled || !reportRect) return;
            if (width || height) reportRect(targetRef.current.id, { x, y, width, height });
        });
        return () => {
            cancelled = true;
        };
    }, [reportRect, target.id, target.disabled, measureSignal, focusSnapshot]);

    return {
        focused: focusSnapshot !== "" && !target.disabled,
        focusVisible: focusSnapshot === "visible" && !target.disabled,
        focus,
        activate,
        targetProps: {
            tabIndex: target.disabled ? undefined : (0 as const),
            ...(hasDom()
                ? { id: domIdForTarget(idPrefix, target.id), ...(composeRef ? { ref: composedRef } : null) }
                : { nativeID: domIdForTarget(idPrefix, target.id), ref: composedRef }),
            ...(hasDom() || target.pressToActivate === false ? null : { onPress: activate }),
        } satisfies Partial<ViewProps> & { id?: string; tabIndex?: 0; ref?: RefCallback<unknown> },
    };
}

export function useKeyboardNavigationKeyPress(
    controller: KeyboardNavigationController,
    options: KeyboardNavigationKeyPressOptions = {},
) {
    const controllerRef = useRef(controller);
    const optionsRef = useRef(options);
    controllerRef.current = controller;
    optionsRef.current = options;

    return useCallback((event: unknown) => {
        const opts = optionsRef.current;
        if (opts.enabled === false || opts.shouldHandleEvent?.(event) === false) return false;
        const typed = event as KeyboardNavigationEventLike & {
            preventDefault?: () => void;
            stopImmediatePropagation?: () => void;
            stopPropagation?: () => void;
        };
        const key = normalizeKeyboardNavigationKey(typed.nativeEvent?.key ?? typed.key);
        const isComposing = typed.nativeEvent?.isComposing ?? typed.isComposing;
        if (isComposing) return false;
        if (hasKeyboardNavigationModifier(typed, { allowShift: key === "Tab" })) return false;

        let handled = false;
        if (key === "Escape") {
            opts.onEscape?.();
            handled = !!opts.onEscape;
        } else if (key === "ArrowUp") {
            handled = controllerRef.current.moveFocus("up", "immediate");
        } else if (key === "ArrowDown") {
            handled = controllerRef.current.moveFocus("down", "immediate");
        } else if (key === "ArrowLeft") {
            handled = controllerRef.current.moveFocus("left", "immediate");
        } else if (key === "ArrowRight") {
            handled = controllerRef.current.moveFocus("right", "immediate");
        } else if (key === "Tab") {
            handled = controllerRef.current.moveSequentialFocus(shiftKeyFromEvent(typed) ? -1 : 1, {
                allowTextEntry: opts.allowTextEntryTab,
            });
        } else if (key === "Enter") {
            handled = controllerRef.current.activateFocused();
        }

        if (handled) {
            typed.preventDefault?.();
            typed.stopPropagation?.();
            typed.stopImmediatePropagation?.();
        }
        return handled;
    }, []);
}

export function hasKeyboardNavigationModifier(
    event: KeyboardNavigationEventLike,
    options: { allowShift?: boolean } = {},
) {
    const shift = !!(event.nativeEvent?.shiftKey ?? event.shiftKey);
    const ctrl = !!(event.nativeEvent?.ctrlKey ?? event.ctrlKey);
    const alt = !!(event.nativeEvent?.altKey ?? event.altKey);
    const meta = !!(event.nativeEvent?.metaKey ?? event.metaKey);
    return ctrl || alt || meta || (!options.allowShift && shift);
}

function normalizeKeyboardNavigationKey(key: string | undefined) {
    const normalized = key?.toLowerCase();
    if (normalized?.includes("right")) return "ArrowRight";
    if (normalized?.includes("left")) return "ArrowLeft";
    if (normalized?.includes("down")) return "ArrowDown";
    if (normalized?.includes("up")) return "ArrowUp";
    switch (normalized) {
        case "up":
            return "ArrowUp";
        case "down":
            return "ArrowDown";
        case "left":
            return "ArrowLeft";
        case "right":
            return "ArrowRight";
        case "escape":
            return "Escape";
        case "enter":
        case "return":
            return "Enter";
        default:
            return key;
    }
}

export function useKeyboardNavigationWindowKeyboard(
    controller: KeyboardNavigationController,
    options: KeyboardNavigationKeyPressOptions = {},
) {
    const onKey = useKeyboardNavigationKeyPress(controller, options);

    useEffect(() => {
        if (!hasDom() || typeof window === "undefined") return;
        const onWindowKeyDown = (event: KeyboardEvent) => {
            onKey(event);
        };
        window.addEventListener("keydown", onWindowKeyDown, true);
        return () => window.removeEventListener("keydown", onWindowKeyDown, true);
    }, [onKey]);

    return onKey;
}

function useKeyboardNavigationMeasureSignal(): number {
    const [signal, setSignal] = useState(0);
    useEffect(() => {
        if (hasDom()) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sub = Dimensions.addEventListener("change", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = undefined;
                setSignal((n) => n + 1);
            }, RESIZE_SETTLE_MS);
        });
        return () => {
            if (timer) clearTimeout(timer);
            sub.remove();
        };
    }, [setSignal]);
    return signal;
}

function center(rect: KeyboardNavigationRect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function compareReadingOrder(a: KeyboardNavigationTargetModel, b: KeyboardNavigationTargetModel) {
    const ra = a.rect;
    const rb = b.rect;
    if (!ra || !rb) return a.id.localeCompare(b.id);
    const ca = center(ra);
    const cb = center(rb);
    const rowEps = Math.min(ra.height, rb.height) * 0.5 || 8;
    if (Math.abs(ca.y - cb.y) > rowEps) return ca.y - cb.y;
    return ca.x - cb.x || a.id.localeCompare(b.id);
}

function compareSequential(
    a: KeyboardNavigationTargetModel,
    b: KeyboardNavigationTargetModel,
    options: KeyboardNavigationModelOptions,
) {
    return groupRank(a.group, options.groupOrder) - groupRank(b.group, options.groupOrder) || compareReadingOrder(a, b);
}

function groupRank(group: string | undefined, groupOrder: readonly string[] | undefined) {
    if (!groupOrder?.length) return 0;
    const index = groupOrder.indexOf(group ?? "");
    return index < 0 ? groupOrder.length : index;
}

function bestDirectionalTarget(
    targets: KeyboardNavigationTargetModel[],
    current: KeyboardNavigationTargetModel,
    direction: KeyboardNavigationDirection,
    options: KeyboardNavigationModelOptions,
) {
    let best: { target: KeyboardNavigationTargetModel; score: number } | null = null;
    for (const target of targets) {
        if (target.id === current.id) continue;
        const score = directionalScore(current, target, direction);
        if (score == null) continue;
        if (!best || score < best.score || (score === best.score && compareSequential(target, best.target, options) < 0)) {
            best = { target, score };
        }
    }
    return best?.target.id ?? "";
}

function directionalScore(
    current: KeyboardNavigationTargetModel,
    target: KeyboardNavigationTargetModel,
    direction: KeyboardNavigationDirection,
) {
    const a = center(current.rect!);
    const b = center(target.rect!);
    const horizontal = direction === "left" || direction === "right";
    const primary = horizontal ? b.x - a.x : b.y - a.y;
    const cross = horizontal ? b.y - a.y : b.x - a.x;
    const forward = direction === "right" || direction === "down" ? primary > 1 : primary < -1;
    if (!forward) return null;
    if (Math.abs(primary) < Math.abs(cross)) return null;
    if (!besideInDirection(a, target.rect!, direction)) return null;
    return Math.abs(primary) * 1000 + Math.abs(cross);
}

function besideInDirection(
    sourceCenter: { x: number; y: number },
    rect: KeyboardNavigationRect,
    direction: KeyboardNavigationDirection,
) {
    switch (direction) {
        case "right":
            return rect.x >= sourceCenter.x;
        case "left":
            return rect.x + rect.width <= sourceCenter.x;
        case "down":
            return rect.y >= sourceCenter.y;
        case "up":
            return rect.y + rect.height <= sourceCenter.y;
    }
}

function domIdForTarget(prefix: string | undefined, id: string) {
    return `${prefix ?? DEFAULT_ID_PREFIX}${id}`;
}

function hasDom() {
    return typeof window !== "undefined" && typeof document !== "undefined" && typeof HTMLElement !== "undefined";
}

function blurActiveDomTextEntry() {
    if (!hasDom()) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active.isContentEditable) {
        active.blur();
        return;
    }
    const tag = active.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") active.blur();
}

function focusDomTargetElement(id: string) {
    if (!hasDom()) return;
    const node = document.getElementById(id);
    if (!(node instanceof HTMLElement) || document.activeElement === node) return;
    node.focus({ preventScroll: true });
}

let keyboardFocusIntent = false;
let keyboardIntentInstalled = false;
function ensureKeyboardIntentTracker() {
    if (keyboardIntentInstalled || !hasDom()) return;
    keyboardIntentInstalled = true;
    window.addEventListener(
        "keydown",
        (event) => {
            if (event.key === "Tab" || event.key.startsWith("Arrow")) keyboardFocusIntent = true;
        },
        true,
    );
    for (const type of ["pointerdown", "mousedown", "touchstart"] as const) {
        window.addEventListener(
            type,
            () => {
                keyboardFocusIntent = false;
            },
            true,
        );
    }
}

const suppressedOutlinePrefixes = new Set<string>();
function ensureFocusOutlineSuppressed(prefix: string) {
    if (!hasDom() || suppressedOutlinePrefixes.has(prefix)) return;
    suppressedOutlinePrefixes.add(prefix);
    const style = document.createElement("style");
    style.setAttribute("data-rngpui-keyboard", `outline-reset:${prefix}`);
    style.textContent = `[id^="${cssString(prefix)}"]:focus,[id^="${cssString(prefix)}"]:focus-visible{outline:none!important;}`;
    document.head.appendChild(style);
}

function cssString(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shiftKeyFromEvent(event: { nativeEvent?: { shiftKey?: boolean }; shiftKey?: boolean }) {
    return !!(event.nativeEvent?.shiftKey ?? event.shiftKey);
}
