/**
 * Runtime conformance fixture for RN measure APIs.
 *
 * Run:
 *   bun run conformance:measure
 *
 * Expected:
 *   - ref.measure, ref.measureInWindow, UIManager.measure, and
 *     UIManager.measureLayout all resolve after native layout
 *   - measured geometry is non-zero, not the stale synchronous zero fallback
 */
import { useEffect, useRef } from "react";
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

function assertRect(label: string, rect: { width: number; height: number; x?: number; y?: number }) {
    if (rect.width <= 0 || rect.height <= 0) {
        console.error(`CONFORMANCE measure ${label} FAIL rect=${JSON.stringify(rect)}`);
        process.exit(1);
    }
    console.log(`CONFORMANCE measure ${label} PASS rect=${JSON.stringify(rect)}`);
}

function App() {
    const rootRef = useRef<MeasureRef | null>(null);
    const targetRef = useRef<MeasureRef | null>(null);

    useEffect(() => {
        const start = setTimeout(() => {
        const target = targetRef.current;
        const root = rootRef.current;
        if (!target || !root) {
            console.error("CONFORMANCE measure refs FAIL");
            process.exit(1);
            return;
        }

        let remaining = 4;
        const complete = () => {
            remaining -= 1;
            if (remaining === 0) {
                console.log("CONFORMANCE measure all PASS");
                process.exit(0);
            }
        };

        const timeout = setTimeout(() => {
            console.error(`CONFORMANCE measure timeout FAIL remaining=${remaining}`);
            process.exit(1);
        }, 3000);

        target.measure((x, y, width, height, pageX, pageY) => {
            assertRect("ref.measure", { x: pageX, y: pageY, width, height });
            if (x !== 0 || y !== 0) {
                console.error(`CONFORMANCE measure ref.measure origin FAIL x=${x} y=${y}`);
                process.exit(1);
            }
            complete();
        });

        target.measureInWindow((x, y, width, height) => {
            assertRect("ref.measureInWindow", { x, y, width, height });
            complete();
        });

        const targetHandle = findNodeHandle(target);
        const rootHandle = findNodeHandle(root);
        if (targetHandle == null || rootHandle == null) {
            console.error("CONFORMANCE measure handles FAIL");
            process.exit(1);
            return;
        }

        UIManager.measure(targetHandle, (x, y, width, height, pageX, pageY) => {
            assertRect("UIManager.measure", { x: pageX, y: pageY, width, height });
            if (x !== 0 || y !== 0) {
                console.error(`CONFORMANCE measure UIManager.measure origin FAIL x=${x} y=${y}`);
                process.exit(1);
            }
            complete();
        });

        UIManager.measureLayout(
            targetHandle,
            rootHandle,
            () => {
                console.error("CONFORMANCE measure UIManager.measureLayout FAIL");
                process.exit(1);
            },
            (x, y, width, height) => {
                assertRect("UIManager.measureLayout", { x, y, width, height });
                complete();
            },
        );
        }, 100);

        return () => clearTimeout(start);
    }, []);

    const NativeView = View as never;

    return (
        <NativeView ref={rootRef} style={s.root}>
            <View style={s.panel}>
                <Text style={s.heading} numberOfLines={1}>
                    measure conformance
                </Text>
                <NativeView ref={targetRef} style={s.target}>
                    <Text style={s.targetText} numberOfLines={1}>
                        measured box
                    </Text>
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
    targetText: {
        color: "#ffffff",
        fontSize: 13,
        fontWeight: "800",
    },
});

render(<App />, { width: 500, height: 220 });
