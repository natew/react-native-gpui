//! Native consumer of the declarative `_gpuiTransition` descriptor — the CSS-transition
//! analog for the gpui renderer. Where the reanimated overlay (`anim_overlay`) is driven
//! per-frame from JS, this drives itself: a Tamagui "gpui animation driver" emits a
//! `_gpuiTransition` block on the committed style declaring WHICH keys should animate and
//! HOW (duration/easing/delay). On each real Tree commit we diff the committed animatable
//! values against the previous commit and, for any key that changed AND is named by the
//! transition, arm a tween from old→new. A timer driver in `service.rs` ticks the tweens
//! into the SAME overlay (`anim_overlay::apply_ops`) the reanimated path uses, so paint /
//! layout merge them identically — no paint or div changes needed.
//!
//! Pruning mirrors the overlay discipline: a Tree commit drops tween + prev-value state
//! for ids no longer present so a removed node can't keep ticking.
//!
//! Future wire-shape idea (not a dep — just a refactor candidate): the `gpui-animation`
//! crate (chi11321) models transitions as `transition_when(state, …)` with a `Transition`
//! trait + priority resolution. If we ever expose more transition intent from JS, a
//! `(predicate, priority, easing)` triple is a nicer wire shape than the current
//! per-(node,key) `Tween` records — JS would declare "when state X, animate these keys at
//! priority N with easing E," and the resolver picks the winning transition per key
//! instead of us tracking individual tweens. Not adopting the crate (its API targets
//! hand-authored gpui element trees, which we don't have — our tree is reconciled from
//! React), just noting the API model is worth stealing if this driver gets a v2.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use gpui::{Hsla, Rgba};
use once_cell::sync::Lazy;
use serde_json::{Map, Value};

use crate::elements::{ease_out_cubic, lerp};
use crate::style::{TransformOp, parse_css_color, parse_transform_ops};

/// the style keys this driver knows how to interpolate. `keys: ["all"]` expands to
/// exactly those present in the committed style.
const ANIMATABLE_KEYS: &[&str] = &[
    "opacity",
    "backgroundColor",
    "color",
    "borderColor",
    "width",
    "height",
    "borderRadius",
    "transform",
];

fn is_color_key(k: &str) -> bool {
    matches!(k, "backgroundColor" | "color" | "borderColor")
}

struct Tween {
    from_json: Value,
    to_json: Value,
    start: Instant,
    delay: Duration,
    duration: Duration,
    easing: String,
}

/// One node's endlessly repeating keyframe animation — the CSS `@keyframes … infinite`
/// analog, where a `Tween` is the CSS `transition` analog. Declared once on the committed
/// style and then driven entirely here: a spinner, a pulse, or a blinking caret costs the
/// JS side nothing per frame, because nothing about it changes on the JS side per frame.
///
/// `offset` is where in the cycle this node starts, 0..1, which is how a grid of cells
/// running one shared animation reads as a wave. It is CSS's negative `animation-delay`
/// expressed as the fraction it actually means.
struct KeyframeLoop {
    /// `(position 0..1, value)` pairs, sorted by position. Values are raw style JSON, so
    /// this interpolates colors and transforms through the same code a tween uses.
    stops: Vec<(f32, Value)>,
    duration: Duration,
    offset: f32,
    easing: String,
    start: Instant,
}

// (node, key) → in-flight tween, and last-committed animatable values per node so the next
// commit can diff against them.
static GPUI_TWEENS: Lazy<Mutex<HashMap<(u64, String), Tween>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PREV_APPLIED: Lazy<Mutex<HashMap<u64, Map<String, Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
// (node, key) → its repeating keyframe animation. Separate from the tween map because a
// loop never finishes: it lives until the node leaves the tree or stops declaring it.
static GPUI_LOOPS: Lazy<Mutex<HashMap<(u64, String), KeyframeLoop>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// CSS timing functions. The four named curves are their real CSS definitions rather
/// than polynomial lookalikes, and `cubic-bezier(x1, y1, x2, y2)` is accepted verbatim,
/// so a design can name any curve it wants instead of picking the nearest of four.
///
/// The named curves used to be cubic approximations: "ease" in particular was aliased to
/// ease-in-out, which is symmetric, while the real "ease" is not. An unknown name still
/// falls back to ease-out.
pub fn ease(name: &str, t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    match name {
        "linear" => t,
        "ease" => CubicBezier::new(0.25, 0.1, 0.25, 1.0).eval(t),
        "ease-in" => CubicBezier::new(0.42, 0.0, 1.0, 1.0).eval(t),
        "ease-out" => CubicBezier::new(0.0, 0.0, 0.58, 1.0).eval(t),
        "ease-in-out" => CubicBezier::new(0.42, 0.0, 0.58, 1.0).eval(t),
        other => match parse_cubic_bezier(other) {
            Some(curve) => curve.eval(t),
            None => ease_out_cubic(t),
        },
    }
}

/// `cubic-bezier(x1, y1, x2, y2)`. Whitespace is free-form; anything else is None so the
/// caller can fall back.
fn parse_cubic_bezier(name: &str) -> Option<CubicBezier> {
    let inner = name.trim().strip_prefix("cubic-bezier")?.trim();
    let inner = inner.strip_prefix('(')?.strip_suffix(')')?;
    let mut parts = inner.split(',').map(|n| n.trim().parse::<f32>());
    let x1 = parts.next()?.ok()?;
    let y1 = parts.next()?.ok()?;
    let x2 = parts.next()?.ok()?;
    let y2 = parts.next()?.ok()?;
    if parts.next().is_some() {
        return None;
    }
    if ![x1, y1, x2, y2].iter().all(|n| n.is_finite()) {
        return None;
    }
    Some(CubicBezier::new(x1, y1, x2, y2))
}

/// A CSS cubic-bezier timing function: endpoints fixed at (0,0) and (1,1), the two control
/// points given. Solving y for a given x is the standard UnitBezier approach — Newton
/// iteration, falling back to bisection when the derivative is too flat to trust.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CubicBezier {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

impl CubicBezier {
    pub const fn new(x1: f32, y1: f32, x2: f32, y2: f32) -> Self {
        Self { x1, y1, x2, y2 }
    }

    pub fn eval(&self, x: f32) -> f32 {
        if x <= 0.0 {
            return 0.0;
        }
        if x >= 1.0 {
            return 1.0;
        }
        bezier_axis(self.solve_t(x), self.y1, self.y2)
    }

    fn solve_t(&self, x: f32) -> f32 {
        let mut t = x;
        for _ in 0..8 {
            let error = bezier_axis(t, self.x1, self.x2) - x;
            if error.abs() < 1e-6 {
                return t;
            }
            let slope = bezier_axis_slope(t, self.x1, self.x2);
            if slope.abs() < 1e-6 {
                break;
            }
            t -= error / slope;
        }
        // Newton stalled (a flat or non-monotonic x curve); bisect, which always converges.
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        let mut t = x.clamp(0.0, 1.0);
        for _ in 0..24 {
            let value = bezier_axis(t, self.x1, self.x2);
            if (value - x).abs() < 1e-6 {
                return t;
            }
            if value > x {
                hi = t;
            } else {
                lo = t;
            }
            t = (lo + hi) * 0.5;
        }
        t
    }
}

/// One axis of a unit cubic bezier with endpoints 0 and 1.
fn bezier_axis(t: f32, a: f32, b: f32) -> f32 {
    let u = 1.0 - t;
    3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t
}

fn bezier_axis_slope(t: f32, a: f32, b: f32) -> f32 {
    let u = 1.0 - t;
    3.0 * u * u * a + 6.0 * u * t * (b - a) + 3.0 * t * t * (1.0 - b)
}

/// lerp two colors in RGB space (not HSL — avoids hue wraparound between, say, red↔green).
pub fn lerp_color(from: Hsla, to: Hsla, t: f32) -> Hsla {
    let a: Rgba = from.into();
    let b: Rgba = to.into();
    Hsla::from(Rgba {
        r: lerp(a.r, b.r, t),
        g: lerp(a.g, b.g, t),
        b: lerp(a.b, b.b, t),
        a: lerp(a.a, b.a, t),
    })
}

/// serialize an `Hsla` to an `rgba(r,g,b,a)` string that `parse_css_color` round-trips.
fn color_to_rgba_string(c: Hsla) -> String {
    let rgba: Rgba = c.into();
    format!(
        "rgba({},{},{},{})",
        (rgba.r * 255.0).round() as i32,
        (rgba.g * 255.0).round() as i32,
        (rgba.b * 255.0).round() as i32,
        rgba.a
    )
}

fn op_kind(op: &TransformOp) -> u8 {
    match op {
        TransformOp::TranslateX(_) => 0,
        TransformOp::TranslateY(_) => 1,
        TransformOp::Scale(_) => 2,
        TransformOp::ScaleX(_) => 3,
        TransformOp::ScaleY(_) => 4,
        TransformOp::Rotate(_) => 5,
    }
}

fn op_scalar(op: &TransformOp) -> f32 {
    match *op {
        TransformOp::TranslateX(n)
        | TransformOp::TranslateY(n)
        | TransformOp::Scale(n)
        | TransformOp::ScaleX(n)
        | TransformOp::ScaleY(n)
        | TransformOp::Rotate(n) => n,
    }
}

fn op_identity(op: &TransformOp) -> f32 {
    // scale ops rest at 1, translate/rotate at 0 — the value an absent side lerps toward.
    match op {
        TransformOp::Scale(_) | TransformOp::ScaleX(_) | TransformOp::ScaleY(_) => 1.0,
        _ => 0.0,
    }
}

fn op_with_scalar(op: &TransformOp, n: f32) -> TransformOp {
    match op {
        TransformOp::TranslateX(_) => TransformOp::TranslateX(n),
        TransformOp::TranslateY(_) => TransformOp::TranslateY(n),
        TransformOp::Scale(_) => TransformOp::Scale(n),
        TransformOp::ScaleX(_) => TransformOp::ScaleX(n),
        TransformOp::ScaleY(_) => TransformOp::ScaleY(n),
        TransformOp::Rotate(_) => TransformOp::Rotate(n),
    }
}

/// lerp two transform op lists, matching by op kind. an op present on only one side lerps
/// against its identity value (scale→1, translate/rotate→0). the union preserves order
/// from `from` then appends any kinds only in `to`.
pub fn lerp_transform_ops(from: &[TransformOp], to: &[TransformOp], t: f32) -> Vec<TransformOp> {
    let mut out = Vec::new();
    for f in from {
        let template = *f;
        let to_val = to
            .iter()
            .find(|o| op_kind(o) == op_kind(f))
            .map(op_scalar)
            .unwrap_or_else(|| op_identity(f));
        out.push(op_with_scalar(&template, lerp(op_scalar(f), to_val, t)));
    }
    for o in to {
        if from.iter().any(|f| op_kind(f) == op_kind(o)) {
            continue;
        }
        // only in `to`: animate from its identity up to the target.
        out.push(op_with_scalar(o, lerp(op_identity(o), op_scalar(o), t)));
    }
    out
}

/// re-serialize transform ops to the `[{translateY: n}, {scale: n}, ...]` JSON array that
/// `overlay_transform` re-parses via `parse_transform_ops` (radians for rotate).
fn transform_ops_to_json(ops: &[TransformOp]) -> Value {
    let arr: Vec<Value> = ops
        .iter()
        .map(|op| {
            let (k, n) = match *op {
                TransformOp::TranslateX(n) => ("translateX", n),
                TransformOp::TranslateY(n) => ("translateY", n),
                TransformOp::Scale(n) => ("scale", n),
                TransformOp::ScaleX(n) => ("scaleX", n),
                TransformOp::ScaleY(n) => ("scaleY", n),
                TransformOp::Rotate(n) => ("rotate", n),
            };
            let mut m = Map::new();
            m.insert(k.to_string(), Value::from(n as f64));
            Value::Object(m)
        })
        .collect();
    Value::Array(arr)
}

struct KeyConfig {
    duration: Duration,
    delay: Duration,
    easing: String,
}

/// parse a per-key config from `byKey[key] ?? default`. `type: "spring"` is approximated
/// as ease-out for v1 (see module note). a missing duration defaults to 200ms.
fn key_config(bykey: Option<&Value>, default: Option<&Value>, delay: Duration) -> KeyConfig {
    let cfg = bykey.or(default).and_then(|v| v.as_object());
    let duration_ms = cfg
        .and_then(|m| m.get("duration"))
        .and_then(|v| v.as_f64())
        .unwrap_or(200.0)
        .max(0.0);
    let is_spring = cfg.and_then(|m| m.get("type")).and_then(|v| v.as_str()) == Some("spring");
    let easing = if is_spring {
        // v1: approximate spring as ease-out (damping/stiffness/mass ignored for now).
        "ease-out".to_string()
    } else {
        cfg.and_then(|m| m.get("easing"))
            .and_then(|v| v.as_str())
            .unwrap_or("ease-out")
            .to_string()
    };
    KeyConfig {
        duration: Duration::from_secs_f64(duration_ms / 1000.0),
        delay,
        easing,
    }
}

/// expand a `_gpuiTransition.keys` array against the committed style: `["all"]` → every
/// animatable key actually present in the style.
fn expand_keys(keys: &[Value], style_json: &Map<String, Value>) -> Vec<String> {
    let wants_all = keys.iter().any(|k| k.as_str() == Some("all"));
    if wants_all {
        return ANIMATABLE_KEYS
            .iter()
            .filter(|k| style_json.contains_key(**k))
            .map(|k| k.to_string())
            .collect();
    }
    keys.iter()
        .filter_map(|k| k.as_str())
        .filter(|k| ANIMATABLE_KEYS.contains(k))
        .map(String::from)
        .collect()
}

/// the parsed `_gpuiTransition` descriptor (shape shared by `note_commit`'s committed
/// style and the emitter path's `animate_to`). borrows from the descriptor map.
struct TransitionDesc<'a> {
    keys: Vec<String>,
    bykey: Option<&'a Map<String, Value>>,
    default: Option<&'a Value>,
    delay: Duration,
}

/// parse a `_gpuiTransition` descriptor against the target style. `keys` is expanded
/// (`["all"]` → animatable keys present in `target`). shared by both arming paths so the
/// descriptor shape lives in one place.
fn parse_transition<'a>(
    transition: &'a Map<String, Value>,
    target: &Map<String, Value>,
) -> TransitionDesc<'a> {
    let keys = transition
        .get("keys")
        .and_then(|v| v.as_array())
        .map(|a| expand_keys(a, target))
        .unwrap_or_default();
    let bykey = transition.get("byKey").and_then(|v| v.as_object());
    let default = transition.get("default");
    let delay = Duration::from_secs_f64(
        transition
            .get("delay")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .max(0.0)
            / 1000.0,
    );
    TransitionDesc {
        keys,
        bykey,
        default,
        delay,
    }
}

/// the current interpolated value of an in-flight tween at `now` — used so an interrupted
/// animation re-arms from where it actually is, not from its original `from`. before the
/// delay this is the `from` value; after the duration it's the exact target.
fn tween_current_value(tw: &Tween, key: &str, now: Instant) -> Option<Value> {
    let elapsed = now.saturating_duration_since(tw.start);
    if elapsed < tw.delay {
        return Some(tw.from_json.clone());
    }
    let raw = (elapsed - tw.delay).as_secs_f32() / tw.duration.as_secs_f32();
    if raw >= 1.0 {
        return Some(tw.to_json.clone());
    }
    interpolate(&tw.from_json, &tw.to_json, key, ease(&tw.easing, raw))
}

/// Read a `_gpuiLoop` descriptor off a committed style and register (or drop) the node's
/// repeating animations. Returns true if the node has any loop running afterwards.
///
/// The descriptor is one entry per animated key:
///
/// ```json
/// "_gpuiLoop": [
///   { "key": "opacity", "duration": 750, "offset": 0.333,
///     "stops": [[0, 1], [0.45, 0.1], [0.92, 0.1], [1, 1]] }
/// ]
/// ```
///
/// A commit that declares the SAME animation leaves it running from its original start.
/// That is what lets an ordinary re-render happen underneath a spinner without the
/// spinner jumping back to the top of its cycle, which is the whole reason this is
/// declarative rather than a per-frame style write.
fn note_loops(global_id: u64, style_json: &Map<String, Value>) -> bool {
    let declared = style_json.get("_gpuiLoop").and_then(|v| v.as_array());
    let mut loops = GPUI_LOOPS.lock().unwrap();

    let Some(declared) = declared else {
        // a node that stopped declaring loops (or never did) keeps none. cheap: the map is
        // empty in the common case, so this is a hash lookup miss per committed node.
        if loops.is_empty() {
            return false;
        }
        loops.retain(|(id, _), _| *id != global_id);
        return false;
    };

    let now = Instant::now();
    let mut live_keys: HashSet<String> = HashSet::new();
    let mut any = false;

    for entry in declared {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(key) = entry.get("key").and_then(|v| v.as_str()) else {
            continue;
        };
        if !ANIMATABLE_KEYS.contains(&key) {
            continue;
        }
        let Some(stops) = entry.get("stops").and_then(|v| v.as_array()) else {
            continue;
        };
        let mut parsed: Vec<(f32, Value)> = stops
            .iter()
            .filter_map(|stop| {
                let pair = stop.as_array()?;
                let at = pair.first()?.as_f64()? as f32;
                Some((at.clamp(0.0, 1.0), pair.get(1)?.clone()))
            })
            .collect();
        if parsed.len() < 2 {
            continue;
        }
        parsed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let duration_ms = entry
            .get("duration")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .max(1.0);
        let offset = entry
            .get("offset")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .rem_euclid(1.0) as f32;
        let easing = entry
            .get("easing")
            .and_then(|v| v.as_str())
            .unwrap_or("linear")
            .to_string();
        let next = KeyframeLoop {
            stops: parsed,
            duration: Duration::from_secs_f64(duration_ms / 1000.0),
            offset,
            easing,
            start: now,
        };
        live_keys.insert(key.to_string());
        any = true;
        match loops.entry((global_id, key.to_string())) {
            std::collections::hash_map::Entry::Occupied(mut slot) => {
                let existing = slot.get();
                let unchanged = existing.duration == next.duration
                    && existing.offset == next.offset
                    && existing.easing == next.easing
                    && existing.stops == next.stops;
                if !unchanged {
                    slot.insert(next);
                }
            }
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(next);
            }
        }
    }

    // a key this node used to animate but no longer declares stops running.
    loops.retain(|(id, key), _| *id != global_id || live_keys.contains(key));
    any
}

/// the value a loop holds at `now`: the phase, walked into its stop list and interpolated
/// between the bracketing pair.
fn loop_value(lp: &KeyframeLoop, key: &str, now: Instant) -> Option<Value> {
    let elapsed = now.saturating_duration_since(lp.start).as_secs_f32();
    let phase = (elapsed / lp.duration.as_secs_f32() + lp.offset).rem_euclid(1.0);
    let mut lower = &lp.stops[0];
    let mut upper = lp.stops.last().unwrap();
    for pair in lp.stops.windows(2) {
        if phase >= pair[0].0 && phase <= pair[1].0 {
            lower = &pair[0];
            upper = &pair[1];
            break;
        }
    }
    let span = upper.0 - lower.0;
    if span <= 0.0 {
        return Some(lower.1.clone());
    }
    interpolate(
        &lower.1,
        &upper.1,
        key,
        ease(&lp.easing, (phase - lower.0) / span),
    )
}

/// advance every repeating animation one tick, writing into the same overlay the tweens
/// use so paint merges them identically.
pub fn tick_loops() {
    let now = Instant::now();
    let mut ops: HashMap<u64, Map<String, Value>> = HashMap::new();
    {
        let loops = GPUI_LOOPS.lock().unwrap();
        for ((id, key), lp) in loops.iter() {
            if let Some(value) = loop_value(lp, key, now) {
                ops.entry(*id).or_default().insert(key.clone(), value);
            }
        }
    }
    if !ops.is_empty() {
        crate::anim_overlay::apply_ops(ops.into_iter().collect());
    }
}

pub fn loops_active() -> bool {
    !GPUI_LOOPS.lock().unwrap().is_empty()
}

/// detection entry, called once per committed node. diffs the committed animatable values
/// against the prior commit and arms a tween for each changed key the transition names.
/// returns true if any tween was armed. with no `_gpuiTransition` it just refreshes the
/// stored prev values (so a later transition diffs against the right baseline).
pub fn note_commit(global_id: u64, style_json: &Map<String, Value>) -> bool {
    let looping = note_loops(global_id, style_json);
    let transition = style_json
        .get("_gpuiTransition")
        .and_then(|v| v.as_object());

    let Some(transition) = transition else {
        // no transition on this node: it can never arm a tween, so do NOT track its prev
        // values. tracking every node would lock + write PREV_APPLIED for the whole tree
        // on every commit — a commit-hot-path cost paid by nodes that never animate. a
        // node only starts transitioning from the first commit that carries
        // `_gpuiTransition`; not animating on that opt-in commit also matches CSS (a
        // property doesn't transition on the same commit that first sets `transition`).
        return looping;
    };

    let TransitionDesc {
        keys,
        bykey,
        default,
        delay,
    } = parse_transition(transition, style_json);

    let mut prev = PREV_APPLIED.lock().unwrap();
    let prev_entry = prev.entry(global_id).or_default();
    let mut tweens = GPUI_TWEENS.lock().unwrap();
    let mut armed = false;

    for key in &keys {
        let Some(to_val) = style_json.get(key) else {
            continue;
        };
        let from_val = prev_entry.get(key).cloned();
        let changed = from_val.as_ref() != Some(to_val);
        // no prior value = first sight of this node; nothing to animate from, just record.
        if let Some(from_val) = from_val.filter(|_| changed) {
            let cfg = key_config(bykey.and_then(|m| m.get(key)), default, delay);
            if cfg.duration.is_zero() {
                // duration 0 → let the committed value snap normally; clear any tween.
                tweens.remove(&(global_id, key.clone()));
            } else {
                tweens.insert(
                    (global_id, key.clone()),
                    Tween {
                        from_json: from_val,
                        to_json: to_val.clone(),
                        start: Instant::now(),
                        delay: cfg.delay,
                        duration: cfg.duration,
                        easing: cfg.easing,
                    },
                );
                armed = true;
            }
        }
    }

    // refresh prev for ALL animatable keys (not just animated ones) so future diffs are
    // against the true last commit.
    for k in ANIMATABLE_KEYS {
        if let Some(v) = style_json.get(*k) {
            prev_entry.insert(k.to_string(), v.clone());
        } else {
            prev_entry.remove(*k);
        }
    }

    armed || looping
}

/// emitter entry — the analog of `note_commit` for a zero-commit (avoidReRenders) driver
/// that pushes a resolved target style + transition straight to native instead of going
/// through a React commit. `target` is the COMPLETE merged target style (not a delta);
/// `transition` is the same `_gpuiTransition` descriptor shape. for each named key we arm
/// a tween from the node's current value (a live tween's interpolated value if one is in
/// flight, else `PREV_APPLIED`) toward the target. with no prior value the target is just
/// recorded and snapped (nothing to animate from).
pub fn animate_to(global_id: u64, target: &Map<String, Value>, transition: &Map<String, Value>) {
    let TransitionDesc {
        keys,
        bykey,
        default,
        delay,
    } = parse_transition(transition, target);

    let now = Instant::now();
    // keys that must be written to the overlay NOW (instant / snap). unlike the commit
    // path, the emitter has NO React commit behind it — the overlay is the only way the
    // new value reaches paint, so an instant key (duration 0, or no prior to animate
    // from) must be written here or it would never show.
    let mut snap: Map<String, Value> = Map::new();
    {
        let mut prev = PREV_APPLIED.lock().unwrap();
        let prev_entry = prev.entry(global_id).or_default();
        let mut tweens = GPUI_TWEENS.lock().unwrap();

        for key in &keys {
            let Some(to_val) = target.get(key) else {
                continue;
            };
            let map_key = (global_id, key.clone());
            // `from` = a live tween's CURRENT interpolated value (so an interrupted hover
            // animates smoothly from where it is), else the last applied value.
            let from_val = tweens
                .get(&map_key)
                .and_then(|tw| tween_current_value(tw, key, now))
                .or_else(|| prev_entry.get(key).cloned());
            prev_entry.insert(key.clone(), to_val.clone());

            let Some(from_val) = from_val else {
                // no prior value = nothing to animate from; snap straight to the target.
                snap.insert(key.clone(), to_val.clone());
                continue;
            };
            if from_val == *to_val {
                continue;
            }
            let cfg = key_config(bykey.and_then(|m| m.get(key)), default, delay);
            if cfg.duration.is_zero() {
                // duration 0 → snap to target now; drop any in-flight tween for this key.
                tweens.remove(&map_key);
                snap.insert(key.clone(), to_val.clone());
                continue;
            }
            // idempotent: an identical in-flight tween (same from/to/config) shouldn't restart.
            if let Some(existing) = tweens.get(&map_key)
                && existing.from_json == from_val
                && existing.to_json == *to_val
                && existing.duration == cfg.duration
                && existing.delay == cfg.delay
                && existing.easing == cfg.easing
            {
                continue;
            }
            tweens.insert(
                map_key,
                Tween {
                    from_json: from_val,
                    to_json: to_val.clone(),
                    start: now,
                    delay: cfg.delay,
                    duration: cfg.duration,
                    easing: cfg.easing,
                },
            );
        }
    }

    // write instant/snap values straight to the overlay (locks released above first).
    if !snap.is_empty() {
        crate::anim_overlay::apply_ops(vec![(global_id, snap)]);
    }
}

fn interpolate(from: &Value, to: &Value, key: &str, p: f32) -> Option<Value> {
    if is_color_key(key) {
        let a = parse_css_color(from.as_str()?)?;
        let b = parse_css_color(to.as_str()?)?;
        return Some(Value::String(color_to_rgba_string(lerp_color(a, b, p))));
    }
    if key == "transform" {
        let a = parse_transform_ops(from).unwrap_or_default();
        let b = parse_transform_ops(to).unwrap_or_default();
        return Some(transform_ops_to_json(&lerp_transform_ops(&a, &b, p)));
    }
    // numeric keys (opacity/width/height/borderRadius).
    let a = from.as_f64()? as f32;
    let b = to.as_f64()? as f32;
    Some(Value::from(lerp(a, b, p) as f64))
}

/// advance every in-flight tween one tick, writing the interpolated values into the
/// overlay. a finished tween writes its exact target (settle) then is removed. returns true
/// if any tween is still active.
pub fn tick_tweens() -> bool {
    let now = Instant::now();
    let mut ops: HashMap<u64, Map<String, Value>> = HashMap::new();
    let mut done: Vec<(u64, String)> = Vec::new();

    {
        let tweens = GPUI_TWEENS.lock().unwrap();
        for ((id, key), tw) in tweens.iter() {
            let elapsed = now.saturating_duration_since(tw.start);
            let (p, finished) = if elapsed < tw.delay {
                (0.0, false)
            } else {
                let raw = (elapsed - tw.delay).as_secs_f32() / tw.duration.as_secs_f32();
                if raw >= 1.0 {
                    (1.0, true)
                } else {
                    (ease(&tw.easing, raw), false)
                }
            };
            // at settle, write the exact target so float drift can't leave it short.
            let value = if finished {
                Some(tw.to_json.clone())
            } else {
                interpolate(&tw.from_json, &tw.to_json, key, p)
            };
            if let Some(value) = value {
                ops.entry(*id).or_default().insert(key.clone(), value);
            }
            if finished {
                done.push((*id, key.clone()));
            }
        }
    }

    if !ops.is_empty() {
        crate::anim_overlay::apply_ops(ops.into_iter().collect());
    }

    if !done.is_empty() {
        let mut tweens = GPUI_TWEENS.lock().unwrap();
        for k in done {
            tweens.remove(&k);
        }
    }

    tweens_active()
}

/// whether any TWEEN is mid-flight. distinct from `tweens_active` because a tween is
/// what needs the driver running at full frame rate: it is a transition a hand started
/// and is watching land.
pub fn tweens_in_flight() -> bool {
    !GPUI_TWEENS.lock().unwrap().is_empty()
}

/// whether the driver loop has anything to tick. a repeating animation counts: unlike a
/// tween it never settles, so the driver stays armed for as long as one is on screen.
pub fn tweens_active() -> bool {
    tweens_in_flight() || loops_active()
}

/// How often a repeating animation is worth advancing. A spinner is a few pixels of
/// opacity, and pinning the whole window to the tween driver's frame rate to move it was
/// paying a full repaint every 8ms for something nobody can see move that fast. The
/// reference app runs its entire loader family off one 30fps tick for the same reason.
pub const LOOP_TICK: Duration = Duration::from_millis(33);

/// drop tween + loop + prev-value state for ids no longer in the live tree.
pub fn retain(present: &HashSet<u64>) {
    GPUI_TWEENS
        .lock()
        .unwrap()
        .retain(|(id, _), _| present.contains(id));
    GPUI_LOOPS
        .lock()
        .unwrap()
        .retain(|(id, _), _| present.contains(id));
    PREV_APPLIED
        .lock()
        .unwrap()
        .retain(|id, _| present.contains(id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // these tests mutate the process-global tween/prev maps; serialize them.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn reset() {
        GPUI_TWEENS.lock().unwrap().clear();
        PREV_APPLIED.lock().unwrap().clear();
        GPUI_LOOPS.lock().unwrap().clear();
    }

    fn pulse_style(offset: f64) -> Map<String, Value> {
        json!({
            "opacity": 1.0,
            "_gpuiLoop": [{
                "key": "opacity",
                "duration": 1000,
                "offset": offset,
                "stops": [[0.0, 1.0], [0.5, 0.0], [1.0, 1.0]],
            }],
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn value_at(id: u64, key: &str, phase_secs: f32) -> f32 {
        let loops = GPUI_LOOPS.lock().unwrap();
        let lp = loops.get(&(id, key.to_string())).expect("loop registered");
        let now = lp.start + Duration::from_secs_f32(phase_secs);
        loop_value(lp, key, now).unwrap().as_f64().unwrap() as f32
    }

    #[test]
    fn a_declared_loop_runs_forever_and_reads_its_stops() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        assert!(note_commit(700, &pulse_style(0.0)));
        // a loop never settles, so the driver stays armed with no tween in flight.
        assert!(GPUI_TWEENS.lock().unwrap().is_empty());
        assert!(loops_active());
        // 1000ms period, 1 → 0 → 1: quarter of the way down is halfway to zero.
        assert!((value_at(700, "opacity", 0.0) - 1.0).abs() < 1e-3);
        assert!((value_at(700, "opacity", 0.25) - 0.5).abs() < 1e-3);
        assert!((value_at(700, "opacity", 0.5) - 0.0).abs() < 1e-3);
        assert!((value_at(700, "opacity", 0.75) - 0.5).abs() < 1e-3);
        // and it wraps rather than clamping at the end of the list.
        assert!((value_at(700, "opacity", 2.25) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn an_offset_starts_the_cycle_further_along() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        note_commit(701, &pulse_style(0.5));
        // half a period of head start: at t=0 it is already at the trough.
        assert!((value_at(701, "opacity", 0.0) - 0.0).abs() < 1e-3);
        assert!((value_at(701, "opacity", 0.5) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn re_declaring_the_same_loop_does_not_restart_it() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        note_commit(702, &pulse_style(0.0));
        let first = GPUI_LOOPS
            .lock()
            .unwrap()
            .get(&(702, "opacity".to_string()))
            .unwrap()
            .start;
        std::thread::sleep(Duration::from_millis(5));
        // an unrelated re-render commits the same style again. a spinner must not snap
        // back to the top of its cycle every time React touches the row it sits in.
        note_commit(702, &pulse_style(0.0));
        let second = GPUI_LOOPS
            .lock()
            .unwrap()
            .get(&(702, "opacity".to_string()))
            .unwrap()
            .start;
        assert_eq!(first, second);
        // but a DIFFERENT animation replaces it.
        note_commit(702, &pulse_style(0.25));
        assert_ne!(
            GPUI_LOOPS
                .lock()
                .unwrap()
                .get(&(702, "opacity".to_string()))
                .unwrap()
                .start,
            second
        );
    }

    #[test]
    fn a_loop_stops_when_the_node_stops_declaring_it_or_leaves() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        note_commit(703, &pulse_style(0.0));
        assert!(loops_active());
        // the node re-commits without the descriptor (the session stopped working).
        note_commit(703, json!({"opacity": 1.0}).as_object().unwrap());
        assert!(!loops_active());
        // and an unmounted node's loop is pruned with the rest of its state.
        note_commit(704, &pulse_style(0.0));
        assert!(loops_active());
        retain(&HashSet::new());
        assert!(!loops_active());
    }

    #[test]
    fn ticking_a_loop_writes_into_the_shared_overlay() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        // half a period of head start, so the very first tick lands at the trough and the
        // overlay's value is distinguishable from the committed 1.0.
        note_commit(705, &pulse_style(0.5));
        tick_loops();
        let merged =
            crate::anim_overlay::merged_element_style(705, &json!({"opacity": 1.0})).unwrap();
        assert!(
            merged.opacity.unwrap() < 0.05,
            "overlay should carry the loop's value, got {:?}",
            merged.opacity
        );
        crate::anim_overlay::retain(&HashSet::new());
    }

    #[test]
    fn ease_endpoints_are_zero_and_one() {
        for name in [
            "linear",
            "ease",
            "ease-in",
            "ease-out",
            "ease-in-out",
            "cubic-bezier(0.16, 1, 0.3, 1)",
            "wat",
        ] {
            assert!(ease(name, 0.0).abs() < 1e-6, "{name} t=0");
            assert!((ease(name, 1.0) - 1.0).abs() < 1e-6, "{name} t=1");
        }
    }

    #[test]
    fn named_curves_match_their_css_definitions() {
        // the four CSS names ARE cubic-beziers; spelling one out must give the same
        // number as naming it.
        for (name, spelled) in [
            ("ease", "cubic-bezier(0.25, 0.1, 0.25, 1)"),
            ("ease-in", "cubic-bezier(0.42, 0, 1, 1)"),
            ("ease-out", "cubic-bezier(0, 0, 0.58, 1)"),
            ("ease-in-out", "cubic-bezier(0.42, 0, 0.58, 1)"),
        ] {
            for step in 1..10 {
                let t = step as f32 / 10.0;
                let a = ease(name, t);
                let b = ease(spelled, t);
                assert!((a - b).abs() < 1e-4, "{name} @ {t}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn expo_out_front_loads_its_travel() {
        // the reference entrance curve: most of the distance is covered early, which is
        // what separates it from a symmetric ease.
        let quarter = ease("cubic-bezier(0.16, 1, 0.3, 1)", 0.25);
        assert!(quarter > 0.6, "expo-out at t=0.25 was {quarter}");
        let symmetric = ease("ease-in-out", 0.25);
        assert!(symmetric < 0.2, "ease-in-out at t=0.25 was {symmetric}");
    }

    #[test]
    fn a_committed_curve_reaches_the_interpolated_value() {
        let _g = TEST_LOCK.lock().unwrap();
        reset();
        // the whole path a design actually uses: a named easing on the JS transition
        // descriptor, through key_config, into the value the renderer paints.
        let transition = json!({
            "keys": ["opacity"],
            "byKey": {},
            "default": {"duration": 400, "easing": "cubic-bezier(0.16, 1, 0.3, 1)"},
            "delay": 0,
        });
        note_commit(
            42,
            json!({"opacity": 0.0, "_gpuiTransition": transition})
                .as_object()
                .unwrap(),
        );
        assert!(note_commit(
            42,
            json!({"opacity": 1.0, "_gpuiTransition": transition})
                .as_object()
                .unwrap()
        ));

        let tweens = GPUI_TWEENS.lock().unwrap();
        let tween = tweens.get(&(42, "opacity".to_string())).expect("armed");
        // a quarter of the way through a 400ms expo-out, most of the travel is done.
        let quarter = tween.start + Duration::from_millis(100);
        let value = tween_current_value(tween, "opacity", quarter)
            .and_then(|v| v.as_f64())
            .expect("a value mid-flight");
        assert!(value > 0.6 && value < 1.0, "expo-out at 25% was {value}");
    }

    #[test]
    fn a_malformed_curve_falls_back_instead_of_panicking() {
        for name in [
            "cubic-bezier(1, 2, 3)",
            "cubic-bezier(a, b, c, d)",
            "cubic-bezier(0, 0, 1, 1, 1)",
            "cubic-bezier",
        ] {
            let mid = ease(name, 0.5);
            assert!((0.0..=1.0).contains(&mid), "{name} gave {mid}");
        }
    }

    #[test]
    fn lerp_color_midpoint_is_halfway_in_rgb() {
        let black = parse_css_color("rgb(0,0,0)").unwrap();
        let white = parse_css_color("rgb(255,255,255)").unwrap();
        let mid: Rgba = lerp_color(black, white, 0.5).into();
        assert!((mid.r - 0.5).abs() < 0.01);
        assert!((mid.g - 0.5).abs() < 0.01);
        assert!((mid.b - 0.5).abs() < 0.01);
    }

    #[test]
    fn lerp_transform_midpoint_and_absent_side_identity() {
        let from = vec![TransformOp::TranslateY(0.0), TransformOp::Scale(1.0)];
        let to = vec![TransformOp::TranslateY(20.0), TransformOp::Scale(2.0)];
        let mid = lerp_transform_ops(&from, &to, 0.5);
        assert_eq!(op_scalar(&mid[0]), 10.0);
        assert_eq!(op_scalar(&mid[1]), 1.5);

        // absent on `from` → starts at identity (scale rests at 1).
        let only_to = vec![TransformOp::Scale(3.0)];
        let mid2 = lerp_transform_ops(&[], &only_to, 0.5);
        assert_eq!(op_scalar(&mid2[0]), 2.0); // (1 → 3) @ .5

        // absent on `to` → animates toward identity (translate rests at 0).
        let only_from = vec![TransformOp::TranslateX(10.0)];
        let mid3 = lerp_transform_ops(&only_from, &[], 0.5);
        assert_eq!(op_scalar(&mid3[0]), 5.0); // (10 → 0) @ .5
    }

    #[test]
    fn note_commit_arms_on_change_only() {
        let _g = TEST_LOCK.lock().unwrap();
        reset();
        let transition =
            json!({"keys": ["opacity"], "byKey": {}, "default": {"duration": 100}, "delay": 0});

        // first sight: records prev, no tween (nothing to animate from).
        let s0 = json!({"opacity": 1.0, "_gpuiTransition": transition});
        assert!(!note_commit(1, s0.as_object().unwrap()));
        assert!(!tweens_active());

        // unchanged value: no arm.
        let s1 = json!({"opacity": 1.0, "_gpuiTransition": transition});
        assert!(!note_commit(1, s1.as_object().unwrap()));

        // changed value: arms.
        let s2 = json!({"opacity": 0.0, "_gpuiTransition": transition});
        assert!(note_commit(1, s2.as_object().unwrap()));
        assert!(tweens_active());
    }

    #[test]
    fn note_commit_skips_duration_zero() {
        let _g = TEST_LOCK.lock().unwrap();
        reset();
        let transition =
            json!({"keys": ["opacity"], "byKey": {}, "default": {"duration": 0}, "delay": 0});
        note_commit(
            2,
            json!({"opacity": 1.0, "_gpuiTransition": transition})
                .as_object()
                .unwrap(),
        );
        // changed but duration 0 → snap, no tween.
        assert!(!note_commit(
            2,
            json!({"opacity": 0.0, "_gpuiTransition": transition})
                .as_object()
                .unwrap()
        ));
        assert!(!tweens_active());
    }

    #[test]
    fn animate_to_arms_and_reinterrupts_from_live_value() {
        let _g = TEST_LOCK.lock().unwrap();
        reset();
        let transition = json!({"keys": ["opacity"], "byKey": {}, "default": {"duration": 100}});
        let transition = transition.as_object().unwrap();

        // no prior value: first animate_to records the target and snaps (no tween).
        animate_to(1, json!({"opacity": 1.0}).as_object().unwrap(), transition);
        assert!(!tweens_active());

        // with a prior value present, animate_to to a new target arms a tween 1.0 → 0.0.
        animate_to(1, json!({"opacity": 0.0}).as_object().unwrap(), transition);
        assert!(tweens_active());
        let orig = {
            let tweens = GPUI_TWEENS.lock().unwrap();
            let tw = tweens.get(&(1, "opacity".to_string())).unwrap();
            assert_eq!(tw.from_json.as_f64().unwrap(), 1.0);
            assert_eq!(tw.to_json.as_f64().unwrap(), 0.0);
            tw.from_json.clone()
        };
        let orig_from = orig.as_f64().unwrap();

        // let the tween advance partway, then re-target mid-flight. the new tween's `from`
        // must be the live interpolated value (strictly between original from and to), not
        // the original `from` — proving the interruption resumes from where it is.
        std::thread::sleep(Duration::from_millis(30));
        animate_to(1, json!({"opacity": 0.5}).as_object().unwrap(), transition);
        let new_from = {
            let tweens = GPUI_TWEENS.lock().unwrap();
            let tw = tweens.get(&(1, "opacity".to_string())).unwrap();
            assert_eq!(tw.to_json.as_f64().unwrap(), 0.5);
            tw.from_json.as_f64().unwrap()
        };
        assert!(
            new_from < orig_from && new_from > 0.0,
            "re-armed from live value {new_from}, not original from {orig_from} or target 0.0"
        );
    }

    #[test]
    fn tick_settles_and_removes_at_end() {
        let _g = TEST_LOCK.lock().unwrap();
        reset();
        // a tween that is already past its duration → settles to target and is removed.
        GPUI_TWEENS.lock().unwrap().insert(
            (5, "opacity".to_string()),
            Tween {
                from_json: json!(1.0),
                to_json: json!(0.0),
                start: Instant::now() - Duration::from_millis(500),
                delay: Duration::ZERO,
                duration: Duration::from_millis(100),
                easing: "linear".to_string(),
            },
        );
        assert!(tweens_active());
        let still = tick_tweens();
        assert!(!still);
        assert!(!tweens_active());
    }

    #[test]
    fn retain_prunes_absent_ids() {
        let _g = TEST_LOCK.lock().unwrap();
        reset();
        // a transition commit populates PREV_APPLIED for node 7 (non-transition commits
        // are no longer tracked, so use one here to set up the prune assertion).
        let transition =
            json!({"keys": ["opacity"], "byKey": {}, "default": {"duration": 100}, "delay": 0});
        note_commit(
            7,
            json!({"opacity": 1.0, "_gpuiTransition": transition})
                .as_object()
                .unwrap(),
        ); // populates PREV_APPLIED
        GPUI_TWEENS.lock().unwrap().insert(
            (7, "opacity".to_string()),
            Tween {
                from_json: json!(1.0),
                to_json: json!(0.0),
                start: Instant::now(),
                delay: Duration::ZERO,
                duration: Duration::from_millis(100),
                easing: "linear".to_string(),
            },
        );
        let present: HashSet<u64> = [9u64].into_iter().collect();
        retain(&present);
        assert!(!tweens_active());
        assert!(PREV_APPLIED.lock().unwrap().get(&7).is_none());
    }
}
