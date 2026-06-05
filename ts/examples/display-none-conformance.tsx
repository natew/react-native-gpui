/**
 * Runtime conformance fixture for display:none subtrees.
 *
 * Before the renderer skipped hidden children, GPUI could prepaint a hidden
 * text child whose measured layout never ran and panic with:
 * "measurement has not been performed on agentbus".
 */
import { render, View, Text, StyleSheet } from "../src/index";

function App() {
    return (
        <View style={s.root}>
            <View style={s.hiddenView}>
                <Text style={s.hiddenText}>agentbus</Text>
            </View>
            <Text style={s.hiddenText}>agentbus</Text>
            <View style={s.card}>
                <Text style={s.title}>display none conformance</Text>
                <Text style={s.body}>
                    Hidden View and Text nodes should not request, prepaint, or paint child text.
                </Text>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: "#f5f6f8",
        padding: 24,
    },
    hiddenView: {
        display: "none",
    },
    hiddenText: {
        display: "none",
        color: "#17202c",
        fontSize: 14,
    },
    card: {
        width: 420,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#d4d9e2",
        backgroundColor: "#ffffff",
        padding: 18,
        gap: 8,
    },
    title: {
        color: "#17202c",
        fontSize: 15,
        fontWeight: "800",
    },
    body: {
        color: "#687589",
        fontSize: 13,
        lineHeight: 18,
    },
});

render(<App />, { width: 520, height: 220 });
