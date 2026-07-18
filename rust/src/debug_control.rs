//! Request/reply debug control socket for the `rngpui` CLI.
//!
//! This is intentionally separate from the app transport. The production runtime is
//! one process: Rust GPUI host + embedded Hermes. The CLI talks to that host over a
//! Unix socket only when `RNGPUI_CONTROL_SOCKET` is set.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use flume::Sender;
use serde_json::{Value, json};

use crate::Incoming;

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) fn start(path: String, tx: Sender<Incoming>) {
    std::thread::Builder::new()
        .name("rngpui-debug-control".into())
        .spawn(move || {
            let _ = std::fs::remove_file(&path);
            let listener = match UnixListener::bind(&path) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("[rngpui control] failed to bind {path}: {error}");
                    return;
                }
            };
            for stream in listener.incoming() {
                let tx = tx.clone();
                match stream {
                    Ok(stream) => handle_stream(stream, &tx),
                    Err(error) => eprintln!("[rngpui control] accept failed: {error}"),
                }
            }
        })
        .expect("spawn rngpui debug control thread");
}

fn handle_stream(mut stream: UnixStream, tx: &Sender<Incoming>) {
    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(error) => {
            write_response(
                &mut stream,
                json!({"ok": false, "error": error.to_string()}),
            );
            return;
        }
    };
    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();
    if let Err(error) = reader.read_line(&mut line) {
        write_response(
            &mut stream,
            json!({"ok": false, "error": error.to_string()}),
        );
        return;
    }
    let request: Value = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(error) => {
            write_response(
                &mut stream,
                json!({"ok": false, "error": error.to_string()}),
            );
            return;
        }
    };
    let req_id = request.get("reqId").and_then(Value::as_u64).unwrap_or(0);
    // animation tracing + frame stats touch only global state — answer inline, without
    // a main-loop round-trip, so traceStop replies instantly even mid-animation.
    if let Some(mut response) = handle_trace_request(&request) {
        if let Value::Object(map) = &mut response {
            map.insert("reqId".into(), json!(req_id));
        }
        write_response(&mut stream, response);
        return;
    }
    if let Some(mut response) = handle_hermes_request(&request) {
        if let Value::Object(map) = &mut response {
            map.insert("reqId".into(), json!(req_id));
        }
        write_response(&mut stream, response);
        return;
    }
    let (reply_tx, reply_rx) = flume::bounded::<Value>(1);
    let incoming = match incoming_for_request(&request, reply_tx) {
        Ok(incoming) => incoming,
        Err(error) => {
            write_response(
                &mut stream,
                json!({"ok": false, "reqId": req_id, "error": error}),
            );
            return;
        }
    };
    if tx.send(incoming).is_err() {
        write_response(
            &mut stream,
            json!({"ok": false, "reqId": req_id, "error": "service loop is closed"}),
        );
        return;
    }
    let mut response = match reply_rx.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(response) => response,
        Err(_) => json!({"ok": false, "error": "debug command timed out"}),
    };
    if let Value::Object(map) = &mut response {
        map.insert("reqId".into(), json!(req_id));
    }
    write_response(&mut stream, response);
}

fn handle_hermes_request(value: &Value) -> Option<Value> {
    let cmd = value.get("$cmd").and_then(Value::as_str)?;
    match cmd {
        "hotEval" | "evalJs" => {
            let code = value.get("code").and_then(Value::as_str).unwrap_or("");
            let url = value
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or(if cmd == "hotEval" {
                    "rngpui-hot-update.js"
                } else {
                    "rngpui-eval.js"
                });
            let hot = cmd == "hotEval";
            match crate::hermes::eval_script_blocking(
                code.to_string(),
                url.to_string(),
                hot,
                RESPONSE_TIMEOUT,
            ) {
                Ok(()) => Some(json!({"ok": true, "type": cmd})),
                Err(error) => Some(json!({"ok": false, "type": cmd, "error": error})),
            }
        }
        _ => None,
    }
}

fn handle_trace_request(value: &Value) -> Option<Value> {
    let cmd = value.get("$cmd").and_then(Value::as_str)?;
    match cmd {
        "frameStats" => Some(crate::anim_trace::frame_stats()),
        "traceStart" => {
            let ids = value.get("ids").and_then(Value::as_array).map(|ids| {
                ids.iter()
                    .filter_map(Value::as_u64)
                    .collect::<std::collections::HashSet<u64>>()
            });
            let keys = string_set(value, "keys");
            let native_keys = string_set(value, "nativeKeys");
            let max_ms = value.get("maxMs").and_then(Value::as_u64).unwrap_or(10_000);
            Some(crate::anim_trace::start(ids, keys, native_keys, max_ms))
        }
        "traceStop" => Some(crate::anim_trace::stop()),
        _ => None,
    }
}

fn string_set(value: &Value, key: &str) -> Option<std::collections::HashSet<String>> {
    value.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn incoming_for_request(value: &Value, reply: Sender<Value>) -> Result<Incoming, &'static str> {
    let cmd = value
        .get("$cmd")
        .and_then(Value::as_str)
        .ok_or("missing $cmd")?;
    match cmd {
        "dump" => Ok(Incoming::DebugDump { reply }),
        "terminalPresentation" => Ok(Incoming::DebugTerminalPresentation {
            id: value
                .get("id")
                .and_then(Value::as_u64)
                .ok_or("missing id")?,
            reply,
        }),
        "tap" => Ok(Incoming::DebugTap {
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        "realtap" => Ok(Incoming::DebugRealTap {
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        "realcontext" => Ok(Incoming::DebugRealContext {
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        "realdown" => Ok(Incoming::DebugRealDown {
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        "realup" => Ok(Incoming::DebugRealUp {
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        "realmove" => Ok(Incoming::DebugRealMove {
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        // a REAL press-drag: MouseDown at (x,y) → `steps` interpolated MouseMoves
        // (pressed_button=Left, so ev.dragging()) to (x2,y2) → MouseUp, dispatched
        // through gpui's actual event loop. exercises the live press-drag sweep
        // (cross-row scrub) an OS drag takes — the synth `dragAt` path bypasses it.
        // `steps` low = a fast flick (big jumps between samples).
        "realdrag" => Ok(Incoming::DebugRealDrag {
            x: number(value, "x")?,
            y: number(value, "y")?,
            x2: number(value, "x2")?,
            y2: number(value, "y2")?,
            steps: number(value, "steps").unwrap_or(8.0) as u32,
            reply,
        }),
        // a REAL press-drag along an arbitrary waypoint PATH: MouseDown at the first
        // point → held MouseMoves (pressed_button=Left) through every subsequent point
        // → MouseUp at the last. unlike `realdrag` (straight line) this can reverse
        // direction (down-then-up scrub) to exercise capture retention across a turn.
        "realdragpath" => {
            let points = value
                .get("points")
                .and_then(Value::as_array)
                .ok_or("realdragpath needs points array")?;
            let mut path = Vec::with_capacity(points.len());
            for p in points {
                let x = p.get("x").and_then(Value::as_f64).ok_or("point.x")? as f32;
                let y = p.get("y").and_then(Value::as_f64).ok_or("point.y")? as f32;
                path.push((x, y));
            }
            if path.len() < 2 {
                return Err("realdragpath needs >=2 points");
            }
            Ok(Incoming::DebugRealDragPath { path, reply })
        }
        "resize" => Ok(Incoming::DebugResize {
            w: number(value, "w")?,
            h: number(value, "h")?,
            reply,
        }),
        "dragAt" => Ok(Incoming::DebugDragAt {
            phase: value
                .get("phase")
                .and_then(Value::as_str)
                .ok_or("dragAt command needs phase")?
                .to_string(),
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        "scrollAt" => Ok(Incoming::DebugScrollAt {
            x: number(value, "x")?,
            y: number(value, "y")?,
            dx: number(value, "dx").unwrap_or(0.0),
            dy: number(value, "dy").unwrap_or(0.0),
            reply,
        }),
        "nativeScrollAt" => Ok(Incoming::DebugNativeScrollAt {
            x: number(value, "x")?,
            y: number(value, "y")?,
            dy: number(value, "dy").unwrap_or(0.0),
            reply,
        }),
        "type" => Ok(Incoming::DebugTypeText {
            text: value
                .get("text")
                .and_then(Value::as_str)
                .ok_or("type command needs text")?
                .to_string(),
            reply,
        }),
        "inputState" => Ok(Incoming::DebugInputState { reply }),
        "imeSetMarked" => Ok(Incoming::DebugImeSetMarked {
            text: value
                .get("text")
                .and_then(Value::as_str)
                .ok_or("imeSetMarked command needs text")?
                .to_string(),
            selected_range: optional_range(value, "selectedRange")?,
            replacement_range: optional_range(value, "replacementRange")?,
            reply,
        }),
        "imeCommit" => Ok(Incoming::DebugImeCommit {
            text: value
                .get("text")
                .and_then(Value::as_str)
                .ok_or("imeCommit command needs text")?
                .to_string(),
            reply,
        }),
        "imeUnmark" => Ok(Incoming::DebugImeUnmark { reply }),
        "axEdit" => Ok(Incoming::DebugAccessibilityEditInput {
            id: value
                .get("id")
                .and_then(Value::as_u64)
                .ok_or("axEdit command needs id")?,
            text: value
                .get("text")
                .and_then(Value::as_str)
                .ok_or("axEdit command needs text")?
                .to_string(),
            insert_at_cursor: value
                .get("insertAtCursor")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            reply,
        }),
        "axFocus" => Ok(Incoming::DebugAccessibilitySetInputFocus {
            id: value
                .get("id")
                .and_then(Value::as_u64)
                .ok_or("axFocus command needs id")?,
            focused: value
                .get("focused")
                .and_then(Value::as_bool)
                .ok_or("axFocus command needs focused")?,
            reply,
        }),
        "key" => Ok(Incoming::DebugKeyPress {
            key: value
                .get("key")
                .and_then(Value::as_str)
                .ok_or("key command needs key")?
                .to_string(),
            reply,
        }),
        "realKey" => Ok(Incoming::DebugRealKey {
            key: value
                .get("key")
                .and_then(Value::as_str)
                .ok_or("realKey command needs key")?
                .to_string(),
            reply,
        }),
        "webviewCopyProof" => Ok(Incoming::DebugWebviewCopyProof {
            x: number(value, "x")?,
            y: number(value, "y")?,
            reply,
        }),
        // dispatch a gpui action by its registered name (e.g. "input::Copy") down the
        // window's focused dispatch path — the same route the app-delegate menu
        // fallthrough takes — and report the pasteboard string afterwards. Lets a
        // probe exercise menu-equivalent behavior (Cmd+C copy of the native text
        // selection) that DebugRealKey can't reach (the OS menu layer isn't present
        // in a synthetic key dispatch).
        "dispatchAction" => Ok(Incoming::DebugDispatchAction {
            name: value
                .get("name")
                .and_then(Value::as_str)
                .ok_or("dispatchAction command needs name")?
                .to_string(),
            reply,
        }),
        _ => Err("unknown debug command"),
    }
}

fn optional_range(
    value: &Value,
    key: &'static str,
) -> Result<Option<std::ops::Range<usize>>, &'static str> {
    let Some(items) = value.get(key) else {
        return Ok(None);
    };
    let items = items.as_array().ok_or("range must be an array")?;
    if items.len() != 2 {
        return Err("range must contain start and end");
    }
    let start = items[0].as_u64().ok_or("range start must be an integer")? as usize;
    let end = items[1].as_u64().ok_or("range end must be an integer")? as usize;
    if end < start {
        return Err("range end must not precede start");
    }
    Ok(Some(start..end))
}

fn number(value: &Value, key: &'static str) -> Result<f32, &'static str> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .map(|value| value as f32)
        .ok_or(key)
}

fn write_response(stream: &mut UnixStream, value: Value) {
    let _ = writeln!(stream, "{value}");
    let _ = stream.flush();
}
