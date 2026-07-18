import { useState } from "react";
import Animated, { scrollTo, useAnimatedRef } from "react-native-reanimated";
import { runOnUI } from "react-native-worklets";
import { Pressable, ScrollView, StyleSheet, Text, View, render } from "../src/index";

const TARGET_INDEX = 180;
const ROW_HEIGHT = 40;
const TARGET_SCROLL_Y = TARGET_INDEX * ROW_HEIGHT - 200;
const rows = Array.from({ length: 220 }, (_, index) => index);

function App() {
    const scrollRef = useAnimatedRef<ScrollView>();
    const [observedY, setObservedY] = useState(0);

    const scrollToTarget = () => {
        runOnUI(() => {
            "worklet";
            scrollTo(scrollRef, 0, TARGET_SCROLL_Y, false);
        })();
    };

    return (
        <View style={styles.root}>
            <View style={styles.header}>
                <Text nativeID="reanimated-scroll-status" style={styles.status}>
                    {`y:${observedY.toFixed(0)}`}
                </Text>
                <Pressable nativeID="reanimated-scroll-trigger" style={styles.trigger} onPress={scrollToTarget}>
                    <Text style={styles.triggerText}>jump</Text>
                </Pressable>
            </View>
            <Animated.ScrollView
                ref={scrollRef}
                nativeID="reanimated-scroll-host"
                style={styles.list}
                onScroll={(event: unknown) => {
                    const y = (event as { nativeEvent?: { contentOffset?: { y?: number } } }).nativeEvent
                        ?.contentOffset?.y;
                    if (typeof y === "number") setObservedY(y);
                }}
            >
                {rows.map((index) => (
                    <View
                        key={index}
                        nativeID={index === TARGET_INDEX ? "reanimated-scroll-target" : undefined}
                        style={styles.row}
                    >
                        <Text style={styles.text}>{`row ${index}`}</Text>
                    </View>
                ))}
            </Animated.ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#10151f", padding: 16 },
    header: { height: 28, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    status: { color: "#9fb3cb", fontSize: 12 },
    trigger: { width: 64, height: 24, alignItems: "center", justifyContent: "center", backgroundColor: "#273449" },
    triggerText: { color: "#d9e4f2", fontSize: 12 },
    list: { flex: 1, backgroundColor: "#171f2c" },
    row: {
        height: ROW_HEIGHT,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: "#2a3547",
    },
    text: { color: "#d9e4f2", fontSize: 13 },
});

render(<App />, { width: 420, height: 360 });
