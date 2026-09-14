/**
 * Conformance fixture for :focus-visible on a freshly mounted focus scope.
 *
 * `useKeyboardNavigationController` takes a required `initialId`, so every app that
 * uses keyboard navigation starts with a focused target. Whether that target reads as
 * `:focus-visible` decides if the focus ring paints before the user has touched
 * anything: on the web a target focused by page load is `:focus` but not
 * `:focus-visible`, and the ring appears only once focus is keyboard-driven.
 *
 * A target must not read `focusVisible` on the initial frame, and must read it once the
 * keyboard reveals the ring. Both directions are asserted; a fixture that only checked
 * the first would pass with the ring broken outright.
 */
import { useEffect, useRef, useState } from "react";
import {
    KeyboardNavigationProvider,
    render,
    StyleSheet,
    Text,
    View,
    useKeyboardNavigationController,
    useKeyboardNavigationTarget,
} from "../src/index";

const initialId = "alpha";

function Target({ id, onSnapshot }: { id: string; onSnapshot: (id: string, focusVisible: boolean) => void }) {
    const { focusVisible } = useKeyboardNavigationTarget({ id, group: "stage", onActivate: () => {} });
    useEffect(() => {
        onSnapshot(id, focusVisible);
    }, [id, focusVisible, onSnapshot]);
    return (
        <View style={styles.box}>
            <Text style={styles.label}>{id}</Text>
        </View>
    );
}

function App() {
    const keyboard = useKeyboardNavigationController({
        initialId,
        initialGroup: "stage",
        idPrefix: "focus-visible-conformance",
        // negative control: RNGPUI_FOCUS_VISIBLE_INITIAL=1 opts back into the ring at
        // launch, which must make the gate fail
        initialFocusVisible: process.env.RNGPUI_FOCUS_VISIBLE_INITIAL === "1" ? true : undefined,
    });
    const [visible, setVisible] = useState<Record<string, boolean>>({});
    const stepRef = useRef(0);

    const onSnapshot = (id: string, focusVisible: boolean) => {
        setVisible((previous) => (previous[id] === focusVisible ? previous : { ...previous, [id]: focusVisible }));
    };

    useEffect(() => {
        const report = (id: string) => visible[id];
        if (stepRef.current === 0) {
            if (report(initialId) === undefined || report("beta") === undefined) return;
            stepRef.current = 1;
            const initial = [initialId, "beta"]
                .map((id) => `${id}=${report(id)}`)
                .sort()
                .join(" ");
            console.log(`CONFORMANCE focus-visible initial ${initial}`);
            // revealing a registered target is what every keyboard path does before it
            // moves focus, so this is the ring's real trigger, not a flag poke
            const timer = setTimeout(() => keyboard.activateFocused(), 200);
            return () => clearTimeout(timer);
        }
        if (stepRef.current === 1 && report(initialId)) {
            stepRef.current = 2;
            console.log(`CONFORMANCE focus-visible keyboard ${initialId}=${report(initialId)} beta=${report("beta")}`);
        }
    }, [keyboard, visible]);

    return (
        <KeyboardNavigationProvider controller={keyboard}>
            <View style={styles.root}>
                <Target id={initialId} onSnapshot={onSnapshot} />
                <Target id="beta" onSnapshot={onSnapshot} />
            </View>
        </KeyboardNavigationProvider>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, padding: 16, gap: 8, backgroundColor: "#10141c" },
    box: { height: 44, justifyContent: "center", paddingHorizontal: 16, backgroundColor: "#171e29" },
    label: { color: "#a9bad2", fontSize: 14 },
});

render(<App />, { title: "focus-visible-conformance", width: 420, height: 320 });
