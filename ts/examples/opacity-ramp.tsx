// Pixel animation conformance fixture: a STATIONARY red box (no movement — so a pixel
// sample isolates opacity, unlike animation-conformance.tsx which also moves `left`)
// whose opacity pulses 0.15↔1 forever. check-opacity-ramp-conformance.mjs samples the
// composited frame over ~2s and asserts the box's pixel actually interpolates — i.e.
// opacity ANIMATES and PAINTS per frame, not just sits in the style tree.
import { useEffect, useRef } from "react";
import { Animated, Easing, View, render } from "../src/index";

function App() {
  const opacity = useRef(new Animated.Value(0.15)).current;
  useEffect(() => {
    const loop = () => {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: false } as never),
        Animated.timing(opacity, { toValue: 0.15, duration: 800, easing: Easing.linear, useNativeDriver: false } as never),
      ]).start(() => loop());
    };
    loop();
  }, [opacity]);
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center" }}>
      <Animated.View nativeID="ramp-box" style={{ width: 360, height: 240, backgroundColor: "#ff0000", opacity }} />
    </View>
  );
}

render(<App />, { width: 520, height: 360 });
