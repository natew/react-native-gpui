//! The Rust→JS event channel. Everything the service tells the JS side travels as
//! one newline-delimited JSON object per line on stdout. `runtime.ts` parses these
//! into `BridgeEvent`s and routes them back to React handlers.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::json;

// serialize stdout writes so concurrent emits (render thread + input subscriptions)
// never interleave a half-written line.
static OUT: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

// last layout we emitted per node id — the render loop runs every frame, so we only
// emit `layout` when a node's measured rect actually changes.
static LAST_LAYOUT: Lazy<Mutex<HashMap<u64, (i32, i32, i32, i32)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
// most recent painted rect per node id. imperative rn `measure()` can subscribe to
// layout after the element has already painted; this cache lets us answer with the
// last real native geometry instead of a stale zero placeholder.
static LAST_FRAME: Lazy<Mutex<HashMap<u64, (f32, f32, f32, f32)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static LAYOUT_SUBSCRIBERS: Lazy<Mutex<std::collections::HashSet<u64>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

pub fn emit_line(line: &str) {
    let _g = OUT.lock().unwrap();
    let mut so = std::io::stdout().lock();
    let _ = so.write_all(line.as_bytes());
    let _ = so.write_all(b"\n");
    let _ = so.flush();
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

pub fn command(id: &str) {
    emit_value(json!({ "type": "command", "id": id }));
}

/// A gesture event with no payload (press / pressIn / pressOut / longPress / focus / blur / submit).
pub fn event(id: u64, name: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": name }));
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
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": name,
        "pageX": page_x,
        "pageY": page_y,
        "locationX": location_x,
        "locationY": location_y,
        "shiftKey": shift_key,
        "ctrlKey": ctrl_key,
        "altKey": alt_key,
        "metaKey": meta_key
    }));
}

pub fn change_text(id: u64, value: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "changeText", "value": value }));
}

pub fn change(id: u64, value: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "change", "value": value }));
}

pub fn key_press(
    id: u64,
    key: &str,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
) {
    emit_value(json!({
        "type": "event",
        "id": id,
        "event": "keyPress",
        "key": key,
        "shiftKey": shift_key,
        "ctrlKey": ctrl_key,
        "altKey": alt_key,
        "metaKey": meta_key
    }));
}

/// A `<WebView>` posted a message from its page (`window.ReactNativeWebView.postMessage`
/// / `window.ipc.postMessage`). Routed to the node's `onMessage` handler.
pub fn webview_message(id: u64, data: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "message", "value": data }));
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

pub fn remember_layout(id: u64, x: f32, y: f32, width: f32, height: f32) {
    LAST_FRAME.lock().unwrap().insert(id, (x, y, width, height));
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
