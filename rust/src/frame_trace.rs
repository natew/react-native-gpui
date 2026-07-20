//! Per-frame timing instrumentation, gated behind `RNGPUI_FRAME_TRACE`.
//!
//! The render pipeline runs synchronously inside gpui's `Window::draw`:
//! `ServiceApp::render` (builds the root element) → taffy layout (during the root
//! element's `request_layout`) → `prepaint` → `paint`. None of those stages is
//! individually observable from outside gpui, so this module threads thread-local
//! timers through the element pipeline and accumulates each stage's wall-clock cost,
//! then flushes a one-line breakdown at the next frame's start.
//!
//! It exists to answer the only question that matters for the hover-repaint goal:
//! for a frame where the React tree did NOT change (a hover `window.refresh()`), how
//! many milliseconds go to element rebuild vs layout vs prepaint vs paint? A still
//! screenshot or an event-dispatch latency number cannot answer that.

use std::cell::Cell;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

static ENABLED: Lazy<bool> = Lazy::new(|| std::env::var_os("RNGPUI_FRAME_TRACE").is_some());

#[inline]
pub fn enabled() -> bool {
    *ENABLED
}

thread_local! {
    // wall-clock at this frame's render() entry.
    static FRAME_T0: Cell<Option<Instant>> = const { Cell::new(None) };
    // create_element (element rebuild) cost for this frame.
    static CREATE: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    // accumulated request_layout cost across the whole tree (top-level entry only).
    static LAYOUT: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    // accumulated prepaint cost across the whole tree (top-level entry only).
    static PREPAINT: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    // accumulated paint cost across the whole tree (top-level entry only).
    static PAINT: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    // nesting depth, so we time only the outermost (whole-tree) pass for each stage.
    static LAYOUT_DEPTH: Cell<u32> = const { Cell::new(0) };
    static PREPAINT_DEPTH: Cell<u32> = const { Cell::new(0) };
    static PAINT_DEPTH: Cell<u32> = const { Cell::new(0) };
    // how many div elements were (re)built this frame — gpui is immediate-mode (its
    // element arena + taffy tree are cleared every draw), so every node is rebuilt every
    // frame by design; this counts them so the per-frame cost can be read per node.
    static REBUILT: Cell<u32> = const { Cell::new(0) };
    // whether root was dirty (real commit) or this was an idle repaint (hover/scroll).
    static ROOT_DIRTY: Cell<bool> = const { Cell::new(false) };
    // named sub-stage accumulators (RNGPUI_FRAME_TRACE=2): attribute the stage totals to
    // specific per-node work without a sampling profiler.
    static NAMED: [Cell<Duration>; NAMED_COUNT] = const { [const { Cell::new(Duration::ZERO) }; NAMED_COUNT] };
}

pub const NAMED_COUNT: usize = 9;
pub const NAMED_LABELS: [&str; NAMED_COUNT] = [
    "style_build",
    "child_create",
    "taffy_request",
    "ax",
    "hitbox",
    "occluder",
    "text_layout",
    "paint_quad",
    "event_flags",
];

static DETAIL: Lazy<bool> =
    Lazy::new(|| std::env::var("RNGPUI_FRAME_TRACE").is_ok_and(|v| v == "2"));

#[inline]
pub fn detail() -> bool {
    *DETAIL
}

/// Time a named sub-stage (detail mode only). Usage: `let _t = named(IDX);`
pub struct NamedGuard(Option<(usize, Instant)>);

pub fn named(idx: usize) -> NamedGuard {
    if !detail() {
        return NamedGuard(None);
    }
    NamedGuard(Some((idx, Instant::now())))
}

impl Drop for NamedGuard {
    fn drop(&mut self) {
        if let Some((idx, start)) = self.0 {
            NAMED.with(|cells| {
                let c = &cells[idx];
                c.set(c.get() + start.elapsed());
            });
        }
    }
}

/// Called at the very top of `ServiceApp::render`. Flushes the *previous* frame's
/// accumulated breakdown (the prior frame's paint has fully completed by now) and
/// resets the per-frame accumulators for the frame about to run.
pub fn begin_render(root_dirty: bool) {
    if !enabled() {
        return;
    }
    flush_previous();
    FRAME_T0.with(|c| c.set(Some(Instant::now())));
    CREATE.with(|c| c.set(Duration::ZERO));
    LAYOUT.with(|c| c.set(Duration::ZERO));
    PREPAINT.with(|c| c.set(Duration::ZERO));
    PAINT.with(|c| c.set(Duration::ZERO));
    REBUILT.with(|c| c.set(0));
    ROOT_DIRTY.with(|c| c.set(root_dirty));
    NAMED.with(|cells| {
        for c in cells {
            c.set(Duration::ZERO);
        }
    });
}

fn flush_previous() {
    if FRAME_T0.with(|c| c.get()).is_none() {
        return;
    }
    let create = CREATE.with(|c| c.get());
    let layout = LAYOUT.with(|c| c.get());
    let prepaint = PREPAINT.with(|c| c.get());
    let paint = PAINT.with(|c| c.get());
    let root_dirty = ROOT_DIRTY.with(|c| c.get());
    let rebuilt = REBUILT.with(|c| c.get());
    let total = create + layout + prepaint + paint;
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    eprintln!(
        "[frame] {} total~{:.2}ms = create {:.2} + layout {:.2} + prepaint {:.2} + paint {:.2} | nodes rebuilt={}",
        if root_dirty { "COMMIT " } else { "idle   " },
        ms(total),
        ms(create),
        ms(layout),
        ms(prepaint),
        ms(paint),
        rebuilt,
    );
    if detail() {
        let parts = NAMED.with(|cells| {
            NAMED_LABELS
                .iter()
                .zip(cells.iter())
                .map(|(label, c)| format!("{label} {:.2}", ms(c.get())))
                .collect::<Vec<_>>()
                .join(" + ")
        });
        eprintln!("[frame-detail] {parts}");
    }
}

pub fn add_create(d: Duration) {
    if enabled() {
        CREATE.with(|c| c.set(c.get() + d));
    }
}

pub fn note_rebuilt() {
    if enabled() {
        REBUILT.with(|c| c.set(c.get() + 1));
    }
}

/// RAII guard timing the outermost request_layout pass (the whole-tree layout).
pub struct LayoutGuard(Option<Instant>);

pub fn layout_guard() -> LayoutGuard {
    if !enabled() {
        return LayoutGuard(None);
    }
    let outer = LAYOUT_DEPTH.with(|c| {
        let d = c.get();
        c.set(d + 1);
        d == 0
    });
    LayoutGuard(if outer { Some(Instant::now()) } else { None })
}

impl Drop for LayoutGuard {
    fn drop(&mut self) {
        if !enabled() {
            return;
        }
        LAYOUT_DEPTH.with(|c| c.set(c.get().saturating_sub(1)));
        if let Some(start) = self.0 {
            LAYOUT.with(|c| c.set(c.get() + start.elapsed()));
        }
    }
}

/// RAII guard timing the outermost prepaint pass.
pub struct PrepaintGuard(Option<Instant>);

pub fn prepaint_guard() -> PrepaintGuard {
    if !enabled() {
        return PrepaintGuard(None);
    }
    let outer = PREPAINT_DEPTH.with(|c| {
        let d = c.get();
        c.set(d + 1);
        d == 0
    });
    PrepaintGuard(if outer { Some(Instant::now()) } else { None })
}

impl Drop for PrepaintGuard {
    fn drop(&mut self) {
        if !enabled() {
            return;
        }
        PREPAINT_DEPTH.with(|c| c.set(c.get().saturating_sub(1)));
        if let Some(start) = self.0 {
            PREPAINT.with(|c| c.set(c.get() + start.elapsed()));
        }
    }
}

/// RAII guard timing the outermost paint pass.
pub struct PaintGuard(Option<Instant>);

pub fn paint_guard() -> PaintGuard {
    if !enabled() {
        return PaintGuard(None);
    }
    let outer = PAINT_DEPTH.with(|c| {
        let d = c.get();
        c.set(d + 1);
        d == 0
    });
    PaintGuard(if outer { Some(Instant::now()) } else { None })
}

impl Drop for PaintGuard {
    fn drop(&mut self) {
        if !enabled() {
            return;
        }
        PAINT_DEPTH.with(|c| c.set(c.get().saturating_sub(1)));
        if let Some(start) = self.0 {
            PAINT.with(|c| c.set(c.get() + start.elapsed()));
        }
    }
}
