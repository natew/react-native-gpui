//! Per-frame animation value tracing for the `rngpui` CLI.
//!
//! Answers "what values did this animation actually drive, frame by frame?" without
//! screenshots: `traceStart` arms a session, every off-thread reanimated style write
//! (`anim_overlay::apply_ops`) and every NativeLayout tween tick records a timestamped
//! sample, and `traceStop` returns the whole series plus painted-frame stats so the
//! CLI can prove cadence (dropped frames), curve shape (spring overshoot vs linear),
//! and endpoints — in one round-trip.
//!
//! The painted-frame counter is always on (one atomic increment + one bounded ring
//! push per draw); sample recording is gated on a relaxed `AtomicBool` so the
//! non-tracing hot path costs a single load.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{Value, json};

static FRAMES_PAINTED: AtomicU64 = AtomicU64::new(0);
static TRACING: AtomicBool = AtomicBool::new(false);

// (frame index, instant) of recent draws, for fps / frame-gap stats. 720 entries
// covers ~6s at 120Hz.
static PAINT_TIMES: Lazy<Mutex<VecDeque<(u64, Instant)>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(720)));

static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));

const MAX_SAMPLES: usize = 50_000;

struct Session {
    t0: Instant,
    deadline: Instant,
    start_frame: u64,
    /// node ids whose overlay writes are recorded; None = all nodes
    ids: Option<HashSet<u64>>,
    /// style keys recorded; None = all keys
    keys: Option<HashSet<String>>,
    /// NativeLayout keys recorded; None = all keys
    native_keys: Option<HashSet<String>>,
    samples: Vec<Value>,
    truncated: bool,
}

/// Called once per `ServiceApp::render` (one gpui draw).
pub fn on_frame_painted() -> u64 {
    let frame = FRAMES_PAINTED.fetch_add(1, Ordering::Relaxed) + 1;
    let mut times = PAINT_TIMES.lock().unwrap();
    if times.len() >= 720 {
        times.pop_front();
    }
    times.push_back((frame, Instant::now()));
    frame
}

#[inline]
pub fn tracing() -> bool {
    TRACING.load(Ordering::Relaxed)
}

/// Record one node's animated style write (the off-thread reanimated / tamagui-driver
/// path). Called from `anim_overlay::apply_ops` for each (id, style) op.
pub fn record_style_op(id: u64, style: &serde_json::Map<String, Value>) {
    if !tracing() {
        return;
    }
    let mut guard = SESSION.lock().unwrap();
    let Some(session) = guard.as_mut() else {
        return;
    };
    if !session.accepting() {
        return;
    }
    if let Some(ids) = &session.ids {
        if !ids.contains(&id) {
            return;
        }
    }
    let t = session.t0.elapsed().as_secs_f64() * 1000.0;
    let frame = FRAMES_PAINTED.load(Ordering::Relaxed);
    for (k, v) in style {
        if let Some(keys) = &session.keys {
            if !keys.contains(k.as_str()) {
                continue;
            }
        }
        session.push(json!({ "t": t, "f": frame, "id": id, "k": k, "v": v }));
    }
}

/// Record one NativeLayout tween tick (the flowb FLIP path). Called from the
/// interpolation in `elements::div::native_layout_override`.
pub fn record_native_layout(
    key: &str,
    width: Option<f32>,
    height: Option<f32>,
    x: Option<f32>,
    y: Option<f32>,
) {
    if !tracing() {
        return;
    }
    let mut guard = SESSION.lock().unwrap();
    let Some(session) = guard.as_mut() else {
        return;
    };
    if !session.accepting() {
        return;
    }
    if let Some(keys) = &session.native_keys {
        if !keys.contains(key) {
            return;
        }
    }
    let t = session.t0.elapsed().as_secs_f64() * 1000.0;
    let frame = FRAMES_PAINTED.load(Ordering::Relaxed);
    let mut v = serde_json::Map::new();
    if let Some(w) = width {
        v.insert("width".into(), json!(w));
    }
    if let Some(h) = height {
        v.insert("height".into(), json!(h));
    }
    if let Some(x) = x {
        v.insert("x".into(), json!(x));
    }
    if let Some(y) = y {
        v.insert("y".into(), json!(y));
    }
    session.push(json!({ "t": t, "f": frame, "nativeKey": key, "k": "frame", "v": v }));
}

impl Session {
    fn accepting(&self) -> bool {
        Instant::now() <= self.deadline && self.samples.len() < MAX_SAMPLES
    }

    fn push(&mut self, sample: Value) {
        if self.samples.len() >= MAX_SAMPLES {
            self.truncated = true;
            return;
        }
        self.samples.push(sample);
    }
}

/// Arm a trace session. Replaces any existing one.
pub fn start(
    ids: Option<HashSet<u64>>,
    keys: Option<HashSet<String>>,
    native_keys: Option<HashSet<String>>,
    max_ms: u64,
) -> Value {
    let now = Instant::now();
    let start_frame = FRAMES_PAINTED.load(Ordering::Relaxed);
    *SESSION.lock().unwrap() = Some(Session {
        t0: now,
        deadline: now + Duration::from_millis(max_ms.clamp(50, 60_000)),
        start_frame,
        ids,
        keys,
        native_keys,
        samples: Vec::new(),
        truncated: false,
    });
    TRACING.store(true, Ordering::Relaxed);
    json!({ "ok": true, "startFrame": start_frame })
}

/// Disarm and return everything the session captured.
pub fn stop() -> Value {
    TRACING.store(false, Ordering::Relaxed);
    let Some(session) = SESSION.lock().unwrap().take() else {
        return json!({ "ok": false, "error": "no trace session active" });
    };
    let end_frame = FRAMES_PAINTED.load(Ordering::Relaxed);
    let duration_ms = session.t0.elapsed().as_secs_f64() * 1000.0;
    // per-draw gaps inside the trace window, from the paint ring
    let times = PAINT_TIMES.lock().unwrap();
    let mut gaps_ms: Vec<f64> = Vec::new();
    let mut prev: Option<Instant> = None;
    for (frame, at) in times.iter() {
        if *frame <= session.start_frame {
            continue;
        }
        if let Some(p) = prev {
            gaps_ms.push(at.duration_since(p).as_secs_f64() * 1000.0);
        }
        prev = Some(*at);
    }
    json!({
        "ok": true,
        "durationMs": duration_ms,
        "framesPainted": end_frame - session.start_frame,
        "paintGapsMs": gaps_ms,
        "truncated": session.truncated,
        "samples": session.samples,
    })
}

/// Always-available paint cadence snapshot.
pub fn frame_stats() -> Value {
    let frames = FRAMES_PAINTED.load(Ordering::Relaxed);
    let times = PAINT_TIMES.lock().unwrap();
    let now = Instant::now();
    let last_1s = times
        .iter()
        .filter(|(_, at)| now.duration_since(*at) <= Duration::from_secs(1))
        .count();
    let last_frame_ago_ms = times
        .back()
        .map(|(_, at)| now.duration_since(*at).as_secs_f64() * 1000.0);
    let mut avg_gap_ms = None;
    if times.len() >= 2 {
        let recent: Vec<&(u64, Instant)> = times.iter().rev().take(120).collect();
        if recent.len() >= 2 {
            let span = recent[0].1.duration_since(recent[recent.len() - 1].1);
            avg_gap_ms = Some(span.as_secs_f64() * 1000.0 / (recent.len() - 1) as f64);
        }
    }
    json!({
        "ok": true,
        "framesPainted": frames,
        "fpsLast1s": last_1s,
        "lastFrameAgoMs": last_frame_ago_ms,
        "avgFrameGapMs": avg_gap_ms,
    })
}
