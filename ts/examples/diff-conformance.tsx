import { useMemo, useState } from "react";
import { Diff, StyleSheet, Text, View, render, useColorScheme } from "../src/index";

function App() {
    const scheme = useColorScheme();
    const dark = scheme === "dark";
    const [collapsedPaths, setCollapsedPaths] = useState<string[]>(["src/generated.ts"]);
    const [expanded, setExpanded] = useState(false);
    const [status, setStatus] = useState("ready");
    const patch = useMemo(() => {
        const lines = [
            "diff --git a/src/generated.ts b/src/generated.ts",
            "--- a/src/generated.ts",
            "+++ b/src/generated.ts",
            "@@ -1,2 +1,2 @@",
            "-const label = 'before';",
            "+const label = 'after';",
            " export default label;",
            "diff --git a/src/large.ts b/src/large.ts",
            "--- a/src/large.ts",
            "+++ b/src/large.ts",
            "@@ -1,30000 +1,30000 @@",
        ];
        for (let line = 1; line <= 30_000; line += 1) {
            lines.push(` export const row${line} = ${line};`);
        }
        return `${lines.join("\n")}\n`;
    }, []);

    return (
        <View style={[styles.root, { backgroundColor: dark ? "#111216" : "#f7f8fa" }]}>
            <Text nativeID="diff-status" style={[styles.status, { color: dark ? "#c8cbd1" : "#1f2328" }]}>
                {status}
            </Text>
            <Diff
                accessibilityLabel="native-diff"
                patch={patch}
                wordDiff
                scroll
                maxLines={expanded ? 250_000 : 200}
                collapsedPaths={collapsedPaths}
                onToggleFile={({ nativeEvent }) => {
                    const path = nativeEvent.value;
                    if (!path) return;
                    setCollapsedPaths((current) =>
                        current.includes(path) ? current.filter((value) => value !== path) : [...current, path],
                    );
                    setStatus(`toggle:${path}`);
                }}
                onShowMore={() => {
                    setExpanded(true);
                    setStatus("show-more");
                }}
                onLineClick={({ nativeEvent }) => {
                    setStatus(`line:${nativeEvent.oldLine ?? ""}:${nativeEvent.newLine ?? ""}`);
                }}
                style={[
                    styles.diff,
                    {
                        backgroundColor: dark ? "#111216" : "#ffffff",
                        color: dark ? "#c8cbd1" : "#1f2328",
                    },
                ]}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, padding: 16, gap: 8 },
    status: { height: 22, fontFamily: "Menlo", fontSize: 12, lineHeight: 18 },
    diff: { flex: 1, fontFamily: "Menlo", fontSize: 12, lineHeight: 18 },
});

render(<App />, { title: "diff-conformance", width: 760, height: 560 });
