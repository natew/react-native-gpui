// Isolated test of the host fetch (+ WebSocket) bridge against a live agentbus daemon.
import { useEffect, useState } from "react";
import { AppRegistry, Text, View } from "../src/index";

function App() {
    const [status, setStatus] = useState("fetching…");
    useEffect(() => {
        console.log("[fetch-smoke] calling fetch /api/version");
        fetch("http://127.0.0.1:7777/api/version")
            .then((r) => {
                console.log("[fetch-smoke] response status=" + r.status + " ok=" + r.ok);
                return r.json();
            })
            .then((j) => {
                console.log("[fetch-smoke] json " + JSON.stringify(j));
                setStatus("ok " + JSON.stringify(j));
            })
            .catch((e) => {
                console.log("[fetch-smoke] error " + String(e));
                setStatus("err " + String(e));
            });

        console.log("[fetch-smoke] opening ws /ws");
        const ws = new WebSocket("ws://127.0.0.1:7777/ws");
        ws.onopen = () => console.log("[fetch-smoke] ws OPEN");
        ws.onmessage = (e) => console.log("[fetch-smoke] ws MSG " + String(e.data).slice(0, 80));
        ws.onclose = (e) => console.log("[fetch-smoke] ws CLOSE " + e.code);
    }, []);
    return (
        <View style={{ width: 600, height: 200, backgroundColor: "#222" }}>
            <Text style={{ color: "#fff", fontSize: 14 }}>{status}</Text>
        </View>
    );
}

AppRegistry.registerComponent("fs", () => App);
AppRegistry.runApplication("fs", { width: 600, height: 200 });
