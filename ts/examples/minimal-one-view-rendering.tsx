// The floor fixture's twin: the same one View, but never stopping rendering.
//
// minimal-one-view.tsx paints once and goes quiet, and measures TWO IOSurfaces.
// This one keeps frames in flight and measures THREE, on identical content. The
// difference is not anything either fixture renders — it is gpui's Metal drawable
// pool. metal_renderer.rs sets layer.set_maximum_drawable_count(3) and CAMetalLayer
// realises drawables lazily, so a fixture that paints once only ever needs two.
//
// That matters because a static fixture therefore UNDERSTATES a real app's memory
// by one full-resolution drawable, and every "floor" taken with one is low by that
// much. At 1360x880 on a 2x display a drawable is 2720*1760*4 = 18.26 MiB.
//
// Measured with scripts/measure-footprint.sh, window pinned 1360x880:
//   minimal-one-view.tsx            145.6 MB   IOSurface 37.0M   (2 drawables)
//   this fixture                    183.3 MB   IOSurface 55.5M   (3 drawables)
//   the full ControlRoom app        249.9 MB   IOSurface 55.5M   (3 drawables)
//
// The count is a property of the drawable pool, confirmed by area scaling rather
// than by inference: at half linear size (a quarter of the area) the same pair
// measures 9696K and 14.2M, still exactly 2:3, and both shrink by 3.91x against a
// predicted 4x. A fixed per-component allocation could not do that.
import { useEffect, useState } from "react";
import { render, View } from "../src/index";

function App() {
    const [t, setT] = useState(0);
    useEffect(() => {
        let raf = 0;
        const tick = () => {
            setT((v) => v + 1);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);
    return (
        <View style={{ flex: 1, backgroundColor: "#101010" }}>
            <View
                style={{
                    width: 200,
                    height: 200,
                    marginLeft: 40 + (t % 120),
                    marginTop: 40 + (t % 90),
                    backgroundColor: "#3b82f6",
                }}
            />
        </View>
    );
}

render(<App />, { width: 1360, height: 880 });
