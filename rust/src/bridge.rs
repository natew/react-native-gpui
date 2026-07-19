//! The Rust→JS event channel. In the single-process model the JS runs in an embedded
//! Hermes runtime on the JS thread (see hermes.rs); events are pushed as JSON strings onto
//! a `flume` channel that the JS thread's loop drains and dispatches via
//! `globalThis.__rngpui_onHostEvent`. `runtime.ts` parses these into `BridgeEvent`s and
//! routes them back to React handlers. The JSON shapes are unchanged from the old stdio bridge.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::json;

// last layout we emitted per node id — the render loop runs every frame, so we only
// emit `layout` when a node's measured rect actually changes.
static LAST_LAYOUT: Lazy<Mutex<HashMap<u64, (i32, i32, i32, i32)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
// most recent painted rect per node id. imperative rn `measure()` can subscribe to
// layout after the element has already painted; this cache lets us answer with the
// last real native geometry instead of a stale zero placeholder.
static LAST_FRAME: Lazy<Mutex<HashMap<u64, (f32, f32, f32, f32)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
thread_local! {
    // Layout reporting runs on the GPUI main thread. During one paint, collect all
    // node frames locally and merge them under LAST_FRAME's mutex once at the root.
    // Calls outside paint keep their immediate semantics for lifecycle code/tests.
    static FRAME_LAYOUTS: RefCell<Option<HashMap<u64, (f32, f32, f32, f32)>>> = const { RefCell::new(None) };
}
static LAYOUT_SUBSCRIBERS: Lazy<Mutex<std::collections::HashSet<u64>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

// Total host events emitted to JS. `realtap` (debug_control) snapshots this before/after
// dispatching a REAL gpui pointer event through the window's hitbox hit-test, so it can
// report whether a JS handler actually fired (a real press/click emits one or more of
// these). This is how we detect "the click reached a handler" through gpui's real event
// loop — unlike synth_tap, which invokes handlers straight off the serialized tree.
static EVENTS_EMITTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn events_emitted_count() -> u64 {
    EVENTS_EMITTED.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn emit_line(line: &str) {
    EVENTS_EMITTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // queue for the JS thread's loop, which calls __rngpui_onHostEvent(line) on the JS thread.
    crate::hermes::post("__rngpui_onHostEvent", line.to_string());
}

fn emit_value(v: serde_json::Value) {
    emit_line(&v.to_string());
}

pub fn ready(width: f32, height: f32) {
    emit_value(json!({ "type": "ready", "width": width, "height": height }));
}

pub fn resize(width: f32, height: f32) {
    emit_value(json!({ "type": "resize", "width": width, "height": height }));
}

/// The system light/dark appearance changed (or the initial value emitted when the
/// window opens). JS updates its `Appearance` source-of-truth and re-themes the tree.
pub fn appearance(scheme: &str) {
    emit_value(json!({ "type": "appearance", "colorScheme": scheme }));
}

pub fn command(id: &str) {
    emit_value(json!({ "type": "command", "id": id }));
}

/// A gesture event with no payload (press / pressIn / pressOut / longPress / focus / blur).
pub fn event(id: u64, name: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": name }));
}

pub fn submit(id: u64, value: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "submit", "value": value }));
}

pub fn mouse_event(
    id: u64,
    name: &str,
    page_x: f32,
    page_y: f32,
    location_x: f32,
    location_y: f32,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
) {
    mouse_event_with_button(
        id, name, page_x, page_y, location_x, location_y, shift_key, ctrl_key, alt_key, meta_key,
        0, 1,
    );
}

pub fn mouse_event_with_button(
    id: u64,
    name: &str,
    page_x: f32,
    page_y: f32,
    location_x: f32,
    location_y: f32,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
    button: i32,
    buttons: i32,
) {
    mouse_event_inner(
        id, name, page_x, page_y, location_x, location_y, shift_key, ctrl_key, alt_key, meta_key,
        false, button, buttons,
    );
}

pub fn press_drag_mouse_event(
    id: u64,
    name: &str,
    page_x: f32,
    page_y: f32,
    location_x: f32,
    location_y: f32,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
) {
    mouse_event_inner(
        id, name, page_x, page_y, location_x, location_y, shift_key, ctrl_key, alt_key, meta_key,
        true, 0, 1,
    );
}

fn mouse_event_inner(
    id: u64,
    name: &str,
    page_x: f32,
    page_y: f32,
    location_x: f32,
    location_y: f32,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
    press_drag: bool,
    button: i32,
    buttons: i32,
) {
    let mut event = json!({
        "type": "event",
        "id": id,
        "event": name,
        "button": button,
        "buttons": buttons,
        "pageX": page_x,
        "pageY": page_y,
        "locationX": location_x,
        "locationY": location_y,
        "shiftKey": shift_key,
        "ctrlKey": ctrl_key,
        "altKey": alt_key,
        "metaKey": meta_key
    });
    if press_drag {
        event["pressDrag"] = json!(true);
    }
    emit_value(event);
}

/// A node's native hover/press pseudo state flipped (opt-in via `pseudoEvents: true`).
/// Carries the ABSOLUTE state (`hovered`/`pressed`), so the queue coalescer can drop all
/// but the latest per node losslessly. Routed by the rngpui pseudo registry (ts/src/
/// platform-driver.ts) to the tamagui platform driver — never to a React event handler.
pub fn pseudo(id: u64, hovered: bool, pressed: bool) {
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": "pseudo",
        "hovered": hovered,
        "pressed": pressed
    }));
}

pub fn scroll_event(
    id: u64,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    content_width: f32,
    content_height: f32,
) {
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": "scroll",
        "scrollX": x,
        "scrollY": y,
        "scrollWidth": width,
        "scrollHeight": height,
        "scrollContentWidth": content_width,
        "scrollContentHeight": content_height
    }));
}

pub fn change_text(id: u64, value: &str, is_composing: bool, event_count: u64) {
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": "changeText",
        "value": value,
        "isComposing": is_composing,
        "eventCount": event_count
    }));
}

pub fn change(id: u64, value: &str, is_composing: bool, event_count: u64) {
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": "change",
        "value": value,
        "isComposing": is_composing,
        "eventCount": event_count
    }));
}

pub fn key_press(
    id: u64,
    key: &str,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
    is_composing: bool,
) {
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": "keyPress",
        "key": key,
        "shiftKey": shift_key,
        "ctrlKey": ctrl_key,
        "altKey": alt_key,
        "metaKey": meta_key,
        "isComposing": is_composing
    }));
}

/// A `<WebView>` posted a message from its page (`window.ReactNativeWebView.postMessage`
/// / `window.ipc.postMessage`). Routed to the node's `onMessage` handler.
pub fn webview_message(id: u64, data: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "message", "value": data }));
}

/// Raw text the terminal element produced natively (clipboard paste, dropped
/// file paths) that should be written straight to the PTY. Routed to the
/// `GhosttyTerminal`'s `onInsertText` handler.
pub fn terminal_text(id: u64, text: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "terminalText", "value": text }));
}

/// The terminal element measured its grid from its painted bounds and real font
/// cell metrics. Routed to the `GhosttyTerminal`'s `onMeasureViewport` handler
/// so JS can size the PTY to fit the stage exactly.
pub fn terminal_viewport(id: u64, cols: u16, rows: u16) {
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": "terminalViewport",
        "cols": cols,
        "rows": rows
    }));
}

/// Emit `layout` only if this node's rounded rect changed since last frame.
pub fn layout_if_changed(id: u64, x: f32, y: f32, width: f32, height: f32) {
    remember_layout(id, x, y, width, height);
    let key = (
        x.round() as i32,
        y.round() as i32,
        width.round() as i32,
        height.round() as i32,
    );
    {
        let mut last = LAST_LAYOUT.lock().unwrap();
        if last.get(&id) == Some(&key) {
            return;
        }
        last.insert(id, key);
    }
    emit_layout(id, x, y, width, height);
}

pub fn begin_layout_frame() {
    FRAME_LAYOUTS.with(|layouts| {
        *layouts.borrow_mut() = Some(HashMap::new());
    });
}

pub fn flush_layout_frame() {
    let pending = FRAME_LAYOUTS.with(|layouts| layouts.borrow_mut().take());
    if let Some(pending) = pending
        && !pending.is_empty()
    {
        LAST_FRAME.lock().unwrap().extend(pending);
    }
}

pub fn remember_layout(id: u64, x: f32, y: f32, width: f32, height: f32) {
    let frame = (x, y, width, height);
    let queued = FRAME_LAYOUTS.with(|layouts| {
        let mut layouts = layouts.borrow_mut();
        let Some(layouts) = layouts.as_mut() else {
            return false;
        };
        layouts.insert(id, frame);
        true
    });
    if !queued {
        LAST_FRAME.lock().unwrap().insert(id, frame);
    }
}

pub fn cached_layout(id: u64) -> Option<(f32, f32, f32, f32)> {
    LAST_FRAME.lock().unwrap().get(&id).copied()
}

pub fn emit_layout(id: u64, x: f32, y: f32, width: f32, height: f32) {
    emit_value(json!({
        "type": "event", "id": id, "event": "layout",
        "layout": { "x": x, "y": y, "width": width, "height": height }
    }));
}

/// emit one cached layout event when a node newly subscribes after it has already
/// painted. dynamic subscriptions are how rn imperative measure apis request host
/// geometry, and without this the JS callback can wait forever.
pub fn emit_cached_layout_for_new_subscribers(present: &std::collections::HashSet<u64>) {
    let new_subscribers: Vec<u64> = {
        let mut subscribers = LAYOUT_SUBSCRIBERS.lock().unwrap();
        let next = present
            .iter()
            .filter(|id| !subscribers.contains(id))
            .copied()
            .collect::<Vec<_>>();
        subscribers.retain(|id| present.contains(id));
        subscribers.extend(present.iter().copied());
        next
    };
    if new_subscribers.is_empty() {
        return;
    }
    let frames = LAST_FRAME.lock().unwrap();
    for id in new_subscribers {
        if let Some((x, y, width, height)) = frames.get(&id).copied() {
            emit_layout(id, x, y, width, height);
        }
    }
}

/// Forget layout state for nodes no longer in the tree, so a re-mounted id re-emits.
pub fn retain_layout(present_nodes: &std::collections::HashSet<u64>) {
    LAST_LAYOUT
        .lock()
        .unwrap()
        .retain(|id, _| present_nodes.contains(id));
    LAST_FRAME
        .lock()
        .unwrap()
        .retain(|id, _| present_nodes.contains(id));
    LAYOUT_SUBSCRIBERS
        .lock()
        .unwrap()
        .retain(|id| present_nodes.contains(id));
}
