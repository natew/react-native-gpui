/**
 * Visual conformance fixture for RN Text `numberOfLines`.
 *
 * Run:
 *   bun run conformance:text-lines
 *
 * Capture the GPUI window, then compare against a known-good capture with:
 *   bun run pixel-diff before.png after.png --crop 0,0,540,300 --diff-out /tmp/text-lines-diff.png
 */
import {
    render,
    View,
    Text,
    StyleSheet,
    type LayoutChangeEvent,
} from "../src/index";

const C = {
    root: "#f5f6f8",
    panel: "#ffffff",
    row: "#eef1f5",
    active: "#e8f0ff",
    border: "#d4d9e2",
    text: "#17202c",
    sub: "#687589",
    accent: "#2f6fed",
    green: "#25a55f",
    warning: "#d97706",
};

const LONG_BRANCH =
    "feature/native-command-palette-and-a-very-long-branch-name-that-must-ellipsize-before-the-time-lane";

function measured(name: string, expectedHeight: number) {
    return (event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        const pass = Math.abs(height - expectedHeight) < 1.5;
        console.log(
            `CONFORMANCE numberOfLines ${name} expectedHeight=${expectedHeight} got=${width.toFixed(1)}x${height.toFixed(1)} ${pass ? "PASS" : "FAIL"}`,
        );
    };
}

function measuredText(name: string, maxHeight: number, minWidth: number, maxWidth: number) {
    return (event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        const heightPass = height <= maxHeight + 1.5;
        const widthPass = width >= minWidth - 1.5 && width <= maxWidth + 1.5;
        const pass = heightPass && widthPass;
        console.log(
            `CONFORMANCE numberOfLines ${name} width=${minWidth}-${maxWidth} maxHeight=${maxHeight} got=${width.toFixed(1)}x${height.toFixed(1)} ${pass ? "PASS" : "FAIL"}`,
        );
    };
}

function BranchRow({
    name,
    subtitle,
    time,
    active,
    numberOfLines,
}: {
    name: string;
    subtitle: string;
    time: string;
    active?: boolean;
    numberOfLines?: number;
}) {
    return (
        <View
            style={[s.row, active && s.rowActive]}
            onLayout={measured(active ? "clamped-active-row" : "reference-row", 58)}
        >
            <View style={[s.status, { backgroundColor: active ? C.green : C.warning }]} />
            <View style={s.copy}>
                <View style={s.titleLine}>
                    <Text style={s.icon} numberOfLines={1}>
                        branch
                    </Text>
                    <Text
                        style={s.title}
                        numberOfLines={numberOfLines}
                        onLayout={measuredText(
                            active ? "clamped-active-title" : "reference-title",
                            (numberOfLines ?? 1) * 18,
                            300,
                            337,
                        )}
                    >
                        {name}
                    </Text>
                </View>
                <Text style={s.subtitle} numberOfLines={1}>
                    {subtitle}
                </Text>
            </View>
            <Text style={s.time} numberOfLines={1}>
                {time}
            </Text>
        </View>
    );
}

function App() {
    return (
        <View style={s.root}>
            <View style={s.panel}>
                <Text style={s.heading} numberOfLines={1}>
                    text line conformance
                </Text>
                <BranchRow
                    active
                    numberOfLines={1}
                    name={LONG_BRANCH}
                    subtitle="expected: one painted line, fixed height, timestamp lane stays visible"
                    time="9m"
                />
                <BranchRow
                    numberOfLines={2}
                    name={`${LONG_BRANCH}/with-a-two-line-limit-for-message-and-branch-badges`}
                    subtitle="expected: title clamps to two painted lines without escaping the row mask"
                    time="12m"
                />
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: C.root,
        padding: 22,
    },
    panel: {
        width: 496,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel,
        padding: 14,
        gap: 10,
    },
    heading: {
        color: C.sub,
        fontSize: 12,
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginBottom: 2,
    },
    row: {
        height: 58,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: C.row,
        overflow: "hidden",
    },
    rowActive: {
        backgroundColor: C.active,
    },
    status: {
        width: 8,
        height: 8,
        borderRadius: 4,
        flexShrink: 0,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    titleLine: {
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        minWidth: 0,
    },
    icon: {
        width: 48,
        color: C.accent,
        fontSize: 10,
        fontWeight: "800",
        flexShrink: 0,
    },
    title: {
        flex: 1,
        minWidth: 0,
        color: C.text,
        fontSize: 14,
        fontWeight: "700",
        lineHeight: 18,
    },
    subtitle: {
        color: C.sub,
        fontSize: 11,
        lineHeight: 14,
    },
    time: {
        width: 34,
        flexShrink: 0,
        color: C.sub,
        fontSize: 11,
        fontWeight: "700",
        textAlign: "right",
    },
});

render(<App />, { width: 540, height: 300 });
