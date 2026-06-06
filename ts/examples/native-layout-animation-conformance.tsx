/**
 * runtime conformance for native layout animations.
 *
 * expected:
 *   - NativeLayout.animateFrame produces intermediate native layout frames
 *   - the animation reaches the final width/x without React layout state changes
 */
import { useEffect, useRef } from "react";
import {
    NativeLayout,
    render,
    StyleSheet,
    Text,
    View,
    type LayoutChangeEvent,
} from "../src/index";

const KEY = "native-layout-animation-pane";

function App() {
    const widths = useRef<number[]>([]);
    const xs = useRef<number[]>([]);
    const done = useRef(false);

    useEffect(() => {
        const timer = setTimeout(() => NativeLayout.animateFrame(KEY, { width: 300, x: 48 }, 180), 120);
        return () => clearTimeout(timer);
    }, []);

    function onPaneLayout(event: LayoutChangeEvent) {
        const width = Math.round(event.nativeEvent.layout.width);
        const x = Math.round(event.nativeEvent.layout.x);
        const last = widths.current[widths.current.length - 1];
        if (last !== width) widths.current.push(width);
        const lastX = xs.current[xs.current.length - 1];
        if (lastX !== x) xs.current.push(x);
    }

    useEffect(() => {
        const timer = setTimeout(() => {
            if (done.current) return;
            done.current = true;
            const sawInitial = widths.current.includes(180);
            const intermediate = widths.current.filter((value) => value > 180 && value < 300);
            const sawFinal = widths.current.includes(300);
            const initialX = xs.current[0] ?? 0;
            const finalX = initialX + 48;
            const sawInitialX = xs.current.includes(initialX);
            const intermediateX = xs.current.filter((value) => value > initialX && value < finalX);
            const sawFinalX = xs.current.includes(finalX);
            if (sawInitial && intermediate.length >= 6 && sawFinal && sawInitialX && intermediateX.length >= 6 && sawFinalX) {
                console.log(
                    `NATIVE_LAYOUT_ANIMATION_CONFORMANCE_PASS frames=${widths.current.length} widths=${widths.current.join(",")} xs=${xs.current.join(",")}`,
                );
                process.exit(0);
            } else {
                console.error(
                    `NATIVE_LAYOUT_ANIMATION_CONFORMANCE_FAIL frames=${widths.current.length} widths=${widths.current.join(",")} xs=${xs.current.join(",")}`,
                );
                process.exit(1);
            }
        }, 900);
        return () => clearTimeout(timer);
    }, []);

    return (
        <View style={s.root}>
            <View style={s.shell}>
                <View nativeLayoutKey={KEY} onLayout={onPaneLayout} style={s.pane}>
                    <Text style={s.text} numberOfLines={1}>
                        native animated pane
                    </Text>
                </View>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: "#f3f6fb",
        padding: 24,
    },
    shell: {
        width: 420,
        height: 100,
        flexDirection: "row",
        alignItems: "stretch",
        backgroundColor: "#ffffff",
        borderWidth: 1,
        borderColor: "#cbd5e1",
        borderRadius: 10,
        overflow: "hidden",
    },
    pane: {
        width: 180,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#2f6fed",
    },
    text: {
        color: "#ffffff",
        fontSize: 14,
        fontWeight: "800",
    },
});

render(<App />, { width: 480, height: 150 });
