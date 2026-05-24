/**
 * gesture API — PanResponder and press handlers.
 *
 * Mirrors the React Native PanResponder API.
 * On desktop/macOS, gestures are mouse-based (not touch).
 */

// ── Event types ─────────────────────────────────────────────────────

export type GestureEvent = {
    nativeEvent: {
        locationX: number;
        locationY: number;
        pageX: number;
        pageY: number;
        timestamp: number;
    };
};

export type GestureState = {
    // ID of the most recent move
    stateID: number;
    // Whether the gesture has started (moved > activation distance)
    moved: boolean;
    // X/Y of the most recent touch
    x: number;
    y: number;
    // X/Y of the initial touch
    x0: number;
    y0: number;
    // Delta from previous event
    dx: number;
    dy: number;
    // Accumulated distance from start
    vx: number;
    vy: number;
    // Velocity of the gesture
    numberActiveTouches: number;
    // Timestamps
    _accountsForMovesUpTo: number;
    // Direction of the most recent movement
    direction: "up" | "down" | "left" | "right" | null;
};

function createGestureState(): GestureState {
    return {
        stateID: 0,
        moved: false,
        x: 0,
        y: 0,
        x0: 0,
        y0: 0,
        dx: 0,
        dy: 0,
        vx: 0,
        vy: 0,
        numberActiveTouches: 1,
        _accountsForMovesUpTo: 0,
        direction: null,
    };
}

function computeDirection(dx: number, dy: number): "up" | "down" | "left" | "right" | null {
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
    if (Math.abs(dx) > Math.abs(dy)) {
        return dx > 0 ? "right" : "left";
    }
    return dy > 0 ? "down" : "up";
}

// ── PanResponder ────────────────────────────────────────────────────

export type PanResponderCallbacks = {
    onStartShouldSetPanResponder?: (e: GestureEvent, gestureState: GestureState) => boolean;
    onMoveShouldSetPanResponder?: (e: GestureEvent, gestureState: GestureState) => boolean;
    onPanResponderGrant?: (e: GestureEvent, gestureState: GestureState) => void;
    onPanResponderMove?: (e: GestureEvent, gestureState: GestureState) => void;
    onPanResponderRelease?: (e: GestureEvent, gestureState: GestureState) => void;
    onPanResponderTerminate?: (e: GestureEvent, gestureState: GestureState) => void;
    onPanResponderTerminationRequest?: (e: GestureEvent, gestureState: GestureState) => boolean;
};

export type PanResponderInstance = {
    panHandlers: {
        onMouseDown?: (e: MouseEvent) => void;
        onMouseMove?: (e: MouseEvent) => void;
        onMouseUp?: (e: MouseEvent) => void;
    };
};

/**
 * PanResponder — create a gesture responder for mouse-based interaction.
 *
 * Usage:
 *   const pan = PanResponder.create({
 *     onStartShouldSetPanResponder: () => true,
 *     onPanResponderMove: (e, gs) => console.log(gs.dx, gs.dy),
 *     onPanResponderRelease: (e, gs) => console.log('release'),
 *   });
 *   // Use pan.panHandlers as element props
 */
export const PanResponder = {
    create(callbacks: PanResponderCallbacks): PanResponderInstance {
        let gestureState = createGestureState();
        let isResponder = false;
        let stateIDCounter = 0;

        function makeEvent(native: Partial<GestureEvent["nativeEvent"]>): GestureEvent {
            return {
                nativeEvent: {
                    locationX: 0,
                    locationY: 0,
                    pageX: 0,
                    pageY: 0,
                    timestamp: Date.now(),
                    ...native,
                },
            };
        }

        function handleDown(e: MouseEvent) {
            const gestureEvent = makeEvent({
                pageX: e.clientX,
                pageY: e.clientY,
                locationX: e.offsetX,
                locationY: e.offsetY,
                timestamp: Date.now(),
            });

            if (callbacks.onStartShouldSetPanResponder?.(gestureEvent, gestureState) ?? true) {
                isResponder = true;
                gestureState = {
                    ...createGestureState(),
                    stateID: ++stateIDCounter,
                    x: e.clientX,
                    y: e.clientY,
                    x0: e.clientX,
                    y0: e.clientY,
                    _accountsForMovesUpTo: Date.now(),
                };
                callbacks.onPanResponderGrant?.(gestureEvent, gestureState);
            }
        }

        function handleMove(e: MouseEvent) {
            if (!isResponder) {
                // Check if we should become responder on move
                const gestureEvent = makeEvent({
                    pageX: e.clientX,
                    pageY: e.clientY,
                    locationX: e.offsetX,
                    locationY: e.offsetY,
                    timestamp: Date.now(),
                });
                if (callbacks.onMoveShouldSetPanResponder?.(gestureEvent, gestureState) ?? false) {
                    isResponder = true;
                    gestureState = {
                        ...createGestureState(),
                        stateID: ++stateIDCounter,
                        x: e.clientX,
                        y: e.clientY,
                        x0: e.clientX,
                        y0: e.clientY,
                    };
                    callbacks.onPanResponderGrant?.(gestureEvent, gestureState);
                }
                return;
            }

            const dx = e.clientX - gestureState.x;
            const dy = e.clientY - gestureState.y;

            gestureState = {
                ...gestureState,
                moved: true,
                x: e.clientX,
                y: e.clientY,
                dx: gestureState.dx + dx,
                dy: gestureState.dy + dy,
                vx: dx,
                vy: dy,
                direction: computeDirection(dx, dy),
                _accountsForMovesUpTo: Date.now(),
            };

            const gestureEvent = makeEvent({
                pageX: e.clientX,
                pageY: e.clientY,
                locationX: e.offsetX,
                locationY: e.offsetY,
                timestamp: Date.now(),
            });

            callbacks.onPanResponderMove?.(gestureEvent, gestureState);
        }

        function handleUp(e: MouseEvent) {
            if (!isResponder) return;

            const gestureEvent = makeEvent({
                pageX: e.clientX,
                pageY: e.clientY,
                locationX: e.offsetX,
                locationY: e.offsetY,
                timestamp: Date.now(),
            });

            callbacks.onPanResponderRelease?.(gestureEvent, gestureState);
            isResponder = false;
            gestureState = createGestureState();
        }

        return {
            panHandlers: {
                onMouseDown: handleDown,
                onMouseMove: handleMove,
                onMouseUp: handleUp,
            },
        };
    },
};

// ── Press handlers ──────────────────────────────────────────────────

export type PressHandlers = {
    onPress?: (e: GestureEvent) => void;
    onLongPress?: (e: GestureEvent) => void;
    onPressIn?: (e: GestureEvent) => void;
    onPressOut?: (e: GestureEvent) => void;
};

const LONG_PRESS_DURATION = 500;

/**
 * createPressHandlers — React Native-style press interactions.
 * Uses a timer to detect long press (>500ms).
 */
export function createPressHandlers(handlers: PressHandlers) {
    let pressStart = 0;
    let longPressFired = false;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    function makeEvent(e: MouseEvent): GestureEvent {
        return {
            nativeEvent: {
                locationX: e.offsetX,
                locationY: e.offsetY,
                pageX: e.clientX,
                pageY: e.clientY,
                timestamp: Date.now(),
            },
        };
    }

    function onMouseDown(e: MouseEvent) {
        pressStart = Date.now();
        longPressFired = false;
        handlers.onPressIn?.(makeEvent(e));

        longPressTimer = setTimeout(() => {
            longPressFired = true;
            handlers.onLongPress?.(makeEvent(e));
        }, LONG_PRESS_DURATION);
    }

    function onMouseUp(e: MouseEvent) {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        handlers.onPressOut?.(makeEvent(e));
        if (!longPressFired) {
            handlers.onPress?.(makeEvent(e));
        }
    }

    return {
        onMouseDown,
        onMouseUp,
    };
}
