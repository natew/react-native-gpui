import { useEffect } from "react";
import { ScrollView, StyleSheet, Text, View, render } from "../src/index";

const STALL_MS = 2_000;

function App() {
    useEffect(() => {
        console.log("CONFORMANCE native-scroll-react-stall READY");
        const timer = setTimeout(() => {
            console.log("CONFORMANCE native-scroll-react-stall STALL_START");
            const until = Date.now() + STALL_MS;
            while (Date.now() < until) {
                // keep Hermes' React runtime busy while AppKit and GPUI scroll.
            }
            console.log("CONFORMANCE native-scroll-react-stall STALL_END");
        }, 700);
        return () => clearTimeout(timer);
    }, []);

    return (
        <View style={styles.root}>
            <Text style={styles.heading}>native scroll during React stall</Text>
            <ScrollView testID="stall-scroll" style={styles.scroll} showsVerticalScrollIndicator={false}>
                {Array.from({ length: 160 }, (_, index) => (
                    <View key={index} style={styles.row}>
                        <Text style={styles.rowText}>row {String(index).padStart(3, "0")}</Text>
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, padding: 24, gap: 12, backgroundColor: "#10141c" },
    heading: { color: "#dce7fa", fontSize: 16, fontWeight: "600" },
    scroll: { flex: 1, borderRadius: 12, backgroundColor: "#171e29" },
    row: { height: 44, justifyContent: "center", paddingHorizontal: 16 },
    rowText: { color: "#a9bad2", fontSize: 14 },
});

render(<App />, { title: "native-scroll-react-stall", width: 480, height: 620 });
