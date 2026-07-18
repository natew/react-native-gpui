import { AppRegistry, ScrollView, Text, View } from "../src/index";

const ROWS = Array.from({ length: 320 }, (_, index) => index);

function App() {
    return (
        <View style={{ flex: 1, backgroundColor: "#111318", padding: 24 }}>
            <Text style={{ color: "#f4f4f5", fontSize: 20, fontWeight: "600", marginBottom: 12 }}>
                Overview
            </Text>
            <ScrollView
                testID="overview-scroll"
                style={{ flex: 1, borderRadius: 10, backgroundColor: "#181b22" }}
                contentContainerStyle={{ padding: 8 }}
            >
                {ROWS.map((index) => (
                    <View
                        key={index}
                        testID={`overview-row-${String(index).padStart(3, "0")}`}
                        style={{
                            height: 48,
                            flexDirection: "row",
                            alignItems: "center",
                            paddingHorizontal: 12,
                            borderBottomWidth: 1,
                            borderBottomColor: "#292d37",
                        }}
                    >
                        <View
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                marginRight: 10,
                                backgroundColor: index % 3 === 0 ? "#32d583" : "#667085",
                            }}
                        />
                        <View style={{ flex: 1 }}>
                            <Text style={{ color: "#e4e7ec", fontSize: 13 }}>{`Session ${index + 1}`}</Text>
                            <Text style={{ color: "#858b98", fontSize: 11 }}>{`worker-${index % 12} · active`}</Text>
                        </View>
                        <Text style={{ color: "#98a2b3", fontSize: 11 }}>{`${index * 3 + 7}m`}</Text>
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}

AppRegistry.registerComponent("ScrollPerformanceConformance", () => App);
AppRegistry.runApplication("ScrollPerformanceConformance", { width: 900, height: 700 });
