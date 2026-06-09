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

fn incoming_for_request(value: &Value, reply: Sender<Value>) -> Result<Incoming, &'static str> {
    let cmd = value
        .get("$cmd")
        .and_then(Value::as_str)
        .ok_or("missing $cmd")?;
    match cmd {
        "dump" => Ok(Incoming::DebugDump { reply }),
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
        "realmove" => Ok(Incoming::DebugRealMove {
            x: number(value, "x")?,
            y: number(value, "y")?,
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
        "type" => Ok(Incoming::DebugTypeText {
            text: value
                .get("text")
                .and_then(Value::as_str)
                .ok_or("type command needs text")?
                .to_string(),
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
        _ => Err("unknown debug command"),
    }
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
