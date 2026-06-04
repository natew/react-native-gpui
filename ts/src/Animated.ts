/**
 * A minimal RN `Animated` for the gpui target. gpui re-renders from React state
 * (see render.ts), so we don't drive per-frame native animation here: animated
 * components pass through to their host, values are inert, and timing/spring
 * resolve immediately (finished). This is enough for tamagui's native render
 * path to run; transitions just settle instantly. A real per-frame driver can
 * be added later.
 */
import { View, Text, Image, ScrollView } from "./components";

type EndCallback = (result: { finished: boolean }) => void;
interface CompositeAnimation {
    start(cb?: EndCallback): void;
    stop(): void;
    reset(): void;
}

export class AnimatedValue {
    _value: number;
    constructor(value = 0) {
        this._value = value;
    }
    setValue(value: number): void {
        this._value = value;
    }
    setOffset(_offset: number): void {}
    flattenOffset(): void {}
    extractOffset(): void {}
    addListener(_cb: (state: { value: number }) => void): string {
        return "0";
    }
    removeListener(_id: string): void {}
    removeAllListeners(): void {}
    stopAnimation(cb?: (value: number) => void): void {
        cb?.(this._value);
    }
    resetAnimation(cb?: (value: number) => void): void {
        cb?.(this._value);
    }
    interpolate(_config: unknown): AnimatedValue {
        return new AnimatedValue(this._value);
    }
    __getValue(): number {
        return this._value;
    }
}

class AnimatedValueXY {
    x: AnimatedValue;
    y: AnimatedValue;
    constructor(value: { x?: number; y?: number } = {}) {
        this.x = new AnimatedValue(value.x ?? 0);
        this.y = new AnimatedValue(value.y ?? 0);
    }
    setValue(value: { x: number; y: number }): void {
        this.x.setValue(value.x);
        this.y.setValue(value.y);
    }
    getLayout() {
        return { left: this.x, top: this.y };
    }
    getTranslateTransform() {
        return [{ translateX: this.x }, { translateY: this.y }];
    }
}

function settle(value: unknown, config: { toValue?: unknown }): CompositeAnimation {
    return {
        start(cb?: EndCallback) {
            if (value instanceof AnimatedValue && typeof config?.toValue === "number") {
                value.setValue(config.toValue);
            }
            cb?.({ finished: true });
        },
        stop() {},
        reset() {},
    };
}

function group(animations: CompositeAnimation[]): CompositeAnimation {
    return {
        start(cb?: EndCallback) {
            animations.forEach((a) => a?.start?.());
            cb?.({ finished: true });
        },
        stop() {
            animations.forEach((a) => a?.stop?.());
        },
        reset() {
            animations.forEach((a) => a?.reset?.());
        },
    };
}

export const Animated = {
    View,
    Text,
    Image,
    ScrollView,
    Value: AnimatedValue,
    ValueXY: AnimatedValueXY,
    timing: settle,
    spring: settle,
    decay: settle,
    parallel: (anims: CompositeAnimation[]) => group(anims),
    sequence: (anims: CompositeAnimation[]) => group(anims),
    stagger: (_ms: number, anims: CompositeAnimation[]) => group(anims),
    loop: (anim: CompositeAnimation): CompositeAnimation => ({
        start(cb?: EndCallback) {
            anim?.start?.();
            cb?.({ finished: true });
        },
        stop() {
            anim?.stop?.();
        },
        reset() {
            anim?.reset?.();
        },
    }),
    delay: (_ms: number): CompositeAnimation => ({
        start(cb?: EndCallback) {
            cb?.({ finished: true });
        },
        stop() {},
        reset() {},
    }),
    event: (_argMapping: unknown, _config?: unknown) => () => {},
    createAnimatedComponent: <T,>(component: T): T => component,
    add: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    subtract: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    multiply: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    divide: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    modulo: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    diffClamp: () => new AnimatedValue(0),
};

const identity = (t: number) => t;
export const Easing = {
    linear: identity,
    ease: identity,
    quad: identity,
    cubic: identity,
    poly: () => identity,
    sin: identity,
    circle: identity,
    exp: identity,
    elastic: () => identity,
    back: () => identity,
    bounce: identity,
    bezier: () => identity,
    in: (fn: (t: number) => number) => fn,
    out: (fn: (t: number) => number) => fn,
    inOut: (fn: (t: number) => number) => fn,
    step0: (n: number) => (n > 0 ? 1 : 0),
    step1: (n: number) => (n >= 1 ? 1 : 0),
};
