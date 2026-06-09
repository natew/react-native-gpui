//! Off-thread reanimated fast path: a per-node animated-style overlay.
//!
//! When a Tamagui spring (or any `useAnimatedStyle`) ticks, upstream reanimated
//! calls `global._updateProps(ops)` every frame. The TS seam
//! (`ts/src/reanimated-seam.ts`) coalesces those ops within one rAF tick and crosses
//! into the host ONCE per frame via `__rngpui_setNodeStyle`, which lands here as an
//! `Incoming::SetNodeStyle`. The pump writes the overrides into this global map and
//! calls `cx.notify()` WITHOUT replacing `ServiceApp::root` — so React never
//! re-commits per frame and the whole serialize → applyTree → parse pipeline is
//! skipped. The proof point is exactly that: during an animation the host sees
//! `setNodeStyle`, never `applyTree`.
//!
//! The override is parsed into a partial `ElementStyle` (same `from_json` the tree
//! parser uses), so it merges into the committed style identically. `div`/`text`
//! element builders call `overlay_for` and, when present, merge it over the
//! committed `ElementStyle` BEFORE `build_gpui_style`, so a `width`/`height` spring
//! reflows layout and an `opacity`/`backgroundColor` spring repaints — the single
//! style path feeds both yoga layout and paint.
//!
//! Pruning mirrors the `retain_layout` discipline: a real `Incoming::Tree` drops
//! overlay entries for ids no longer present so stale springs can't pin a removed
//! node.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::Value;

use crate::style::ElementStyle;

/// globalId → the raw animated style JSON object last pushed for that node. Stored as
/// the raw `serde_json` object (not a parsed `ElementStyle`) so the merge below sees
/// exactly the keys reanimated wrote and nothing else — `ElementStyle::from_json`
/// fills unset fields with `None`, and merging a full struct would clobber the
/// committed style's other fields. Keeping the raw object lets us layer only the
/// animated keys on top of the committed JSON-equivalent style.
static OVERLAY: Lazy<Mutex<HashMap<u64, serde_json::Map<String, Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// Set when an overlay op CHANGES a layout-box key (width/height/flex/inset/…), i.e. the
// animated value actually moves the yoga box — a worklet-driven pane RESIZE. The render
// gate then runs the (otherwise-skipped) tree lifecycle for that frame so native WebViews
// reposition to follow the new layout. Paint-only animations (opacity, transform scale/y —
// what dialogs/sheets use) never flip this, so the freeze fix stands: an opacity spring
// still skips the per-frame WebView reposition + whole-tree walks. A dialog's frame-1 full
// style does carry width/height, but it's STATIC (held, not changing) on every frame after,
// so only that first frame flips it — one lifecycle frame, not a per-frame pin.
static LAYOUT_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn is_layout_key(k: &str) -> bool {
    matches!(
        k,
        "width"
            | "height"
            | "minWidth"
            | "maxWidth"
            | "minHeight"
            | "maxHeight"
            | "flex"
            | "flexGrow"
            | "flexShrink"
            | "flexBasis"
            | "top"
            | "left"
            | "right"
            | "bottom"
            | "marginTop"
            | "marginLeft"
            | "marginRight"
            | "marginBottom"
            | "paddingTop"
            | "paddingLeft"
            | "paddingRight"
            | "paddingBottom"
            | "gap"
            | "rowGap"
            | "columnGap"
    )
}

/// True (clearing the flag) when an overlay op CHANGED a layout-box key since the last
/// check — the render gate uses this to run the tree lifecycle (WebView reposition + layout)
/// for a worklet-driven resize frame, while opacity/transform animation frames stay gated.
pub fn take_layout_dirty() -> bool {
    LAYOUT_DIRTY.swap(false, std::sync::atomic::Ordering::Relaxed)
}

/// Apply a batch of per-node style overrides. Each entry is (globalId, styleObject).
/// A style object that resolves empty clears that node's overlay. Returns true when
/// anything actually changed (so the caller can skip the notify on a no-op frame).
pub fn apply_ops(ops: Vec<(u64, serde_json::Map<String, Value>)>) -> bool {
    if ops.is_empty() {
        return false;
    }
    let trace = std::env::var_os("RNGPUI_OVERLAY_TRACE").is_some();
    let mut overlay = OVERLAY.lock().unwrap();
    let mut changed = false;
    for (id, style) in ops {
        if trace {
            eprintln!(
                "[overlay] id={id} ops keys=[{}]",
                style.keys().cloned().collect::<Vec<_>>().join(",")
            );
        }
        if style.is_empty() {
            if overlay.remove(&id).is_some() {
                changed = true;
            }
            continue;
        }
        // MERGE per-key into the existing overlay — do NOT replace it. reanimated's
        // `useAnimatedStyle` (e.g. Tamagui's dialog driver) emits the FULL animated
        // style on the first frame (backgroundColor, borders, padding, radius, width,
        // height, opacity, transform) but only the per-frame CHANGING keys thereafter
        // (just `opacity`/`transform` once the spring is the only thing moving). A
        // wholesale replace dropped backgroundColor (and the borders/padding/radius)
        // after frame 1, so the dialog/overlay painted with no background. Merging keeps
        // every key the node ever animated until a real Tree commit prunes it.
        let entry = overlay.entry(id).or_default();
        for (k, v) in style {
            match entry.get(&k) {
                Some(existing) if existing == &v => {}
                _ => {
                    if is_layout_key(&k) {
                        // a layout-box key actually MOVED this frame (resize) — let the
                        // render gate run the lifecycle so native WebViews follow.
                        LAYOUT_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    entry.insert(k, v);
                    changed = true;
                }
            }
        }
    }
    changed
}

/// The committed `ElementStyle` for `global_id`, with any live animated overrides
/// merged on top. Returns `None` when there is no overlay for this node, so the hot
/// path stays a single map lookup + clone-free fast exit for the overwhelmingly
/// common (un-animated) node.
pub fn merged_style(
    global_id: u64,
    base: &ElementStyle,
    base_json: &Value,
) -> Option<ElementStyle> {
    let overlay = OVERLAY.lock().unwrap();
    let over = overlay.get(&global_id)?;
    // start from the committed style's own JSON-equivalent, layer the animated keys
    // on top, and re-parse — so the merge runs through exactly the same `from_json`
    // the tree parser uses (border-box subtraction, color parsing, shorthands).
    let mut merged = base_json
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    for (k, v) in over {
        merged.insert(k.clone(), v.clone());
    }
    let style = ElementStyle::from_json(&Value::Object(merged));
    // from_json starts from default, dropping fields the tree parser doesn't read but
    // the committed ElementStyle does carry implicitly (none today — from_json reads
    // every styled field). Keep `base` as the source of truth for anything from_json
    // wouldn't reconstruct by carrying it forward where the overlay is silent.
    let _ = base;
    Some(style)
}

/// True when `global_id` currently has an animated overlay (cheap presence check used
/// to gate the more expensive merge in the element builders).
pub fn has_overlay(global_id: u64) -> bool {
    OVERLAY.lock().unwrap().contains_key(&global_id)
}

/// Drop overlay entries for ids no longer present in the live tree (mirrors
/// `bridge::retain_layout`). Called on every real `Incoming::Tree` commit.
pub fn retain(present: &HashSet<u64>) {
    OVERLAY.lock().unwrap().retain(|id, _| present.contains(id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // the two tests below both mutate the process-global OVERLAY; serialize them so
    // cargo's parallel runner can't interleave their state.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn obj(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn apply_and_merge_width_overlay() {
        let _serial = TEST_LOCK.lock().unwrap();
        OVERLAY.lock().unwrap().clear();

        let base_json = json!({ "width": 100.0, "height": 40.0 });
        let base = ElementStyle::from_json(&base_json);

        // no overlay yet → None
        assert!(merged_style(42, &base, &base_json).is_none());

        let changed = apply_ops(vec![(42, obj(json!({ "width": 180.0 })))]);
        assert!(changed);

        let merged = merged_style(42, &base, &base_json).expect("overlay present");
        assert_eq!(merged.width.and_then(crate::style::Dim::as_px), Some(180.0));
        // untouched committed key survives
        assert_eq!(merged.height.and_then(crate::style::Dim::as_px), Some(40.0));

        // identical re-apply is a no-op
        assert!(!apply_ops(vec![(42, obj(json!({ "width": 180.0 })))]));

        // empty style clears
        assert!(apply_ops(vec![(42, serde_json::Map::new())]));
        assert!(merged_style(42, &base, &base_json).is_none());

        OVERLAY.lock().unwrap().clear();
    }

    #[test]
    fn retain_prunes_absent_ids() {
        let _serial = TEST_LOCK.lock().unwrap();
        OVERLAY.lock().unwrap().clear();
        apply_ops(vec![
            (1, obj(json!({ "opacity": 0.5 }))),
            (2, obj(json!({ "opacity": 0.5 }))),
        ]);
        let mut present = HashSet::new();
        present.insert(1u64);
        retain(&present);
        assert!(has_overlay(1));
        assert!(!has_overlay(2));
        OVERLAY.lock().unwrap().clear();
    }

    #[test]
    fn later_ops_merge_per_key_not_replace() {
        // the dialog-background regression: reanimated's useAnimatedStyle emits the FULL
        // animated style on frame 1 (backgroundColor + opacity + transform), then only the
        // per-frame-changing keys thereafter (opacity/transform). A wholesale replace
        // dropped backgroundColor after frame 1 → dialogs painted with no background.
        let _serial = TEST_LOCK.lock().unwrap();
        OVERLAY.lock().unwrap().clear();

        let base_json = json!({ "width": 300.0, "height": 160.0 });
        let base = ElementStyle::from_json(&base_json);

        // frame 1: full animated style, including the background.
        apply_ops(vec![(
            7,
            obj(json!({ "backgroundColor": "rgba(15,18,24,0.24)", "opacity": 0.0 })),
        )]);
        // frames 2..n: only the spring-driven keys.
        apply_ops(vec![(7, obj(json!({ "opacity": 0.5 })))]);
        apply_ops(vec![(7, obj(json!({ "opacity": 1.0 })))]);

        let merged = merged_style(7, &base, &base_json).expect("overlay present");
        // background MUST survive the later opacity-only ops.
        assert!(
            merged.background_color.is_some(),
            "backgroundColor was dropped by a later opacity-only op (the dialog-bg bug)"
        );
        assert_eq!(merged.opacity, Some(1.0));

        OVERLAY.lock().unwrap().clear();
    }
}
