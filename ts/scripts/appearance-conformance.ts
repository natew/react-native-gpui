// Unit test for the native-driven system color scheme path. The GPUI service emits
// an `appearance` event on window open and on every macOS light/dark toggle;
// `applyNativeColorScheme` feeds that into the same Appearance source-of-truth that
// `useColorScheme` and `DynamicColorIOS` resolution read. This pins the behavior
// without needing a window or touching the host's real system theme.
import assert from "node:assert";
import { Appearance, applyNativeColorScheme } from "../src/colors.ts";

let changes = 0;
let lastScheme: string | null = null;
const sub = Appearance.addChangeListener(({ colorScheme }) => {
    changes += 1;
    lastScheme = colorScheme;
});

// pin a known baseline regardless of the host's real system scheme.
applyNativeColorScheme("light");
const baseline = changes;
assert.equal(Appearance.getColorScheme(), "light", "baseline light");

// 1. a native dark event flips the effective scheme and notifies subscribers.
applyNativeColorScheme("dark");
assert.equal(Appearance.getColorScheme(), "dark", "native dark event flips effective scheme");
assert.equal(lastScheme, "dark", "listener received the new scheme");
const afterDark = changes;
assert.ok(afterDark > baseline, "scheme change notifies listeners");

// 2. the same scheme again is a no-op — no redundant re-theme.
applyNativeColorScheme("dark");
assert.equal(changes, afterDark, "repeated native scheme does not re-notify");

// 3. flipping back to light re-themes again.
applyNativeColorScheme("light");
assert.equal(Appearance.getColorScheme(), "light", "native light event flips back");
assert.ok(changes > afterDark, "flip back notifies");

// 4. a manual override masks native system changes (the conformance test path).
Appearance.setColorScheme("light");
const afterOverride = changes;
applyNativeColorScheme("dark");
assert.equal(Appearance.getColorScheme(), "light", "override masks the native system scheme");
assert.equal(changes, afterOverride, "masked native change does not re-theme");

sub.remove();
console.log("APPEARANCE_UNIT_PASS native scheme drives effective colorScheme + listeners");
