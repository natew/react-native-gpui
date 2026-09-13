// Same rendered output as inline.tsx, byte-identical wire payloads, but stable style
// objects and React.memo so only the changed row re-renders. The gap between the two is
// what React Compiler buys on this tree.
import { drain, report } from "./globals";

import { memo, useEffect, useState } from "react";
import { render } from "../../src/render";
import { Text, View } from "../../src/components";

const ROWS = 300;
const COMMITS = 200;
let bump: (n: number) => void = () => {};

const ROW_STYLE = { width: 200, height: 24, backgroundColor: "#123456", flexDirection: "row" } as const;
const ROW_STYLE_HOT = { width: 201, height: 24, backgroundColor: "#123456", flexDirection: "row" } as const;
const TEXT_STYLE = { color: "#ffffff", fontSize: 12 } as const;
const DOT_STYLE = { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ff0000" } as const;

const Row = memo(function Row({ index, hot, version }: { index: number; hot: boolean; version: number }) {
    return (
        <View testID={"row-" + index} style={hot ? ROW_STYLE_HOT : ROW_STYLE}>
            <Text style={TEXT_STYLE}>{"row " + index + " v" + (hot ? version : 0)}</Text>
            <View style={DOT_STYLE} />
        </View>
    );
});

function App() {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        bump = (n: number) => setVersion(n);
    }, []);
    return (
        <View style={{ width: 400, height: 8000 }}>
            {Array.from({ length: ROWS }, (_, index) => {
                const hot = index === version % ROWS;
                return <Row key={index} index={index} hot={hot} version={hot ? version : 0} />;
            })}
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
report("memo", COMMITS, ROWS, Date.now() - startedAt);
