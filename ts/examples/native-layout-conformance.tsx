/**
 * runtime conformance for native layout overrides.
 *
 * expected:
 *   - a keyed view lays out at its React width first
 *   - NativeLayout.setWidth updates that width in the gpui service
 *   - onLayout observes the new width without a React state width change
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

const KEY = "native-layout-pane";

function App() {
    const sawInitial = useRef(false);
    const done = useRef(false);

    useEffect(() => {
        const timer = setTimeout(() => NativeLayout.setWidth(KEY, 284), 120);
        return () => clearTimeout(timer);
    }, []);

    function onPaneLayout(event: LayoutChangeEvent) {
        const width = Math.round(event.nativeEvent.layout.width);
        if (width === 180) {
            sawInitial.current = true;
        }
        if (sawInitial.current && width === 284 && !done.current) {
            done.current = true;
            console.log("NATIVE_LAYOUT_CONFORMANCE_PASS width=284");
            process.exit(0);
        }
    }

    useEffect(() => {
        const timer = setTimeout(() => {
            if (!done.current) {
                console.error("NATIVE_LAYOUT_CONFORMANCE_FAIL timed out");
                process.exit(1);
            }
        }, 1000);
        return () => clearTimeout(timer);
    }, []);

    return (
        <View style={s.root}>
            <View style={s.shell}>
                <View nativeLayoutKey={KEY} onLayout={onPaneLayout} style={s.pane}>
                    <Text style={s.text} numberOfLines={1}>
                        native pane
                    </Text>
                </View>
                <View
                    nativeResize={{ target: KEY, edge: "right", min: 160, max: 360 }}
                    style={s.handle}
                />
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
    handle: {
        width: 10,
        cursor: "col-resize",
        backgroundColor: "#d9e5f6",
    },
});

render(<App />, { width: 480, height: 150 });
