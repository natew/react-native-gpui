/**
 * 100,000-item LegendList performance and compatibility fixture.
 *
 * the list uses stable data, two recycled row types, and exact fixed sizes. the
 * controls exercise large imperative jumps while rngpui's tree/stats commands
 * verify that native node count stays bounded.
 */
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { memo, useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, render } from "../src/index";

const emptyReference = process.env.RNGPUI_LEGEND_EMPTY_REFERENCE === "1";
const ITEM_COUNT = emptyReference ? 0 : 100_000;
const ESTIMATED_LIST_SIZE = { height: 644, width: 900 } as const;
const fixtureStartedAt = performance.now();

type ItemKind = "compact" | "summary";
type Item = number;

// the numeric index is the immutable item identity. deriving the short key and
// row type only when LegendList asks avoids retaining 100,000 objects and id strings
// before first paint while preserving stable keys and typed recycling.
const items: readonly Item[] = Array.from({ length: ITEM_COUNT }, (_, index) => index);

type RowProps = { index: number };

const CompactRow = memo(function CompactRow({ index }: RowProps) {
    return (
        <View nativeID={`legend-item-${index}`} style={s.compactRow}>
            <Text style={s.index} numberOfLines={1}>
                {String(index).padStart(6, "0")}
            </Text>
            <Text style={s.label} numberOfLines={1}>
                {`Stable item ${index}`}
            </Text>
            <Text style={s.kind} numberOfLines={1}>
                compact
            </Text>
        </View>
    );
});

const SummaryRow = memo(function SummaryRow({ index }: RowProps) {
    return (
        <View nativeID={`legend-item-${index}`} style={s.summaryRow}>
            <Text style={s.index} numberOfLines={1}>
                {String(index).padStart(6, "0")}
            </Text>
            <Text style={s.label} numberOfLines={1}>
                {`Summary row ${index}`}
            </Text>
            <Text style={s.kind} numberOfLines={1}>
                summary
            </Text>
        </View>
    );
});

function renderItem({ item }: { item: Item }) {
    return item % 20 === 0 ? (
        <SummaryRow index={item} />
    ) : (
        <CompactRow index={item} />
    );
}

function keyExtractor(item: Item) {
    return String(item);
}

function getItemType(item: Item): ItemKind {
    return item % 20 === 0 ? "summary" : "compact";
}

function getFixedItemSize(item: Item) {
    return item % 20 === 0 ? 56 : 40;
}

function App() {
    const listRef = useRef<LegendListRef | null>(null);
    const [loadLabel, setLoadLabel] = useState("loading");
    const [targetLabel, setTargetLabel] = useState("top");

    const jumpTo = useCallback((index: number) => {
        setTargetLabel(`jumping:${index}`);
        listRef.current
            ?.scrollToIndex({ animated: false, index })
            .then(() => setTargetLabel(`settled:${index}`));
    }, []);
    const jumpMiddle = useCallback(() => jumpTo(50_000), [jumpTo]);
    const jumpEnd = useCallback(() => jumpTo(99_999), [jumpTo]);
    const jumpStart = useCallback(() => jumpTo(0), [jumpTo]);
    const onLoad = useCallback(({ elapsedTimeInMs }: { elapsedTimeInMs: number }) => {
        const appElapsed = performance.now() - fixtureStartedAt;
        const label = `loaded:${elapsedTimeInMs.toFixed(1)}ms app:${appElapsed.toFixed(1)}ms`;
        console.log(`LEGEND_100K_LOAD ${label}`);
        setLoadLabel(label);
    }, []);

    return (
        <View style={s.root}>
            <View style={s.toolbar}>
                <View style={s.headingBlock}>
                    <Text style={s.heading} numberOfLines={1}>
                        LegendList 100,000
                    </Text>
                    <Text
                        nativeID={emptyReference ? "legend-empty-ready" : "legend-load-status"}
                        style={s.status}
                        numberOfLines={1}
                    >
                        {loadLabel} · {targetLabel}
                    </Text>
                </View>
                <Pressable nativeID="jump-middle" style={s.button} onPress={jumpMiddle}>
                    <Text style={s.buttonText}>middle</Text>
                </Pressable>
                <Pressable nativeID="jump-end" style={s.button} onPress={jumpEnd}>
                    <Text style={s.buttonText}>end</Text>
                </Pressable>
                <Pressable nativeID="jump-start" style={s.button} onPress={jumpStart}>
                    <Text style={s.buttonText}>start</Text>
                </Pressable>
            </View>
            <LegendList
                ref={listRef}
                data={items}
                drawDistance={160}
                estimatedItemSize={40}
                estimatedListSize={ESTIMATED_LIST_SIZE}
                getFixedItemSize={getFixedItemSize}
                getItemType={getItemType}
                keyExtractor={keyExtractor}
                nativeID="legend-list"
                onLoad={onLoad}
                recycleItems
                renderItem={renderItem}
                style={s.list}
            />
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: "#0b1018",
    },
    toolbar: {
        height: 56,
        paddingHorizontal: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        backgroundColor: "#151d2a",
        borderBottomWidth: 1,
        borderBottomColor: "#2b3a50",
    },
    headingBlock: {
        flex: 1,
        minWidth: 0,
    },
    heading: {
        color: "#f4f7fb",
        fontSize: 15,
        fontWeight: "700",
    },
    status: {
        color: "#8fa2bd",
        fontSize: 11,
        marginTop: 2,
    },
    button: {
        height: 32,
        minWidth: 60,
        paddingHorizontal: 12,
        borderRadius: 7,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#275a9f",
    },
    buttonText: {
        color: "#ffffff",
        fontSize: 12,
        fontWeight: "600",
    },
    list: {
        flex: 1,
    },
    compactRow: {
        height: 40,
        paddingHorizontal: 14,
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: 1,
        borderBottomColor: "#202c3d",
        backgroundColor: "#0f1621",
    },
    summaryRow: {
        height: 56,
        paddingHorizontal: 14,
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: 1,
        borderBottomColor: "#37516f",
        backgroundColor: "#17273a",
    },
    index: {
        width: 64,
        color: "#65b2ff",
        fontSize: 12,
        fontWeight: "600",
    },
    label: {
        flex: 1,
        color: "#d8e2ef",
        fontSize: 13,
    },
    kind: {
        width: 66,
        color: "#8396af",
        fontSize: 11,
        textAlign: "right",
    },
});

render(<App />, { width: 900, height: 700 });
