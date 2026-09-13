// Commit-path bench, "naive app" shape: inline style objects and a prop that changes on
// every row, so React calls commitUpdate on the whole subtree even though one row's
// rendered output changes. This is the shape that makes the mutation phase dominate.
import { drain, report } from "./globals";

import { useEffect, useState } from "react";
import { render } from "../../src/render";
import { Text, View } from "../../src/components";

const ROWS = 300;
const COMMITS = 200;
let bump: (n: number) => void = () => {};

function Row({ index, version }: { index: number; version: number }) {
    const hot = index === version % ROWS;
    return (
        <View
            testID={"row-" + index}
            style={{ width: hot ? 201 : 200, height: 24, backgroundColor: "#123456", flexDirection: "row" }}
        >
            <Text style={{ color: "#ffffff", fontSize: 12 }}>{"row " + index + " v" + (hot ? version : 0)}</Text>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#ff0000" }} />
        </View>
    );
}

function App() {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        bump = (n: number) => setVersion(n);
    }, []);
    return (
        <View style={{ width: 400, height: 8000 }}>
            {Array.from({ length: ROWS }, (_, index) => (
                <Row key={index} index={index} version={version} />
            ))}
        </View>
    );
}

render(<App />, { width: 400, height: 800 });
drain();

const startedAt = Date.now();
for (let i = 1; i <= COMMITS; i++) {
    bump(i);
    drain();
}
report("inline", COMMITS, ROWS, Date.now() - startedAt);
