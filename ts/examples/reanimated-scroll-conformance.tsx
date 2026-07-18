import { useEffect, useState } from "react";
import Animated, {
    scrollTo,
    useAnimatedReaction,
    useAnimatedRef,
    useSharedValue,
} from "react-native-reanimated";
import { ScrollView, StyleSheet, Text, View, render } from "../src/index";

const TARGET_INDEX = 180;
const ROW_HEIGHT = 40;
const rows = Array.from({ length: 220 }, (_, index) => index);

function App() {
    const scrollRef = useAnimatedRef<ScrollView>();
    const command = useSharedValue(0);
    const [observedY, setObservedY] = useState(0);

    useAnimatedReaction(
        () => command.value,
        (next, previous) => {
            if (next === 1 && previous !== 1) {
                scrollTo(scrollRef, 0, TARGET_INDEX * ROW_HEIGHT, false);
            }
        },
    );

    useEffect(() => {
        const timer = setTimeout(() => {
            command.value = 1;
        }, 250);
        return () => clearTimeout(timer);
    }, [command]);

    return (
        <View style={styles.root}>
            <Text nativeID="reanimated-scroll-status" style={styles.status}>
                {`y:${observedY.toFixed(0)}`}
            </Text>
            <Animated.ScrollView
                ref={scrollRef}
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
    status: { height: 24, color: "#9fb3cb", fontSize: 12 },
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
