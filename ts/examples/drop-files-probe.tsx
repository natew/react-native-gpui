import { useEffect } from "react";
import { AppRegistry, Text, View, StyleSheet } from "../src/index";

function App() {
    useEffect(() => {
        console.log("DROP_FILES_PROBE READY");
    }, []);

    return (
        <View
            nativeID="drop-target"
            testID="drop-target"
            onDrop={(event) => {
                const paths = event.nativeEvent.paths.join(",");
                console.log(`DROP_FILES_PROBE DROP ${paths}`);
            }}
            onLayout={(event) => {
                const { x, y, width, height } = event.nativeEvent.layout;
                console.log(`DROP_FILES_PROBE BOX x=${x} y=${y} w=${width} h=${height}`);
            }}
            style={s.box}
        >
            <Text style={s.label}>drop here</Text>
        </View>
    );
}

const s = StyleSheet.create({
    box: { width: 320, height: 200, backgroundColor: "#333333" },
    label: { color: "#ffffff", padding: 12 },
});

AppRegistry.registerComponent("DropFilesProbe", () => App);
AppRegistry.runApplication("DropFilesProbe", { width: 320, height: 200 });
