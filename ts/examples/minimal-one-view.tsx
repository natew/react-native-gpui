// The memory FLOOR probe: the smallest app this engine can render, one View.
//
// The parity doc claims a one-View app already measures 129 MB against a 130 MB
// ceiling, which if true makes the memory goal arithmetically impossible and turns
// it into a conversation rather than an engineering task. That claim predates
// several changes and had no committed fixture, so this is the fixture.
//
// The window is 1360x880 deliberately: IOSurface is allocated per full-resolution
// backing store, ~19.1 MB at this size on a 2x display, so a floor measured at a
// different window size is not comparable to the doc's number or to the app's.
import { render, View } from "../src/index";

function App() {
    return <View style={{ flex: 1, backgroundColor: "#101010" }} />;
}

render(<App />, { width: 1360, height: 880 });
