// Minimal end-to-end smoke for the single-process Hermes host: renders a few native
// View/Text nodes through the library's own reconciler. No Tamagui, no agentbus app — just
// proves bundle eval → reconcile → __rngpui_applyTree → GPUI window + paint, in one process.
//
//   bun scripts/bundle-hermes.mjs examples/hermes-smoke.tsx /tmp/hermes-smoke.js
//   RNGPUI_BUNDLE=/tmp/hermes-smoke.js rngpui-service
import { useEffect, useState } from "react";
import { AppRegistry, Text, View } from "../src/index";

function App() {
    const [n, setN] = useState(0);
    console.log("[smoke] render, tick =", n);
    // exercises the host env: timers fire on the Rust loop → setState → re-render → applyTree.
    useEffect(() => {
        console.log("[smoke] mounted; starting interval");
        const t = setInterval(() => setN((v) => v + 1), 500);
        return () => clearInterval(t);
    }, []);
    return (
        <View
            style={{
                width: 600,
                height: 400,
                backgroundColor: "#1e1e2e",
                alignItems: "center",
                justifyContent: "center",
            }}
        >
            <View style={{ padding: 24, backgroundColor: "#313244", borderRadius: 12 }}>
                <Text style={{ color: "#cdd6f4", fontSize: 28, fontWeight: "700" }}>
                    Hello from Hermes
                </Text>
                <Text style={{ color: "#a6adc8", fontSize: 16, marginTop: 8 }}>
                    single process · no Bun · no pipe
                </Text>
                <Text style={{ color: "#89b4fa", fontSize: 20, marginTop: 16 }}>tick {n}</Text>
            </View>
        </View>
    );
}

AppRegistry.registerComponent("smoke", () => App);
AppRegistry.runApplication("smoke", { width: 600, height: 400 });
