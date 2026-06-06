/**
 * Runtime conformance fixture for RN measure APIs.
 *
 * Run:
 *   bun run conformance:measure
 *
 * Expected:
 *   - ref.measure, ref.measureInWindow, UIManager.measure, and
 *     UIManager.measureLayout all resolve after native layout
 *   - Text host nodes are measurable, not just View/div nodes
 *   - measuring after a layout-changing update returns fresh geometry
 */
import { useEffect, useRef, useState } from "react";
import {
    findNodeHandle,
    render,
    StyleSheet,
    Text,
    UIManager,
    View,
} from "../src/index";

const C = {
    bg: "#f4f7fb",
    panel: "#ffffff",
    border: "#cbd5e1",
    target: "#2f6fed",
    text: "#142033",
};

type MeasureRef = {
    measure: (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => void;
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
};
type Rect = { x: number; y: number; width: number; height: number; pageX?: number; pageY?: number };

function assertRect(label: string, rect: { width: number; height: number; x?: number; y?: number }) {
    if (rect.width <= 0 || rect.height <= 0) {
        console.error(`CONFORMANCE measure ${label} FAIL rect=${JSON.stringify(rect)}`);
        process.exit(1);
    }
    console.log(`CONFORMANCE measure ${label} PASS rect=${JSON.stringify(rect)}`);
}

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function measureRef(node: MeasureRef, label: string): Promise<Rect> {
    return new Promise((resolve) => {
        node.measure((x, y, width, height, pageX, pageY) => {
            const rect = { x, y, width, height, pageX, pageY };
            assertRect(label, { x: pageX, y: pageY, width, height });
            resolve(rect);
        });
    });
}

function measureInWindowRef(node: MeasureRef, label: string): Promise<Rect> {
    return new Promise((resolve) => {
        node.measureInWindow((x, y, width, height) => {
            const rect = { x, y, width, height };
            assertRect(label, rect);
            resolve(rect);
        });
    });
}

function uiMeasure(handle: number, label: string): Promise<Rect> {
    return new Promise((resolve) => {
        UIManager.measure(handle, (x, y, width, height, pageX, pageY) => {
            const rect = { x, y, width, height, pageX, pageY };
            assertRect(label, { x: pageX, y: pageY, width, height });
            resolve(rect);
        });
    });
}

function uiMeasureLayout(handle: number, rootHandle: number, label: string): Promise<Rect> {
    return new Promise((resolve, reject) => {
        UIManager.measureLayout(
            handle,
            rootHandle,
            () => reject(new Error(`${label} failed`)),
            (x, y, width, height) => {
                const rect = { x, y, width, height };
                assertRect(label, rect);
                resolve(rect);
            },
        );
    });
}

function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 1500)),
    ]);
}

function App() {
    const [wide, setWide] = useState(false);
    const rootRef = useRef<MeasureRef | null>(null);
    const targetRef = useRef<MeasureRef | null>(null);
    const textRef = useRef<MeasureRef | null>(null);

    useEffect(() => {
        let canceled = false;
        async function run() {
            await wait(50);
            const target = targetRef.current;
            const root = rootRef.current;
            const text = textRef.current;
            if (!target || !root || !text) throw new Error("refs missing");

            const targetHandle = findNodeHandle(target);
            const rootHandle = findNodeHandle(root);
            if (targetHandle == null || rootHandle == null) throw new Error("handles missing");

            const initial = await measureRef(target, "ref.measure");
            if (initial.x !== 0 || initial.y !== 0) {
                throw new Error(`ref.measure origin ${initial.x},${initial.y}`);
            }
            await measureInWindowRef(target, "ref.measureInWindow");
            await uiMeasure(targetHandle, "UIManager.measure");
            await uiMeasureLayout(targetHandle, rootHandle, "UIManager.measureLayout");
            await measureRef(text, "Text.ref.measure");

            setWide(true);
            await wait(70);
            const updated = await measureRef(target, "ref.measure after update");
            if (Math.round(updated.width) !== 220) {
                throw new Error(`stale after update width=${updated.width}`);
            }

            if (!canceled) {
                console.log("CONFORMANCE measure all PASS");
                process.exit(0);
            }
        }
        withTimeout("CONFORMANCE measure", run()).catch((error) => {
            console.error(`CONFORMANCE measure FAIL ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        });
        return () => {
            canceled = true;
        };
    }, []);

    const NativeView = View as never;
    const NativeText = Text as never;

    return (
        <NativeView ref={rootRef} style={s.root}>
            <View style={s.panel}>
                <Text style={s.heading} numberOfLines={1}>
                    measure conformance
                </Text>
                <NativeView ref={targetRef} style={[s.target, wide && s.targetWide]}>
                    <NativeText ref={textRef} style={s.targetText} numberOfLines={1}>
                        measured box
                    </NativeText>
                </NativeView>
            </View>
        </NativeView>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: C.bg,
        padding: 28,
    },
    panel: {
        width: 420,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel,
        padding: 18,
        gap: 12,
    },
    heading: {
        color: C.text,
        fontSize: 13,
        fontWeight: "800",
    },
    target: {
        width: 148,
        height: 52,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.target,
    },
    targetWide: {
        width: 220,
    },
    targetText: {
        color: "#ffffff",
        fontSize: 13,
        fontWeight: "800",
    },
});

render(<App />, { width: 500, height: 220 });
