//! Embedded Hermes JS engine on a dedicated thread. The Rust binary owns the macOS
//! main thread for GPUI/Metal; this module runs React on a JS thread and talks through the
//! `hermes_shim` C ABI. See plans/single-process-hermes.md.
//!
//! Data flow:
//!   JS → Rust:  the bundle's reconciler calls `globalThis.__rngpui_applyTree(json)` every
//!               commit; an ordered tree worker parses it off the Hermes thread and
//!               sends an `Incoming` on the `flume` channel the GPUI applier drains.
//!   Rust → JS:  anything that must call into JS (`bridge::emit_*` events, fetch/ws results)
//!               calls `hermes::post(fn, arg)`, which queues a `JsCall`; this thread's loop
//!               drains the queue and invokes the global JS fn on the JS thread.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use flume::{Receiver, Sender};
use serde_json::json;
use tungstenite::Message;
use tungstenite::stream::MaybeTlsStream;

use crate::Incoming;

const PREAMBLE: &str = include_str!("hermes_preamble.js");

unsafe extern "C" {
    fn rng_hermes_create() -> *mut c_void;
    fn rng_hermes_destroy(rt: *mut c_void);
    fn rng_hermes_eval(
        rt: *mut c_void,
        data: *const u8,
        len: usize,
        url: *const c_char,
        errbuf: *mut c_char,
        errcap: usize,
    ) -> i32;
    fn rng_hermes_install_void_fn(
        rt: *mut c_void,
        name: *const c_char,
        f: extern "C" fn(*mut c_void, *const c_char),
        userdata: *mut c_void,
    );
    fn rng_hermes_install_num_fn(
        rt: *mut c_void,
        name: *const c_char,
        f: extern "C" fn(*mut c_void, *const c_char) -> f64,
        userdata: *mut c_void,
    );
    fn rng_hermes_call1(
        rt: *mut c_void,
        name: *const c_char,
        arg: *const c_char,
        errbuf: *mut c_char,
        errcap: usize,
    ) -> i32;
    fn rng_hermes_drain_microtasks(rt: *mut c_void);
    // Externally-backed shared buffers for the reanimated UI/worklet runtime: one shared
    // memory region exposed as a zero-copy JS ArrayBuffer in multiple runtimes.
    fn rng_hermes_shared_buffer_create(len: usize) -> *mut c_void;
    fn rng_hermes_install_shared_buffer(
        rt: *mut c_void,
        name: *const c_char,
        buffer: *mut c_void,
        len: usize,
    );
}

// ── host → JS call queue ────────────────────────────────────────────────────
// anything on any thread that needs to invoke a JS global posts here; the JS thread's
// loop drains it and calls the function on the (single) JS thread.
struct HostCall {
    func: &'static str,
    arg: String,
    // when this call was enqueued, so the dispatcher can measure how long it waited
    // behind other work on the single JS thread (RNGPUI_PSEUDO_TRACE reads this for
    // hover/press feedback — the latency that grows under load).
    posted_at: Instant,
}
enum JsCall {
    Call(HostCall),
    Eval {
        code: String,
        url: String,
        hot: bool,
        reply: Option<Sender<Result<(), String>>>,
    },
}
static JS_CALLS: OnceLock<Sender<JsCall>> = OnceLock::new();

pub fn post(func: &'static str, arg: String) {
    if let Some(tx) = JS_CALLS.get() {
        let _ = tx.send(JsCall::Call(HostCall {
            func,
            arg,
            posted_at: Instant::now(),
        }));
    }
}

pub fn eval_script_blocking(
    code: String,
    url: String,
    hot: bool,
    timeout: Duration,
) -> Result<(), String> {
    let Some(tx) = JS_CALLS.get() else {
        return Err("JS runtime is not ready".to_string());
    };
    let (reply_tx, reply_rx) = flume::bounded::<Result<(), String>>(1);
    tx.send(JsCall::Eval {
        code,
        url,
        hot,
        reply: Some(reply_tx),
    })
    .map_err(|_| "JS runtime is closed".to_string())?;
    reply_rx
        .recv_timeout(timeout)
        .map_err(|_| "timed out waiting for JS eval".to_string())?
}

// ── reanimated worklet/UI runtime (see plans/off-thread-reanimated.md) ──────
// A SECOND Hermes runtime on its own thread acts as reanimated's real UI
// runtime: dispatched worklets, useAnimatedStyle mappers, and animation driving
// run there, isolated from React-thread stalls. Its own JsCall queue mirrors the
// React runtime's.
static UI_CALLS: OnceLock<Sender<JsCall>> = OnceLock::new();

pub fn post_ui(func: &'static str, arg: String) {
    if let Some(tx) = UI_CALLS.get() {
        let _ = tx.send(JsCall::Call(HostCall {
            func,
            arg,
            posted_at: Instant::now(),
        }));
    }
}

/// One process-wide `performance.now()` epoch shared by both runtimes so event
/// and animation timestamps are comparable across the worklet boundary.
static EPOCH: OnceLock<Instant> = OnceLock::new();
fn epoch() -> Instant {
    *EPOCH.get_or_init(Instant::now)
}

// Shared-value slot region, installed in BOTH runtimes as the zero-copy
// ArrayBuffer global `__rngpui_svSlots`. Float64 layout (must match
// worklet-runtime.ts): [0]=magic, [1]=capacity in floats, [2..3] reserved,
// slots from index 4. React runtime allocates even slot ids, UI runtime odd.
const SV_SLOTS_MAGIC: f64 = 0x504e_9a01_u32 as f64;
const SV_SLOTS_FLOATS: usize = 262_144;

struct SharedPtr(*mut c_void);
unsafe impl Send for SharedPtr {}
unsafe impl Sync for SharedPtr {}
static SV_SLOTS: OnceLock<SharedPtr> = OnceLock::new();

fn sv_slots() -> *mut c_void {
    SV_SLOTS
        .get_or_init(|| unsafe {
            let ptr = rng_hermes_shared_buffer_create(SV_SLOTS_FLOATS * 8);
            let floats = ptr as *mut f64;
            *floats = SV_SLOTS_MAGIC;
            *floats.add(1) = SV_SLOTS_FLOATS as f64;
            SharedPtr(ptr)
        })
        .0
}

fn install_sv_slots(rt: *mut c_void) {
    let name = CString::new("__rngpui_svSlots").unwrap();
    unsafe { rng_hermes_install_shared_buffer(rt, name.as_ptr(), sv_slots(), SV_SLOTS_FLOATS * 8) };
}

// ── timers (driven by the JS thread loop) ───────────────────────────────────
struct Timer {
    due: Instant,
    interval_ms: u64, // 0 = one-shot
}

#[derive(Default)]
struct TimerState {
    map: HashMap<u64, Timer>,
}

impl TimerState {
    fn add(&mut self, id: u64, ms: u64, repeat: bool) {
        self.map.insert(
            id,
            Timer {
                due: Instant::now() + Duration::from_millis(ms),
                interval_ms: if repeat { ms.max(1) } else { 0 },
            },
        );
    }
    fn remove(&mut self, id: u64) {
        self.map.remove(&id);
    }
    fn pop_due(&mut self, now: Instant) -> Vec<u64> {
        let fired: Vec<u64> = self
            .map
            .iter()
            .filter(|(_, t)| t.due <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in &fired {
            if let Some(t) = self.map.get_mut(id) {
                if t.interval_ms == 0 {
                    self.map.remove(id);
                } else {
                    t.due = now + Duration::from_millis(t.interval_ms);
                }
            }
        }
        fired
    }
    fn next_deadline(&self) -> Option<Instant> {
        self.map.values().map(|t| t.due).min()
    }
}

struct JsContext {
    tree_tx: Sender<Incoming>,
    tree_json_tx: Sender<String>,
    start: Instant,
    timers: RefCell<TimerState>,
}

/// preserve React commit order while moving tree parsing and delta reconstruction
/// off the React thread. animation writes keep their direct render-thread lane.
pub(crate) fn start_tree_parser(tree_tx: Sender<Incoming>) -> Sender<String> {
    let (tree_json_tx, tree_json_rx) = flume::unbounded::<String>();
    std::thread::Builder::new()
        .name("hermes-tree-parser".into())
        .spawn(move || {
            while let Ok(json) = tree_json_rx.recv() {
                let incoming = match serde_json::from_str::<serde_json::Value>(&json) {
                    Ok(value) => crate::parse_incoming(&value),
                    Err(error) => {
                        eprintln!("[hermes] applyTree: bad json: {error}");
                        None
                    }
                };
                if let Some(incoming) = incoming
                    && tree_tx.send(incoming).is_err()
                {
                    break;
                }
            }
        })
        .expect("spawn Hermes tree parser thread");
    tree_json_tx
}

fn ctx_ref<'a>(ud: *mut c_void) -> &'a JsContext {
    unsafe { &*(ud as *const JsContext) }
}

fn arg_str(arg: *const c_char) -> String {
    if arg.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(arg) }
        .to_string_lossy()
        .into_owned()
}

// RNGPUI_ANIM_TRACE=1 logs every applyTree / setNodeStyle crossing so the reanimated
// conformance harness can prove the fast path: during a spring, only `setNodeStyle`
// fires (no `applyTree`), i.e. React doesn't re-commit per frame.
static ANIM_TRACE: OnceLock<u8> = OnceLock::new();
fn anim_trace_level() -> u8 {
    *ANIM_TRACE.get_or_init(|| {
        std::env::var("RNGPUI_ANIM_TRACE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    })
}
fn anim_trace() -> bool {
    anim_trace_level() >= 1
}

extern "C" fn host_apply_tree(ud: *mut c_void, arg: *const c_char) {
    let ctx = ctx_ref(ud);
    let s = arg_str(arg);
    if anim_trace() {
        eprintln!("[anim-trace] applyTree bytes={}", s.len());
    }
    let _ = ctx.tree_json_tx.send(s);
}

extern "C" fn host_log(_ud: *mut c_void, arg: *const c_char) {
    eprintln!("{}", arg_str(arg));
}

// reanimated fast path: the TS seam coalesces all `_updateProps` ops within one rAF
// tick and crosses here ONCE per frame. The arg is `[[globalId, {styleKey: value}],
// …]`; parse it into (id, style-object) pairs and hand them to the applier, which
// updates the animated-style overlay + cx.notify() WITHOUT replacing `root`.
extern "C" fn host_set_node_style(ud: *mut c_void, arg: *const c_char) {
    let ctx = ctx_ref(ud);
    let s = arg_str(arg);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&s) else {
        eprintln!("[hermes] setNodeStyle: bad json");
        return;
    };
    let Some(arr) = value.as_array() else {
        return;
    };
    let mut ops: Vec<(u64, serde_json::Map<String, serde_json::Value>)> =
        Vec::with_capacity(arr.len());
    for entry in arr {
        let Some(pair) = entry.as_array() else {
            continue;
        };
        if pair.len() != 2 {
            continue;
        }
        let Some(id) = pair[0].as_u64() else { continue };
        // a style object (animated keys) or null/empty → clear that node's overlay.
        let style = pair[1]
            .as_object()
            .cloned()
            .unwrap_or_else(serde_json::Map::new);
        ops.push((id, style));
    }
    if !ops.is_empty() {
        if anim_trace() {
            eprintln!("[anim-trace] setNodeStyle ops={}", ops.len());
            // level 2: per-op target id + style keys (which node gets which keys —
            // the question every dropped-style/split-identity bug comes down to).
            if anim_trace_level() >= 2 {
                let thread = std::thread::current();
                let from = thread.name().unwrap_or("?");
                for (id, style) in &ops {
                    let keys: Vec<&str> = style.keys().map(|k| k.as_str()).collect();
                    eprintln!(
                        "[anim-trace]   op id={} from={} keys={}",
                        id,
                        from,
                        keys.join(",")
                    );
                }
            }
        }
        let _ = ctx.tree_tx.send(crate::Incoming::SetNodeStyle { ops });
    }
}

// reanimated imperative scrolling crosses directly from either Hermes runtime to
// the native service. it uses the same Incoming::ScrollTo path as ScrollView refs,
// so there is one source of clamping, AppKit driver sync, and onScroll delivery.
extern "C" fn host_scroll_to(ud: *mut c_void, arg: *const c_char) {
    let ctx = ctx_ref(ud);
    let s = arg_str(arg);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&s) else {
        eprintln!("[hermes] scrollTo: bad json");
        return;
    };
    let Some(values) = value.as_array() else {
        return;
    };
    let Some(id) = values.first().and_then(serde_json::Value::as_u64) else {
        return;
    };
    let x = values
        .get(1)
        .and_then(serde_json::Value::as_f64)
        .map(|value| value as f32);
    let y = values
        .get(2)
        .and_then(serde_json::Value::as_f64)
        .map(|value| value as f32);
    let _ = ctx.tree_tx.send(crate::Incoming::ScrollTo { id, x, y });
}

// emitter fast path: a zero-commit (avoidReRenders) Tamagui driver pushes a resolved
// target style + transition straight here instead of going through a React commit. The
// arg is `{globalId, style: {<resolved target>}, transition: <_gpuiTransition descriptor>}`;
// the native tween engine arms a from→target tween, ticked into the same overlay the
// commit-detect path uses.
extern "C" fn host_animate_node_style(ud: *mut c_void, arg: *const c_char) {
    let ctx = ctx_ref(ud);
    let s = arg_str(arg);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&s) else {
        eprintln!("[hermes] animateNodeStyle: bad json");
        return;
    };
    let Some(global_id) = value.get("globalId").and_then(|v| v.as_u64()) else {
        return;
    };
    let style = value
        .get("style")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    let transition = value
        .get("transition")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    if anim_trace() {
        eprintln!(
            "[anim-trace] animateNodeStyle id={} keys={}",
            global_id,
            style.keys().cloned().collect::<Vec<_>>().join(",")
        );
    }
    let _ = ctx.tree_tx.send(crate::Incoming::AnimateNodeStyle {
        global_id,
        style,
        transition,
    });
}

extern "C" fn host_now(ud: *mut c_void, _arg: *const c_char) -> f64 {
    ctx_ref(ud).start.elapsed().as_secs_f64() * 1000.0
}

extern "C" fn host_set_timer(ud: *mut c_void, arg: *const c_char) {
    let ctx = ctx_ref(ud);
    if let Ok((id, ms, repeat)) = serde_json::from_str::<(u64, f64, u8)>(&arg_str(arg)) {
        let ms = if ms.is_finite() && ms > 0.0 {
            ms.round() as u64
        } else {
            0
        };
        ctx.timers.borrow_mut().add(id, ms, repeat != 0);
    }
}

extern "C" fn host_request_frame(_ud: *mut c_void, _arg: *const c_char) {
    crate::frame_clock::request(crate::frame_clock::REACT);
}

extern "C" fn host_request_frame_ui(_ud: *mut c_void, _arg: *const c_char) {
    crate::frame_clock::request(crate::frame_clock::UI);
}

// React→UI bridge: the worklets stub posts a WorkletMessage JSON; it lands on
// the UI runtime as `__rngpui_peerRecv(json)`.
extern "C" fn host_ui_post(_ud: *mut c_void, arg: *const c_char) {
    post_ui("__rngpui_peerRecv", arg_str(arg));
}

// UI→React bridge: runOnJS callbacks + shared-value listener wakeups.
extern "C" fn host_js_post(_ud: *mut c_void, arg: *const c_char) {
    post("__rngpui_peerRecv", arg_str(arg));
}

extern "C" fn host_clear_timer(ud: *mut c_void, arg: *const c_char) {
    let ctx = ctx_ref(ud);
    if let Ok((id,)) = serde_json::from_str::<(u64,)>(&arg_str(arg)) {
        ctx.timers.borrow_mut().remove(id);
    }
}

extern "C" fn host_close(ud: *mut c_void, _arg: *const c_char) {
    let ctx = ctx_ref(ud);
    let _ = ctx.tree_tx.send(Incoming::Quit);
}

extern "C" fn host_exit(_ud: *mut c_void, arg: *const c_char) {
    let code = arg_str(arg).parse::<i32>().unwrap_or(0);
    std::process::exit(code);
}

extern "C" fn host_reload_app(_ud: *mut c_void, _arg: *const c_char) {
    reload_app();
}

/// The one app-reload path: rebuild (when RNGPUI_RELOAD_CMD is set) then exec-replace
/// the process with itself so the new bundle is read from disk. Reached from Cmd+R via
/// the JS host fn above, and from an external `kill -USR2 <pid>` via
/// `install_reload_signal_handler` (the live-reload watcher).
pub(crate) fn reload_app() {
    // dev rebuild-on-reload: the launcher can set RNGPUI_RELOAD_CMD (e.g. a
    // one-shot Hermes bundle build) so a reload picks up source edits without a
    // separate watcher. runs synchronously — the exec below reads the bundle
    // from disk, so it must complete first. a failed rebuild aborts the reload:
    // re-exec'ing stale bytecode would silently mask the build error.
    if let Ok(cmd) = std::env::var("RNGPUI_RELOAD_CMD")
        && !cmd.trim().is_empty()
    {
        eprintln!("[hermes] reload: running RNGPUI_RELOAD_CMD: {cmd}");
        match std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .status()
        {
            Ok(status) if status.success() => {}
            Ok(status) => {
                eprintln!(
                    "[hermes] reload aborted: RNGPUI_RELOAD_CMD exited with {status}; keeping the running bundle"
                );
                return;
            }
            Err(error) => {
                eprintln!("[hermes] reload aborted: RNGPUI_RELOAD_CMD failed to spawn: {error}");
                return;
            }
        }
    }
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[hermes] reload current_exe failed: {error}");
            std::process::exit(1);
        }
    };
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    eprintln!("[hermes] reloading app bundle via exec");
    let error = std::process::Command::new(exe).args(args).exec();
    eprintln!("[hermes] reload exec failed: {error}");
    std::process::exit(1);
}

// external live-reload trigger: `kill -USR2 <pid>` reloads the app through the same
// path as Cmd+R. a signal handler can't rebuild/exec directly (not async-signal-safe),
// so the handler writes one byte to a self-pipe and a dedicated thread does the work.
// installing this also makes a stray SIGUSR2 harmless — the default action kills the
// process.
static RELOAD_PIPE_WRITE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

extern "C" fn on_sigusr2(_sig: libc::c_int) {
    let fd = RELOAD_PIPE_WRITE.load(std::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        unsafe {
            libc::write(fd, b"r".as_ptr() as *const libc::c_void, 1);
        }
    }
}

pub(crate) fn install_reload_signal_handler() {
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        eprintln!("[hermes] reload signal pipe failed; kill -USR2 reload disabled");
        return;
    }
    RELOAD_PIPE_WRITE.store(fds[1], std::sync::atomic::Ordering::Relaxed);
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_sigusr2 as *const () as usize;
        sa.sa_flags = libc::SA_RESTART;
        libc::sigaction(libc::SIGUSR2, &sa, std::ptr::null_mut());
    }
    let read_fd = fds[0];
    std::thread::Builder::new()
        .name("rngpui-reload-signal".into())
        .spawn(move || {
            let mut buf = [0u8; 1];
            loop {
                let n = unsafe { libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, 1) };
                if n == 1 {
                    reload_app();
                } else if n <= 0 {
                    break;
                }
            }
        })
        .expect("spawn reload signal thread");
}

// ── fetch (HTTP via ureq, on a worker thread, result posted back to JS) ──────
#[derive(serde::Deserialize)]
struct FetchReq {
    id: u64,
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    body: Option<String>,
    // binary request body (base64); takes precedence over `body` when present. the JS
    // bridge sets this for byte payloads like the voice POST that a string can't carry.
    #[serde(default, rename = "bodyBase64")]
    body_base64: Option<String>,
}

fn do_fetch(req: FetchReq) -> String {
    let method = req.method.unwrap_or_else(|| "GET".into());
    let mut r = ureq::request(&method, &req.url);
    if let Some(h) = &req.headers {
        for (k, v) in h {
            r = r.set(k, v);
        }
    }
    let resp = if let Some(b64) = &req.body_base64 {
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => r.send_bytes(&bytes),
            Err(e) => {
                return json!({"id": req.id, "ok": false, "status": 0, "error": format!("bad body_base64: {e}")}).to_string();
            }
        }
    } else {
        match req.body {
            Some(b) => r.send_string(&b),
            None => r.call(),
        }
    };
    match resp {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().unwrap_or_default();
            json!({"id": req.id, "ok": status < 400, "status": status, "body": body}).to_string()
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            json!({"id": req.id, "ok": false, "status": code, "body": body}).to_string()
        }
        Err(e) => {
            json!({"id": req.id, "ok": false, "status": 0, "error": e.to_string()}).to_string()
        }
    }
}

extern "C" fn host_fetch(_ud: *mut c_void, arg: *const c_char) {
    let s = arg_str(arg);
    std::thread::spawn(move || {
        let result = match serde_json::from_str::<FetchReq>(&s) {
            Ok(req) => do_fetch(req),
            Err(e) => {
                json!({"id": 0, "ok": false, "status": 0, "error": e.to_string()}).to_string()
            }
        };
        post("__rngpui_fetchDone", result);
    });
}

// ── microphone capture (cpal; see audio.rs) ─────────────────────────────────
extern "C" fn host_audio(_ud: *mut c_void, arg: *const c_char) {
    crate::audio::handle(&arg_str(arg));
}

// ── WebSocket (tungstenite; one worker thread per connection) ────────────────
enum WsCmd {
    Send(String),
    // binary frame: the JS shim base64-encodes the ArrayBuffer/Uint8Array body so the
    // bytes survive the string bridge intact (a plain `String(data)` corrupted them to
    // "[object ArrayBuffer]"). decoded back to bytes here and sent as a real binary frame.
    SendBinary(Vec<u8>),
    Close,
}
static WS_REGISTRY: OnceLock<Mutex<HashMap<u64, Sender<WsCmd>>>> = OnceLock::new();
fn ws_registry() -> &'static Mutex<HashMap<u64, Sender<WsCmd>>> {
    WS_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ws_set_nonblocking(stream: &mut MaybeTlsStream<TcpStream>) {
    match stream {
        MaybeTlsStream::Plain(t) => {
            let _ = t.set_nonblocking(true);
        }
        MaybeTlsStream::Rustls(t) => {
            let _ = t.get_ref().set_nonblocking(true);
        }
        _ => {}
    }
}

/// Build a tungstenite handshake request, optionally injecting
/// `Sec-WebSocket-Protocol` so Hermes-land WebSocket users can pass
/// subprotocols (e.g. `@rocicorp/zero` smuggles its auth token there).
fn build_ws_request(
    url: &str,
    protocols: Option<&[String]>,
) -> Result<tungstenite::handshake::client::Request, tungstenite::Error> {
    use tungstenite::client::IntoClientRequest;
    let mut req = url.into_client_request()?;
    if let Some(list) = protocols
        && !list.is_empty()
        && let Ok(value) = tungstenite::http::HeaderValue::from_str(&list.join(", "))
    {
        req.headers_mut().insert("sec-websocket-protocol", value);
    }
    Ok(req)
}

fn ws_thread(id: u64, url: String, protocols: Option<Vec<String>>, cmd_rx: Receiver<WsCmd>) {
    let connect_result = match build_ws_request(&url, protocols.as_deref()) {
        Ok(req) => tungstenite::connect(req),
        Err(e) => Err(e),
    };
    let mut socket = match connect_result {
        Ok((s, _resp)) => s,
        Err(e) => {
            ws_registry().lock().unwrap().remove(&id);
            post(
                "__rngpui_wsEvent",
                json!({"id": id, "type": "close", "code": 1006, "reason": e.to_string()})
                    .to_string(),
            );
            return;
        }
    };
    ws_set_nonblocking(socket.get_mut());
    post(
        "__rngpui_wsEvent",
        json!({"id": id, "type": "open"}).to_string(),
    );

    loop {
        // drain outgoing commands
        let mut closing = false;
        loop {
            match cmd_rx.try_recv() {
                Ok(WsCmd::Send(t)) => {
                    let _ = socket.send(Message::Text(t));
                }
                Ok(WsCmd::SendBinary(b)) => {
                    let _ = socket.send(Message::Binary(b));
                }
                Ok(WsCmd::Close) => {
                    let _ = socket.close(None);
                    closing = true;
                    break;
                }
                Err(flume::TryRecvError::Empty) => break,
                Err(flume::TryRecvError::Disconnected) => {
                    let _ = socket.close(None);
                    closing = true;
                    break;
                }
            }
        }
        // read incoming
        match socket.read() {
            Ok(Message::Text(t)) => {
                post(
                    "__rngpui_wsEvent",
                    json!({"id": id, "type": "message", "data": t}).to_string(),
                );
            }
            Ok(Message::Binary(b)) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&b);
                post(
                    "__rngpui_wsEvent",
                    json!({"id": id, "type": "message", "binary": true, "data": data}).to_string(),
                );
            }
            Ok(Message::Close(_)) => {
                post(
                    "__rngpui_wsEvent",
                    json!({"id": id, "type": "close", "code": 1000}).to_string(),
                );
                break;
            }
            Ok(_) => {} // ping/pong/frame handled internally
            Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if closing {
                    break;
                }
                std::thread::sleep(Duration::from_millis(8));
            }
            Err(e) => {
                post(
                    "__rngpui_wsEvent",
                    json!({"id": id, "type": "close", "code": 1006, "reason": e.to_string()})
                        .to_string(),
                );
                break;
            }
        }
        if closing {
            post(
                "__rngpui_wsEvent",
                json!({"id": id, "type": "close", "code": 1000}).to_string(),
            );
            break;
        }
    }
    ws_registry().lock().unwrap().remove(&id);
}

#[derive(serde::Deserialize)]
struct WsOpenReq {
    id: u64,
    url: String,
    #[serde(default)]
    protocols: Option<Vec<String>>,
}

extern "C" fn host_ws_open(_ud: *mut c_void, arg: *const c_char) {
    if let Ok(req) = serde_json::from_str::<WsOpenReq>(&arg_str(arg)) {
        let (tx, rx) = flume::unbounded::<WsCmd>();
        ws_registry().lock().unwrap().insert(req.id, tx);
        std::thread::spawn(move || ws_thread(req.id, req.url, req.protocols, rx));
    }
}

extern "C" fn host_ws_send(_ud: *mut c_void, arg: *const c_char) {
    // protocol: [id, data, isBinary]. for a text frame `data` is the string as-is; for a
    // binary frame `data` is base64 (the JS shim encoded the ArrayBuffer/Uint8Array), which
    // we decode back to the original bytes here so a real binary frame goes on the wire.
    if let Ok((id, data, is_binary)) = serde_json::from_str::<(u64, String, bool)>(&arg_str(arg))
        && let Some(tx) = ws_registry().lock().unwrap().get(&id)
    {
        if is_binary {
            match base64::engine::general_purpose::STANDARD.decode(&data) {
                Ok(bytes) => {
                    let _ = tx.send(WsCmd::SendBinary(bytes));
                }
                Err(e) => eprintln!("[hermes] ws send: bad binary base64: {e}"),
            }
        } else {
            let _ = tx.send(WsCmd::Send(data));
        }
    }
}

extern "C" fn host_ws_close(_ud: *mut c_void, arg: *const c_char) {
    if let Ok((id,)) = serde_json::from_str::<(u64,)>(&arg_str(arg))
        && let Some(tx) = ws_registry().lock().unwrap().get(&id)
    {
        let _ = tx.send(WsCmd::Close);
    }
}

#[derive(serde::Deserialize)]
struct PickPathsReq {
    id: u64,
    #[serde(default = "default_true")]
    files: bool,
    #[serde(default)]
    directories: bool,
    #[serde(default)]
    multiple: bool,
    #[serde(default)]
    prompt: Option<String>,
}

fn default_true() -> bool {
    true
}

extern "C" fn host_pick_paths(ud: *mut c_void, arg: *const c_char) {
    let ctx = ctx_ref(ud);
    if let Ok(req) = serde_json::from_str::<PickPathsReq>(&arg_str(arg)) {
        let _ = ctx.tree_tx.send(Incoming::PickPaths {
            id: req.id,
            files: req.files,
            directories: req.directories,
            multiple: req.multiple,
            prompt: req.prompt.unwrap_or_else(|| "Choose file".to_string()),
        });
    }
}

// ── runtime helpers ─────────────────────────────────────────────────────────
fn eval(rt: *mut c_void, data: &[u8], url: &str) -> Result<(), String> {
    let curl = CString::new(url).unwrap_or_default();
    let mut err = [0u8; 2048];
    let rc = unsafe {
        rng_hermes_eval(
            rt,
            data.as_ptr(),
            data.len(),
            curl.as_ptr(),
            err.as_mut_ptr() as *mut c_char,
            err.len(),
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(unsafe { CStr::from_ptr(err.as_ptr() as *const c_char) }
            .to_string_lossy()
            .into_owned())
    }
}

fn call1(rt: *mut c_void, name: &str, arg: &str) {
    let cname = CString::new(name).unwrap_or_default();
    let carg = CString::new(arg).unwrap_or_default();
    let mut err = [0u8; 2048];
    let rc = unsafe {
        rng_hermes_call1(
            rt,
            cname.as_ptr(),
            carg.as_ptr(),
            err.as_mut_ptr() as *mut c_char,
            err.len(),
        )
    };
    if rc != 0 {
        let msg = unsafe { CStr::from_ptr(err.as_ptr() as *const c_char) }
            .to_string_lossy()
            .into_owned();
        eprintln!("[hermes] call {name} failed: {msg}");
    }
}

fn install_void(
    rt: *mut c_void,
    name: &str,
    f: extern "C" fn(*mut c_void, *const c_char),
    ud: *mut c_void,
) {
    let cname = CString::new(name).unwrap();
    unsafe { rng_hermes_install_void_fn(rt, cname.as_ptr(), f, ud) };
}

fn install_num(
    rt: *mut c_void,
    name: &str,
    f: extern "C" fn(*mut c_void, *const c_char) -> f64,
    ud: *mut c_void,
) {
    let cname = CString::new(name).unwrap();
    unsafe { rng_hermes_install_num_fn(rt, cname.as_ptr(), f, ud) };
}

/// The JS Appearance module needs the system scheme BEFORE the first React commit
/// (DynamicColorIOS resolves at serialize time), but the JS thread starts ahead of
/// NSApplication/GPUI init. macOS publishes dark mode as the global user default
/// `AppleInterfaceStyle` ("Dark"; absent = light), readable without an app instance.
/// Best-effort: the window's `observe_window_appearance` event still corrects any
/// mismatch right after open (and the reconciler invalidates its serialize caches
/// on that event, so the correction is complete).
#[cfg(target_os = "macos")]
fn system_color_scheme() -> &'static str {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let defaults: *mut Object = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let key: *mut Object = msg_send![
            class!(NSString),
            stringWithUTF8String: c"AppleInterfaceStyle".as_ptr()
        ];
        let style: *mut Object = msg_send![defaults, stringForKey: key];
        if style.is_null() { "light" } else { "dark" }
    }
}

#[cfg(not(target_os = "macos"))]
fn system_color_scheme() -> &'static str {
    "dark"
}

/// Spawn the JS thread: create the Hermes runtime, install host fns, evaluate the preamble
/// + `bundle`, then run the JS event loop. The first React commit (during bundle eval) sends
///
/// `Incoming::Tree` on `tree_tx`, which `main()` awaits inside `app.run`.
pub fn start(bundle: Vec<u8>, tree_tx: Sender<Incoming>, tree_json_tx: Sender<String>) {
    let (calls_tx, calls_rx) = flume::unbounded::<JsCall>();
    let _ = JS_CALLS.set(calls_tx);
    // rAF rides the display's real vsync: raf.ts arms the clock per frame via
    // __rngpui_requestFrame, the display link posts one fireFrame back per tick.
    crate::frame_clock::register(
        crate::frame_clock::REACT,
        Arc::new(|| post("__rngpui_fireFrame", String::new())),
    );

    std::thread::Builder::new()
        .name("hermes-js".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let thread_start = Instant::now();
            let mark = |label: &str| {
                if std::env::var_os("RNGPUI_STARTUP_TIMING").is_some() {
                    eprintln!(
                        "[hermes startup] {label} +{:.1}ms",
                        thread_start.elapsed().as_secs_f64() * 1000.0
                    );
                }
            };
            let rt = unsafe { rng_hermes_create() };
            if rt.is_null() {
                eprintln!("[hermes] failed to create runtime");
                std::process::exit(1);
            }
            mark("runtime created");
            let ctx = Box::new(JsContext {
                tree_tx,
                tree_json_tx,
                start: epoch(),
                timers: RefCell::new(TimerState::default()),
            });
            let ud = (&*ctx as *const JsContext) as *mut c_void;

            install_void(rt, "__rngpui_applyTree", host_apply_tree, ud);
            install_void(rt, "__rngpui_setNodeStyle", host_set_node_style, ud);
            install_void(rt, "__rngpui_scrollTo", host_scroll_to, ud);
            install_void(
                rt,
                "__rngpui_animateNodeStyle",
                host_animate_node_style,
                ud,
            );
            install_void(rt, "__rngpui_log", host_log, ud);
            install_void(rt, "__rngpui_exit", host_exit, ud);
            install_void(rt, "__rngpui_reloadApp", host_reload_app, ud);
            install_void(rt, "__rngpui_setTimer", host_set_timer, ud);
            install_void(rt, "__rngpui_clearTimer", host_clear_timer, ud);
            install_void(rt, "__rngpui_requestFrame", host_request_frame, ud);
            install_void(rt, "__rngpui_close", host_close, ud);
            install_void(rt, "__rngpui_fetch", host_fetch, ud);
            install_void(rt, "__rngpui_audio", host_audio, ud);
            install_void(rt, "__rngpui_wsOpen", host_ws_open, ud);
            install_void(rt, "__rngpui_wsSend", host_ws_send, ud);
            install_void(rt, "__rngpui_wsClose", host_ws_close, ud);
            install_void(rt, "__rngpui_pickPaths", host_pick_paths, ud);
            install_void(rt, "__rngpui_uiPost", host_ui_post, ud);
            install_num(rt, "__rngpui_now", host_now, ud);
            install_sv_slots(rt);
            mark("host fns installed");

            let env = std::env::vars().collect::<HashMap<String, String>>();
            let env_script = format!(
                "globalThis.process={{env:{},pid:{}}};globalThis.__rngpuiInitialColorScheme=\"{}\";",
                serde_json::to_string(&env).unwrap_or_else(|_| "{}".to_string()),
                std::process::id(),
                system_color_scheme()
            );
            if let Err(e) = eval(rt, env_script.as_bytes(), "host-env.js") {
                eprintln!("[hermes] env eval failed: {e}");
                std::process::exit(1);
            }
            mark("environment installed");

            if let Err(e) = eval(rt, PREAMBLE.as_bytes(), "hermes-preamble.js") {
                eprintln!("[hermes] preamble eval failed: {e}");
                std::process::exit(1);
            }
            mark("preamble evaluated");
            if let Err(e) = eval(rt, &bundle, "app.bundle") {
                eprintln!("[hermes] bundle eval failed: {e}");
                std::process::exit(1);
            }
            unsafe { rng_hermes_drain_microtasks(rt) };
            mark("bundle evaluated");

            run_loop(rt, &ctx, &calls_rx);
            unsafe { rng_hermes_destroy(rt) };
        })
        .expect("spawn hermes-js thread");
}

/// Spawn the reanimated worklet/UI runtime thread (plans/off-thread-reanimated.md):
/// a second Hermes runtime where dispatched worklets, `useAnimatedStyle` mappers,
/// and animation driving run, isolated from React-thread stalls. Its
/// `_updateProps` crosses straight to the render thread as
/// `Incoming::SetNodeStyle` — never touching the React runtime. The ui bundle is
/// app-independent library code (upstream reanimated core + the worklet bridge).
pub fn start_ui(bundle: Vec<u8>, tree_tx: Sender<Incoming>, tree_json_tx: Sender<String>) {
    let (calls_tx, calls_rx) = flume::unbounded::<JsCall>();
    let _ = UI_CALLS.set(calls_tx);
    crate::frame_clock::register(
        crate::frame_clock::UI,
        Arc::new(|| post_ui("__rngpui_fireFrame", String::new())),
    );

    std::thread::Builder::new()
        .name("hermes-ui".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let rt = unsafe { rng_hermes_create() };
            if rt.is_null() {
                eprintln!("[hermes-ui] failed to create runtime");
                std::process::exit(1);
            }
            let ctx = Box::new(JsContext {
                tree_tx,
                tree_json_tx,
                start: epoch(),
                timers: RefCell::new(TimerState::default()),
            });
            let ud = (&*ctx as *const JsContext) as *mut c_void;

            // Deliberately a SUBSET of the React runtime's host fns: no applyTree
            // (no React here), no fetch/ws/pickPaths/exit/reload (app concerns).
            install_void(rt, "__rngpui_setNodeStyle", host_set_node_style, ud);
            install_void(rt, "__rngpui_scrollTo", host_scroll_to, ud);
            install_void(rt, "__rngpui_log", host_log, ud);
            install_void(rt, "__rngpui_setTimer", host_set_timer, ud);
            install_void(rt, "__rngpui_clearTimer", host_clear_timer, ud);
            install_void(rt, "__rngpui_requestFrame", host_request_frame_ui, ud);
            install_void(rt, "__rngpui_jsPost", host_js_post, ud);
            install_num(rt, "__rngpui_now", host_now, ud);
            install_sv_slots(rt);

            let env = std::env::vars().collect::<HashMap<String, String>>();
            let env_script = format!(
                "globalThis.process={{env:{},pid:{}}};",
                serde_json::to_string(&env).unwrap_or_else(|_| "{}".to_string()),
                std::process::id(),
            );
            if let Err(e) = eval(rt, env_script.as_bytes(), "host-env.js") {
                eprintln!("[hermes-ui] env eval failed: {e}");
                std::process::exit(1);
            }
            if let Err(e) = eval(rt, PREAMBLE.as_bytes(), "hermes-preamble.js") {
                eprintln!("[hermes-ui] preamble eval failed: {e}");
                std::process::exit(1);
            }
            if let Err(e) = eval(rt, &bundle, "ui-runtime.bundle") {
                eprintln!("[hermes-ui] ui bundle eval failed: {e}");
                std::process::exit(1);
            }
            unsafe { rng_hermes_drain_microtasks(rt) };

            run_loop(rt, &ctx, &calls_rx);
            unsafe { rng_hermes_destroy(rt) };
        })
        .expect("spawn hermes-ui thread");
}

// High-frequency events that are safe to coalesce to "latest wins" — a window resize (or
// drag/scroll) emits these every repaint frame, and for a big tree that's hundreds of layout
// events per frame. Without coalescing the unbounded queue grows faster than the JS thread
// drains it (each event can trigger a re-render), so it backs up exponentially and freezes.
// Discrete events (press / key / changeText / ready / appearance / fetch / ws) are never
// coalesced — order and every occurrence matter.
#[derive(Hash, PartialEq, Eq, Debug)]
enum CKey {
    Resize,
    Layout(u64),
    Move(u64),
    Scroll(u64),
    // renderer→JS pseudo lane: a fast hover sweep flips many nodes per frame. The payload
    // carries the node's ABSOLUTE hovered/pressed state, so latest-wins per node is lossless.
    Pseudo(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueClass {
    DiscreteInput,
    // native hover/press pseudo-state flips. Interactive PAINT feedback (Tamagui drives
    // hoverStyle/pressStyle off these without a React commit) — it must land promptly, so
    // it's dispatched right after discrete input and AHEAD of async completions. It used to
    // fall in `Other`, i.e. behind every ws/fetch frame, which is why a hover sweep lagged
    // under load (a busy terminal floods `AsyncCompletion`). Coalesced latest-wins per node.
    Pseudo,
    AsyncCompletion,
    Other,
}

fn queue_class(func: &'static str, arg: &str) -> QueueClass {
    if func == "__rngpui_onHostEvent" {
        if is_discrete_input_event(arg) {
            return QueueClass::DiscreteInput;
        }
        if is_pseudo_event(arg) {
            return QueueClass::Pseudo;
        }
        return QueueClass::Other;
    }
    if func == "__rngpui_wsEvent"
        || func == "__rngpui_fetchDone"
        || func == "__rngpui_audioDone"
        || func == "__rngpui_audioLevel"
    {
        QueueClass::AsyncCompletion
    } else {
        QueueClass::Other
    }
}

// cheap substring check, mirroring is_discrete_input_event — pseudo carries absolute
// {hovered,pressed} so latest-wins coalescing is lossless.
fn is_pseudo_event(arg: &str) -> bool {
    arg.contains("\"type\":\"event\"") && arg.contains("\"event\":\"pseudo\"")
}

fn is_discrete_input_event(arg: &str) -> bool {
    if !arg.contains("\"type\":\"event\"") {
        return false;
    }
    arg.contains("\"event\":\"mouseDown\"")
        || arg.contains("\"event\":\"mouseUp\"")
        || arg.contains("\"event\":\"touchStart\"")
        || arg.contains("\"event\":\"touchEnd\"")
        || arg.contains("\"event\":\"startShouldSetResponder\"")
        || arg.contains("\"event\":\"startShouldSetResponderCapture\"")
        || arg.contains("\"event\":\"responderStart\"")
        || arg.contains("\"event\":\"responderGrant\"")
        || arg.contains("\"event\":\"responderRelease\"")
        || arg.contains("\"event\":\"responderEnd\"")
        || arg.contains("\"event\":\"responderTerminate\"")
        || arg.contains("\"event\":\"responderTerminationRequest\"")
        || arg.contains("\"event\":\"pressIn\"")
        || arg.contains("\"event\":\"pressOut\"")
        || arg.contains("\"event\":\"press\"")
        || arg.contains("\"event\":\"click\"")
        || arg.contains("\"event\":\"changeText\"")
        || arg.contains("\"event\":\"keyPress\"")
        || arg.contains("\"event\":\"submit\"")
        || arg.contains("\"event\":\"focus\"")
        || arg.contains("\"event\":\"blur\"")
}

fn coalesce_key(arg: &str) -> Option<CKey> {
    // cheap substring pre-filter so discrete events aren't JSON-parsed in the hot path.
    let resize = arg.contains("\"type\":\"resize\"");
    let layout = arg.contains("\"event\":\"layout\"");
    let mv = arg.contains("\"event\":\"mouseMove\"");
    let scroll = arg.contains("\"event\":\"scroll\"");
    let pseudo = arg.contains("\"event\":\"pseudo\"");
    if !(resize || layout || mv || scroll || pseudo) {
        return None;
    }
    if resize {
        return Some(CKey::Resize);
    }
    let id = serde_json::from_str::<serde_json::Value>(arg)
        .ok()?
        .get("id")?
        .as_u64()?;
    if layout {
        Some(CKey::Layout(id))
    } else if mv {
        Some(CKey::Move(id))
    } else if scroll {
        Some(CKey::Scroll(id))
    } else {
        Some(CKey::Pseudo(id))
    }
}

// flush accumulated UI-event args to JS: a single event goes through __rngpui_onHostEvent,
// multiple go through __rngpui_onHostEventBatch (wrapped in React batchedUpdates → ONE
// re-render for the whole batch, instead of one sync re-render per event).
fn flush_events(rt: *mut c_void, events: &mut Vec<String>) {
    match events.len() {
        0 => {}
        1 => call1(rt, "__rngpui_onHostEvent", &events[0]),
        _ => {
            let mut arr =
                String::with_capacity(events.iter().map(|e| e.len() + 1).sum::<usize>() + 2);
            arr.push('[');
            arr.push_str(&events.join(","));
            arr.push(']');
            call1(rt, "__rngpui_onHostEventBatch", &arr);
        }
    }
    events.clear();
}

/// Dispatch a batch of queued calls: coalesce floods (resize / per-node layout / move /
/// scroll → latest), and group consecutive UI events into one batched React update. Discrete
/// input always runs before async completions so a slow fetch/ws frame cannot jump ahead of
/// a tap that native already accepted; async completions still run before coalesced layout /
/// move / scroll noise.
/// Drop superseded high-frequency events IN PLACE, keeping only the LATEST per `CKey`
/// (resize / per-node layout / move / scroll / pseudo). Survivor order is preserved.
/// Discrete-input / async / unkeyed calls are never dropped. Each coalescable payload
/// carries absolute state, so latest-wins is lossless.
fn coalesce_latest(calls: &mut Vec<HostCall>) {
    if calls.len() < 2 {
        return;
    }
    let mut last: HashMap<CKey, usize> = HashMap::new();
    let mut keep = vec![true; calls.len()];
    for (i, c) in calls.iter().enumerate() {
        if c.func != "__rngpui_onHostEvent" {
            continue;
        }
        if let Some(k) = coalesce_key(&c.arg)
            && let Some(prev) = last.insert(k, i)
        {
            keep[prev] = false;
        }
    }
    let mut i = 0;
    calls.retain(|_| {
        let k = keep[i];
        i += 1;
        k
    });
}

/// Pure dispatch plan: bucket a batch by `QueueClass`, coalesce the floods, and return the
/// calls in final dispatch ORDER. The order encodes interaction priority on the single JS
/// thread — (1) discrete input (taps/keys the user just made; never reordered behind
/// anything), then (2) pseudo feedback (hover/press paint, coalesced latest-per-node; must
/// land promptly), then (3) async completions (ws / fetch / audio — bulk data, where a busy
/// terminal lives), then (4) move/scroll/layout/resize noise (coalesced; observational).
///
/// Promoting (2) above (3) is the fix for the "hover lags under load" symptom: a flood of
/// websocket frames (terminal output) no longer delays the hover highlight. Kept FFI-free so
/// the ordering + coalescing is unit-testable.
fn plan_dispatch(batch: Vec<HostCall>) -> Vec<HostCall> {
    let mut input = Vec::new();
    let mut pseudo = Vec::new();
    let mut async_completions = Vec::new();
    let mut rest = Vec::new();
    for call in batch {
        match queue_class(call.func, &call.arg) {
            QueueClass::DiscreteInput => input.push(call),
            QueueClass::Pseudo => pseudo.push(call),
            QueueClass::AsyncCompletion => async_completions.push(call),
            QueueClass::Other => rest.push(call),
        }
    }
    coalesce_latest(&mut pseudo);
    coalesce_latest(&mut rest);
    let mut plan = input;
    plan.extend(pseudo);
    plan.extend(async_completions);
    plan.extend(rest);
    plan
}

fn dispatch_coalesced(rt: *mut c_void, batch: Vec<HostCall>) {
    // RNGPUI_PSEUDO_TRACE logs how long each hover/press flip waited in the JS-thread queue
    // before dispatch, plus the batch size it landed in. On an idle machine `batch=1` and
    // wait≈0 (pseudo dispatches immediately); under load it lands in a larger batch — the
    // priority order (input → pseudo → async → noise) keeps that wait small instead of it
    // sitting behind a flood of websocket/terminal frames.
    let trace_pseudo = std::env::var_os("RNGPUI_PSEUDO_TRACE").is_some();
    let raw_len = batch.len();
    if raw_len == 1 {
        if trace_pseudo && batch[0].func == "__rngpui_onHostEvent" && is_pseudo_event(&batch[0].arg)
        {
            let waited = batch[0].posted_at.elapsed().as_secs_f64() * 1000.0;
            eprintln!("[pseudo-trace] dispatch wait={waited:.2}ms batch=1");
        }
        call1(rt, batch[0].func, &batch[0].arg);
        return;
    }
    let plan = plan_dispatch(batch);
    if std::env::var_os("RNGPUI_DEBUG_QUEUE").is_some() && raw_len > 16 {
        eprintln!("[hermes] coalesced batch {raw_len} -> {}", plan.len());
    }
    // Execute the plan: consecutive `onHostEvent` calls ride one `__rngpui_onHostEventBatch`
    // (a single React batchedUpdates); a non-event call breaks the run and fires inline.
    let mut events: Vec<String> = Vec::new();
    for c in plan {
        if trace_pseudo && c.func == "__rngpui_onHostEvent" && is_pseudo_event(&c.arg) {
            let waited = c.posted_at.elapsed().as_secs_f64() * 1000.0;
            eprintln!("[pseudo-trace] dispatch wait={waited:.2}ms batch={raw_len}");
        }
        if c.func == "__rngpui_onHostEvent" {
            events.push(c.arg);
        } else {
            flush_events(rt, &mut events);
            call1(rt, c.func, &c.arg);
        }
    }
    flush_events(rt, &mut events);
}

fn dispatch_batch(rt: *mut c_void, batch: Vec<JsCall>) {
    let mut calls = Vec::new();
    for job in batch {
        match job {
            JsCall::Call(call) => calls.push(call),
            JsCall::Eval {
                code,
                url,
                hot,
                reply,
            } => {
                dispatch_coalesced(rt, calls);
                calls = Vec::new();
                let result = if hot {
                    let wrapped = format!(
                        "globalThis.__rngpuiBeginHotUpdate&&globalThis.__rngpuiBeginHotUpdate();\ntry{{\n{}\n}}finally{{globalThis.__rngpuiEndHotUpdate&&globalThis.__rngpuiEndHotUpdate();}}",
                        code
                    );
                    eval(rt, wrapped.as_bytes(), &url)
                } else {
                    eval(rt, code.as_bytes(), &url)
                };
                unsafe { rng_hermes_drain_microtasks(rt) };
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                } else if let Err(error) = result {
                    eprintln!("[hermes] eval failed: {error}");
                }
            }
        }
    }
    dispatch_coalesced(rt, calls);
}

fn run_loop(rt: *mut c_void, ctx: &JsContext, calls_rx: &Receiver<JsCall>) {
    let max_wait = Duration::from_millis(250);
    // RNGPUI_PERF_TRACE=1 logs the wall time the single JS thread spends processing
    // each batch of native calls (React render + reconcile + microtasks). This IS the
    // input-freeze budget: while the thread is in here it cannot accept the next tap.
    // Threshold (ms) is configurable so a flood of cheap frames doesn't spam.
    let perf_trace = std::env::var_os("RNGPUI_PERF_TRACE").is_some();
    let perf_threshold_ms: f64 = std::env::var("RNGPUI_PERF_TRACE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4.0);
    loop {
        // React's initial mount and Promise continuations can be queued as Hermes
        // microtasks even when there are no native calls or timers. Drain before
        // blocking; otherwise startup waits for max_wait before the first tree.
        unsafe { rng_hermes_drain_microtasks(rt) };
        // block until the next call or the next timer deadline (rAF arrives as a
        // fireFrame JsCall posted by the vsync frame_clock, not a timer).
        let wait = ctx
            .timers
            .borrow()
            .next_deadline()
            .map(|d| d.saturating_duration_since(Instant::now()))
            .unwrap_or(max_wait)
            .min(max_wait);
        let first = match calls_rx.recv_timeout(wait) {
            Ok(call) => Some(call),
            Err(flume::RecvTimeoutError::Timeout) => None,
            Err(flume::RecvTimeoutError::Disconnected) => return,
        };
        // collect the whole queued batch (the blocking recv + everything else pending).
        let mut batch: Vec<JsCall> = Vec::new();
        if let Some(c) = first {
            batch.push(c);
        }
        loop {
            match calls_rx.try_recv() {
                Ok(c) => batch.push(c),
                Err(flume::TryRecvError::Empty) => break,
                Err(flume::TryRecvError::Disconnected) => return,
            }
        }
        let trace = if perf_trace {
            Some((batch.len(), perf_batch_label(&batch), Instant::now()))
        } else {
            None
        };
        dispatch_batch(rt, batch);

        // fire due timers, then run microtasks (Promises / React scheduling).
        let due = ctx.timers.borrow_mut().pop_due(Instant::now());
        for id in due {
            call1(rt, "__rngpui_fireTimer", &id.to_string());
        }
        unsafe { rng_hermes_drain_microtasks(rt) };

        if let Some((len, label, started)) = trace {
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            if ms >= perf_threshold_ms {
                eprintln!("[perf] js-block {ms:.1}ms batch={len} {label}");
            }
        }
    }
}

// A short attribution hint for a processed batch: how many calls and what the first
// few were (event name for UI events, else the host fn). Cheap substring sniffing,
// no JSON parse in the hot path.
fn perf_batch_label(batch: &[JsCall]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for call in batch.iter().take(3) {
        match call {
            JsCall::Call(call) if call.func == "__rngpui_onHostEvent" => {
                let ev = call
                    .arg
                    .split("\"event\":\"")
                    .nth(1)
                    .and_then(|s| s.split('"').next())
                    .unwrap_or("event");
                parts.push(ev.to_string());
            }
            JsCall::Call(call) => {
                parts.push(call.func.trim_start_matches("__rngpui_").to_string());
            }
            JsCall::Eval { hot, .. } => {
                parts.push(if *hot { "hotEval" } else { "eval" }.to_string());
            }
        }
    }
    if batch.len() > 3 {
        parts.push(format!("+{}", batch.len() - 3));
    }
    parts.join(",")
}

#[cfg(test)]
mod tests {
    use super::{
        CKey, HostCall, QueueClass, coalesce_key, plan_dispatch, queue_class, start_tree_parser,
    };
    use crate::Incoming;
    use std::time::{Duration, Instant};

    #[test]
    fn tree_parser_preserves_commit_order() {
        let (tree_tx, tree_rx) = flume::unbounded();
        let tree_json_tx = start_tree_parser(tree_tx);

        tree_json_tx
            .send(r#"{"$cmd":"inspector","enabled":false}"#.to_string())
            .unwrap();
        tree_json_tx
            .send(r#"{"$cmd":"inspector","enabled":true}"#.to_string())
            .unwrap();
        assert!(matches!(
            tree_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Incoming::Inspector { enabled: false }
        ));
        assert!(matches!(
            tree_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Incoming::Inspector { enabled: true }
        ));
    }

    fn call(func: &'static str, arg: &str) -> HostCall {
        HostCall {
            func,
            arg: arg.to_string(),
            posted_at: Instant::now(),
        }
    }

    // a short label for a planned call: the host event name, else the host fn.
    fn label(c: &HostCall) -> String {
        if c.func == "__rngpui_onHostEvent" {
            if let Some(i) = c.arg.find("\"event\":\"") {
                let rest = &c.arg[i + 9..];
                if let Some(j) = rest.find('"') {
                    return rest[..j].to_string();
                }
            }
            return "event".to_string();
        }
        c.func.to_string()
    }

    #[test]
    fn pseudo_events_coalesce_latest_wins_per_node() {
        // pseudo carries absolute state, so latest-wins per node is lossless: two flips of
        // the same node share a key (older drops), different nodes get distinct keys.
        let a1 = r#"{"type":"event","id":7,"event":"pseudo","hovered":true,"pressed":false}"#;
        let a2 = r#"{"type":"event","id":7,"event":"pseudo","hovered":false,"pressed":false}"#;
        let b = r#"{"type":"event","id":8,"event":"pseudo","hovered":true,"pressed":false}"#;
        assert_eq!(coalesce_key(a1), Some(CKey::Pseudo(7)));
        assert_eq!(coalesce_key(a1), coalesce_key(a2));
        assert_ne!(coalesce_key(a1), coalesce_key(b));
        // pseudo must not be misclassified as a coalescible mouseMove/scroll/layout key.
        assert_ne!(coalesce_key(a1), Some(CKey::Move(7)));
    }

    #[test]
    fn pseudo_events_are_their_own_priority_class() {
        // hover/press feedback is interactive paint: it gets its own class so it can be
        // dispatched ahead of async completions (a busy terminal must not delay a highlight),
        // while still coalescing latest-per-node. It is NOT discrete input (renderer-driven,
        // not a tap) and NOT plain `Other` (which sits behind async).
        let arg = r#"{"type":"event","id":7,"event":"pseudo","hovered":true,"pressed":false}"#;
        assert_eq!(queue_class("__rngpui_onHostEvent", arg), QueueClass::Pseudo);
    }

    #[test]
    fn pseudo_feedback_dispatches_before_async_completions() {
        // THE regression guard for "hover lags under load": a flood of websocket frames
        // (terminal output) must not be dispatched ahead of a hover flip on the single JS
        // thread. Build a batch where ws frames arrive before the pseudo flip; the plan must
        // still place the pseudo first.
        let batch = vec![
            call("__rngpui_wsEvent", r#"{"event":"message","n":1}"#),
            call("__rngpui_wsEvent", r#"{"event":"message","n":2}"#),
            call("__rngpui_wsEvent", r#"{"event":"message","n":3}"#),
            call(
                "__rngpui_onHostEvent",
                r#"{"type":"event","id":4,"event":"pseudo","hovered":true,"pressed":false}"#,
            ),
        ];
        let plan: Vec<String> = plan_dispatch(batch).iter().map(label).collect();
        assert_eq!(
            plan,
            vec![
                "pseudo",
                "__rngpui_wsEvent",
                "__rngpui_wsEvent",
                "__rngpui_wsEvent"
            ],
            "pseudo must be dispatched before any async completion"
        );
    }

    #[test]
    fn plan_dispatch_orders_by_interaction_priority() {
        // discrete input → pseudo feedback → async completions → motion/layout noise.
        let batch = vec![
            call(
                "__rngpui_onHostEvent",
                r#"{"type":"event","id":1,"event":"mouseMove"}"#,
            ),
            call("__rngpui_wsEvent", r#"{"event":"message"}"#),
            call(
                "__rngpui_onHostEvent",
                r#"{"type":"event","id":2,"event":"pseudo","hovered":true,"pressed":false}"#,
            ),
            call(
                "__rngpui_onHostEvent",
                r#"{"type":"event","id":3,"event":"mouseDown"}"#,
            ),
        ];
        let plan: Vec<String> = plan_dispatch(batch).iter().map(label).collect();
        assert_eq!(
            plan,
            vec!["mouseDown", "pseudo", "__rngpui_wsEvent", "mouseMove"]
        );
    }

    #[test]
    fn plan_dispatch_coalesces_pseudo_latest_per_node() {
        // two flips of node 5 collapse to the latest; node 6 survives independently; the
        // coalescing happens within the (promoted) pseudo lane, ahead of the ws frame.
        let batch = vec![
            call(
                "__rngpui_onHostEvent",
                r#"{"type":"event","id":5,"event":"pseudo","hovered":true,"pressed":false}"#,
            ),
            call(
                "__rngpui_onHostEvent",
                r#"{"type":"event","id":5,"event":"pseudo","hovered":false,"pressed":false}"#,
            ),
            call(
                "__rngpui_onHostEvent",
                r#"{"type":"event","id":6,"event":"pseudo","hovered":true,"pressed":false}"#,
            ),
            call("__rngpui_wsEvent", r#"{"event":"message"}"#),
        ];
        let plan = plan_dispatch(batch);
        let labels: Vec<String> = plan.iter().map(label).collect();
        assert_eq!(labels, vec!["pseudo", "pseudo", "__rngpui_wsEvent"]);
        // the surviving node-5 flip is the LATEST (hovered:false), not the stale first one.
        assert!(plan[0].arg.contains("\"id\":5"));
        assert!(plan[0].arg.contains("\"hovered\":false"));
        assert!(plan[1].arg.contains("\"id\":6"));
    }

    #[test]
    fn discrete_tap_events_outrank_async_completions() {
        for event in [
            "mouseDown",
            "touchStart",
            "responderGrant",
            "responderRelease",
            "pressOut",
            "press",
        ] {
            let arg = format!(r#"{{"type":"event","id":7,"event":"{event}"}}"#);
            assert_eq!(
                queue_class("__rngpui_onHostEvent", &arg),
                QueueClass::DiscreteInput,
                "{event}"
            );
        }
        assert_eq!(
            queue_class("__rngpui_fetchDone", r#"{"id":1,"ok":true}"#),
            QueueClass::AsyncCompletion
        );
        assert_eq!(
            queue_class("__rngpui_wsEvent", r#"{"id":1,"event":"message"}"#),
            QueueClass::AsyncCompletion
        );
    }

    #[test]
    fn coalescible_motion_and_layout_do_not_outrank_async() {
        for event in ["layout", "mouseMove", "scroll"] {
            let arg = format!(r#"{{"type":"event","id":7,"event":"{event}"}}"#);
            assert_eq!(
                queue_class("__rngpui_onHostEvent", &arg),
                QueueClass::Other,
                "{event}"
            );
        }
    }
}
