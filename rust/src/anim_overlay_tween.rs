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

// (node, key) → in-flight tween, and last-committed animatable values per node so the next
// commit can diff against them.
static GPUI_TWEENS: Lazy<Mutex<HashMap<(u64, String), Tween>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PREV_APPLIED: Lazy<Mutex<HashMap<u64, Map<String, Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// cubic-bezier-ish easings. ease-out delegates to the shared `ease_out_cubic`; the others
/// are the standard CSS curve approximations. an unknown name falls back to ease-out.
pub fn ease(name: &str, t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    match name {
        "linear" => t,
        "ease-in" => t * t * t,
        "ease-in-out" => {
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        }
        // "ease" is close to a slow-in/slow-out; reuse ease-in-out so it's not linear.
        "ease" => ease("ease-in-out", t),
        // "ease-out" and any unknown name → ease-out.
        _ => ease_out_cubic(t),
    }
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

/// detection entry, called once per committed node. diffs the committed animatable values
/// against the prior commit and arms a tween for each changed key the transition names.
/// returns true if any tween was armed. with no `_gpuiTransition` it just refreshes the
/// stored prev values (so a later transition diffs against the right baseline).
pub fn note_commit(global_id: u64, style_json: &Map<String, Value>) -> bool {
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
        return false;
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

    armed
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

pub fn tweens_active() -> bool {
    !GPUI_TWEENS.lock().unwrap().is_empty()
}

/// drop tween + prev-value state for ids no longer in the live tree.
pub fn retain(present: &HashSet<u64>) {
    GPUI_TWEENS
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
    }

    #[test]
    fn ease_endpoints_are_zero_and_one() {
        for name in [
            "linear",
            "ease",
            "ease-in",
            "ease-out",
            "ease-in-out",
            "wat",
        ] {
            assert!(ease(name, 0.0).abs() < 1e-6, "{name} t=0");
            assert!((ease(name, 1.0) - 1.0).abs() < 1e-6, "{name} t=1");
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
