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
use std::sync::atomic::{AtomicUsize, Ordering};

use once_cell::sync::Lazy;
use serde_json::Value;

use crate::style::ElementStyle;

/// globalId → the raw animated style JSON object last pushed for that node. Stored as
/// the raw `serde_json` object (not a parsed `ElementStyle`) so the merge below sees
/// exactly the keys reanimated wrote and nothing else — `ElementStyle::from_json`
/// fills unset fields with `None`, and merging a full struct would clobber the
/// committed style's other fields. Keeping the raw object lets us layer only the
/// animated keys on top of the committed JSON-equivalent style.
struct OverlayEntry {
    style: serde_json::Map<String, Value>,
    /// bumped whenever a key actually changes — the merged-style cache key.
    rev: u64,
}

static OVERLAY: Lazy<Mutex<HashMap<u64, OverlayEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Live overlay-entry count, mirrored from `OVERLAY` (updated under its lock). Lets the
/// per-node hot paths (`merged_gpui_style`, `has_overlay` — called for EVERY node during
/// layout + paint) skip locking `OVERLAY` entirely when nothing is animated, which is the
/// overwhelmingly common case (a static frame). All accesses are on the main thread
/// (apply_ops runs on the pump; the reads run during paint), so a relaxed mirror is exact.
static OVERLAY_COUNT: AtomicUsize = AtomicUsize::new(0);

/// globalId → (overlay rev, committed-style identity, built style) for the last merge.
/// A STEADY overlay (e.g. Tamagui's avoidReRenders hover path leaves a permanent entry
/// per row) must not cost a JSON clone + re-parse + style build per node per frame —
/// that tax made every frame ~40% slower with ~90 animated rows. The base identity is
/// the committed `style_json`'s address: stable while the element's `Arc` is alive, and
/// the whole cache is dropped on every real Tree commit (see `retain`), so a recycled
/// allocation can never alias a stale entry.
struct MergedCache {
    rev: u64,
    base_ptr: usize,
    style: gpui::Style,
}

static MERGED: Lazy<Mutex<HashMap<u64, MergedCache>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// Set when an overlay op CHANGES a layout-box key (width/height/flex/inset/…), i.e. the
// animated value actually moves the yoga box — a worklet-driven pane RESIZE. The render
// gate then runs the (otherwise-skipped) tree lifecycle for that frame so native WebViews
// reposition to follow the new layout. Paint-only animations (opacity, transform scale/y —
// what dialogs/sheets use) never flip this, so the freeze fix stands: an opacity spring
// still skips the per-frame WebView reposition + whole-tree walks. A dialog's frame-1 full
// style does carry width/height, but it's STATIC (held, not changing) on every frame after,
// so only that first frame flips it — one lifecycle frame, not a per-frame pin.
static LAYOUT_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// Set true when the most recent host action that scheduled a draw was a paint-only
// `SetNodeStyle` batch (every changed key is paint-only — backgroundColor/color/opacity/
// borderColor/shadow/tint/transform — so no taffy box moved). The render gate reads this
// (via `take_paint_only_frame`) to enable the retained-layout fast path: skip the taffy
// rebuild + flexbox solve and replay the prior full-layout frame's geometry. ANY other
// path that schedules a draw and might move a box — a React tree commit, a text-input
// edit, a scrollTo, a native-layout/resize override, an inspector toggle — clears it via
// `clear_paint_only_frame()` so that frame falls back to a full layout. It is also
// consumed (reset to false) every render, so a stale true can never carry into a later
// non-paint-only frame.
static PAINT_ONLY_FRAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Keys whose animated change repaints WITHOUT moving any layout box — the retained-layout
/// fast path is sound only when every key in a `SetNodeStyle` batch is one of these. The
/// inverse of `is_layout_key`, but spelled out as an allowlist (not `!is_layout_key`) so a
/// brand-new key name we don't recognize defaults to "treat as layout-affecting" — the
/// safe direction (force a full layout) rather than silently reusing stale geometry.
/// `transform` is here because gpui applies element transforms at PAINT time (an element
/// offset/scale in the paint pass), never through taffy — a translate/scale spring does
/// not change a node's taffy box. `fontSize`/`lineHeight`/`letterSpacing` are NOT here:
/// they resize the text box.
pub fn is_paint_only_key(k: &str) -> bool {
    matches!(
        k,
        "backgroundColor"
            | "background"
            | "color"
            | "opacity"
            | "borderColor"
            | "borderTopColor"
            | "borderRightColor"
            | "borderBottomColor"
            | "borderLeftColor"
            | "shadowColor"
            | "shadowOpacity"
            | "shadowRadius"
            | "tintColor"
            | "transform"
            | "borderRadius"
    )
}

/// The render gate calls this once per frame: returns whether this frame is paint-only
/// (so the retained-layout fast path may engage) AND resets the flag, so it can never
/// leak into a later non-paint-only frame.
pub fn take_paint_only_frame() -> bool {
    PAINT_ONLY_FRAME.swap(false, std::sync::atomic::Ordering::Relaxed)
}

/// Any host action that schedules a draw and might move a layout box calls this to veto
/// the retained-layout fast path for the resulting frame (tree commit, input edit,
/// scrollTo, native layout/resize, inspector toggle, …).
pub fn clear_paint_only_frame() {
    PAINT_ONLY_FRAME.store(false, std::sync::atomic::Ordering::Relaxed);
}

/// Arm the retained-layout fast path for the frame a non-`SetNodeStyle` repaint is about
/// to schedule, when that repaint is geometry-stable. The native hover/press pseudo-style
/// swap is the case: it replaces a precomputed variant in PAINT (after layout), never re-
/// laying-out, so the frame's geometry is identical to the last full-layout frame. The
/// render gate still re-confirms `!root_dirty && !layout_dirty && !resize && …` before
/// trusting it, so a stray mark can at worst cost one needless full layout, never a wrong
/// one.
pub fn mark_paint_only_frame() {
    PAINT_ONLY_FRAME.store(true, std::sync::atomic::Ordering::Relaxed);
}

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
    // does every key that actually changed in this batch repaint without moving a box?
    // Starts true; any changed layout key flips it false. A pure overlay-clear (revert to
    // committed style) keeps it true — the committed layout was already solved.
    let mut all_paint_only = true;
    for (id, style) in ops {
        if trace {
            eprintln!(
                "[overlay] id={id} ops keys=[{}]",
                style.keys().cloned().collect::<Vec<_>>().join(",")
            );
        }
        if style.is_empty() {
            if overlay.remove(&id).is_some() {
                MERGED.lock().unwrap().remove(&id);
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
        let entry = overlay.entry(id).or_insert_with(|| OverlayEntry {
            style: serde_json::Map::new(),
            rev: 0,
        });
        let mut entry_changed = false;
        for (k, v) in style {
            match entry.style.get(&k) {
                Some(existing) if existing == &v => {}
                _ => {
                    if is_layout_key(&k) {
                        // a layout-box key actually MOVED this frame (resize) — let the
                        // render gate run the lifecycle so native WebViews follow.
                        LAYOUT_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    // a CHANGED key that isn't on the paint-only allowlist vetoes the
                    // retained-layout reuse for this frame (force a full taffy solve).
                    if !is_paint_only_key(&k) {
                        all_paint_only = false;
                    }
                    entry.style.insert(k, v);
                    entry_changed = true;
                }
            }
        }
        if entry_changed {
            entry.rev += 1;
            changed = true;
        }
    }
    // arm the retained-layout fast path only when SOMETHING changed and every changed key
    // repainted in place. A no-op batch (`changed==false`) leaves the flag untouched — it
    // wouldn't have scheduled a draw anyway.
    if changed && all_paint_only {
        PAINT_ONLY_FRAME.store(true, std::sync::atomic::Ordering::Relaxed);
    } else if changed {
        PAINT_ONLY_FRAME.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    OVERLAY_COUNT.store(overlay.len(), Ordering::Relaxed);
    changed
}

/// The committed style for `global_id` with any live animated overrides merged on top,
/// built into a ready `gpui::Style`. Returns `None` when there is no overlay for this
/// node, so the hot path stays a single map lookup for the overwhelmingly common
/// (un-animated) node. The merge (JSON clone + `from_json` re-parse + style build) runs
/// only when the overlay rev or the committed style changed — a steady overlay costs a
/// hashmap hit + `gpui::Style` clone per frame, same as the un-animated cache path.
pub fn merged_gpui_style(
    global_id: u64,
    base_json: &Value,
    default_bg: Option<u32>,
) -> Option<gpui::Style> {
    // fast path: no overlay anywhere → skip the lock (every node, every static frame).
    if OVERLAY_COUNT.load(Ordering::Relaxed) == 0 {
        return None;
    }
    let overlay = OVERLAY.lock().unwrap();
    let over = overlay.get(&global_id)?;
    let base_ptr = base_json as *const Value as usize;
    // only the default_bg=None variant is cached (the only one live callers use) —
    // mirrors `ReactElement::cached_gpui_style`.
    if default_bg.is_none()
        && let Some(cached) = MERGED.lock().unwrap().get(&global_id)
        && cached.rev == over.rev
        && cached.base_ptr == base_ptr
    {
        return Some(cached.style.clone());
    }
    // start from the committed style's own JSON-equivalent, layer the animated keys
    // on top, and re-parse — so the merge runs through exactly the same `from_json`
    // the tree parser uses (border-box subtraction, color parsing, shorthands).
    let mut merged = base_json
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    for (k, v) in &over.style {
        merged.insert(k.clone(), v.clone());
    }
    let style = ElementStyle::from_json(&Value::Object(merged)).build_gpui_style(default_bg);
    if default_bg.is_none() {
        MERGED.lock().unwrap().insert(
            global_id,
            MergedCache {
                rev: over.rev,
                base_ptr,
                style: style.clone(),
            },
        );
    }
    Some(style)
}

/// True when `global_id` currently has an animated overlay (cheap presence check used
/// to gate the pseudo-style swap in paint).
pub fn has_overlay(global_id: u64) -> bool {
    if OVERLAY_COUNT.load(Ordering::Relaxed) == 0 {
        return false;
    }
    OVERLAY.lock().unwrap().contains_key(&global_id)
}

/// Uncached merge returning the `ElementStyle` — debug dump and tests only; the hot
/// per-frame path is `merged_gpui_style`.
pub fn merged_element_style(global_id: u64, base_json: &Value) -> Option<ElementStyle> {
    let overlay = OVERLAY.lock().unwrap();
    let over = overlay.get(&global_id)?;
    let mut merged = base_json
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    for (k, v) in &over.style {
        merged.insert(k.clone(), v.clone());
    }
    Some(ElementStyle::from_json(&Value::Object(merged)))
}

/// Drop overlay entries for ids no longer present in the live tree (mirrors
/// `bridge::retain_layout`). Called on every real `Incoming::Tree` commit. The merged
/// cache is dropped wholesale: a commit may swap any node's committed style (and frees
/// the old `Arc`s, so cached base addresses must never be compared across commits).
pub fn retain(present: &HashSet<u64>) {
    let mut overlay = OVERLAY.lock().unwrap();
    overlay.retain(|id, _| present.contains(id));
    OVERLAY_COUNT.store(overlay.len(), Ordering::Relaxed);
    drop(overlay);
    MERGED.lock().unwrap().clear();
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
    fn paint_only_key_classifier_allowlists_repaint_keys_only() {
        // every key that repaints in place without moving a taffy box.
        for k in [
            "backgroundColor",
            "color",
            "opacity",
            "borderColor",
            "shadowColor",
            "tintColor",
            "transform",
            "borderRadius",
        ] {
            assert!(is_paint_only_key(k), "{k} should be paint-only");
        }
        // every layout-box key must be REJECTED (force a full solve).
        for k in [
            "width",
            "height",
            "flex",
            "flexGrow",
            "marginTop",
            "paddingLeft",
            "gap",
            "top",
            "left",
        ] {
            assert!(!is_paint_only_key(k), "{k} must NOT be paint-only");
        }
        // a key we don't recognize defaults to layout-affecting (the safe direction):
        // never silently reuse stale geometry for an unknown key.
        assert!(!is_paint_only_key("fontSize"));
        assert!(!is_paint_only_key("lineHeight"));
        assert!(!is_paint_only_key("someBrandNewKey"));
        // the two classifiers must never both claim a key.
        for k in ["width", "backgroundColor", "opacity", "marginTop", "flex"] {
            assert!(
                !(is_paint_only_key(k) && is_layout_key(k)),
                "{k} cannot be both paint-only and layout"
            );
        }
    }

    #[test]
    fn apply_ops_arms_paint_only_only_for_paint_keys() {
        let _serial = TEST_LOCK.lock().unwrap();
        OVERLAY.lock().unwrap().clear();
        MERGED.lock().unwrap().clear();
        // a pure background change → paint-only frame armed.
        take_paint_only_frame(); // clear any residue
        assert!(apply_ops(vec![(
            1,
            obj(json!({ "backgroundColor": "#fff" }))
        )]));
        assert!(
            take_paint_only_frame(),
            "a backgroundColor-only batch must arm the retained-layout fast path"
        );
        // consume-once: a second read with no new ops is false.
        assert!(!take_paint_only_frame());

        // a batch that touches a layout key → NOT paint-only (force a full solve).
        assert!(apply_ops(vec![(1, obj(json!({ "width": 50.0 })))]));
        assert!(
            !take_paint_only_frame(),
            "a width change must veto the retained-layout fast path"
        );

        // a MIXED batch (one paint key + one layout key) → vetoed.
        assert!(apply_ops(vec![(
            2,
            obj(json!({ "opacity": 0.5, "height": 30.0 }))
        )]));
        assert!(
            !take_paint_only_frame(),
            "a mixed paint+layout batch must veto reuse"
        );

        // an explicit veto wins even after a paint-only arm in the same frame
        // (the input-edit / native-resize coalescing case).
        assert!(apply_ops(vec![(3, obj(json!({ "color": "#abc" })))]));
        clear_paint_only_frame();
        assert!(
            !take_paint_only_frame(),
            "clear_paint_only_frame must veto a coalesced paint-only arm"
        );

        OVERLAY.lock().unwrap().clear();
        MERGED.lock().unwrap().clear();
    }

    #[test]
    fn apply_and_merge_width_overlay() {
        let _serial = TEST_LOCK.lock().unwrap();
        OVERLAY.lock().unwrap().clear();
        MERGED.lock().unwrap().clear();

        let base_json = json!({ "width": 100.0, "height": 40.0 });

        // no overlay yet → None
        assert!(merged_element_style(42, &base_json).is_none());
        assert!(merged_gpui_style(42, &base_json, None).is_none());

        let changed = apply_ops(vec![(42, obj(json!({ "width": 180.0 })))]);
        assert!(changed);

        let merged = merged_element_style(42, &base_json).expect("overlay present");
        assert_eq!(merged.width.and_then(crate::style::Dim::as_px), Some(180.0));
        // untouched committed key survives
        assert_eq!(merged.height.and_then(crate::style::Dim::as_px), Some(40.0));

        // the cached gpui build agrees and is stable across repeat calls (cache hit)
        let built = merged_gpui_style(42, &base_json, None).expect("overlay present");
        assert_eq!(built.size.width, gpui::px(180.0).into());
        let built_again = merged_gpui_style(42, &base_json, None).expect("cache hit");
        assert_eq!(built_again.size.width, gpui::px(180.0).into());

        // identical re-apply is a no-op
        assert!(!apply_ops(vec![(42, obj(json!({ "width": 180.0 })))]));

        // a changed value invalidates the cached merge
        assert!(apply_ops(vec![(42, obj(json!({ "width": 220.0 })))]));
        let rebuilt = merged_gpui_style(42, &base_json, None).expect("overlay present");
        assert_eq!(rebuilt.size.width, gpui::px(220.0).into());

        // empty style clears
        assert!(apply_ops(vec![(42, serde_json::Map::new())]));
        assert!(merged_element_style(42, &base_json).is_none());
        assert!(merged_gpui_style(42, &base_json, None).is_none());

        OVERLAY.lock().unwrap().clear();
        MERGED.lock().unwrap().clear();
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
        MERGED.lock().unwrap().clear();

        let base_json = json!({ "width": 300.0, "height": 160.0 });

        // frame 1: full animated style, including the background.
        apply_ops(vec![(
            7,
            obj(json!({ "backgroundColor": "rgba(15,18,24,0.24)", "opacity": 0.0 })),
        )]);
        // frames 2..n: only the spring-driven keys — each must invalidate the cached
        // merge (read between ops, like real frames do).
        let f1 = merged_gpui_style(7, &base_json, None).expect("overlay present");
        assert_eq!(f1.opacity, Some(0.0));
        apply_ops(vec![(7, obj(json!({ "opacity": 0.5 })))]);
        let f2 = merged_gpui_style(7, &base_json, None).expect("overlay present");
        assert_eq!(f2.opacity, Some(0.5));
        apply_ops(vec![(7, obj(json!({ "opacity": 1.0 })))]);

        let merged = merged_element_style(7, &base_json).expect("overlay present");
        // background MUST survive the later opacity-only ops.
        assert!(
            merged.background_color.is_some(),
            "backgroundColor was dropped by a later opacity-only op (the dialog-bg bug)"
        );
        assert_eq!(merged.opacity, Some(1.0));

        OVERLAY.lock().unwrap().clear();
        MERGED.lock().unwrap().clear();
    }
}
