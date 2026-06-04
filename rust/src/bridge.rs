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

/// A gesture event with no payload (press / pressIn / pressOut / longPress / focus / blur / submit).
pub fn event(id: u64, name: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": name }));
}

pub fn change_text(id: u64, value: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "changeText", "value": value }));
}

/// A `<WebView>` posted a message from its page (`window.ReactNativeWebView.postMessage`
/// / `window.ipc.postMessage`). Routed to the node's `onMessage` handler.
pub fn webview_message(id: u64, data: &str) {
    emit_value(json!({ "type": "event", "id": id, "event": "message", "value": data }));
}

/// Emit `layout` only if this node's rounded rect changed since last frame.
pub fn layout_if_changed(id: u64, x: f32, y: f32, width: f32, height: f32) {
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
    emit_value(json!({
        "type": "event", "id": id, "event": "layout",
        "layout": { "x": x, "y": y, "width": width, "height": height }
    }));
}

/// Forget layout state for nodes no longer in the tree, so a re-mounted id re-emits.
pub fn retain_layout(present: &std::collections::HashSet<u64>) {
    LAST_LAYOUT
        .lock()
        .unwrap()
        .retain(|id, _| present.contains(id));
}
