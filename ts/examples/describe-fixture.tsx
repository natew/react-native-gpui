/**
 * Fixture for the `rngpui` CLI describe/color conformance check
 * (scripts/describe-conformance.mjs). A handful of fixed-position, fixed-color,
 * testID'd boxes the CLI can resolve by selector and assert non-degenerate bounds +
 * sampled-color-matches-authored-color against, all offscreen, no screenshot.
 *
 *   RNGPUI_NO_ACTIVATE=1 RNGPUI_TEST_MODE=1 bun run examples/describe-fixture.tsx
 */
import { AppRegistry, View, Text } from "../src/index";

// known, distinct, solid colors at known positions. The page background is a single
// flat fill so a sample anywhere outside the boxes reads it cleanly.
const PAGE_BG = "#eef2f7";
const RED = "#d92d20";
const GREEN = "#12b76a";
const BLUE = "#2e6cf0";

function App() {
    return (
        <View style={{ flex: 1, backgroundColor: PAGE_BG }} accessibilityLabel="page-root">
            <View
                testID="box-red"
                style={{ position: "absolute", left: 40, top: 40, width: 200, height: 120, backgroundColor: RED }}
            />
            <View
                testID="box-green"
                style={{ position: "absolute", left: 300, top: 40, width: 200, height: 120, backgroundColor: GREEN }}
            />
            <View
                testID="box-blue"
                style={{ position: "absolute", left: 40, top: 220, width: 200, height: 120, backgroundColor: BLUE }}
            >
                <Text testID="box-blue-label" style={{ color: "#ffffff", padding: 12 }}>
                    Blue Box
                </Text>
            </View>
        </View>
    );
}

AppRegistry.registerComponent("DescribeFixture", () => App);
AppRegistry.runApplication("DescribeFixture", { width: 640, height: 420 });
