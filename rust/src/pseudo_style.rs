//! Native hover/press pseudo styles: a per-node precomputed `gpui::Style` the host applies at
//! paint when an element's own hitbox reports hover (and, for press, a held button).
//!
//! This mirrors [`crate::anim_overlay`] — a global per-node style map consulted by the element
//! builders and pruned on each tree commit — but the source is the COMMITTED tree rather than
//! reanimated's per-frame ops. The reconciler emits a node's `hoverStyle`/`pressStyle` as
//! separate DELTAS (never merged into the base `style`); `parse_json_tree` merges each delta over
//! the node's own committed style and builds the resulting `gpui::Style` ONCE per React commit,
//! storing it here. `div`'s paint then swaps in that precomputed style when the node is hovered —
//! so a hover bg change repaints on the host thread with ZERO JS round-trip and no relayout, which
//! is what lets rapid hovering hold frame rate (the old path re-entered React: a hover event
//! crossed to JS, re-serialized the node, and re-applied the whole tree).
//!
//! Lifecycle: parse calls [`set`] for EVERY node — entries are stored for nodes carrying a
//! pseudo style and removed for nodes that stopped carrying one (a sidebar row flipping to
//! active with `hoverStyle={active ? undefined : …}` must drop its stale hover, or the old
//! hover bg repaints over the selection). [`retain`] drops entries for ids no longer in the
//! live tree (called alongside `anim_overlay::retain` on every real Tree commit).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use once_cell::sync::Lazy;

/// The precomputed gpui styles for a node's pseudo-states. Each is `None` when the node carries
/// no `hoverStyle` / `pressStyle` respectively (a node is only stored when at least one is set).
#[derive(Clone)]
pub struct PseudoStyles {
    pub hover: Option<gpui::Style>,
    pub press: Option<gpui::Style>,
}

/// globalId → its precomputed pseudo styles. Only nodes that carry a hover/press style appear;
/// paint never touches this map for other nodes (`ReactElement::has_pseudo_style` gates the
/// read), and parse's unconditional `set` is a cheap remove-miss for them.
static STYLES: Lazy<Mutex<HashMap<u64, PseudoStyles>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Record (or, with both `None`, clear) a node's precomputed pseudo styles. Called from
/// `parse_json_tree` for nodes whose serialized form carries a `hoverStyle`/`pressStyle`.
pub fn set(id: u64, hover: Option<gpui::Style>, press: Option<gpui::Style>) {
    let mut map = STYLES.lock().unwrap();
    if hover.is_none() && press.is_none() {
        map.remove(&id);
    } else {
        map.insert(id, PseudoStyles { hover, press });
    }
}

/// True when this node carries a native hover/press pseudo style. Production code reads
/// the precomputed `ReactElement::has_pseudo_style` flag instead (no lock per node per
/// frame); this stays for the tests below.
#[cfg(test)]
fn has(id: u64) -> bool {
    STYLES.lock().unwrap().contains_key(&id)
}

/// The precomputed pseudo styles for `id`, cloned for paint. `None` when the node has none.
pub fn get(id: u64) -> Option<PseudoStyles> {
    STYLES.lock().unwrap().get(&id).cloned()
}

/// Drop entries for ids no longer present in the live tree (mirrors `anim_overlay::retain`).
pub fn retain(present: &HashSet<u64>) {
    STYLES.lock().unwrap().retain(|id, _| present.contains(id));
}

/// Serializes tests that touch the global [`STYLES`] map (service.rs parse tests share it).
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn test_clear() {
    STYLES.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // build a minimal gpui::Style carrying a background, to assert hover vs base differ.
    fn styled(bg_present: bool) -> gpui::Style {
        let json = if bg_present {
            json!({ "backgroundColor": "rgb(10,20,30)" })
        } else {
            json!({})
        };
        crate::style::ElementStyle::from_json(&json).build_gpui_style(None)
    }

    #[test]
    fn set_get_has_and_clear() {
        let _serial = TEST_LOCK.lock().unwrap();
        test_clear();

        assert!(!has(1));
        assert!(get(1).is_none());

        set(1, Some(styled(true)), None);
        assert!(has(1));
        let ps = get(1).expect("present");
        assert!(ps.hover.is_some());
        assert!(ps.press.is_none());

        // both-None clears the entry.
        set(1, None, None);
        assert!(!has(1));

        test_clear();
    }

    #[test]
    fn retain_prunes_absent_ids() {
        let _serial = TEST_LOCK.lock().unwrap();
        test_clear();

        set(1, Some(styled(true)), None);
        set(2, Some(styled(true)), None);
        let mut present = HashSet::new();
        present.insert(1u64);
        retain(&present);
        assert!(has(1));
        assert!(!has(2));

        test_clear();
    }
}
