/**
 * Interactive fixture for `rngpui trace` — nothing animates until tapped, so the
 * trace session controls timing (no launch races, no self-exit).
 *
 *   bun cli/bin.ts trace card --action "tap go-button" --ms 1500 --launch examples/trace-fixture.tsx
 *
 * Tapping "go" fires two animation lanes at once:
 *   - reanimated worklet spring on the card: opacity + translateY + scale (off-thread
 *     SetNodeStyle path)
 *   - NativeLayout.animateFrame on the pane: width + x tween (Rust-side tween path)
 */
import { useState } from "react";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { NativeLayout, Pressable, StyleSheet, Text, View, render } from "../src/index";

const PANE_KEY = "trace-pane";

function App() {
    const open = useSharedValue(0);
    const [paneWide, setPaneWide] = useState(false);

    const cardStyle = useAnimatedStyle(() => {
        "worklet";
        return {
            opacity: withSpring(open.value, { damping: 16, stiffness: 160 }),
            transform: [
                { translateY: withSpring(open.value === 1 ? 0 : 24, { damping: 14, stiffness: 120 }) },
                { scale: withSpring(open.value === 1 ? 1 : 0.92, { damping: 14, stiffness: 120 }) },
            ],
        };
    });

    return (
        <View style={s.root}>
            <Pressable
                nativeID="go-button"
                style={s.button}
                onPress={() => {
                    open.value = open.value === 1 ? 0 : 1;
                    const wide = !paneWide;
                    setPaneWide(wide);
                    NativeLayout.animateFrame(PANE_KEY, { width: wide ? 360 : 160, x: wide ? 24 : 120 }, 240);
                }}
            >
                <Text style={s.buttonText}>go</Text>
            </Pressable>
            <Animated.View nativeID="card" style={[s.card, cardStyle]}>
                <Text style={s.cardText}>traced card</Text>
            </Animated.View>
            <View style={s.shell}>
                <View nativeLayoutKey={PANE_KEY} nativeID="pane" style={s.pane}>
                    <Text style={s.cardText} numberOfLines={1}>
                        traced pane
                    </Text>
                </View>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#10141c", padding: 32, gap: 24 },
    button: {
        width: 120,
        height: 44,
        borderRadius: 10,
        backgroundColor: "#2f6fed",
        alignItems: "center",
        justifyContent: "center",
    },
    buttonText: { color: "#ffffff", fontSize: 16 },
    card: {
        width: 280,
        height: 120,
        borderRadius: 16,
        backgroundColor: "#1d2533",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 16px 40px rgba(0,0,0,0.6)",
    },
    cardText: { color: "#d7e1f2", fontSize: 15 },
    shell: { height: 80, justifyContent: "center" },
    pane: {
        width: 160,
        height: 64,
        marginLeft: 120,
        borderRadius: 12,
        backgroundColor: "#27405f",
        alignItems: "center",
        justifyContent: "center",
    },
});

render(<App />, { width: 640, height: 420 });
