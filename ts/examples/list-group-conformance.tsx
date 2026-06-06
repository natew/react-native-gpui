/**
 * Conformance fixture for ListGroup press-drag selection.
 *
 * The automated driver launches this offscreen as a smoke fixture. The native
 * press-drag state machine is covered by Rust tests so the default test path
 * does not take over the user's pointer or foreground app.
 */
import { useEffect, useRef, useState } from "react";
import { render, View, Text, ListGroup, StyleSheet } from "../src/index";

const ROWS = ["alpha", "beta", "gamma"];
const expected = process.env.RNGPUI_LIST_GROUP_EXPECT?.split(",").filter(Boolean);

function App() {
    const [selected, setSelected] = useState("alpha");
    const [sequence, setSequence] = useState("");
    const sequenceRef = useRef<string[]>([]);

    useEffect(() => {
        let failTimer: ReturnType<typeof setTimeout> | undefined;
        let smokeTimer: ReturnType<typeof setTimeout> | undefined;
        if (process.env.RNGPUI_LIST_GROUP_SMOKE) {
            smokeTimer = setTimeout(() => {
                console.log("CONFORMANCE list-group smoke PASS");
                process.exit(0);
            }, 500);
        }
        if (expected?.length) {
            failTimer = setTimeout(() => {
                console.error(`CONFORMANCE list-group FAIL timeout sequence=${JSON.stringify(sequenceRef.current)}`);
                process.exit(1);
            }, 6000);
        }
        return () => {
            if (failTimer) clearTimeout(failTimer);
            if (smokeTimer) clearTimeout(smokeTimer);
        };
    }, []);

    function select(id: string) {
        const next = [...sequenceRef.current, id];
        sequenceRef.current = next;
        setSelected(id);
        setSequence(next.join(","));
        console.log(`CONFORMANCE list-group select id=${id} sequence=${next.join(",")}`);
        if (!expected?.length) return;

        const wanted = expected.join(",");
        const got = next.join(",");
        if (next.length === expected.length && got === wanted) {
            console.log("CONFORMANCE list-group all PASS");
            setTimeout(() => process.exit(0), 50);
        } else if (next.length >= expected.length) {
            console.error(`CONFORMANCE list-group FAIL expected=${wanted} got=${got}`);
            setTimeout(() => process.exit(1), 50);
        }
    }

    return (
        <View style={s.root}>
            <ListGroup id="primary-list" style={s.list}>
                {ROWS.map((row) => {
                    const active = row === selected;
                    return (
                        <View
                            key={row}
                            accessibilityRole="button"
                            accessibilityLabel={`Drag row ${row}`}
                            style={[s.row, active && s.rowActive]}
                            onStartShouldSetResponder={() => true}
                            onResponderRelease={() => select(row)}
                        >
                            <Text style={[s.label, active && s.labelActive]}>{row}</Text>
                        </View>
                    );
                })}
            </ListGroup>
            <Text style={s.sequence}>sequence={sequence}</Text>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: "#f5f7fb",
        padding: 20,
    },
    list: {
        width: 260,
        borderWidth: 1,
        borderColor: "#cfd7e6",
        borderRadius: 8,
        overflow: "hidden",
        backgroundColor: "#ffffff",
    },
    row: {
        height: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        borderBottomWidth: 1,
        borderColor: "#e2e7f0",
        backgroundColor: "#ffffff",
    },
    rowActive: {
        backgroundColor: "#2f6fed",
    },
    label: {
        color: "#182033",
        fontSize: 14,
        fontWeight: "700",
    },
    labelActive: {
        color: "#ffffff",
    },
    sequence: {
        marginTop: 14,
        color: "#536078",
        fontSize: 12,
    },
});

render(<App />, { width: 360, height: 220 });
