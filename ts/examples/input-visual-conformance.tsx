/**
 * Visual conformance fixture for native-macOS TextInput fidelity (caret, text color,
 * vertical centering). Rendered offscreen with RNGPUI_CAPTURE_PNG; the pixel gate
 * (scripts/input-visual-conformance.mjs) scans the resulting full-opacity PNG.
 *
 * Appearance: the rust input theme is forced by RNGPUI_FORCE_APPEARANCE=dark|light
 * (read in service.rs). The fixture's own backdrop color is inlined at bundle time via
 * RNGPUI_INPUT_FIXTURE_APPEARANCE (the Hermes host gives JS an empty process.env at
 * runtime, so the gate passes it as a bundle-time define) so the window matches.
 *
 * Three fields on a solid neutral-gray field background (identical in both modes, so the
 * accent-blue caret and the near-black/near-white text are both far from it in RGB and
 * trivially separable by the gate):
 *   - FIELD A (focused, EMPTY): a lone caret at the left padding → caret width/color/blink.
 *   - FIELD B (unfocused, "Hg"): typed-text color + vertical centering inside a tall field.
 *   - FIELD C (unfocused, empty, placeholder): placeholder color + centering.
 */
import { useEffect, useRef } from "react";
import { render, View, TextInput, StyleSheet, type TextInputHandle } from "../src/index";

const DARK = process.env.RNGPUI_INPUT_FIXTURE_APPEARANCE === "dark";

// neutral mid-gray field bg, identical in both modes (max contrast vs both text + caret).
const FIELD_BG = "#7a7a7a";
const ROOT_BG = DARK ? "#0a0a0a" : "#ffffff";

// authored geometry (logical px) — kept in sync with the gate.
export const LAYOUT = {
    window: { width: 400, height: 320 },
    fieldA: { x: 40, y: 32, width: 320, height: 44 }, // focused empty → caret
    fieldB: { x: 40, y: 108, width: 320, height: 44 }, // "Hg" → text color + centering
    fieldC: { x: 40, y: 184, width: 320, height: 44 }, // placeholder → centering
    padLeft: 10,
    fontSize: 16,
    lineHeight: 20,
};

function App() {
    const aRef = useRef<TextInputHandle | null>(null);

    useEffect(() => {
        // keep field A focused so its caret paints + blinks.
        let n = 0;
        const t = setInterval(() => {
            aRef.current?.focus();
            if (++n >= 12) clearInterval(t);
        }, 50);
        return () => clearInterval(t);
    }, []);

    return (
        <View style={[s.root, { backgroundColor: ROOT_BG }]}>
            <View style={[s.field, { top: LAYOUT.fieldA.y }]}>
                <TextInput ref={aRef} value="" autoFocus style={s.input} />
            </View>
            <View style={[s.field, { top: LAYOUT.fieldB.y }]}>
                <TextInput value="Hg" style={s.input} />
            </View>
            <View style={[s.field, { top: LAYOUT.fieldC.y }]}>
                <TextInput value="" placeholder="Placeholder" style={s.input} />
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        flex: 1,
    },
    field: {
        position: "absolute",
        left: LAYOUT.fieldA.x,
        width: LAYOUT.fieldA.width,
        height: LAYOUT.fieldA.height,
        borderRadius: 8,
        backgroundColor: FIELD_BG,
        // intentionally NO vertical padding/alignItems here: the gate proves the
        // gpui-component Input centers its own text inside this taller field box.
    },
    input: {
        flex: 1,
        fontSize: LAYOUT.fontSize,
        lineHeight: LAYOUT.lineHeight,
        paddingHorizontal: LAYOUT.padLeft,
        backgroundColor: "transparent",
        borderWidth: 0,
    },
});

render(<App />, { width: LAYOUT.window.width, height: LAYOUT.window.height });
