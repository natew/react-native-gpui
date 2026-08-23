use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};

use gpui::{AnyElement, IntoElement as _, ParentElement as _, Styled as _, div, px};

static ENABLED: AtomicBool = AtomicBool::new(false);
static INIT: Once = Once::new();

fn initialize() {
    INIT.call_once(|| {
        ENABLED.store(
            std::env::var_os("RNGPUI_PERFORMANCE_HUD").is_some(),
            Ordering::Relaxed,
        );
    });
}

pub fn enabled() -> bool {
    initialize();
    ENABLED.load(Ordering::Relaxed)
}

pub fn set_enabled(enabled: bool) {
    initialize();
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn element(node_count: usize) -> Option<AnyElement> {
    if !enabled() {
        return None;
    }
    let stats = crate::anim_trace::frame_stats_snapshot();
    let gap = stats
        .avg_frame_gap_ms
        .map_or_else(|| "-".to_string(), |value| format!("{value:.1}ms"));
    let last = stats
        .last_frame_ago_ms
        .map_or_else(|| "-".to_string(), |value| format!("{value:.0}ms"));
    Some(
        div()
            .absolute()
            .top(px(8.0))
            .right(px(8.0))
            .px(px(8.0))
            .py(px(5.0))
            .rounded(px(5.0))
            .bg(gpui::rgba(0x101116e8))
            .text_color(gpui::rgba(0xe8eaf0ff))
            .font_family("Menlo")
            .text_size(px(11.0))
            .line_height(px(15.0))
            .child(format!(
                "RNGPUI  {:>3} fps  gap {gap}\nframe {}  last {last}  nodes {node_count}",
                stats.fps_last_1s, stats.frames_painted,
            ))
            .into_any_element(),
    )
}
