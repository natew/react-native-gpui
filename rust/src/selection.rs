//! Native text selection for `<Text selectable>` nodes (RN's `selectable` prop).
//!
//! Model (borrowed from gpui-component's TextView): ONE window-global selection
//! rectangle in window coordinates, anchored where a drag started over a selectable
//! text's hitbox and stretched to the live pointer. Every selectable text node
//! decides per character whether it falls inside that region (text-flow semantics,
//! not a pure rect: full middle lines select edge-to-edge), paints its own highlight
//! quads, and registers its selected substring in a copy registry. Cmd+C concatenates
//! the registry in visual order (top→bottom, left→right). This makes selection span
//! multiple Text nodes — summary lines, terminal tail, titles — for free.
//!
//! Everything lives on the main thread (gpui is single-threaded): thread_locals, no
//! locks. Paint is the synchronization point — the registry entry for a node is
//! replaced on every paint and dropped when the node paints with no selection.

use std::cell::RefCell;
use std::collections::HashMap;

use gpui::{Bounds, Pixels, Point, px};

/// Minimum drag distance before a selection becomes live, so an ordinary click
/// (press without movement) never flashes a one-character selection.
const DRAG_THRESHOLD: f32 = 4.0;

#[derive(Clone, Copy)]
struct Drag {
    start: Point<Pixels>,
    current: Point<Pixels>,
    live: bool,
    /// mouse released — the selection is frozen; later moves must not stretch it.
    ended: bool,
}

#[derive(Clone)]
struct Segment {
    /// window position of the segment's first selected character (visual sort key).
    order: (f32, f32),
    text: String,
}

thread_local! {
    static DRAG: RefCell<Option<Drag>> = const { RefCell::new(None) };
    /// node global_id -> its currently selected substring (rebuilt each paint).
    static SEGMENTS: RefCell<HashMap<u64, Segment>> = RefCell::new(HashMap::new());
}

pub fn begin_drag(position: Point<Pixels>) {
    DRAG.with(|d| {
        *d.borrow_mut() = Some(Drag {
            start: position,
            current: position,
            live: false,
            ended: false,
        })
    });
    SEGMENTS.with(|s| s.borrow_mut().clear());
}

/// Returns true when the drag state changed in a way that needs a repaint.
pub fn update_drag(position: Point<Pixels>) -> bool {
    DRAG.with(|d| {
        let mut d = d.borrow_mut();
        let Some(drag) = d.as_mut() else {
            return false;
        };
        if drag.ended {
            return false;
        }
        drag.current = position;
        let dx = f32::from(drag.current.x - drag.start.x);
        let dy = f32::from(drag.current.y - drag.start.y);
        drag.live = drag.live || dx.hypot(dy) >= DRAG_THRESHOLD;
        drag.live
    })
}

pub fn end_drag() {
    DRAG.with(|d| {
        let mut d = d.borrow_mut();
        if let Some(drag) = d.as_mut() {
            if drag.live {
                drag.ended = true;
            } else {
                // a plain click: no selection — drop it entirely.
                *d = None;
            }
        }
    });
}

pub fn is_dragging() -> bool {
    DRAG.with(|d| d.borrow().is_some())
}

/// Clear any live selection. Returns true if there was one (repaint needed).
pub fn clear() -> bool {
    let had = DRAG.with(|d| d.borrow_mut().take().map(|d| d.live).unwrap_or(false));
    SEGMENTS.with(|s| s.borrow_mut().clear());
    had
}

/// The live selection region as a top-left → bottom-right bounds, or None.
pub fn selection_bounds() -> Option<Bounds<Pixels>> {
    DRAG.with(|d| {
        let d = d.borrow();
        let drag = d.as_ref()?;
        if !drag.live {
            return None;
        }
        let (a, b) = (drag.start, drag.current);
        // normalize so start is the visually-earlier point (reading order).
        let (start, end) = if (a.y, a.x) <= (b.y, b.x) {
            (a, b)
        } else {
            (b, a)
        };
        Some(Bounds::from_corners(
            gpui::point(start.x.min(end.x), start.y),
            gpui::point(start.x.max(end.x).max(start.x + px(1.0)), end.y),
        ))
    })
}

/// Text-flow selection test (gpui-component's semantics): chars on full middle
/// lines select edge-to-edge; the first/last lines clip at the anchor x.
pub fn point_in_selection(
    pos: Point<Pixels>,
    char_width: Pixels,
    bounds: &Bounds<Pixels>,
    line_height: Pixels,
) -> bool {
    let top = bounds.top();
    let bottom = bounds.bottom();
    let left = bounds.left();
    let right = bounds.right();

    if pos.y + line_height < top || pos.y >= bottom {
        return false;
    }
    let single_line = (bottom - top) <= line_height;
    if single_line {
        return pos.x + char_width * 0.5 >= left && pos.x + char_width * 0.5 <= right;
    }
    let is_above = pos.y <= top;
    let is_below = pos.y + line_height >= bottom;
    if is_above {
        pos.x + char_width * 0.5 >= left
    } else if is_below {
        pos.x + char_width * 0.5 <= right
    } else {
        true
    }
}

/// Record (or drop) a node's selected substring for the Cmd+C registry.
pub fn set_segment(node: u64, order: (f32, f32), text: String) {
    SEGMENTS.with(|s| {
        let mut s = s.borrow_mut();
        if text.is_empty() {
            s.remove(&node);
        } else {
            s.insert(node, Segment { order, text });
        }
    });
}

/// All selected text in visual order. Different rows join with newlines,
/// side-by-side nodes on the same row with a space.
pub fn selected_text() -> Option<String> {
    SEGMENTS.with(|s| {
        let s = s.borrow();
        if s.is_empty() {
            return None;
        }
        let mut segs: Vec<&Segment> = s.values().collect();
        segs.sort_by(|a, b| {
            (a.order.0, a.order.1)
                .partial_cmp(&(b.order.0, b.order.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut out = String::new();
        let mut last_y: Option<f32> = None;
        for seg in segs {
            if let Some(y) = last_y {
                if (seg.order.0 - y).abs() > 1.0 {
                    out.push('\n');
                } else {
                    out.push(' ');
                }
            }
            out.push_str(&seg.text);
            last_y = Some(seg.order.0);
        }
        Some(out)
    })
}
