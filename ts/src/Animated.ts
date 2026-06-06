/**
 * RN `Animated` for the gpui target. GPUI renders from React commits, so this
 * driver runs JS-frame animations, not native-driver mutations: values notify
 * React subscribers, animated components unwrap animated style values, and each
 * frame commits plain styles to the GPUI bridge.
 */
import { View, Text, Image, ScrollView } from "./components";
import { createElement, useEffect, useMemo, useState, type ComponentType } from "react";

type EndCallback = (result: { finished: boolean }) => void;
interface CompositeAnimation {
    start(cb?: EndCallback): void;
    stop(): void;
    reset(): void;
}

export class AnimatedValue {
    _value: number;
    private _listeners = new Map<string, (state: { value: number }) => void>();
    private _nextListenerId = 1;
    constructor(value = 0) {
        this._value = value;
    }
    setValue(value: number): void {
        if (Object.is(this._value, value)) return;
        this._value = value;
        this._emit();
    }
    setOffset(_offset: number): void {}
    flattenOffset(): void {}
    extractOffset(): void {}
    addListener(_cb: (state: { value: number }) => void): string {
        const id = String(this._nextListenerId++);
        this._listeners.set(id, _cb);
        return id;
    }
    removeListener(_id: string): void {
        this._listeners.delete(_id);
    }
    removeAllListeners(): void {
        this._listeners.clear();
    }
    stopAnimation(cb?: (value: number) => void): void {
        cb?.(this._value);
    }
    resetAnimation(cb?: (value: number) => void): void {
        cb?.(this._value);
    }
    interpolate(config: InterpolationConfig): AnimatedInterpolation {
        return new AnimatedInterpolation(this, config);
    }
    __getValue(): number {
        return this._value;
    }
    private _emit() {
        const state = { value: this._value };
        for (const listener of this._listeners.values()) listener(state);
    }
}

type InterpolationConfig = {
    inputRange: number[];
    outputRange: Array<number | string>;
    extrapolate?: "extend" | "clamp" | "identity";
    extrapolateLeft?: "extend" | "clamp" | "identity";
    extrapolateRight?: "extend" | "clamp" | "identity";
};

export class AnimatedInterpolation {
    constructor(
        private parent: AnimatedValue,
        private config: InterpolationConfig,
    ) {}
    addListener(cb: (state: { value: number }) => void): string {
        return this.parent.addListener(cb);
    }
    removeListener(id: string): void {
        this.parent.removeListener(id);
    }
    __getValue(): number | string {
        return interpolateValue(this.parent.__getValue(), this.config);
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

type AnimationConfig = {
    toValue?: unknown;
    duration?: number;
    delay?: number;
    easing?: (value: number) => number;
};

const raf =
    globalThis.requestAnimationFrame?.bind(globalThis) ??
    ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
const caf = globalThis.cancelAnimationFrame?.bind(globalThis) ?? ((id: number) => clearTimeout(id));

function animate(value: unknown, config: AnimationConfig, spring = false): CompositeAnimation {
    let frame: number | null = null;
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let finish: EndCallback | undefined;
    // remember where the first iteration started so loop() can rewind to it
    // before each repeat (RN's resetBeforeIteration). without this, a looped
    // timing would re-read its now-settled value as `from` and animate to==from
    // (no motion) — which is what made the offscreen RepaintPump go stale.
    let iterationStart: number | null = null;

    const stop = (finished: boolean) => {
        stopped = true;
        if (frame != null) caf(frame);
        if (delayTimer) clearTimeout(delayTimer);
        frame = null;
        delayTimer = null;
        finish?.({ finished });
        finish = undefined;
    };

    return {
        start(cb?: EndCallback) {
            finish = cb;
            stopped = false;
            if (!(value instanceof AnimatedValue) || typeof config?.toValue !== "number") {
                cb?.({ finished: true });
                return;
            }
            if (iterationStart === null) iterationStart = value.__getValue();
            const from = value.__getValue();
            const to = config.toValue;
            const duration = Math.max(1, config.duration ?? (spring ? 280 : 220));
            const easing = config.easing ?? (spring ? Easing.out(Easing.cubic) : Easing.inOut(Easing.cubic));

            const run = () => {
                const start = performance.now();
                const step = (now: number) => {
                    if (stopped) return;
                    const progress = Math.min(1, (now - start) / duration);
                    const eased = easing(progress);
                    value.setValue(from + (to - from) * eased);
                    if (progress >= 1) {
                        stop(true);
                    } else {
                        frame = raf(step);
                    }
                };
                frame = raf(step);
            };

            if (config.delay && config.delay > 0) delayTimer = setTimeout(run, config.delay);
            else run();
        },
        stop() {
            stop(false);
        },
        reset() {
            stop(false);
            // rewind to the very first start value so a subsequent start() (e.g.
            // a loop iteration) animates the full from→to range again.
            if (iterationStart !== null && value instanceof AnimatedValue) {
                value.setValue(iterationStart);
            }
        },
    };
}

function parallelGroup(animations: CompositeAnimation[]): CompositeAnimation {
    let stopped = false;
    return {
        start(cb?: EndCallback) {
            if (animations.length === 0) {
                cb?.({ finished: true });
                return;
            }
            stopped = false;
            let remaining = animations.length;
            let allFinished = true;
            animations.forEach((animation) => {
                animation?.start?.(({ finished }) => {
                    allFinished &&= finished;
                    remaining -= 1;
                    if (remaining === 0 && !stopped) cb?.({ finished: allFinished });
                });
            });
        },
        stop() {
            stopped = true;
            animations.forEach((a) => a?.stop?.());
        },
        reset() {
            animations.forEach((a) => a?.reset?.());
        },
    };
}

function sequenceGroup(animations: CompositeAnimation[]): CompositeAnimation {
    let index = 0;
    let stopped = false;
    const runNext = (cb?: EndCallback) => {
        if (stopped) return;
        const animation = animations[index++];
        if (!animation) {
            cb?.({ finished: true });
            return;
        }
        animation.start(({ finished }) => {
            if (!finished) {
                cb?.({ finished: false });
                return;
            }
            runNext(cb);
        });
    };
    return {
        start(cb?: EndCallback) {
            index = 0;
            stopped = false;
            runNext(cb);
        },
        stop() {
            stopped = true;
            animations[index]?.stop?.();
        },
        reset() {
            index = 0;
            animations.forEach((a) => a?.reset?.());
        },
    };
}

export const Animated = {
    View: createAnimatedComponent(View as ComponentType<any>),
    Text: createAnimatedComponent(Text as ComponentType<any>),
    Image: createAnimatedComponent(Image as ComponentType<any>),
    ScrollView: createAnimatedComponent(ScrollView as ComponentType<any>),
    Value: AnimatedValue,
    ValueXY: AnimatedValueXY,
    timing: (value: unknown, config: AnimationConfig) => animate(value, config, false),
    spring: (value: unknown, config: AnimationConfig) => animate(value, config, true),
    decay: (value: unknown, config: AnimationConfig) => animate(value, config, false),
    parallel: (anims: CompositeAnimation[]) => parallelGroup(anims),
    sequence: (anims: CompositeAnimation[]) => sequenceGroup(anims),
    stagger: (_ms: number, anims: CompositeAnimation[]) => parallelGroup(anims),
    loop: (anim: CompositeAnimation, config?: { iterations?: number }): CompositeAnimation => {
        // -1 (or omitted) = infinite, matching RN's default.
        const iterations = config?.iterations ?? -1;
        let stopped = false;
        let count = 0;
        const runOnce = (cb?: EndCallback) => {
            if (stopped) return;
            anim?.reset?.();
            anim?.start?.(({ finished }) => {
                if (stopped || !finished) {
                    cb?.({ finished });
                    return;
                }
                count += 1;
                if (iterations >= 0 && count >= iterations) {
                    cb?.({ finished: true });
                    return;
                }
                runOnce(cb);
            });
        };
        return {
            start(cb?: EndCallback) {
                stopped = false;
                count = 0;
                runOnce(cb);
            },
            stop() {
                stopped = true;
                anim?.stop?.();
            },
            reset() {
                stopped = true;
                count = 0;
                anim?.reset?.();
            },
        };
    },
    delay: (ms: number): CompositeAnimation => ({
        start(cb?: EndCallback) {
            const id = setTimeout(() => cb?.({ finished: true }), ms);
            return () => clearTimeout(id);
        },
        stop() {},
        reset() {},
    }),
    event: (_argMapping: unknown, _config?: unknown) => () => {},
    createAnimatedComponent: <T,>(component: T): T => createAnimatedComponent(component as ComponentType<any>) as T,
    add: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    subtract: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    multiply: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    divide: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    modulo: (a: AnimatedValue) => new AnimatedValue(a.__getValue?.() ?? 0),
    diffClamp: () => new AnimatedValue(0),
};

const identity = (t: number) => t;
// base curves operate as "ease-in" shapes (accelerate from 0); the in/out/inOut
// wrappers below derive the symmetric variants from them, matching RN's Easing.
const quad = (t: number) => t * t;
const cubic = (t: number) => t * t * t;
// ease() is the classic css ease (cubic-bezier(0.25, 0.1, 0.25, 1)); approximate
// with a smoothstep-style curve so motion isn't linear.
const ease = (t: number) => t * t * (3 - 2 * t);

// out(f) = mirror of the in-curve; inOut(f) = first-half f(2t)/2, second mirrored.
const easeOut = (fn: (t: number) => number) => (t: number) => 1 - fn(1 - t);
const easeInOut = (fn: (t: number) => number) => (t: number) =>
    t < 0.5 ? fn(t * 2) / 2 : 1 - fn((1 - t) * 2) / 2;

export const Easing = {
    linear: identity,
    ease,
    quad,
    cubic,
    poly: (n: number) => (t: number) => Math.pow(t, n),
    sin: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
    circle: (t: number) => 1 - Math.sqrt(1 - t * t),
    exp: (t: number) => Math.pow(2, 10 * (t - 1)),
    elastic: () => identity,
    back: () => identity,
    bounce: identity,
    bezier: () => identity,
    in: (fn: (t: number) => number) => fn,
    out: easeOut,
    inOut: easeInOut,
    step0: (n: number) => (n > 0 ? 1 : 0),
    step1: (n: number) => (n >= 1 ? 1 : 0),
};

function createAnimatedComponent(Component: ComponentType<any>) {
    return function AnimatedComponent(props: Record<string, unknown>) {
        const values = useMemo(() => collectAnimatedValues(props.style), [props.style]);
        const [, rerender] = useState(0);
        useEffect(() => {
            if (values.length === 0) return;
            const listenerIds = values.map((value) => value.addListener(() => rerender((count) => count + 1)));
            return () => {
                values.forEach((value, index) => value.removeListener(listenerIds[index]));
            };
        }, [values]);
        return createElement(Component, { ...props, style: resolveAnimated(props.style) });
    };
}

function isAnimatedValue(value: unknown): value is AnimatedValue | AnimatedInterpolation {
    return !!value && typeof value === "object" && typeof (value as { __getValue?: unknown }).__getValue === "function";
}

function collectAnimatedValues(value: unknown, out: Array<AnimatedValue | AnimatedInterpolation> = []) {
    if (!value) return out;
    if (isAnimatedValue(value)) {
        out.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) collectAnimatedValues(item, out);
    } else if (typeof value === "object") {
        for (const item of Object.values(value as Record<string, unknown>)) collectAnimatedValues(item, out);
    }
    return out;
}

function resolveAnimated(value: unknown): unknown {
    if (!value) return value;
    if (isAnimatedValue(value)) return value.__getValue();
    if (Array.isArray(value)) return value.map(resolveAnimated);
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = resolveAnimated(item);
        }
        return out;
    }
    return value;
}

function interpolateValue(input: number, config: InterpolationConfig): number | string {
    const inputRange = config.inputRange;
    const outputRange = config.outputRange;
    if (inputRange.length < 2 || outputRange.length < 2 || inputRange.length !== outputRange.length) {
        return outputRange[0] ?? input;
    }

    let index = 1;
    while (index < inputRange.length - 1 && input > inputRange[index]) index += 1;

    const inMin = inputRange[index - 1];
    const inMax = inputRange[index];
    const outMin = outputRange[index - 1];
    const outMax = outputRange[index];
    const side = input < inMin ? "Left" : input > inMax ? "Right" : "";
    const extrapolate =
        side === "Left"
            ? (config.extrapolateLeft ?? config.extrapolate ?? "extend")
            : side === "Right"
              ? (config.extrapolateRight ?? config.extrapolate ?? "extend")
              : "extend";
    if (extrapolate === "identity") return input;

    const bounded = extrapolate === "clamp" ? Math.min(inMax, Math.max(inMin, input)) : input;
    const progress = inMax === inMin ? 0 : (bounded - inMin) / (inMax - inMin);

    if (typeof outMin === "number" && typeof outMax === "number") {
        return outMin + (outMax - outMin) * progress;
    }

    if (typeof outMin === "string" && typeof outMax === "string") {
        const parsedMin = parseNumericString(outMin);
        const parsedMax = parseNumericString(outMax);
        if (parsedMin && parsedMax && parsedMin.unit === parsedMax.unit) {
            return `${parsedMin.value + (parsedMax.value - parsedMin.value) * progress}${parsedMin.unit}`;
        }
    }

    return progress < 1 ? outMin : outMax;
}

function parseNumericString(value: string): { value: number; unit: string } | null {
    const match = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(value.trim());
    if (!match) return null;
    return { value: Number(match[1]), unit: match[2] };
}
