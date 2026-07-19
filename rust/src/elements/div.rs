use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Bounds, Corners, CursorStyle, DispatchPhase, Display, Element, ElementId,
    GlobalElementId, Hitbox, HitboxBehavior, Hsla, IntoElement, LayoutId, Modifiers, MouseButton,
    MouseDownEvent, MouseExitEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, ScrollDelta,
    ScrollWheelEvent, Window, div, point, prelude::*, px,
};
use once_cell::sync::Lazy;

use crate::elements::{
    NativeResizeEdge, ReactElement, bounds_have_drawable_area, create_element, report_layout,
};
use crate::style::ElementStyle;

// Scroll offset per scroll-container id, persisted across the continuous
// re-render loop so wheel scrolling sticks.
#[derive(Clone, Copy, Default)]
struct ScrollOffset {
    x: f32,
    y: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct NativeLayoutOverride {
    width: Option<f32>,
    height: Option<f32>,
    x: Option<f32>,
    y: Option<f32>,
}

#[derive(Clone, Copy, Debug, Default)]
struct NativeLayoutFrame {
    width: f32,
    height: f32,
}

#[derive(Clone, Copy, Debug)]
struct NativeLayoutAnimation {
    from_width: Option<f32>,
    to_width: Option<f32>,
    from_height: Option<f32>,
    to_height: Option<f32>,
    from_x: Option<f32>,
    to_x: Option<f32>,
    from_y: Option<f32>,
    to_y: Option<f32>,
    start: Instant,
    duration: Duration,
}

#[derive(Clone, Debug)]
struct ActiveNativeResize {
    handle_id: u64,
    target: String,
    edge: NativeResizeEdge,
    min: Option<f32>,
    max: Option<f32>,
    start_position: f32,
    start_value: f32,
    last_refresh: Instant,
}

#[derive(Clone, Debug)]
struct ActivePressDrag {
    start_id: u64,
    group: Option<String>,
    did_activate: bool,
    left_start: bool,
    start_events: Vec<String>,
    start_bounds: Bounds<Pixels>,
    start_cancelled: bool,
}

#[derive(Clone, Debug)]
struct DragReleaseTarget {
    id: u64,
    events: Vec<String>,
    bounds: Bounds<Pixels>,
    position: Point<Pixels>,
}

static SCROLL: Lazy<Mutex<HashMap<u64, ScrollOffset>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NATIVE_SCROLL_OWNED: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static SCROLL_TO_END: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static PENDING_SCROLL_EVENTS: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static HOVER: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
// ids currently hovered/pressed for the renderer→JS pseudo lane. Separate from HOVER (which is
// maintained only for nodes with JS mouse listeners): a Tamagui node may subscribe to native
// pseudo flips without wiring mouseEnter/mouseLeave handlers.
static PSEUDO_HOVER: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static PRESSED: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
// Hitbox cache for pseudo-enabled elements, used to re-evaluate hover after layout
// changes (scroll, resize) without waiting for the next MouseMoveEvent — a stationary
// mouse doesn't fire MouseMoveEvent, so scrolled-away elements would stay "hovered"
// forever without this (the stuck-hover-in-scroll-list bug).
static PSEUDO_HITBOXES: Lazy<Mutex<HashMap<u64, Hitbox>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

struct ScrollHoverState {
    last_scroll: Instant,
    settler_armed: bool,
    suppressed: bool,
}

static SCROLL_HOVER: Lazy<Mutex<ScrollHoverState>> = Lazy::new(|| {
    Mutex::new(ScrollHoverState {
        last_scroll: Instant::now(),
        settler_armed: false,
        suppressed: false,
    })
});
const SCROLL_HOVER_SETTLE: Duration = Duration::from_millis(80);

// RNGPUI_DRAG_TRACE=1 logs the live press-drag-sweep gate (mouse-down arming +
// per-row cross-sweep activation) so a real scrub can be diagnosed — synth gates
// pass without exercising the live gpui pointer path (the gesture gap).
static DRAG_TRACE: Lazy<bool> = Lazy::new(|| std::env::var_os("RNGPUI_DRAG_TRACE").is_some());
fn drag_trace() -> bool {
    *DRAG_TRACE
}
static ACTIVE_MOUSE_TARGET: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
static CAPTURED_MOUSE_UP_TARGET: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
static ACTIVE_PRESS_DRAG: Lazy<Mutex<Option<ActivePressDrag>>> = Lazy::new(|| Mutex::new(None));
static SYNTH_DRAG_START_TARGET: Lazy<Mutex<Option<DragReleaseTarget>>> =
    Lazy::new(|| Mutex::new(None));
static SYNTH_DRAG_LAST_TARGET: Lazy<Mutex<Option<DragReleaseTarget>>> =
    Lazy::new(|| Mutex::new(None));
static NATIVE_LAYOUT_OVERRIDES: Lazy<Mutex<HashMap<String, NativeLayoutOverride>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NATIVE_LAYOUT_FRAMES: Lazy<Mutex<HashMap<String, NativeLayoutFrame>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NATIVE_LAYOUT_ANIMATIONS: Lazy<Mutex<HashMap<String, NativeLayoutAnimation>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ACTIVE_NATIVE_RESIZE: Lazy<Mutex<Option<ActiveNativeResize>>> =
    Lazy::new(|| Mutex::new(None));

thread_local! {
    // ancestor scroll viewport in window coordinates. Every container uses it
    // to cull descendants, including rows below ScrollView's required content-
    // container wrapper.
    static SCROLL_CULL_VIEWPORTS: RefCell<Vec<Bounds<Pixels>>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone, Default)]
pub struct DivPrepaintState {
    hitbox: Option<Hitbox>,
    max_scroll_x: f32,
    max_scroll_y: f32,
    scroll_offset: Option<ScrollOffset>,
    // child indices an ancestor scroll viewport windowed out this frame: their laid-out
    // bounds fell outside the viewport (+ one screen of overscan each side), so
    // prepaint skipped them and paint must skip the exact same set. `None` for
    // non-culled divs (paint everything, unchanged). this is the scroll-fps win:
    // a long list otherwise prepaints + paints every row on every wheel tick, and
    // gpui has no partial repaint, so the whole off-screen subtree is pure waste.
    culled: Option<HashSet<usize>>,
}

fn get_scroll(id: u64) -> ScrollOffset {
    SCROLL.lock().unwrap().get(&id).copied().unwrap_or_default()
}
fn set_scroll(id: u64, v: ScrollOffset) {
    SCROLL.lock().unwrap().insert(id, v);
}

pub fn claim_native_scroll(id: u64) {
    NATIVE_SCROLL_OWNED.lock().unwrap().insert(id);
    mark_scroll_event(id);
}

fn mark_scroll_event(id: u64) {
    PENDING_SCROLL_EVENTS.lock().unwrap().insert(id);
}

fn take_scroll_event(id: u64) -> bool {
    PENDING_SCROLL_EVENTS.lock().unwrap().remove(&id)
}

fn active_scroll_cull_viewport() -> Option<Bounds<Pixels>> {
    SCROLL_CULL_VIEWPORTS.with(|viewports| viewports.borrow().last().copied())
}

fn with_scroll_cull_viewport<R>(viewport: Bounds<Pixels>, f: impl FnOnce() -> R) -> R {
    SCROLL_CULL_VIEWPORTS.with(|viewports| viewports.borrow_mut().push(viewport));
    let result = f();
    SCROLL_CULL_VIEWPORTS.with(|viewports| {
        viewports.borrow_mut().pop();
    });
    result
}

fn intersect_viewports(inherited: Option<Bounds<Pixels>>, own: Bounds<Pixels>) -> Bounds<Pixels> {
    inherited.map_or(own, |inherited| inherited.intersect(&own))
}

pub fn scroll_to(id: u64, x: Option<f32>, y: Option<f32>) {
    NATIVE_SCROLL_OWNED.lock().unwrap().remove(&id);
    crate::elements::native_scroll::begin_programmatic_scroll(id);
    let current = get_scroll(id);
    set_scroll(
        id,
        ScrollOffset {
            x: x.unwrap_or(current.x).max(0.0),
            y: y.unwrap_or(current.y).max(0.0),
        },
    );
    mark_scroll_event(id);
}

/// Apply a relative scroll delta to a scroll container's persisted offset — the
/// `rngpui do scroll` driver. Clamped to the painted max in paint, so over-scrolling
/// just pins to the end.
#[cfg(not(target_os = "macos"))]
pub fn scroll_by(id: u64, dx: f32, dy: f32) {
    NATIVE_SCROLL_OWNED.lock().unwrap().remove(&id);
    crate::elements::native_scroll::begin_programmatic_scroll(id);
    let current = get_scroll(id);
    set_scroll(
        id,
        ScrollOffset {
            x: (current.x + dx).max(0.0),
            y: (current.y + dy).max(0.0),
        },
    );
    mark_scroll_event(id);
}

pub fn scroll_to_end(id: u64) {
    NATIVE_SCROLL_OWNED.lock().unwrap().remove(&id);
    crate::elements::native_scroll::begin_programmatic_scroll(id);
    SCROLL_TO_END.lock().unwrap().insert(id);
    mark_scroll_event(id);
}

pub fn set_native_layout_override(
    key: &str,
    width: Option<f32>,
    height: Option<f32>,
    x: Option<f32>,
    y: Option<f32>,
) {
    if key.is_empty() {
        return;
    }
    NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().remove(key);
    set_native_layout_override_now(key, width, height, x, y);
}

pub fn animate_native_layout_override(
    key: &str,
    width: Option<f32>,
    height: Option<f32>,
    x: Option<f32>,
    y: Option<f32>,
    duration_ms: f32,
) {
    if key.is_empty() {
        return;
    }
    if duration_ms <= 0.0 || (!duration_ms.is_finite()) {
        set_native_layout_override(key, width, height, x, y);
        return;
    }

    let current = native_layout_override(key);
    let frame = NATIVE_LAYOUT_FRAMES.lock().unwrap().get(key).copied();
    let from_width = width.map(|_| {
        current
            .width
            .or_else(|| frame.map(|frame| frame.width))
            .unwrap_or(0.0)
    });
    let from_height = height.map(|_| {
        current
            .height
            .or_else(|| frame.map(|frame| frame.height))
            .unwrap_or(0.0)
    });
    let from_x = x.map(|_| current.x.unwrap_or(0.0));
    let from_y = y.map(|_| current.y.unwrap_or(0.0));
    NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().insert(
        key.to_string(),
        NativeLayoutAnimation {
            from_width,
            to_width: width,
            from_height,
            to_height: height,
            from_x,
            to_x: x,
            from_y,
            to_y: y,
            start: Instant::now(),
            duration: Duration::from_secs_f32((duration_ms / 1000.0).max(0.001)),
        },
    );
}

fn set_native_layout_override_now(
    key: &str,
    width: Option<f32>,
    height: Option<f32>,
    x: Option<f32>,
    y: Option<f32>,
) {
    let mut overrides = NATIVE_LAYOUT_OVERRIDES.lock().unwrap();
    let mut next = overrides.get(key).copied().unwrap_or_default();
    if width.is_some() {
        next.width = width;
    }
    if height.is_some() {
        next.height = height;
    }
    if x.is_some() {
        next.x = x;
    }
    if y.is_some() {
        next.y = y;
    }
    if next.width.is_none() && next.height.is_none() && next.x.is_none() && next.y.is_none() {
        overrides.remove(key);
    } else {
        overrides.insert(key.to_string(), next);
    }
}

pub fn clear_native_layout_override(key: &str) {
    NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().remove(key);
    NATIVE_LAYOUT_OVERRIDES.lock().unwrap().remove(key);
}

// drop pointer state for unmounted nodes — a node that unmounts while hovered or
// pressed would otherwise leave its id in these sets forever (ids are monotonic,
// so it's a slow leak rather than a correctness hazard).
pub fn retain_pointer_state(present: &HashSet<u64>) {
    HOVER.lock().unwrap().retain(|id| present.contains(id));
    PSEUDO_HOVER
        .lock()
        .unwrap()
        .retain(|id| present.contains(id));
    PRESSED.lock().unwrap().retain(|id| present.contains(id));
    PSEUDO_HITBOXES
        .lock()
        .unwrap()
        .retain(|id, _| present.contains(id));
}

/// Re-evaluate pseudo hover after a layout change (scroll, resize) that may have
/// moved elements out from under a stationary mouse. Without this, elements that
/// were scrolled away keep their "hovered" pseudo state because `MouseMoveEvent`
/// only fires on actual mouse movement, not on scroll — the stuck-hover-in-scroll
/// bug. Called from the scroll container's wheel handler after the offset update.
///
/// Iterates every element that has a registered pseudo hitbox, checks whether the
/// window's current mouse position is still inside that hitbox, and drops any
/// stale entry. This is O(n) in the number of pseudo-enabled elements — the common
/// case is the visible session rows + project picker menu (~dozens, not thousands).
pub fn re_evaluate_pseudo_hover(window: &Window) {
    if SCROLL_HOVER.lock().unwrap().suppressed {
        return;
    }
    let mut changed: Vec<(u64, bool)> = Vec::new();
    {
        let hitboxes = PSEUDO_HITBOXES.lock().unwrap();
        let mut hover = PSEUDO_HOVER.lock().unwrap();
        for (&id, hitbox) in hitboxes.iter() {
            let was_hovered = hover.contains(&id);
            let is_hovered = hitbox.is_hovered(window);
            if was_hovered != is_hovered {
                if is_hovered {
                    hover.insert(id);
                } else {
                    hover.remove(&id);
                }
                changed.push((id, is_hovered));
            }
        }
    }
    for (id, hovered) in changed {
        if !hovered {
            // leaving the element also cancels an in-flight press on it.
            PRESSED.lock().unwrap().remove(&id);
            crate::bridge::pseudo(id, false, false);
        } else {
            let pressed = PRESSED.lock().unwrap().contains(&id);
            crate::bridge::pseudo(id, true, pressed);
        }
    }
}

fn suppress_pseudo_hover_during_native_scroll(window: &Window, cx: &mut App) {
    let should_arm = {
        let mut state = SCROLL_HOVER.lock().unwrap();
        state.last_scroll = Instant::now();
        let should_arm = !state.settler_armed;
        state.settler_armed = true;
        state.suppressed = true;
        should_arm
    };
    if !should_arm {
        return;
    }

    // A stationary pointer can cross dozens of recycled rows during one fling.
    // Sending every intermediate enter/leave through Tamagui produces a React
    // commit at each row boundary and blocks the main thread that presents the
    // scroll. Clear the initial hover once, then reconcile only the final row.
    let hovered = PSEUDO_HOVER.lock().unwrap().drain().collect::<Vec<_>>();
    for id in hovered {
        PRESSED.lock().unwrap().remove(&id);
        crate::bridge::pseudo(id, false, false);
    }

    let window_handle = window.window_handle();
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(SCROLL_HOVER_SETTLE).await;
            let settled = {
                let mut state = SCROLL_HOVER.lock().unwrap();
                if state.last_scroll.elapsed() < SCROLL_HOVER_SETTLE {
                    false
                } else {
                    state.suppressed = false;
                    state.settler_armed = false;
                    true
                }
            };
            if settled {
                let _ = window_handle.update(cx, |_root, window, _cx| {
                    // The retained pseudo hitboxes describe the previous painted
                    // offset. Refresh first; the normal paint path records the final
                    // hitbox and emits exactly that row's enter event.
                    window.refresh();
                });
                break;
            }
        }
    })
    .detach();
}

pub fn retain_native_layout_keys(keys: &HashSet<String>) {
    NATIVE_LAYOUT_OVERRIDES
        .lock()
        .unwrap()
        .retain(|key, _| keys.contains(key));
    NATIVE_LAYOUT_FRAMES
        .lock()
        .unwrap()
        .retain(|key, _| keys.contains(key));
    NATIVE_LAYOUT_ANIMATIONS
        .lock()
        .unwrap()
        .retain(|key, _| keys.contains(key));
}

pub fn retain_scroll_state(ids: &HashSet<u64>) {
    SCROLL.lock().unwrap().retain(|id, _| ids.contains(id));
    NATIVE_SCROLL_OWNED
        .lock()
        .unwrap()
        .retain(|id| ids.contains(id));
    SCROLL_TO_END.lock().unwrap().retain(|id| ids.contains(id));
    PENDING_SCROLL_EVENTS
        .lock()
        .unwrap()
        .retain(|id| ids.contains(id));
}

fn take_scroll_to_end(id: u64) -> bool {
    SCROLL_TO_END.lock().unwrap().remove(&id)
}

/// Seconds since process start, wrapped hourly to keep f32 precision for the
/// smoke shader's time input.
fn smoke_time_seconds() -> f32 {
    (smoke_epoch().elapsed().as_secs_f64() % 3600.0) as f32
}

fn smoke_epoch() -> &'static Instant {
    static EPOCH: Lazy<Instant> = Lazy::new(Instant::now);
    &EPOCH
}

fn native_layout_override(key: &str) -> NativeLayoutOverride {
    let animation = {
        let animations = NATIVE_LAYOUT_ANIMATIONS.lock().unwrap();
        animations.get(key).copied()
    };

    if let Some(animation) = animation {
        let now = Instant::now();
        let (next, done) = native_layout_animation_value(animation, now);
        if done {
            NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().remove(key);
            set_native_layout_override_now(
                key,
                animation.to_width,
                animation.to_height,
                animation.to_x,
                animation.to_y,
            );
            let settled = NATIVE_LAYOUT_OVERRIDES
                .lock()
                .unwrap()
                .get(key)
                .copied()
                .unwrap_or_default();
            crate::anim_trace::record_native_layout(
                key,
                settled.width,
                settled.height,
                settled.x,
                settled.y,
            );
            return settled;
        }
        crate::anim_trace::record_native_layout(key, next.width, next.height, next.x, next.y);
        return next;
    }
    NATIVE_LAYOUT_OVERRIDES
        .lock()
        .unwrap()
        .get(key)
        .copied()
        .unwrap_or_default()
}

/// True while a native pane-resize drag is in progress. The retained-layout fast path
/// must NOT engage during a drag — each drag step moves a pane's width (a taffy box), so
/// the geometry genuinely changes and must be re-solved.
pub fn native_resize_active() -> bool {
    ACTIVE_NATIVE_RESIZE.lock().unwrap().is_some()
}

pub fn native_layout_has_animations() -> bool {
    // Finalize any animation whose duration has fully elapsed, committing its end value
    // as a static override — driven by wall-clock, independent of whether the element was
    // laid out this frame. The 250fps native-layout driver (service.rs) gates its loop
    // purely on this predicate; an animation is otherwise only cleared by request_layout's
    // native_layout_override (div.rs), so an animated element that stops being laid out
    // before it completes — e.g. a collapsed / `display:none` subtree whose key still
    // lingers in the React tree, so retain_native_layout_keys keeps it — would never be
    // removed, and the driver would spin at 250fps forever (CPU pegged + continuous
    // repaint = the "slow + flicker at idle" report). Purging by time here guarantees the
    // loop terminates while still preserving the animation's final committed position.
    let now = Instant::now();
    let expired: Vec<(String, NativeLayoutAnimation)> = {
        let animations = NATIVE_LAYOUT_ANIMATIONS.lock().unwrap();
        animations
            .iter()
            .filter(|(_, animation)| {
                now.saturating_duration_since(animation.start) >= animation.duration
            })
            .map(|(key, animation)| (key.clone(), *animation))
            .collect()
    };
    for (key, animation) in expired {
        NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().remove(&key);
        set_native_layout_override_now(
            &key,
            animation.to_width,
            animation.to_height,
            animation.to_x,
            animation.to_y,
        );
    }
    !NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().is_empty()
}

fn native_layout_animation_value(
    animation: NativeLayoutAnimation,
    now: Instant,
) -> (NativeLayoutOverride, bool) {
    let elapsed = now.saturating_duration_since(animation.start);
    let raw_progress = elapsed.as_secs_f32() / animation.duration.as_secs_f32();
    let done = raw_progress >= 1.0;
    // ease-out-quart: snappier than cubic (faster initial ramp, tighter tail) so a pane
    // reflow reads as immediate. local to native layout — does NOT touch the shared
    // ease_out_cubic used by the overlay tween.
    let progress = ease_out_quart(raw_progress.clamp(0.0, 1.0));
    (
        NativeLayoutOverride {
            width: animation
                .to_width
                .map(|to| lerp(animation.from_width.unwrap_or(to), to, progress)),
            height: animation
                .to_height
                .map(|to| lerp(animation.from_height.unwrap_or(to), to, progress)),
            x: animation
                .to_x
                .map(|to| lerp(animation.from_x.unwrap_or(to), to, progress)),
            y: animation
                .to_y
                .map(|to| lerp(animation.from_y.unwrap_or(to), to, progress)),
        },
        done,
    )
}

pub fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

/// snappier ease-out for native-layout pane reflows (steeper start, tighter settle than
/// cubic). kept separate from `ease_out_cubic` so the shared overlay-tween easing is
/// untouched.
fn ease_out_quart(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(4)
}

pub fn lerp(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t
}

fn remember_native_layout_frame(key: &str, width: f32, height: f32) {
    NATIVE_LAYOUT_FRAMES
        .lock()
        .unwrap()
        .insert(key.to_string(), NativeLayoutFrame { width, height });
}

fn native_layout_value(key: &str, edge: NativeResizeEdge) -> Option<f32> {
    let current = native_layout_override(key);
    if edge.is_horizontal() {
        current.width.or_else(|| {
            NATIVE_LAYOUT_FRAMES
                .lock()
                .unwrap()
                .get(key)
                .map(|frame| frame.width)
        })
    } else {
        current.height.or_else(|| {
            NATIVE_LAYOUT_FRAMES
                .lock()
                .unwrap()
                .get(key)
                .map(|frame| frame.height)
        })
    }
}

fn native_resize_position(edge: NativeResizeEdge, position: Point<Pixels>) -> f32 {
    if edge.is_horizontal() {
        position.x.into()
    } else {
        position.y.into()
    }
}

fn native_resize_cursor(edge: NativeResizeEdge) -> CursorStyle {
    if edge.is_horizontal() {
        CursorStyle::ResizeColumn
    } else {
        CursorStyle::ResizeRow
    }
}

fn update_native_resize(active: &ActiveNativeResize, position: Point<Pixels>) -> bool {
    let delta = (native_resize_position(active.edge, position) - active.start_position)
        * active.edge.delta_sign();
    let mut next = active.start_value + delta;
    if let Some(min) = active.min {
        next = next.max(min);
    }
    if let Some(max) = active.max {
        next = next.min(max);
    }

    let current = native_layout_override(&active.target);
    if active.edge.is_horizontal() {
        let changed = current.width.is_none_or(|value| (value - next).abs() > 0.5);
        if changed {
            set_native_layout_override(&active.target, Some(next), None, None, None);
        }
        changed
    } else {
        let changed = current
            .height
            .is_none_or(|value| (value - next).abs() > 0.5);
        if changed {
            set_native_layout_override(&active.target, None, Some(next), None, None);
        }
        changed
    }
}

fn emit_if(id: u64, enabled: bool, name: &str) {
    if enabled {
        crate::bridge::event(id, name);
    }
}

fn emit_mouse_if(
    id: u64,
    enabled: bool,
    name: &str,
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
) {
    if !enabled {
        return;
    }
    crate::bridge::mouse_event(
        id,
        name,
        position.x.into(),
        position.y.into(),
        (position.x - bounds.origin.x).into(),
        (position.y - bounds.origin.y).into(),
        modifiers.shift,
        modifiers.control,
        modifiers.alt,
        modifiers.platform,
    );
}

fn mouse_button_code(button: MouseButton) -> (i32, i32) {
    match button {
        MouseButton::Left => (0, 1),
        MouseButton::Right => (2, 2),
        MouseButton::Middle => (1, 4),
        MouseButton::Navigate(_) => (0, 0),
    }
}

fn emit_mouse_button_if(
    id: u64,
    enabled: bool,
    name: &str,
    button: MouseButton,
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
) {
    if !enabled {
        return;
    }
    let (button, buttons) = mouse_button_code(button);
    crate::bridge::mouse_event_with_button(
        id,
        name,
        position.x.into(),
        position.y.into(),
        (position.x - bounds.origin.x).into(),
        (position.y - bounds.origin.y).into(),
        modifiers.shift,
        modifiers.control,
        modifiers.alt,
        modifiers.platform,
        button,
        buttons,
    );
}

fn emit_press_drag_mouse_if(
    id: u64,
    enabled: bool,
    name: &str,
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
) {
    if !enabled {
        return;
    }
    crate::bridge::press_drag_mouse_event(
        id,
        name,
        position.x.into(),
        position.y.into(),
        (position.x - bounds.origin.x).into(),
        (position.y - bounds.origin.y).into(),
        modifiers.shift,
        modifiers.control,
        modifiers.alt,
        modifiers.platform,
    );
}

fn events_have_press_action(events: &[String]) -> bool {
    events.iter().any(|event| {
        matches!(
            event.as_str(),
            "press" | "click" | "responderRelease" | "touchEnd" | "mouseUp" | "pointerUp"
        )
    })
}

fn press_drag_groups_match(active_group: &Option<String>, target_group: &Option<String>) -> bool {
    match (active_group.as_deref(), target_group.as_deref()) {
        (Some(active), Some(target)) => active == target,
        (None, None) => true,
        _ => false,
    }
}

fn press_drag_should_activate(
    active: &mut ActivePressDrag,
    target_id: u64,
    target_group: &Option<String>,
) -> bool {
    if target_id == active.start_id && !active.left_start {
        return false;
    }
    if !press_drag_groups_match(&active.group, target_group) {
        return false;
    }
    active.left_start = active.left_start || target_id != active.start_id;
    active.did_activate = true;
    true
}

fn press_drag_mark_left_start(id: u64) {
    let mut guard = ACTIVE_PRESS_DRAG.lock().unwrap();
    if let Some(active) = guard.as_mut()
        && active.start_id == id
    {
        active.left_start = true;
    }
}

fn emit_press_action_sequence(
    id: u64,
    events: &[String],
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
    press_drag: bool,
) {
    for name in [
        "mouseDown",
        "pointerDown",
        "touchStart",
        "startShouldSetResponderCapture",
        "startShouldSetResponder",
        "responderStart",
        "responderGrant",
        "pressIn",
        "mouseUp",
        "pointerUp",
        "touchEnd",
        "responderRelease",
        "responderEnd",
        "pressOut",
        "press",
        "click",
    ] {
        if press_drag {
            emit_press_drag_mouse_if(
                id,
                events.iter().any(|event| event == name),
                name,
                position,
                bounds,
                modifiers,
            );
        } else {
            emit_mouse_if(
                id,
                events.iter().any(|event| event == name),
                name,
                position,
                bounds,
                modifiers,
            );
        }
    }
}

/// Synthesize a full press (mouseDown→pressIn→mouseUp→pressOut→press→click) at a
/// window point on `id`, firing exactly the handlers the node listens for — the same
/// sequence a real left-click produces in `paint`. Used by the `rngpui do tap` driver
/// so the CLI can drive the live tree without OS-level focus theft.
pub fn synth_tap(id: u64, events: &[String], bounds: (f32, f32, f32, f32), x: f32, y: f32) {
    let position = point(px(x), px(y));
    let bounds = Bounds {
        origin: point(px(bounds.0), px(bounds.1)),
        size: gpui::size(px(bounds.2), px(bounds.3)),
    };
    finish_pointer_gesture();
    emit_press_action_sequence(id, events, position, bounds, Modifiers::default(), false);
    finish_pointer_gesture();
}

/// start a synthetic drag on an owned debug-session target. this follows the same
/// state machine as a live left mouse-down, without posting OS-level input or
/// stealing focus from the user.
pub fn synth_drag_start(
    id: u64,
    events: &[String],
    group: Option<&str>,
    bounds: (f32, f32, f32, f32),
    x: f32,
    y: f32,
) {
    let position = point(px(x), px(y));
    let bounds = Bounds {
        origin: point(px(bounds.0), px(bounds.1)),
        size: gpui::size(px(bounds.2), px(bounds.3)),
    };
    let press_action = events_have_press_action(events);
    finish_pointer_gesture();
    *ACTIVE_MOUSE_TARGET.lock().unwrap() = Some(id);
    *CAPTURED_MOUSE_UP_TARGET.lock().unwrap() = None;
    let target = DragReleaseTarget {
        id,
        events: events.to_vec(),
        bounds,
        position,
    };
    *SYNTH_DRAG_START_TARGET.lock().unwrap() = Some(target.clone());
    *SYNTH_DRAG_LAST_TARGET.lock().unwrap() = Some(target);
    if press_action {
        *ACTIVE_PRESS_DRAG.lock().unwrap() = Some(ActivePressDrag {
            start_id: id,
            group: group.map(str::to_string),
            did_activate: false,
            left_start: false,
            start_events: events.to_vec(),
            start_bounds: bounds,
            start_cancelled: false,
        });
    }
    emit_mouse_if(
        id,
        events.iter().any(|event| event == "mouseDown"),
        "mouseDown",
        position,
        bounds,
        Modifiers::default(),
    );
    emit_mouse_if(
        id,
        events.iter().any(|event| event == "pointerDown"),
        "pointerDown",
        position,
        bounds,
        Modifiers::default(),
    );
    emit_mouse_if(
        id,
        events.iter().any(|event| event == "touchStart"),
        "touchStart",
        position,
        bounds,
        Modifiers::default(),
    );
    emit_mouse_if(
        id,
        events
            .iter()
            .any(|event| event == "startShouldSetResponderCapture"),
        "startShouldSetResponderCapture",
        position,
        bounds,
        Modifiers::default(),
    );
    emit_mouse_if(
        id,
        events
            .iter()
            .any(|event| event == "startShouldSetResponder"),
        "startShouldSetResponder",
        position,
        bounds,
        Modifiers::default(),
    );
    emit_mouse_if(
        id,
        events.iter().any(|event| event == "responderStart"),
        "responderStart",
        position,
        bounds,
        Modifiers::default(),
    );
    emit_mouse_if(
        id,
        events.iter().any(|event| event == "responderGrant"),
        "responderGrant",
        position,
        bounds,
        Modifiers::default(),
    );
    emit_mouse_if(
        id,
        events.iter().any(|event| event == "pressIn"),
        "pressIn",
        position,
        bounds,
        Modifiers::default(),
    );
}

/// move a synthetic drag over a target. grouped press targets activate through
/// `activate_drag_press_if_needed`, the same path live mouse movement uses when a
/// pressed pointer sweeps into another row.
pub fn synth_drag_move(
    id: u64,
    events: &[String],
    group: Option<&str>,
    bounds: (f32, f32, f32, f32),
    x: f32,
    y: f32,
) -> bool {
    let position = point(px(x), px(y));
    let bounds = Bounds {
        origin: point(px(bounds.0), px(bounds.1)),
        size: gpui::size(px(bounds.2), px(bounds.3)),
    };
    let group = group.map(str::to_string);
    let entered = {
        let mut last = SYNTH_DRAG_LAST_TARGET.lock().unwrap();
        let changed = last.as_ref().is_none_or(|target| target.id != id);
        *last = Some(DragReleaseTarget {
            id,
            events: events.to_vec(),
            bounds,
            position,
        });
        changed
    };
    let activated = if entered && events_have_press_action(events) {
        activate_drag_press_if_needed(id, &group, events, position, bounds, Modifiers::default())
    } else {
        false
    };
    let active_target = *ACTIVE_MOUSE_TARGET.lock().unwrap();
    // a real captured drag keeps delivering move events to the element that grabbed
    // the press, even as the pointer wanders over OTHER elements (the
    // target_receives_captured_pointer_event branch in the live MouseMoveEvent
    // handler). The hit-test-driven synth path above only targets the element under
    // the cursor, so a trigger-anchored gesture (press a trigger, drag into a
    // separate popover the trigger spawned — e.g. the project picker menu) never saw
    // its captured moves. Mirror the live handler: when the captured target isn't the
    // hit-tested one, also emit its move at the current position using its own stored
    // bounds, so its locationY is correct for the popover hit-test it drives in JS.
    if let Some(captured_id) = active_target
        && captured_id != id
        && let Some(start) = SYNTH_DRAG_START_TARGET.lock().unwrap().clone()
        && start.id == captured_id
    {
        emit_mouse_if(
            captured_id,
            start.events.iter().any(|event| event == "mouseMove"),
            "mouseMove",
            position,
            start.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            captured_id,
            start.events.iter().any(|event| event == "pointerMove"),
            "pointerMove",
            position,
            start.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            captured_id,
            start.events.iter().any(|event| event == "touchMove"),
            "touchMove",
            position,
            start.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            captured_id,
            start.events.iter().any(|event| event == "responderMove"),
            "responderMove",
            position,
            start.bounds,
            Modifiers::default(),
        );
    }
    if target_receives_captured_pointer_event(active_target, id, true) {
        emit_mouse_if(
            id,
            events.iter().any(|event| event == "mouseMove"),
            "mouseMove",
            position,
            bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            id,
            events.iter().any(|event| event == "pointerMove"),
            "pointerMove",
            position,
            bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            id,
            events.iter().any(|event| event == "touchMove"),
            "touchMove",
            position,
            bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            id,
            events.iter().any(|event| event == "responderMove"),
            "responderMove",
            position,
            bounds,
            Modifiers::default(),
        );
    }
    activated
}

/// finish a synthetic drag with the same release cleanup the live mouse-up path emits.
pub fn synth_drag_end() {
    let start = SYNTH_DRAG_START_TARGET.lock().unwrap().clone();
    let last = SYNTH_DRAG_LAST_TARGET.lock().unwrap().clone();
    let active_target = *ACTIVE_MOUSE_TARGET.lock().unwrap();
    let mut target = match (active_target, start, last) {
        (Some(active_id), Some(start), last) if active_id == start.id => {
            let position = last
                .as_ref()
                .map(|target| target.position)
                .unwrap_or(start.position);
            DragReleaseTarget { position, ..start }
        }
        (Some(active_id), _, Some(last)) if active_id == last.id => last,
        (_, _, Some(last)) => last,
        (_, Some(start), _) => start,
        _ => {
            finish_pointer_gesture();
            return;
        }
    };
    if let Some(last) = SYNTH_DRAG_LAST_TARGET.lock().unwrap().clone() {
        target.position = last.position;
    }
    let captured_up_target = *CAPTURED_MOUSE_UP_TARGET.lock().unwrap();
    let captured = active_target == Some(target.id);
    let suppress_action = captured && press_drag_should_suppress_captured_action(target.id);
    let inside = target.bounds.contains(&target.position);
    if target_receives_pointer_up_event(active_target, captured_up_target, target.id, inside) {
        if captured {
            *ACTIVE_MOUSE_TARGET.lock().unwrap() = None;
            *CAPTURED_MOUSE_UP_TARGET.lock().unwrap() = Some(target.id);
            *ACTIVE_PRESS_DRAG.lock().unwrap() = None;
        }
        emit_mouse_if(
            target.id,
            target.events.iter().any(|event| event == "mouseUp") && !suppress_action,
            "mouseUp",
            target.position,
            target.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            target.id,
            target.events.iter().any(|event| event == "pointerUp") && !suppress_action,
            "pointerUp",
            target.position,
            target.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            target.id,
            target.events.iter().any(|event| event == "touchEnd") && !suppress_action,
            "touchEnd",
            target.position,
            target.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            target.id,
            target
                .events
                .iter()
                .any(|event| event == "responderRelease")
                && !suppress_action,
            "responderRelease",
            target.position,
            target.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            target.id,
            target.events.iter().any(|event| event == "responderEnd"),
            "responderEnd",
            target.position,
            target.bounds,
            Modifiers::default(),
        );
        emit_mouse_if(
            target.id,
            target.events.iter().any(|event| event == "pressOut") && !suppress_action,
            "pressOut",
            target.position,
            target.bounds,
            Modifiers::default(),
        );
        if inside {
            emit_mouse_if(
                target.id,
                target.events.iter().any(|event| event == "press") && !suppress_action,
                "press",
                target.position,
                target.bounds,
                Modifiers::default(),
            );
            emit_mouse_if(
                target.id,
                target.events.iter().any(|event| event == "click") && !suppress_action,
                "click",
                target.position,
                target.bounds,
                Modifiers::default(),
            );
        }
    }
    finish_pointer_gesture();
}

fn emit_press_cancel_sequence(
    id: u64,
    events: &[String],
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
) {
    for name in [
        "touchCancel",
        "responderTerminationRequest",
        "responderTerminate",
        "pressOut",
    ] {
        emit_mouse_if(
            id,
            events.iter().any(|event| event == name),
            name,
            position,
            bounds,
            modifiers,
        );
    }
}

fn press_drag_should_suppress_captured_action(id: u64) -> bool {
    ACTIVE_PRESS_DRAG
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|active| active.start_id == id && active.did_activate)
}

fn activate_drag_press_if_needed(
    id: u64,
    group: &Option<String>,
    events: &[String],
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
) -> bool {
    let mut guard = ACTIVE_PRESS_DRAG.lock().unwrap();
    let mut cancel_start: Option<(u64, Vec<String>, Bounds<Pixels>)> = None;
    let should_activate = match guard.as_mut() {
        Some(active) => {
            if !press_drag_should_activate(active, id, group) {
                false
            } else {
                if !active.start_cancelled {
                    active.start_cancelled = true;
                    cancel_start = Some((
                        active.start_id,
                        active.start_events.clone(),
                        active.start_bounds,
                    ));
                }
                true
            }
        }
        None => false,
    };
    drop(guard);
    if !should_activate {
        return false;
    };
    if let Some((start_id, start_events, start_bounds)) = cancel_start {
        emit_press_cancel_sequence(start_id, &start_events, position, start_bounds, modifiers);
    }
    emit_press_action_sequence(id, events, position, bounds, modifiers, true);
    true
}

pub fn finish_pointer_gesture() {
    *ACTIVE_MOUSE_TARGET.lock().unwrap() = None;
    *CAPTURED_MOUSE_UP_TARGET.lock().unwrap() = None;
    *ACTIVE_PRESS_DRAG.lock().unwrap() = None;
    *SYNTH_DRAG_START_TARGET.lock().unwrap() = None;
    *SYNTH_DRAG_LAST_TARGET.lock().unwrap() = None;
}

/// (clip, scroll) for an overflow value.
fn overflow_mode(style: &ElementStyle) -> (bool, bool) {
    match style.overflow.as_deref() {
        Some("scroll") | Some("auto") => (true, true),
        Some("hidden") => (true, false),
        _ => (false, false),
    }
}

/// The main RN View / container element in GPUI.
pub struct ReactDivElement {
    element: Arc<ReactElement>,
    window_id: u64,
    children: Vec<StackedChild>,
    /// the style built in request_layout, reused by paint — building (cloning) the
    /// gpui::Style twice per node per frame was a measurable slice of every frame.
    computed_style: Option<gpui::Style>,
}

struct StackedChild {
    element: AnyElement,
    z_index: i32,
}

impl ReactDivElement {
    pub fn new(element: Arc<ReactElement>, window_id: u64) -> Self {
        Self {
            element,
            window_id,
            children: Vec::new(),
            computed_style: None,
        }
    }

    /// Total height of children (content), used to clamp scrolling.
    fn content_size(
        layout: &[LayoutId],
        window: &mut Window,
        left: Pixels,
        top: Pixels,
    ) -> (Pixels, Pixels) {
        let mut right = left;
        let mut bottom = top;
        for lid in layout {
            let b = window.layout_bounds(*lid);
            if b.right() > right {
                right = b.right();
            }
            if b.bottom() > bottom {
                bottom = b.bottom();
            }
        }
        ((right - left).max(px(0.0)), (bottom - top).max(px(0.0)))
    }

    /// The child indices in stacking (paint) order. In the overwhelmingly common case
    /// where no child overrides `z-index`, document order already IS stacking order, so
    /// this yields `0..len` with **zero allocation** — paint/prepaint each call it once
    /// per div per frame, so at cliff scale (hundreds of divs) the old
    /// `Vec`-allocate-then-collect on every call was pure per-frame heap churn. Only a div
    /// that actually carries a z-reordered child pays for the sort + index Vec.
    fn stacked_child_indices(&self) -> StackedChildOrder {
        if self.children.iter().all(|child| child.z_index == 0) {
            return StackedChildOrder::DocumentOrder(self.children.len());
        }
        StackedChildOrder::Reordered(stacked_child_indices_for(
            self.children.iter().map(|child| child.z_index),
        ))
    }
}

/// Stable z-index stacking order for a child z-index sequence (ascending z, ties keep
/// document order). Only reached when some child overrides `z-index`.
fn stacked_child_indices_for(z_indices: impl IntoIterator<Item = i32>) -> Vec<usize> {
    let mut indexed: Vec<(usize, i32)> = z_indices.into_iter().enumerate().collect();
    indexed.sort_by_key(|(index, z_index)| (*z_index, *index));
    indexed.into_iter().map(|(index, _)| index).collect()
}

/// Child paint order: either plain document order (no allocation) or an explicit
/// z-sorted index list (only when a child overrides `z-index`). `iter()` yields a
/// concrete (non-boxed) iterator so the common path allocates nothing.
enum StackedChildOrder {
    DocumentOrder(usize),
    Reordered(Vec<usize>),
}

impl StackedChildOrder {
    fn iter(&self) -> StackedChildOrderIter<'_> {
        match self {
            StackedChildOrder::DocumentOrder(len) => StackedChildOrderIter::Range(0..*len),
            StackedChildOrder::Reordered(order) => {
                StackedChildOrderIter::Slice(order.iter().copied())
            }
        }
    }
}

enum StackedChildOrderIter<'a> {
    Range(std::ops::Range<usize>),
    Slice(std::iter::Copied<std::slice::Iter<'a, usize>>),
}

impl Iterator for StackedChildOrderIter<'_> {
    type Item = usize;
    fn next(&mut self) -> Option<usize> {
        match self {
            StackedChildOrderIter::Range(range) => range.next(),
            StackedChildOrderIter::Slice(slice) => slice.next(),
        }
    }
}

fn target_receives_captured_pointer_event(
    active_target: Option<u64>,
    target_id: u64,
    inside_target: bool,
) -> bool {
    match active_target {
        Some(active_target) => active_target == target_id,
        None => inside_target,
    }
}

fn target_receives_pointer_up_event(
    active_target: Option<u64>,
    captured_up_target: Option<u64>,
    target_id: u64,
    inside_target: bool,
) -> bool {
    if captured_up_target.is_some() && captured_up_target != Some(target_id) {
        return false;
    }
    target_receives_captured_pointer_event(active_target, target_id, inside_target)
}

// inner corner radii for an `overflow: hidden` container, matching the element's
// own rounded background/border (outer radius minus the border it sits behind).
// these become the content mask's `corner_radii`, so gpui's fragment shaders clip
// the covered descendant primitives (source-over quad/text/image/shadow/underline
// plus fade) to the rounded shape, not just the bounding rect. this reaches even an
// absolutely-positioned child that overflows past a corner, whose own corner is
// elsewhere. all-zero radii are the shader's fast path (a plain rect mask).
fn overflow_clip_radii(
    bounds: Bounds<Pixels>,
    style: &gpui::Style,
    rem_size: Pixels,
) -> Corners<Pixels> {
    let corner_radii = style
        .corner_radii
        .to_pixels(rem_size)
        .clamp_radii_for_quad_size(bounds.size);
    let border_widths = style.border_widths.to_pixels(rem_size);
    Corners {
        top_left: inner_corner_radius(corner_radii.top_left, border_widths.left, border_widths.top),
        top_right: inner_corner_radius(
            corner_radii.top_right,
            border_widths.right,
            border_widths.top,
        ),
        bottom_right: inner_corner_radius(
            corner_radii.bottom_right,
            border_widths.right,
            border_widths.bottom,
        ),
        bottom_left: inner_corner_radius(
            corner_radii.bottom_left,
            border_widths.left,
            border_widths.bottom,
        ),
    }
}

fn inner_corner_radius(
    radius: Pixels,
    horizontal_border: Pixels,
    vertical_border: Pixels,
) -> Pixels {
    let radius: f32 = radius.into();
    let horizontal_border: f32 = horizontal_border.into();
    let vertical_border: f32 = vertical_border.into();
    px((radius - horizontal_border.max(vertical_border)).max(0.0))
}

impl Element for ReactDivElement {
    type PrepaintState = DivPrepaintState;
    type RequestLayoutState = Vec<LayoutId>;

    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Integer(self.element.global_id))
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let _trace = crate::frame_trace::layout_guard();
        crate::frame_trace::note_rebuilt();
        let mut style = self.element.build_gpui_style(None);
        if let Some(key) = self.element.native_layout_key.as_deref() {
            let native = native_layout_override(key);
            if let Some(width) = native.width {
                style.size.width = px(width).into();
            }
            if let Some(height) = native.height {
                style.size.height = px(height).into();
            }
            if let Some(x) = native.x {
                style.inset.left = px(x).into();
            }
            if let Some(y) = native.y {
                style.inset.top = px(y).into();
            }
        }
        if style.display == Display::None {
            self.children.clear();
            let layout_id = window.request_layout(style, [], cx);
            return (layout_id, Vec::new());
        }

        // Build children
        {
            let _t = crate::frame_trace::named(1);
            self.children = self
                .element
                .children
                .iter()
                .map(|child| StackedChild {
                    element: create_element(child.clone(), self.window_id),
                    z_index: child.style.z_index.unwrap_or(0),
                })
                .collect();
        }

        // If element has text content, add it
        let mut pushed_text = false;
        if let Some(ref text) = self.element.text {
            if !text.is_empty() {
                let text_color = self.element.style.color.unwrap_or(Hsla {
                    h: 0.0,
                    s: 0.0,
                    l: 1.0,
                    a: 1.0,
                });
                let text_size = self.element.style.font_size.unwrap_or(14.0);
                let mut te = div().text_color(text_color).text_size(px(text_size));
                if let Some(fam) = self.element.style.gpui_font_family() {
                    te = te.font_family(fam);
                }
                if let Some(lh) = self.element.style.line_height {
                    te = te.line_height(px(lh));
                }
                if let Some(weight) = self.element.style.gpui_font_weight() {
                    te = te.font_weight(weight);
                }
                self.children.push(StackedChild {
                    element: te.child(text.clone()).into_any_element(),
                    z_index: 0,
                });
                pushed_text = true;
            }
        }

        // The text child is pushed LAST, after the regular children. On an incremental frame
        // a text change never shows up in the taffy Style, so signal it right before that one
        // child is requested — marking earlier would dirty a measured node inside the regular
        // children instead, and the node whose text actually changed would keep a stale
        // cached measure (silently wrong geometry).
        let text_index = if pushed_text {
            self.children.len().checked_sub(1)
        } else {
            None
        };
        let text_dirty =
            text_index.is_some() && crate::elements::text_changed(self.element.global_id);
        let mut child_ids: Vec<LayoutId> = Vec::with_capacity(self.children.len());
        for (index, child) in self.children.iter_mut().enumerate() {
            if text_dirty && Some(index) == text_index {
                window.mark_next_measured_dirty();
            }
            child_ids.push(child.element.request_layout(window, cx));
        }

        let _t = crate::frame_trace::named(2);
        // stash the built style for paint — the same element instance carries through
        // this frame's stages, so paint must not rebuild (clone) it a second time.
        self.computed_style = Some(style.clone());
        let layout_id = window.request_layout(style, child_ids.iter().copied(), cx);
        (layout_id, child_ids)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let _trace = crate::frame_trace::prepaint_guard();
        if self.element.style.is_display_none() {
            return DivPrepaintState::default();
        }

        #[cfg(target_os = "macos")]
        {
            let _t = crate::frame_trace::named(3);
            crate::ax::update_frame(window, &self.element, bounds);
        }

        let (_, scroll) = overflow_mode(&self.element.style);

        // claim a hitbox for any view that handles pointer or scroll input.
        // insert_hitbox must run in prepaint (gpui asserts the phase); mouse
        // listeners are wired in paint and query the hitbox's current hover state.
        let interactive = self.element.native_resize.is_some()
            // a node that opted into the renderer→JS pseudo lane (pseudoEvents) also
            // needs a hitbox so the paint pass can detect hover/press flips and emit them.
            || self.element.pseudo_events
            || self.element.interactive;
        let cursor = self.element.style.cursor.is_some();
        let hitbox = if interactive || scroll || cursor {
            let _t = crate::frame_trace::named(4);
            Some(window.insert_hitbox(bounds, HitboxBehavior::Normal))
        } else {
            None
        };

        // record this element as a hit-test occluder when it has a visible background or
        // handles pointer input, so it blocks native webview passthrough wherever it
        // paints over a webview (e.g. the floating composer / command palette over the
        // timeline). see `crate::hit_passthrough`.
        let has_visible_bg = self.element.style.background_image.is_some()
            || self
                .element
                .style
                .background_color
                .is_some_and(|c| c.a > 0.0);
        if interactive || has_visible_bg {
            let _t = crate::frame_trace::named(5);
            crate::hit_passthrough::record_occluder(
                bounds.origin.x.into(),
                bounds.origin.y.into(),
                bounds.size.width.into(),
                bounds.size.height.into(),
            );
        }

        let mut max_scroll_x = 0.0;
        let mut max_scroll_y = 0.0;
        let mut culled: Option<HashSet<usize>> = None;
        if !bounds_have_drawable_area(bounds) {
            return DivPrepaintState {
                hitbox,
                max_scroll_x,
                max_scroll_y,
                scroll_offset: None,
                culled,
            };
        }
        let inherited_viewport = active_scroll_cull_viewport();
        let mut scroll_offset = None;
        let mut child_viewport = inherited_viewport;
        if scroll {
            // clamp the stored offset to the scrollable range, then shift children up
            // by it (in prepaint, so hit-testing matches what's painted).
            let (content_w, content_h) =
                Self::content_size(request_layout, window, bounds.left(), bounds.top());
            max_scroll_x = (content_w - bounds.size.width).max(px(0.0)).into();
            max_scroll_y = (content_h - bounds.size.height).max(px(0.0)).into();
            let current = get_scroll(self.element.global_id);
            let off = if take_scroll_to_end(self.element.global_id) {
                ScrollOffset {
                    x: current.x.clamp(0.0, max_scroll_x),
                    y: max_scroll_y,
                }
            } else {
                let (x, y) = crate::elements::native_scroll::resolve_offset(
                    self.element.global_id,
                    current.x,
                    current.y,
                    max_scroll_x,
                    max_scroll_y,
                    NATIVE_SCROLL_OWNED
                        .lock()
                        .unwrap()
                        .contains(&self.element.global_id),
                );
                ScrollOffset { x, y }
            };
            set_scroll(self.element.global_id, off);
            scroll_offset = Some(off);

            crate::elements::native_scroll::sync_driver(
                window,
                self.element.global_id,
                bounds,
                f32::from(content_w),
                f32::from(content_h),
                off.x,
                off.y,
                self.element.shows_horizontal_scroll_indicator,
                self.element.shows_vertical_scroll_indicator,
            );
            if take_scroll_event(self.element.global_id) && self.element.listens("scroll") {
                let width: f32 = bounds.size.width.into();
                let height: f32 = bounds.size.height.into();
                crate::bridge::scroll_event(
                    self.element.global_id,
                    off.x,
                    off.y,
                    width,
                    height,
                    width + max_scroll_x,
                    height + max_scroll_y,
                );
            }
            // visible bounds plus one screen of overscan on every side, so a fast fling
            // never out-runs the window and pops in blank. `window.layout_bounds` adds
            // the active element offset, so this viewport stays in window coordinates
            // while the child bounds below are shifted by the scroll offset.
            let w = bounds.size.width;
            let h = bounds.size.height;
            let (vx0, vy0, vx1, vy1) = (
                bounds.origin.x - w,
                bounds.origin.y - h,
                bounds.right() + w,
                bounds.bottom() + h,
            );
            let own = Bounds::new(point(vx0, vy0), gpui::size(vx1 - vx0, vy1 - vy0));
            child_viewport = Some(intersect_viewports(inherited_viewport, own));
        }

        let order = self.stacked_child_indices();
        let mut prepaint_children = |window: &mut Window, cx: &mut App| {
            let mut skipped = HashSet::new();
            for index in order.iter() {
                let visible = child_viewport.is_none_or(|viewport| {
                    let child = window.layout_bounds(request_layout[index]);
                    child.right() > viewport.left()
                        && child.left() < viewport.right()
                        && child.bottom() > viewport.top()
                        && child.top() < viewport.bottom()
                });
                if visible {
                    self.children[index].element.prepaint(window, cx);
                } else {
                    skipped.insert(index);
                }
            }
            if !skipped.is_empty() {
                culled = Some(skipped);
            }
        };
        let mut with_viewport = |window: &mut Window, cx: &mut App| {
            if let Some(viewport) = child_viewport {
                with_scroll_cull_viewport(viewport, || prepaint_children(window, cx));
            } else {
                prepaint_children(window, cx);
            }
        };
        if let Some(off) = scroll_offset {
            window.with_element_offset(point(px(-off.x), px(-off.y)), |window| {
                with_viewport(window, cx);
            });
        } else {
            with_viewport(window, cx);
        }

        DivPrepaintState {
            hitbox,
            max_scroll_x,
            max_scroll_y,
            scroll_offset,
            culled,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let _trace = crate::frame_trace::paint_guard();
        if self.element.style.is_display_none() {
            return;
        }
        if !bounds_have_drawable_area(bounds) {
            report_layout(&self.element, bounds);
            return;
        }

        // reuse the style request_layout built this frame (it differs only by the
        // native-layout size/inset overrides, which paint never reads — geometry comes
        // from taffy bounds). rebuilding here doubled the per-node style cost.
        let mut style = self
            .computed_style
            .take()
            .unwrap_or_else(|| self.element.build_gpui_style(None));
        let (clip, scroll) = overflow_mode(&self.element.style);

        // native AppKit drivers report absolute offsets. synthetic debug
        // input and non-macOS platforms keep the delta path through the same listener.
        if scroll {
            let id = self.element.global_id;
            let max_scroll_x = prepaint.max_scroll_x;
            let max_scroll_y = prepaint.max_scroll_y;
            let hitbox = prepaint.hitbox.clone();
            window.on_mouse_event(move |ev: &ScrollWheelEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let native = ev.native_scroll_id.zip(ev.native_scroll_offset);
                if native.is_some_and(|(native_id, _)| native_id != id) {
                    return;
                }
                if native.is_none()
                    && !hitbox
                        .as_ref()
                        .is_some_and(|hitbox| hitbox.should_handle_scroll(window))
                {
                    return;
                }
                {
                    let dy: f32 = match ev.delta {
                        ScrollDelta::Lines(p) => p.y * 32.0,
                        ScrollDelta::Pixels(p) => p.y.into(),
                    };
                    let dx: f32 = match ev.delta {
                        ScrollDelta::Lines(p) => p.x * 32.0,
                        ScrollDelta::Pixels(p) => p.x.into(),
                    };
                    let cur = get_scroll(id);
                    let next = native.map_or_else(
                        || ScrollOffset {
                            x: (cur.x - dx).clamp(0.0, max_scroll_x),
                            y: (cur.y - dy).clamp(0.0, max_scroll_y),
                        },
                        |(_, offset)| ScrollOffset {
                            // AppKit owns transient rubber-band coordinates. Preserve
                            // them through paint; source/programmatic offsets are
                            // clamped by resolve_offset during prepaint.
                            x: f32::from(offset.x),
                            y: f32::from(offset.y),
                        },
                    );
                    if (next.x - cur.x).abs() > 0.01 || (next.y - cur.y).abs() > 0.01 {
                        if native.is_some() {
                            NATIVE_SCROLL_OWNED.lock().unwrap().insert(id);
                            suppress_pseudo_hover_during_native_scroll(window, cx);
                        }
                        set_scroll(id, next);
                        mark_scroll_event(id);
                        // scrolling moves elements under a stationary mouse, so
                        // re-evaluate pseudo hover before repainting — otherwise
                        // scrolled-away elements keep a stale :hover state.
                        re_evaluate_pseudo_hover(window);
                        crate::anim_overlay::arm_paint_only_frame();
                        window.refresh();
                        cx.stop_propagation();
                    }
                }
            });
        }

        if let (Some(spec), Some(hitbox)) =
            (self.element.native_resize.clone(), prepaint.hitbox.clone())
        {
            let id = self.element.global_id;
            let event_bounds = hitbox.bounds.intersect(&hitbox.content_mask.bounds);
            let down_spec = spec.clone();
            window.on_mouse_event(move |ev: &MouseDownEvent, phase, _window, cx| {
                if phase == DispatchPhase::Bubble
                    && ev.button == MouseButton::Left
                    && event_bounds.contains(&ev.position)
                {
                    let start_value = native_layout_value(&down_spec.target, down_spec.edge)
                        .unwrap_or_else(|| down_spec.min.unwrap_or(0.0));
                    *ACTIVE_NATIVE_RESIZE.lock().unwrap() = Some(ActiveNativeResize {
                        handle_id: id,
                        target: down_spec.target.clone(),
                        edge: down_spec.edge,
                        min: down_spec.min,
                        max: down_spec.max,
                        start_position: native_resize_position(down_spec.edge, ev.position),
                        start_value,
                        last_refresh: Instant::now(),
                    });
                    cx.stop_propagation();
                }
            });

            window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let active = ACTIVE_NATIVE_RESIZE.lock().unwrap().clone();
                if let Some(active) = active.filter(|active| active.handle_id == id) {
                    if update_native_resize(&active, ev.position) {
                        // Throttle refresh to ~60fps during resize: on high-refresh
                        // displays (120Hz ProMotion) the MouseMoveEvent fires every
                        // ~8ms, but repainting the full window tree at that rate
                        // drops frames. A 16ms minimum interval caps render cost at
                        // the display's typical refresh rate.
                        let now = Instant::now();
                        let min_frame = Duration::from_secs_f32(1.0 / 60.0);
                        if now.saturating_duration_since(active.last_refresh) >= min_frame {
                            window.refresh();
                            if let Some(current) = ACTIVE_NATIVE_RESIZE.lock().unwrap().as_mut() {
                                current.last_refresh = now;
                            }
                        }
                    }
                    cx.stop_propagation();
                }
            });

            window.on_mouse_event(move |ev: &MouseUpEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble || ev.button != MouseButton::Left {
                    return;
                }
                let mut active = ACTIVE_NATIVE_RESIZE.lock().unwrap();
                if active.as_ref().is_some_and(|active| active.handle_id == id) {
                    *active = None;
                    cx.stop_propagation();
                }
            });
        }

        // pointer events: emit react native press and desktop mouse events to js. bounds-gated; bubbling.
        let id = self.element.global_id;
        let click = self.element.listens("click");
        let context_menu = self.element.listens("contextMenu");
        let mouse_down = self.element.listens("mouseDown");
        let mouse_up = self.element.listens("mouseUp");
        let mouse_enter = self.element.listens("mouseEnter");
        let mouse_leave = self.element.listens("mouseLeave");
        let mouse_over = self.element.listens("mouseOver");
        let mouse_out = self.element.listens("mouseOut");
        let mouse_move = self.element.listens("mouseMove");
        let pointer_down = self.element.listens("pointerDown");
        let pointer_up = self.element.listens("pointerUp");
        let pointer_enter = self.element.listens("pointerEnter");
        let pointer_leave = self.element.listens("pointerLeave");
        let pointer_move = self.element.listens("pointerMove");
        let touch_start = self.element.listens("touchStart");
        let touch_move = self.element.listens("touchMove");
        let touch_end = self.element.listens("touchEnd");
        let touch_cancel = self.element.listens("touchCancel");
        let start_responder = self.element.listens("startShouldSetResponder");
        let start_responder_capture = self.element.listens("startShouldSetResponderCapture");
        let responder_grant = self.element.listens("responderGrant");
        let responder_move = self.element.listens("responderMove");
        let responder_release = self.element.listens("responderRelease");
        let responder_start = self.element.listens("responderStart");
        let responder_end = self.element.listens("responderEnd");
        let responder_terminate = self.element.listens("responderTerminate");
        let responder_termination_request = self.element.listens("responderTerminationRequest");
        let press = self.element.listens("press") || self.element.listens("longPress");
        let press_in = self.element.listens("pressIn");
        let press_out = self.element.listens("pressOut");
        let press_action = events_have_press_action(&self.element.events);
        let press_group = self.element.native_list_group.clone();
        let event_names = self.element.events.clone();
        let tracks_pointer = click
            || context_menu
            || mouse_down
            || mouse_up
            || mouse_enter
            || mouse_leave
            || mouse_over
            || mouse_out
            || mouse_move
            || pointer_down
            || pointer_up
            || pointer_enter
            || pointer_leave
            || pointer_move
            || touch_start
            || touch_move
            || touch_end
            || touch_cancel
            || start_responder
            || start_responder_capture
            || responder_grant
            || responder_move
            || responder_release
            || responder_start
            || responder_end
            || responder_terminate
            || responder_termination_request
            || press
            || press_in
            || press_out;
        if tracks_pointer {
            if let Some(hitbox) = prepaint.hitbox.clone() {
                if context_menu {
                    let event_bounds = hitbox.bounds.intersect(&hitbox.content_mask.bounds);
                    let layout_bounds = bounds;
                    window.on_mouse_event(move |ev: &MouseDownEvent, phase, _window, _cx| {
                        if phase == DispatchPhase::Bubble
                            && ev.button == MouseButton::Right
                            && event_bounds.contains(&ev.position)
                        {
                            emit_mouse_button_if(
                                id,
                                true,
                                "contextMenu",
                                ev.button,
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                        }
                    });
                }
                if mouse_down
                    || pointer_down
                    || touch_start
                    || start_responder
                    || start_responder_capture
                    || responder_grant
                    || responder_start
                    || press_in
                    || press_action
                {
                    let event_bounds = hitbox.bounds.intersect(&hitbox.content_mask.bounds);
                    let layout_bounds = bounds;
                    let press_group_for_down = press_group.clone();
                    let event_names_for_down = event_names.clone();
                    window.on_mouse_event(move |ev: &MouseDownEvent, phase, _window, _cx| {
                        if phase == DispatchPhase::Bubble
                            && ev.button == MouseButton::Left
                            && event_bounds.contains(&ev.position)
                        {
                            *CAPTURED_MOUSE_UP_TARGET.lock().unwrap() = None;
                            let mut active = ACTIVE_MOUSE_TARGET.lock().unwrap();
                            if active.is_none() {
                                *active = Some(id);
                            }
                            let active_target = *active;
                            drop(active);
                            if drag_trace() {
                                eprintln!(
                                    "[drag-trace] DOWN id={id} press_action={press_action} active_target={active_target:?} group={:?}",
                                    press_group_for_down
                                );
                            }
                            if press_action && active_target == Some(id) {
                                *ACTIVE_PRESS_DRAG.lock().unwrap() = Some(ActivePressDrag {
                                    start_id: id,
                                    group: press_group_for_down.clone(),
                                    did_activate: false,
                                    left_start: false,
                                    start_events: event_names_for_down.clone(),
                                    start_bounds: layout_bounds,
                                    start_cancelled: false,
                                });
                            }
                            emit_mouse_if(
                                id,
                                mouse_down,
                                "mouseDown",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                pointer_down,
                                "pointerDown",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                touch_start,
                                "touchStart",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                start_responder_capture,
                                "startShouldSetResponderCapture",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                start_responder,
                                "startShouldSetResponder",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                responder_start,
                                "responderStart",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                responder_grant,
                                "responderGrant",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                press_in,
                                "pressIn",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                        }
                    });
                }
                if click
                    || mouse_up
                    || pointer_up
                    || touch_end
                    || responder_release
                    || responder_end
                    || press
                    || press_out
                {
                    let event_bounds = hitbox.bounds.intersect(&hitbox.content_mask.bounds);
                    let layout_bounds = bounds;
                    window.on_mouse_event(move |ev: &MouseUpEvent, phase, _window, _cx| {
                        if phase != DispatchPhase::Bubble || ev.button != MouseButton::Left {
                            return;
                        }
                        let inside = event_bounds.contains(&ev.position);
                        let active_target = *ACTIVE_MOUSE_TARGET.lock().unwrap();
                        let captured_up_target = *CAPTURED_MOUSE_UP_TARGET.lock().unwrap();
                        let captured = active_target == Some(id);
                        let suppress_action =
                            captured && press_drag_should_suppress_captured_action(id);
                        if !target_receives_pointer_up_event(
                            active_target,
                            captured_up_target,
                            id,
                            inside,
                        ) {
                            return;
                        }
                        if captured {
                            *ACTIVE_MOUSE_TARGET.lock().unwrap() = None;
                            *CAPTURED_MOUSE_UP_TARGET.lock().unwrap() = Some(id);
                            *ACTIVE_PRESS_DRAG.lock().unwrap() = None;
                        }
                        emit_mouse_if(
                            id,
                            mouse_up && !suppress_action,
                            "mouseUp",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            pointer_up && !suppress_action,
                            "pointerUp",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            touch_end && !suppress_action,
                            "touchEnd",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            responder_release && !suppress_action,
                            "responderRelease",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            responder_end,
                            "responderEnd",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            press_out && !suppress_action,
                            "pressOut",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        if inside {
                            emit_mouse_if(
                                id,
                                press && !suppress_action,
                                "press",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                click && !suppress_action,
                                "click",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                        }
                    });
                }
                if mouse_enter
                    || mouse_leave
                    || mouse_over
                    || mouse_out
                    || mouse_move
                    || pointer_enter
                    || pointer_leave
                    || pointer_move
                    || touch_move
                    || responder_move
                    || press_action
                {
                    let hitbox_for_move = hitbox.clone();
                    let layout_bounds = bounds;
                    let press_group_for_move = press_group.clone();
                    let event_names_for_move = event_names.clone();
                    window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, _cx| {
                        if phase != DispatchPhase::Bubble {
                            return;
                        }
                        let inside = hitbox_for_move.is_hovered(window);
                        let mut hover = HOVER.lock().unwrap();
                        let was_inside = hover.contains(&id);
                        if inside && !was_inside {
                            hover.insert(id);
                            drop(hover);
                            emit_mouse_if(
                                id,
                                mouse_enter,
                                "mouseEnter",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                mouse_over,
                                "mouseOver",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                pointer_enter,
                                "pointerEnter",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            if drag_trace() {
                                eprintln!(
                                    "[drag-trace] ENTER id={id} dragging={} press_action={press_action} group={:?} active_drag={}",
                                    ev.dragging(),
                                    press_group_for_move,
                                    ACTIVE_PRESS_DRAG.lock().unwrap().is_some()
                                );
                            }
                            if ev.dragging() && press_action {
                                let activated = activate_drag_press_if_needed(
                                    id,
                                    &press_group_for_move,
                                    &event_names_for_move,
                                    ev.position,
                                    layout_bounds,
                                    ev.modifiers,
                                );
                                if drag_trace() {
                                    eprintln!("[drag-trace]   activate id={id} -> {activated}");
                                }
                            }
                        } else if !inside && was_inside {
                            hover.remove(&id);
                            drop(hover);
                            if ev.dragging() && press_action {
                                press_drag_mark_left_start(id);
                            }
                            emit_mouse_if(
                                id,
                                mouse_leave,
                                "mouseLeave",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                mouse_out,
                                "mouseOut",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                pointer_leave,
                                "pointerLeave",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                        } else {
                            drop(hover);
                            if !inside && ev.dragging() && press_action {
                                press_drag_mark_left_start(id);
                            }
                        }
                        let active_target = *ACTIVE_MOUSE_TARGET.lock().unwrap();
                        if drag_trace() && ev.dragging() && active_target == Some(id) {
                            eprintln!(
                                "[drag-trace] CAPMOVE id={id} inside={inside} responder_move={responder_move} touch_move={touch_move} pos={:?}",
                                ev.position
                            );
                        }
                        if target_receives_captured_pointer_event(active_target, id, inside) {
                            emit_mouse_if(
                                id,
                                mouse_move,
                                "mouseMove",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                pointer_move,
                                "pointerMove",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            // responder/touch moves are RN press-gesture events: they only
                            // exist while a press is active. Without the dragging gate every
                            // wandering HOVER move crossed the bridge as a responderMove to
                            // any Pressable under the cursor (Tamagui subscribes it on every
                            // pressable) — a per-move JS round-trip for nothing.
                            if ev.dragging() {
                                emit_mouse_if(
                                    id,
                                    touch_move,
                                    "touchMove",
                                    ev.position,
                                    layout_bounds,
                                    ev.modifiers,
                                );
                                emit_mouse_if(
                                    id,
                                    responder_move,
                                    "responderMove",
                                    ev.position,
                                    layout_bounds,
                                    ev.modifiers,
                                );
                            }
                        }
                    });
                    window.on_mouse_event(move |_ev: &MouseExitEvent, phase, _w, _cx| {
                        if phase != DispatchPhase::Bubble {
                            return;
                        }
                        let mut hover = HOVER.lock().unwrap();
                        if hover.remove(&id) {
                            drop(hover);
                            emit_if(id, mouse_leave, "mouseLeave");
                            emit_if(id, mouse_out, "mouseOut");
                            emit_if(id, pointer_leave, "pointerLeave");
                            emit_if(id, touch_cancel, "touchCancel");
                            emit_if(
                                id,
                                responder_termination_request,
                                "responderTerminationRequest",
                            );
                            emit_if(id, responder_terminate, "responderTerminate");
                        }
                        if *ACTIVE_MOUSE_TARGET.lock().unwrap() == Some(id) {
                            *ACTIVE_MOUSE_TARGET.lock().unwrap() = None;
                            *ACTIVE_PRESS_DRAG.lock().unwrap() = None;
                            *CAPTURED_MOUSE_UP_TARGET.lock().unwrap() = None;
                        }
                    });
                }
            }
        }

        // renderer→JS pseudo lane. A node with `pseudoEvents` asks the host to emit a
        // coalesced `pseudo` event on native hover/press flips, so Tamagui can drive pseudo
        // state with no React mouse-event lane.
        let wants_events = self.element.pseudo_events;
        if wants_events
            && !SCROLL_HOVER.lock().unwrap().suppressed
            && let Some(hitbox) = prepaint.hitbox.clone()
        {
            let id = self.element.global_id;
            let emit_pseudo = move |hovered: bool, pressed: bool| {
                crate::bridge::pseudo(id, hovered, pressed);
            };
            // remember this hitbox for hover re-evaluation after layout changes
            // (scroll) — used by the scroll container's post-refresh drain.
            PSEUDO_HITBOXES.lock().unwrap().insert(id, hitbox.clone());

            // re-evaluate hover state on every paint: the element is at its final
            // position (scroll offset applied in prepaint), but a stationary mouse
            // won't fire MouseMoveEvent after a layout change (scroll), causing the
            // old element's hover state to persist — the stuck-hover-in-scroll bug.
            // The cost is one hitbox bounds-check per pseudo-enabled element per
            // frame — negligible (~dozens of elements, simple rect test).
            {
                let inside = hitbox.is_hovered(window);
                let mut hover = PSEUDO_HOVER.lock().unwrap();
                if inside == hover.contains(&id) {
                    // no change — avoid the bridge call and press-state lock.
                } else if inside {
                    hover.insert(id);
                    drop(hover);
                    let pressed = PRESSED.lock().unwrap().contains(&id);
                    crate::bridge::pseudo(id, true, pressed);
                } else {
                    hover.remove(&id);
                    drop(hover);
                    PRESSED.lock().unwrap().remove(&id);
                    crate::bridge::pseudo(id, false, false);
                }
            }

            let move_hitbox = hitbox.clone();
            window.on_mouse_event(move |_ev: &MouseMoveEvent, phase, window, _cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let inside = move_hitbox.is_hovered(window);
                let mut hover = PSEUDO_HOVER.lock().unwrap();
                if inside == hover.contains(&id) {
                    return;
                }
                if inside {
                    hover.insert(id);
                } else {
                    hover.remove(&id);
                }
                drop(hover);
                // leaving the element also cancels an in-flight press on it.
                let pressed = if inside {
                    PRESSED.lock().unwrap().contains(&id)
                } else {
                    PRESSED.lock().unwrap().remove(&id);
                    false
                };
                emit_pseudo(inside, pressed);
            });
            let down_hitbox = hitbox.clone();
            window.on_mouse_event(move |ev: &MouseDownEvent, phase, window, _cx| {
                if phase == DispatchPhase::Bubble
                    && ev.button == MouseButton::Left
                    && down_hitbox.is_hovered(window)
                    && PRESSED.lock().unwrap().insert(id)
                {
                    emit_pseudo(true, true);
                }
            });
            window.on_mouse_event(move |ev: &MouseUpEvent, phase, _window, _cx| {
                if phase == DispatchPhase::Bubble
                    && ev.button == MouseButton::Left
                    && PRESSED.lock().unwrap().remove(&id)
                {
                    let hovered = PSEUDO_HOVER.lock().unwrap().contains(&id);
                    emit_pseudo(hovered, false);
                }
            });
            window.on_mouse_event(move |_ev: &MouseExitEvent, phase, _window, _cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let left_hover = PSEUDO_HOVER.lock().unwrap().remove(&id);
                let left_press = PRESSED.lock().unwrap().remove(&id);
                if left_hover || left_press {
                    emit_pseudo(false, false);
                }
            });
        }

        if let Some(key) = self.element.native_layout_key.as_deref() {
            remember_native_layout_frame(key, bounds.size.width.into(), bounds.size.height.into());
        }

        report_layout(&self.element, bounds);

        let mouse_cursor = style.mouse_cursor.or_else(|| {
            self.element
                .native_resize
                .as_ref()
                .map(|spec| native_resize_cursor(spec.edge))
        });
        if let (Some(hitbox), Some(mouse_cursor)) = (prepaint.hitbox.as_ref(), mouse_cursor) {
            window.set_cursor_style(mouse_cursor, hitbox);
        }

        // overflow clip mask. rounding the mask's corners (to the container's inner
        // radii) makes gpui's shaders clip the covered descendant primitives to the
        // rounded shape, reaching even an absolutely-positioned child that overflows a
        // corner (the case the old radius-propagation hack could not reach).
        let overflow_mask = if clip {
            style
                .overflow_mask(bounds, window.rem_size())
                .map(|mut mask| {
                    mask.corner_radii = overflow_clip_radii(bounds, &style, window.rem_size());
                    mask
                })
        } else {
            None
        };

        let order = self.stacked_child_indices();
        // Apply `opacity` to the whole subtree — shadow + background + border + children —
        // exactly as gpui's stock Div does. Without this wrap the host never pushes
        // `style.opacity` onto gpui's element-opacity stack, so an opacity spring /
        // enterStyle / exitStyle (every dialog/sheet fade, AnimatePresence) renders at
        // FULL opacity and only `transform` animates. paint_quad/paint_shadows multiply
        // their alpha by the stack, so wrapping here also fades the drop shadow in lockstep
        // with the card (it previously stayed at full strength while the body faded).
        // `None`/absent opacity is an immediate pass-through (no stack push), so an
        // un-animated node pays nothing.
        // animated smoke background (backgroundImage: 'smoke(dense, faded)'): stamp the
        // per-frame time into the Background (the shader's only animation input) and
        // request the next frame from gpui's display link so shader time advances once
        // per actual display refresh without a free-running timer drifting past vblank.
        if let Some(gpui::Fill::Color(bg)) = style.background.as_mut()
            && bg.is_smoke()
        {
            *bg = bg.with_time(smoke_time_seconds());
            window.request_animation_frame();
        }

        let element_opacity = style.opacity;
        // `transform` rides the same subtree wrap: an animated (overlay) value wins over
        // the committed style's ops, and the matrix is built fresh each paint around the
        // CURRENT bounds center, so transform springs (dialog scale/translateY) paint
        // per-frame with no relayout. Identity/absent → None → zero-cost pass-through.
        let transform_ops = match crate::anim_overlay::overlay_transform(self.element.global_id) {
            Some(value) => crate::style::parse_transform_ops(&value),
            None => self.element.style.transform.clone(),
        };
        let element_transform = transform_ops.and_then(|ops| {
            crate::style::transform_ops_matrix(&ops, bounds, window.scale_factor())
        });
        // in-app liquid-glass backdrop blur: frost the gpui content already drawn behind
        // this view before its own background quad paints over it. `backdropTint` is the
        // glass material color composited over the blurred content; absent → blur only.
        let backdrop_blur_radius = self.element.backdrop_blur_radius;
        let backdrop_tint = self.element.backdrop_tint.unwrap_or(Hsla {
            h: 0.0,
            s: 0.0,
            l: 0.0,
            a: 0.0,
        });
        window.with_element_transform(element_transform, |window| {
            window.with_element_opacity(element_opacity, |window| {
                if let Some(radius) = backdrop_blur_radius {
                    let corner_radii = style
                        .corner_radii
                        .to_pixels(window.rem_size())
                        .clamp_radii_for_quad_size(bounds.size);
                    window.paint_backdrop_blur(bounds, corner_radii, px(radius), backdrop_tint);
                }
                style.paint(bounds, window, cx, |window, cx| {
                    // a scroll container's off-screen children were never prepainted
                    // this frame (see DivPrepaintState::culled); painting them now would
                    // hit gpui's "paint without prepaint" assert, so skip the same set.
                    let culled = prepaint.culled.as_ref();
                    let paint_children = |window: &mut Window| {
                        if let Some(mask) = overflow_mask {
                            window.with_content_mask(Some(mask), |window| {
                                for index in order.iter() {
                                    if culled.is_some_and(|c| c.contains(&index)) {
                                        continue;
                                    }
                                    self.children[index].element.paint(window, cx);
                                }
                            });
                        } else {
                            for index in order.iter() {
                                if culled.is_some_and(|c| c.contains(&index)) {
                                    continue;
                                }
                                self.children[index].element.paint(window, cx);
                            }
                        }
                    };
                    if let Some(offset) = prepaint.scroll_offset {
                        window.with_scroll_region(
                            self.element.global_id,
                            bounds,
                            point(px(offset.x), px(offset.y)),
                            paint_children,
                        );
                    } else {
                        paint_children(window);
                    }
                });
                // edge fades paint AFTER children so they sit on top, multiplying the
                // element's own top/bottom strip toward transparent (revealing the glass
                // behind a transparent chrome). angle 180 fades downward (opaque top edge
                // -> clear bottom edge) for the bottom strip; angle 0 fades upward for the
                // top strip. this wrapper paints the fade AFTER its scroll-list child's
                // region ends, so scene.rs treats it as fixed content and repairs its band
                // (+ scroll delta) each frame while the rest of the viewport still blits —
                // the band re-renders the rows at their new offset before the multiply, so
                // scroll-blit stays engaged AND the fade never ghosts.
                let clamp_h = |requested: f32| {
                    let h = px(requested);
                    if h < bounds.size.height {
                        h
                    } else {
                        bounds.size.height
                    }
                };
                if let Some(strip) = self.element.style.edge_fade_bottom.filter(|s| *s > 0.0) {
                    let h = clamp_h(strip);
                    let strip_bounds = gpui::Bounds::new(
                        point(bounds.origin.x, bounds.bottom() - h),
                        gpui::size(bounds.size.width, h),
                    );
                    window.paint_fade(strip_bounds, 180.0);
                }
                if let Some(strip) = self.element.style.edge_fade_top.filter(|s| *s > 0.0) {
                    let h = clamp_h(strip);
                    let strip_bounds =
                        gpui::Bounds::new(bounds.origin, gpui::size(bounds.size.width, h));
                    window.paint_fade(strip_bounds, 0.0);
                }
            });
        });
    }
}

impl IntoElement for ReactDivElement {
    type Element = AnyElement;
    fn into_element(self) -> Self::Element {
        self.into_any()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::{Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    use gpui::{Bounds, ContentMask, Corners, point, px};
    use once_cell::sync::Lazy;

    use super::{
        ACTIVE_MOUSE_TARGET, ActiveNativeResize, ActivePressDrag, NATIVE_LAYOUT_ANIMATIONS,
        NATIVE_LAYOUT_FRAMES, NATIVE_LAYOUT_OVERRIDES, NativeLayoutAnimation, NativeLayoutOverride,
        animate_native_layout_override, clear_native_layout_override, events_have_press_action,
        finish_pointer_gesture, get_scroll, inner_corner_radius, native_layout_animation_value,
        native_layout_has_animations, native_layout_override, press_drag_should_activate,
        remember_native_layout_frame, retain_scroll_state, scroll_to, scroll_to_end,
        set_native_layout_override, stacked_child_indices_for, take_scroll_event,
        take_scroll_to_end, target_receives_captured_pointer_event,
        target_receives_pointer_up_event, update_native_resize,
    };
    use crate::elements::NativeResizeEdge;

    static NATIVE_LAYOUT_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn native_layout_test_guard() -> MutexGuard<'static, ()> {
        NATIVE_LAYOUT_TEST_LOCK.lock().unwrap()
    }

    #[test]
    fn scroll_to_updates_each_axis_independently() {
        let _guard = native_layout_test_guard();
        let id = 900_001;
        scroll_to(id, Some(42.0), None);
        let next = get_scroll(id);
        assert_eq!(next.x, 42.0);
        assert_eq!(next.y, 0.0);

        scroll_to(id, None, Some(77.0));
        let next = get_scroll(id);
        assert_eq!(next.x, 42.0);
        assert_eq!(next.y, 77.0);
        assert!(take_scroll_event(id));
        assert!(!take_scroll_event(id));
        retain_scroll_state(&HashSet::new());
    }

    #[test]
    fn scroll_to_end_requests_one_programmatic_scroll_event() {
        let _guard = native_layout_test_guard();
        let id = 900_002;
        scroll_to_end(id);

        assert!(take_scroll_event(id));
        assert!(!take_scroll_event(id));
        assert!(take_scroll_to_end(id));
        retain_scroll_state(&HashSet::new());
    }

    #[test]
    fn retain_scroll_state_drops_unmounted_offsets_and_events() {
        let _guard = native_layout_test_guard();
        let keep = 900_003;
        let remove = 900_004;
        scroll_to(keep, None, Some(30.0));
        scroll_to(remove, None, Some(40.0));
        scroll_to_end(remove);

        retain_scroll_state(&HashSet::from([keep]));

        assert_eq!(get_scroll(keep).y, 30.0);
        assert_eq!(get_scroll(remove).y, 0.0);
        assert!(take_scroll_event(keep));
        assert!(!take_scroll_event(remove));
        assert!(!take_scroll_to_end(remove));
        retain_scroll_state(&HashSet::new());
    }

    #[test]
    fn stacked_child_indices_honor_z_index_stably() {
        let order = stacked_child_indices_for([0, 20, -1, 20, 0]);

        assert_eq!(order, vec![2, 0, 4, 1, 3]);
    }

    #[test]
    fn active_pointer_target_exclusively_receives_captured_events() {
        assert!(target_receives_captured_pointer_event(None, 2, true));
        assert!(!target_receives_captured_pointer_event(None, 2, false));
        assert!(target_receives_captured_pointer_event(Some(2), 2, false));
        assert!(!target_receives_captured_pointer_event(Some(1), 2, true));
    }

    #[test]
    fn captured_pointer_up_suppresses_overlapping_later_targets() {
        assert!(!target_receives_pointer_up_event(Some(1), None, 2, true));
        assert!(target_receives_pointer_up_event(Some(1), None, 1, true));
        assert!(!target_receives_pointer_up_event(None, Some(1), 2, true));
        assert!(target_receives_pointer_up_event(None, None, 2, true));
    }

    #[test]
    fn fresh_mouse_down_self_heals_a_wedged_pointer_capture() {
        // serialize: this mutates the process-global ACTIVE_MOUSE_TARGET.
        let _guard = native_layout_test_guard();

        // a stale capture left behind when a gesture's mouse-up never reached gpui
        // (its element unmounted mid-gesture, or a native menu's nested event loop
        // swallowed the up). ACTIVE_MOUSE_TARGET is stuck on a now-dead id.
        *ACTIVE_MOUSE_TARGET.lock().unwrap() = Some(4242);

        // the wedge: while a target is captured, every *other* element is rejected,
        // so all clicks + hovers go dead (the divider's separate ACTIVE_NATIVE_RESIZE
        // path and native webview scroll are unaffected — exactly the reported bug).
        let stuck = *ACTIVE_MOUSE_TARGET.lock().unwrap();
        assert!(!target_receives_captured_pointer_event(stuck, 7, true));

        // the next press's capture-phase handler (service.rs root frame) clears the
        // stale gesture *before* the per-element bubble down-handlers run...
        finish_pointer_gesture();
        assert_eq!(*ACTIVE_MOUSE_TARGET.lock().unwrap(), None);

        // ...so the freshly pressed element captures from a free slot (the real
        // down-handler only captures `if active.is_none()`), and again exclusively
        // receives its own gesture — input is healed.
        {
            let mut active = ACTIVE_MOUSE_TARGET.lock().unwrap();
            if active.is_none() {
                *active = Some(7);
            }
        }
        let healed = *ACTIVE_MOUSE_TARGET.lock().unwrap();
        assert_eq!(healed, Some(7));
        assert!(target_receives_captured_pointer_event(healed, 7, false));

        // don't leak the capture into sibling tests.
        finish_pointer_gesture();
    }

    #[test]
    fn press_action_includes_responder_and_mouse_release_events() {
        let events = |names: &[&str]| {
            names
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>()
        };

        assert!(events_have_press_action(&events(&["press"])));
        assert!(events_have_press_action(&events(&["click"])));
        assert!(events_have_press_action(&events(&["responderRelease"])));
        assert!(events_have_press_action(&events(&["touchEnd"])));
        assert!(events_have_press_action(&events(&["mouseUp"])));
        assert!(events_have_press_action(&events(&["pointerUp"])));
        assert!(!events_have_press_action(&events(&[
            "mouseEnter",
            "responderGrant"
        ])));
    }

    #[test]
    fn press_drag_activation_repeats_on_hover_entry_and_stays_group_scoped() {
        let mut active = ActivePressDrag {
            start_id: 1,
            group: Some("files".to_string()),
            did_activate: false,
            left_start: false,
            start_events: Vec::new(),
            start_bounds: Bounds::default(),
            start_cancelled: false,
        };
        let files = Some("files".to_string());
        let sessions = Some("sessions".to_string());

        assert!(press_drag_should_activate(&mut active, 2, &files));
        assert!(active.did_activate);
        assert!(active.left_start);
        assert!(press_drag_should_activate(&mut active, 2, &files));
        assert!(press_drag_should_activate(&mut active, 1, &files));
        assert!(!press_drag_should_activate(&mut active, 3, &sessions));
        assert!(!press_drag_should_activate(&mut active, 4, &None));
    }

    #[test]
    fn press_drag_start_target_waits_until_pointer_leaves() {
        let mut active = ActivePressDrag {
            start_id: 1,
            group: Some("files".to_string()),
            did_activate: false,
            left_start: false,
            start_events: Vec::new(),
            start_bounds: Bounds::default(),
            start_cancelled: false,
        };
        let files = Some("files".to_string());

        assert!(!press_drag_should_activate(&mut active, 1, &files));
        active.left_start = true;
        assert!(press_drag_should_activate(&mut active, 1, &files));
    }

    #[test]
    fn ungrouped_press_drag_stays_in_ungrouped_targets() {
        let mut active = ActivePressDrag {
            start_id: 1,
            group: None,
            did_activate: false,
            left_start: true,
            start_events: Vec::new(),
            start_bounds: Bounds::default(),
            start_cancelled: false,
        };
        let files = Some("files".to_string());

        assert!(press_drag_should_activate(&mut active, 2, &None));
        assert!(!press_drag_should_activate(&mut active, 3, &files));
    }

    #[test]
    fn inner_corner_radius_subtracts_largest_border() {
        assert_eq!(inner_corner_radius(px(10.0), px(1.0), px(2.0)), px(8.0));
        assert_eq!(inner_corner_radius(px(4.0), px(8.0), px(1.0)), px(0.0));
    }

    // rounded-content-mask intersection math (gpui::ContentMask::intersect). this is the
    // core the rounded overflow clip relies on: a child mask intersected with a rounded
    // ancestor mask must keep the ancestor's rounding where the corners coincide, stay
    // square where an edge slices a corner (documented lossy case), and never over-round.
    fn cmask(x: f32, y: f32, w: f32, h: f32, radii: [f32; 4]) -> ContentMask<gpui::Pixels> {
        ContentMask {
            bounds: Bounds::from_corners(point(px(x), px(y)), point(px(x + w), px(y + h))),
            corner_radii: Corners {
                top_left: px(radii[0]),
                top_right: px(radii[1]),
                bottom_right: px(radii[2]),
                bottom_left: px(radii[3]),
            },
        }
    }

    #[test]
    fn mask_rect_intersect_rect_stays_square() {
        let r = cmask(0., 0., 100., 100., [0.; 4]).intersect(&cmask(10., 10., 50., 50., [0.; 4]));
        assert_eq!(r.bounds.origin, point(px(10.), px(10.)));
        assert_eq!(r.corner_radii, Corners::default());
    }

    #[test]
    fn mask_coincident_corner_keeps_rounding() {
        // child fills the rounded ancestor exactly → every corner coincides → rounding survives.
        let r = cmask(0., 0., 100., 100., [20., 20., 20., 20.])
            .intersect(&cmask(0., 0., 100., 100., [0.; 4]));
        assert_eq!(r.corner_radii.top_left, px(20.));
        assert_eq!(r.corner_radii.bottom_right, px(20.));
    }

    #[test]
    fn mask_coincident_corner_takes_larger_radius() {
        // intersection removes the union of the two corner cut-outs → the more-rounded wins.
        let r = cmask(0., 0., 100., 100., [20., 0., 0., 0.]).intersect(&cmask(
            0.,
            0.,
            100.,
            100.,
            [8., 0., 0., 0.],
        ));
        assert_eq!(r.corner_radii.top_left, px(20.));
    }

    #[test]
    fn mask_inset_child_away_from_corners_is_square() {
        // child fully inside the ancestor, touching no corner → child rect is the sole
        // binding constraint, so no corner needs rounding.
        let r = cmask(0., 0., 100., 100., [20., 20., 20., 20.])
            .intersect(&cmask(30., 30., 40., 40., [0.; 4]));
        assert_eq!(r.corner_radii, Corners::default());
    }

    #[test]
    fn mask_non_coincident_edge_slice_stays_rectangular() {
        // child shares the ancestor's left edge but its top edge slices through the
        // ancestor's rounded corner without the corners coinciding. this is one of the
        // documented lossy cases: the result keeps a rectangular corner (matches the
        // pre-rounding rect clip; never admits anything outside the rect intersection).
        let r = cmask(0., 0., 100., 100., [20., 0., 0., 0.])
            .intersect(&cmask(0., 10., 100., 90., [0.; 4]));
        assert_eq!(r.corner_radii.top_left, px(0.));
    }

    #[test]
    fn mask_radius_clamped_to_intersected_size() {
        // a 10x10 intersection cannot carry a 20px radius; clamping shrinks the coincident
        // radius to fit. that re-anchors the arc, so this is also a lossy case (the shrunk
        // arc can re-admit a sliver the larger input excluded). here we assert only the
        // clamp bound, which keeps the result inside the rect intersection.
        let r = cmask(0., 0., 100., 100., [20., 20., 20., 20.]).intersect(&cmask(
            0.,
            0.,
            10.,
            10.,
            [20., 20., 20., 20.],
        ));
        assert!(f32::from(r.corner_radii.top_left) <= 5.01);
    }

    #[test]
    fn native_layout_override_updates_axes_independently() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("pane-a");
        set_native_layout_override("pane-a", Some(240.0), None, None, None);
        set_native_layout_override("pane-a", None, Some(120.0), Some(-12.0), None);
        let next = native_layout_override("pane-a");
        assert_eq!(next.width, Some(240.0));
        assert_eq!(next.height, Some(120.0));
        assert_eq!(next.x, Some(-12.0));
        clear_native_layout_override("pane-a");
        assert_eq!(
            native_layout_override("pane-a"),
            NativeLayoutOverride::default()
        );
    }

    #[test]
    fn native_layout_animation_interpolates_to_final_size() {
        let start = Instant::now();
        let animation = NativeLayoutAnimation {
            from_width: Some(100.0),
            to_width: Some(200.0),
            from_height: Some(60.0),
            to_height: Some(120.0),
            from_x: Some(0.0),
            to_x: Some(-80.0),
            from_y: None,
            to_y: None,
            start,
            duration: Duration::from_millis(100),
        };

        let (initial, done) = native_layout_animation_value(animation, start);
        assert_eq!(initial.width, Some(100.0));
        assert_eq!(initial.height, Some(60.0));
        assert_eq!(initial.x, Some(0.0));
        assert!(!done);

        let (mid, done) =
            native_layout_animation_value(animation, start + Duration::from_millis(50));
        assert!(mid.width.unwrap() > 100.0);
        assert!(mid.width.unwrap() < 200.0);
        assert!(mid.height.unwrap() > 60.0);
        assert!(mid.height.unwrap() < 120.0);
        assert!(mid.x.unwrap() < 0.0);
        assert!(mid.x.unwrap() > -80.0);
        assert!(!done);

        let (final_size, done) =
            native_layout_animation_value(animation, start + Duration::from_millis(100));
        assert_eq!(final_size.width, Some(200.0));
        assert_eq!(final_size.height, Some(120.0));
        assert_eq!(final_size.x, Some(-80.0));
        assert!(done);
    }

    #[test]
    fn completed_native_layout_animation_commits_without_relocking_animation_state() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("pane-complete");
        NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().insert(
            "pane-complete".to_string(),
            NativeLayoutAnimation {
                from_width: Some(100.0),
                to_width: Some(0.0),
                from_height: None,
                to_height: None,
                from_x: None,
                to_x: None,
                from_y: None,
                to_y: None,
                start: Instant::now() - Duration::from_millis(200),
                duration: Duration::from_millis(100),
            },
        );

        assert_eq!(native_layout_override("pane-complete").width, Some(0.0));
        assert!(
            !NATIVE_LAYOUT_ANIMATIONS
                .lock()
                .unwrap()
                .contains_key("pane-complete")
        );
        clear_native_layout_override("pane-complete");
    }

    #[test]
    fn animate_native_layout_resumes_from_live_value_on_interrupt() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("pane-interrupt");
        // a collapse is in flight: width animating 200 -> 0. let it reach ~midway by
        // arming it in the past, then read the live value.
        NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().insert(
            "pane-interrupt".to_string(),
            NativeLayoutAnimation {
                from_width: Some(200.0),
                to_width: Some(0.0),
                from_height: None,
                to_height: None,
                from_x: Some(0.0),
                to_x: Some(-200.0),
                from_y: None,
                to_y: None,
                start: Instant::now() - Duration::from_millis(50),
                duration: Duration::from_millis(120),
            },
        );
        let live = native_layout_override("pane-interrupt");
        let live_width = live.width.unwrap();
        let live_x = live.x.unwrap();
        assert!(
            live_width < 200.0 && live_width > 0.0,
            "collapse should be mid-flight, got width {live_width}"
        );

        // interrupt: re-arm an EXPAND back to 200. the new tween's `from` must be the live
        // interpolated value (so it reverses smoothly), not a snapped 0 or the stale 200.
        animate_native_layout_override("pane-interrupt", Some(200.0), None, Some(0.0), None, 150.0);
        let armed = NATIVE_LAYOUT_ANIMATIONS
            .lock()
            .unwrap()
            .get("pane-interrupt")
            .copied()
            .unwrap();
        let from_width = armed.from_width.unwrap();
        let from_x = armed.from_x.unwrap();
        assert!(
            (from_width - live_width).abs() < 1.0,
            "expand must resume from live width {live_width}, armed from {from_width}"
        );
        assert!(
            (from_x - live_x).abs() < 1.0,
            "expand must resume from live x {live_x}, armed from {from_x}"
        );
        assert_eq!(armed.to_width, Some(200.0));
        assert_eq!(armed.to_x, Some(0.0));
        clear_native_layout_override("pane-interrupt");
    }

    #[test]
    fn native_layout_has_animations_purges_expired_without_layout_pass() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("orphan-anim");
        // an expired animation whose element is never laid out this frame, so
        // native_layout_override (the only other finalizer) is never called for it.
        NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().insert(
            "orphan-anim".to_string(),
            NativeLayoutAnimation {
                from_width: Some(100.0),
                to_width: Some(0.0),
                from_height: None,
                to_height: None,
                from_x: None,
                to_x: None,
                from_y: None,
                to_y: None,
                start: Instant::now() - Duration::from_millis(500),
                duration: Duration::from_millis(100),
            },
        );

        // the 250fps driver only checks this predicate; once the animation has expired it
        // MUST report "no animations" or the driver spins forever (the element is never
        // laid out, so it can never be finalized via request_layout).
        assert!(
            !native_layout_has_animations(),
            "expired animation must be purged so the driver loop can terminate"
        );
        // and its end value must be committed as a static override, not lost.
        assert_eq!(native_layout_override("orphan-anim").width, Some(0.0));
        clear_native_layout_override("orphan-anim");
    }

    #[test]
    fn native_layout_has_animations_keeps_in_progress_animation() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("live-anim");
        // a still-running animation must NOT be purged — the driver needs to keep ticking.
        NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().insert(
            "live-anim".to_string(),
            NativeLayoutAnimation {
                from_width: Some(0.0),
                to_width: Some(200.0),
                from_height: None,
                to_height: None,
                from_x: None,
                to_x: None,
                from_y: None,
                to_y: None,
                start: Instant::now(),
                duration: Duration::from_secs(10),
            },
        );

        assert!(
            native_layout_has_animations(),
            "in-progress animation must keep the driver alive"
        );
        assert!(
            NATIVE_LAYOUT_ANIMATIONS
                .lock()
                .unwrap()
                .contains_key("live-anim")
        );
        clear_native_layout_override("live-anim");
    }

    #[test]
    fn native_resize_right_edge_grows_width() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("pane-right-edge");
        remember_native_layout_frame("pane-right-edge", 250.0, 80.0);
        let active = ActiveNativeResize {
            handle_id: 1,
            target: "pane-right-edge".to_string(),
            edge: NativeResizeEdge::Right,
            min: Some(210.0),
            max: Some(420.0),
            start_position: 100.0,
            start_value: 250.0,
            last_refresh: Instant::now(),
        };

        assert!(update_native_resize(
            &active,
            gpui::point(px(132.0), px(0.0))
        ));
        assert_eq!(native_layout_override("pane-right-edge").width, Some(282.0));
        clear_native_layout_override("pane-right-edge");
    }

    #[test]
    fn native_resize_left_edge_shrinks_width_and_clamps() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("pane-left-edge");
        remember_native_layout_frame("pane-left-edge", 300.0, 80.0);
        let active = ActiveNativeResize {
            handle_id: 1,
            target: "pane-left-edge".to_string(),
            edge: NativeResizeEdge::Left,
            min: Some(240.0),
            max: Some(460.0),
            start_position: 100.0,
            start_value: 300.0,
            last_refresh: Instant::now(),
        };

        assert!(update_native_resize(
            &active,
            gpui::point(px(190.0), px(0.0))
        ));
        assert_eq!(native_layout_override("pane-left-edge").width, Some(240.0));
        clear_native_layout_override("pane-left-edge");
    }

    #[test]
    fn retain_native_layout_keys_drops_stale_state() {
        let _guard = native_layout_test_guard();
        set_native_layout_override("keep", Some(10.0), None, None, None);
        set_native_layout_override("drop", Some(20.0), None, None, None);
        NATIVE_LAYOUT_FRAMES.lock().unwrap().insert(
            "drop".to_string(),
            super::NativeLayoutFrame {
                width: 20.0,
                height: 10.0,
            },
        );
        NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().insert(
            "drop".to_string(),
            NativeLayoutAnimation {
                from_width: Some(20.0),
                to_width: Some(40.0),
                from_height: None,
                to_height: None,
                from_x: None,
                to_x: None,
                from_y: None,
                to_y: None,
                start: Instant::now(),
                duration: Duration::from_millis(100),
            },
        );
        super::retain_native_layout_keys(&["keep".to_string()].into_iter().collect());

        let overrides = NATIVE_LAYOUT_OVERRIDES.lock().unwrap();
        assert!(overrides.contains_key("keep"));
        assert!(!overrides.contains_key("drop"));
        drop(overrides);
        assert!(!NATIVE_LAYOUT_FRAMES.lock().unwrap().contains_key("drop"));
        assert!(
            !NATIVE_LAYOUT_ANIMATIONS
                .lock()
                .unwrap()
                .contains_key("drop")
        );
        clear_native_layout_override("keep");
    }
}
