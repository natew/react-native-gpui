import { render, StyleSheet, View } from "../src/index";

function App() {
    return (
        <View style={s.root}>
            <View style={s.frame}>
                <View style={s.child} />
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: "#102030",
    },
    frame: {
        marginLeft: 40,
        marginTop: 30,
        width: 140,
        height: 110,
        borderRadius: 24,
        overflow: "hidden",
        backgroundColor: "#102030",
    },
    child: {
        width: "100%",
        height: "100%",
        backgroundColor: "#ff0033",
    },
});

render(<App />, { width: 220, height: 180 });
