import { useEffect, useRef, useState } from "react";
import { render, StyleSheet, Text, TextInput, View } from "../src/index";

const LARGE_TREE_NODES = 800;
const decorationRows = Array.from({ length: LARGE_TREE_NODES }, (_, index) => index);

function App() {
    const [draft, setDraft] = useState("");
    const [secondary, setSecondary] = useState("secondary");
    const [focused, setFocused] = useState("none");
    const [sawComposing, setSawComposing] = useState(false);
    const [lastComposing, setLastComposing] = useState(false);
    const [eventCount, setEventCount] = useState(0);
    const [submitted, setSubmitted] = useState("");
    const [composingEnter, setComposingEnter] = useState(false);
    const primaryFocuses = useRef(0);
    const secondaryFocuses = useRef(0);

    useEffect(() => {
        const timer = setTimeout(() => setSecondary("programmatic"), 500);
        return () => clearTimeout(timer);
    }, []);

    return (
        <View style={styles.root}>
            <View style={styles.largeTree}>
                {decorationRows.map((index) => (
                    <View key={index} style={styles.decorationRow}>
                        <Text style={styles.decorationText}>{`row-${index}`}</Text>
                    </View>
                ))}
            </View>
            <View style={styles.panel}>
                <TextInput
                    testID="primary-input"
                    autoFocus
                    multiline
                    value={draft}
                    onChangeText={setDraft}
                    onChange={(event) => {
                        const composing = event.nativeEvent.isComposing;
                        setLastComposing(composing);
                        setSawComposing((seen) => seen || composing);
                        setEventCount(event.nativeEvent.eventCount);
                    }}
                    onFocus={() => {
                        primaryFocuses.current += 1;
                        setFocused("primary");
                    }}
                    onBlur={() => setFocused((value) => (value === "primary" ? "none" : value))}
                    onSubmitEditing={(event) => setSubmitted(event.nativeEvent.text)}
                    onKeyPress={(event) => {
                        if (event.nativeEvent.key === "Enter" && event.nativeEvent.isComposing) {
                            setComposingEnter(true);
                        }
                    }}
                    placeholder="Primary input"
                    placeholderTextColor="#ff4fa3"
                    style={styles.input}
                />
                <TextInput
                    testID="secondary-input"
                    value={secondary}
                    onChangeText={setSecondary}
                    onFocus={() => {
                        secondaryFocuses.current += 1;
                        setFocused("secondary");
                    }}
                    onBlur={() => setFocused((value) => (value === "secondary" ? "none" : value))}
                    placeholder="Secondary input"
                    style={styles.input}
                />
                <TextInput
                    testID="placeholder-color-input"
                    editable={false}
                    placeholder="COLOR_SENTINEL"
                    placeholderTextColor="#ff4fa3"
                    style={styles.input}
                />
                <Text testID="input-runtime-status" style={styles.status}>
                    {JSON.stringify({
                        draft,
                        secondary,
                        focused,
                        sawComposing,
                        lastComposing,
                        eventCount,
                        submitted,
                        composingEnter,
                        primaryFocuses: primaryFocuses.current,
                        secondaryFocuses: secondaryFocuses.current,
                    })}
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: "#101218",
        overflow: "hidden",
    },
    largeTree: {
        position: "absolute",
        left: 0,
        top: 0,
        width: 300,
    },
    decorationRow: {
        width: 300,
        height: 1,
    },
    decorationText: {
        color: "#141821",
        fontSize: 1,
        lineHeight: 1,
    },
    panel: {
        position: "absolute",
        left: 320,
        top: 40,
        width: 420,
        padding: 16,
        gap: 12,
        borderRadius: 12,
        backgroundColor: "#252a35",
    },
    input: {
        width: 388,
        height: 56,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#596174",
        backgroundColor: "#171a21",
        color: "#43d17d",
        fontSize: 16,
        lineHeight: 22,
    },
    status: {
        color: "#d8deec",
        fontSize: 11,
        lineHeight: 15,
    },
});

render(<App />, { width: 780, height: 520 });
