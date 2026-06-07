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
}

#[derive(Clone, Debug)]
struct PressDragTarget {
    id: u64,
    events: Vec<String>,
    bounds: Bounds<Pixels>,
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
    release_target: Option<PressDragTarget>,
}

static SCROLL: Lazy<Mutex<HashMap<u64, ScrollOffset>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static SCROLL_TO_END: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static HOVER: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static ACTIVE_MOUSE_TARGET: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
static CAPTURED_MOUSE_UP_TARGET: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
static ACTIVE_PRESS_DRAG: Lazy<Mutex<Option<ActivePressDrag>>> = Lazy::new(|| Mutex::new(None));
static NATIVE_LAYOUT_OVERRIDES: Lazy<Mutex<HashMap<String, NativeLayoutOverride>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NATIVE_LAYOUT_FRAMES: Lazy<Mutex<HashMap<String, NativeLayoutFrame>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NATIVE_LAYOUT_ANIMATIONS: Lazy<Mutex<HashMap<String, NativeLayoutAnimation>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ACTIVE_NATIVE_RESIZE: Lazy<Mutex<Option<ActiveNativeResize>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Clone, Default)]
pub struct DivPrepaintState {
    hitbox: Option<Hitbox>,
    max_scroll_x: f32,
    max_scroll_y: f32,
}

fn get_scroll(id: u64) -> ScrollOffset {
    SCROLL.lock().unwrap().get(&id).copied().unwrap_or_default()
}
fn set_scroll(id: u64, v: ScrollOffset) {
    SCROLL.lock().unwrap().insert(id, v);
}

pub fn scroll_to(id: u64, x: Option<f32>, y: Option<f32>) {
    let current = get_scroll(id);
    set_scroll(
        id,
        ScrollOffset {
            x: x.unwrap_or(current.x).max(0.0),
            y: y.unwrap_or(current.y).max(0.0),
        },
    );
}

pub fn scroll_to_end(id: u64) {
    SCROLL_TO_END.lock().unwrap().insert(id);
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

fn take_scroll_to_end(id: u64) -> bool {
    SCROLL_TO_END.lock().unwrap().remove(&id)
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
            return NATIVE_LAYOUT_OVERRIDES
                .lock()
                .unwrap()
                .get(key)
                .copied()
                .unwrap_or_default();
        }
        return next;
    }
    NATIVE_LAYOUT_OVERRIDES
        .lock()
        .unwrap()
        .get(key)
        .copied()
        .unwrap_or_default()
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
    let progress = ease_out_cubic(raw_progress.clamp(0.0, 1.0));
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

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

fn lerp(from: f32, to: f32, t: f32) -> f32 {
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

fn press_drag_should_target(
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

fn press_drag_clear_release_target(id: u64) {
    let mut guard = ACTIVE_PRESS_DRAG.lock().unwrap();
    if let Some(active) = guard.as_mut()
        && active
            .release_target
            .as_ref()
            .is_some_and(|target| target.id == id)
    {
        active.release_target = None;
    }
}

fn emit_press_action_sequence(
    id: u64,
    events: &[String],
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
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

fn press_drag_release_target_for_start(id: u64) -> Option<PressDragTarget> {
    ACTIVE_PRESS_DRAG
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|active| {
            if active.start_id == id {
                active.release_target.clone()
            } else {
                None
            }
        })
}

fn track_drag_press_target_if_needed(
    id: u64,
    group: &Option<String>,
    events: &[String],
    position: Point<Pixels>,
    bounds: Bounds<Pixels>,
    modifiers: Modifiers,
) -> bool {
    let mut guard = ACTIVE_PRESS_DRAG.lock().unwrap();
    let mut cancel_start: Option<(u64, Vec<String>, Bounds<Pixels>)> = None;
    let should_target = match guard.as_mut() {
        Some(active) => {
            if !press_drag_should_target(active, id, group) {
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
                active.release_target = Some(PressDragTarget {
                    id,
                    events: events.to_vec(),
                    bounds,
                });
                true
            }
        }
        None => false,
    };
    drop(guard);
    if !should_target {
        return false;
    };
    if let Some((start_id, start_events, start_bounds)) = cancel_start {
        emit_press_cancel_sequence(start_id, &start_events, position, start_bounds, modifiers);
    }
    true
}

pub fn finish_pointer_gesture() {
    *ACTIVE_MOUSE_TARGET.lock().unwrap() = None;
    *CAPTURED_MOUSE_UP_TARGET.lock().unwrap() = None;
    *ACTIVE_PRESS_DRAG.lock().unwrap() = None;
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
    _parent_style: Option<ElementStyle>,
    children: Vec<StackedChild>,
}

struct StackedChild {
    element: AnyElement,
    z_index: i32,
}

impl ReactDivElement {
    pub fn new(
        element: Arc<ReactElement>,
        window_id: u64,
        parent_style: Option<ElementStyle>,
    ) -> Self {
        Self {
            element,
            window_id,
            _parent_style: parent_style,
            children: Vec::new(),
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

    fn stacked_child_indices(&self) -> Vec<usize> {
        stacked_child_indices_for(self.children.iter().map(|child| child.z_index))
    }
}

fn stacked_child_indices_for(z_indices: impl IntoIterator<Item = i32>) -> Vec<usize> {
    let mut indexed = z_indices.into_iter().enumerate().collect::<Vec<_>>();
    // fast path: when no child overrides z-index (the overwhelmingly common case)
    // document order already is stacking order — skip the comparison sort + remap.
    if indexed.iter().all(|(_, z_index)| *z_index == 0) {
        return (0..indexed.len()).collect();
    }
    indexed.sort_by_key(|(index, z_index)| (*z_index, *index));
    indexed.into_iter().map(|(index, _)| index).collect()
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

#[derive(Clone, Copy, Debug)]
struct RoundedOverflowClip {
    bounds: Bounds<Pixels>,
    radii: Corners<Pixels>,
}

thread_local! {
    static ROUNDED_OVERFLOW_CLIPS: RefCell<Vec<RoundedOverflowClip>> = const { RefCell::new(Vec::new()) };
}

struct RoundedOverflowClipGuard;

impl Drop for RoundedOverflowClipGuard {
    fn drop(&mut self) {
        ROUNDED_OVERFLOW_CLIPS.with(|clips| {
            clips.borrow_mut().pop();
        });
    }
}

fn push_rounded_overflow_clip(
    clip: Option<RoundedOverflowClip>,
) -> Option<RoundedOverflowClipGuard> {
    if let Some(clip) = clip {
        ROUNDED_OVERFLOW_CLIPS.with(|clips| {
            clips.borrow_mut().push(clip);
        });
        Some(RoundedOverflowClipGuard)
    } else {
        None
    }
}

fn rounded_overflow_clip(
    bounds: Bounds<Pixels>,
    style: &gpui::Style,
    rem_size: Pixels,
) -> Option<RoundedOverflowClip> {
    let content_bounds = style.overflow_mask(bounds, rem_size)?.bounds;
    if content_bounds.is_empty() {
        return None;
    }

    let corner_radii = style
        .corner_radii
        .to_pixels(rem_size)
        .clamp_radii_for_quad_size(bounds.size);
    let border_widths = style.border_widths.to_pixels(rem_size);
    let radii = Corners {
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
    };
    if pixels_are_zero(radii.top_left)
        && pixels_are_zero(radii.top_right)
        && pixels_are_zero(radii.bottom_right)
        && pixels_are_zero(radii.bottom_left)
    {
        return None;
    }

    Some(RoundedOverflowClip {
        bounds: content_bounds,
        radii,
    })
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

fn apply_rounded_overflow_clips_to_style(
    style: &mut gpui::Style,
    bounds: Bounds<Pixels>,
    rem_size: Pixels,
) {
    let mut radii = style.corner_radii.to_pixels(rem_size);
    ROUNDED_OVERFLOW_CLIPS.with(|clips| {
        for clip in clips.borrow().iter() {
            let clip_radii = rounded_clip_radii_for_bounds(bounds, *clip);
            radii.top_left = max_pixels(radii.top_left, clip_radii.top_left);
            radii.top_right = max_pixels(radii.top_right, clip_radii.top_right);
            radii.bottom_right = max_pixels(radii.bottom_right, clip_radii.bottom_right);
            radii.bottom_left = max_pixels(radii.bottom_left, clip_radii.bottom_left);
        }
    });
    style.corner_radii = Corners {
        top_left: radii.top_left.into(),
        top_right: radii.top_right.into(),
        bottom_right: radii.bottom_right.into(),
        bottom_left: radii.bottom_left.into(),
    };
}

fn rounded_clip_radii_for_bounds(
    bounds: Bounds<Pixels>,
    clip: RoundedOverflowClip,
) -> Corners<Pixels> {
    let epsilon = 0.5;
    let left: f32 = bounds.left().into();
    let top: f32 = bounds.top().into();
    let right: f32 = bounds.right().into();
    let bottom: f32 = bounds.bottom().into();
    let clip_left: f32 = clip.bounds.left().into();
    let clip_top: f32 = clip.bounds.top().into();
    let clip_right: f32 = clip.bounds.right().into();
    let clip_bottom: f32 = clip.bounds.bottom().into();

    Corners {
        top_left: if left <= clip_left + epsilon && top <= clip_top + epsilon {
            clip.radii.top_left
        } else {
            Pixels::ZERO
        },
        top_right: if right >= clip_right - epsilon && top <= clip_top + epsilon {
            clip.radii.top_right
        } else {
            Pixels::ZERO
        },
        bottom_right: if right >= clip_right - epsilon && bottom >= clip_bottom - epsilon {
            clip.radii.bottom_right
        } else {
            Pixels::ZERO
        },
        bottom_left: if left <= clip_left + epsilon && bottom >= clip_bottom - epsilon {
            clip.radii.bottom_left
        } else {
            Pixels::ZERO
        },
    }
}

fn max_pixels(a: Pixels, b: Pixels) -> Pixels {
    let a: f32 = a.into();
    let b: f32 = b.into();
    px(a.max(b))
}

fn pixels_are_zero(value: Pixels) -> bool {
    let value: f32 = value.into();
    value == 0.0
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
        let inherited = self.element.style.clone();

        if style.display == Display::None {
            self.children.clear();
            let layout_id = window.request_layout(style, [], cx);
            return (layout_id, Vec::new());
        }

        // Build children
        self.children = self
            .element
            .children
            .iter()
            .map(|child| StackedChild {
                element: create_element(child.clone(), self.window_id, Some(inherited.clone())),
                z_index: child.style.z_index.unwrap_or(0),
            })
            .collect();

        // If element has text content, add it
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
            }
        }

        let child_ids: Vec<_> = self
            .children
            .iter_mut()
            .map(|c| c.element.request_layout(window, cx))
            .collect();

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
        if self.element.style.is_display_none() {
            return DivPrepaintState::default();
        }

        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);

        let (_, scroll) = overflow_mode(&self.element.style);

        // claim a hitbox for any view that handles pointer or scroll input.
        // insert_hitbox must run in prepaint (gpui asserts the phase); mouse
        // listeners are wired in paint and query the hitbox's current hover state.
        let interactive = self.element.native_resize.is_some()
            || [
                "click",
                "mouseDown",
                "mouseUp",
                "mouseEnter",
                "mouseLeave",
                "mouseOver",
                "mouseOut",
                "mouseMove",
                "pointerDown",
                "pointerUp",
                "pointerEnter",
                "pointerLeave",
                "pointerMove",
                "touchStart",
                "touchMove",
                "touchEnd",
                "touchCancel",
                "startShouldSetResponder",
                "startShouldSetResponderCapture",
                "responderGrant",
                "responderMove",
                "responderRelease",
                "responderStart",
                "responderEnd",
                "responderTerminate",
                "responderTerminationRequest",
                "press",
                "longPress",
                "pressIn",
                "pressOut",
            ]
            .iter()
            .any(|name| self.element.listens(name));
        let cursor = self.element.style.cursor.is_some();
        let hitbox = if interactive || scroll || cursor {
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
            crate::hit_passthrough::record_occluder(
                bounds.origin.x.into(),
                bounds.origin.y.into(),
                bounds.size.width.into(),
                bounds.size.height.into(),
            );
        }

        let mut max_scroll_x = 0.0;
        let mut max_scroll_y = 0.0;
        if !bounds_have_drawable_area(bounds) {
            return DivPrepaintState {
                hitbox,
                max_scroll_x,
                max_scroll_y,
            };
        }
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
                ScrollOffset {
                    x: current.x.clamp(0.0, max_scroll_x),
                    y: current.y.clamp(0.0, max_scroll_y),
                }
            };
            set_scroll(self.element.global_id, off);
            window.with_element_offset(point(px(-off.x), px(-off.y)), |window| {
                for index in self.stacked_child_indices() {
                    self.children[index].element.prepaint(window, cx);
                }
            });
        } else {
            for index in self.stacked_child_indices() {
                self.children[index].element.prepaint(window, cx);
            }
        }

        DivPrepaintState {
            hitbox,
            max_scroll_x,
            max_scroll_y,
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
        if self.element.style.is_display_none() {
            return;
        }
        if !bounds_have_drawable_area(bounds) {
            report_layout(&self.element, bounds);
            return;
        }

        let mut style = self.element.build_gpui_style(None);
        apply_rounded_overflow_clips_to_style(&mut style, bounds, window.rem_size());
        let (clip, scroll) = overflow_mode(&self.element.style);

        // Wheel handling: a listener that nudges the persisted offset and asks for a
        // repaint. Gated by `bounds.contains` (not `should_handle_scroll`, whose
        // hit-test set only stays fresh under continuous rendering — we render
        // on-demand). Bubble runs inner→outer; the inner scroller consumes and stops
        // propagation so an ancestor doesn't also move.
        if scroll {
            let id = self.element.global_id;
            let max_scroll_x = prepaint.max_scroll_x;
            let max_scroll_y = prepaint.max_scroll_y;
            let hitbox = prepaint.hitbox.clone();
            let on_scroll = self.element.listens("scroll");
            window.on_mouse_event(move |ev: &ScrollWheelEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && hitbox
                        .as_ref()
                        .is_some_and(|hitbox| hitbox.should_handle_scroll(window))
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
                    let next = ScrollOffset {
                        x: (cur.x - dx).clamp(0.0, max_scroll_x),
                        y: (cur.y - dy).clamp(0.0, max_scroll_y),
                    };
                    if (next.x - cur.x).abs() > 0.01 || (next.y - cur.y).abs() > 0.01 {
                        set_scroll(id, next);
                        if on_scroll {
                            crate::bridge::scroll_event(id, next.x, next.y);
                        }
                        window.refresh(); // on-demand: repaint to reflect the new offset
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
                        window.refresh();
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
                            if press_action && active_target == Some(id) {
                                *ACTIVE_PRESS_DRAG.lock().unwrap() = Some(ActivePressDrag {
                                    start_id: id,
                                    group: press_group_for_down.clone(),
                                    did_activate: false,
                                    left_start: false,
                                    start_events: event_names_for_down.clone(),
                                    start_bounds: layout_bounds,
                                    start_cancelled: false,
                                    release_target: None,
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
                        let drag_release_target = if suppress_action {
                            press_drag_release_target_for_start(id)
                        } else {
                            None
                        };
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
                        if let Some(target) = drag_release_target {
                            emit_press_action_sequence(
                                target.id,
                                &target.events,
                                ev.position,
                                target.bounds,
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
                            if ev.dragging() && press_action {
                                track_drag_press_target_if_needed(
                                    id,
                                    &press_group_for_move,
                                    &event_names_for_move,
                                    ev.position,
                                    layout_bounds,
                                    ev.modifiers,
                                );
                            }
                        } else if !inside && was_inside {
                            hover.remove(&id);
                            drop(hover);
                            if ev.dragging() && press_action {
                                press_drag_mark_left_start(id);
                                press_drag_clear_release_target(id);
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

        let overflow_mask = if clip {
            style.overflow_mask(bounds, window.rem_size())
        } else {
            None
        };
        let rounded_clip = if clip {
            rounded_overflow_clip(bounds, &style, window.rem_size())
        } else {
            None
        };

        style.paint(bounds, window, cx, |window, cx| {
            let _rounded_clip_guard = push_rounded_overflow_clip(rounded_clip);
            if let Some(mask) = overflow_mask {
                window.with_content_mask(Some(mask), |window| {
                    for index in self.stacked_child_indices() {
                        self.children[index].element.paint(window, cx);
                    }
                });
            } else {
                for index in self.stacked_child_indices() {
                    self.children[index].element.paint(window, cx);
                }
            }
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
    use std::sync::{Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    use gpui::{Bounds, Corners, Modifiers, point, px};
    use once_cell::sync::Lazy;

    use super::{
        ACTIVE_PRESS_DRAG, ActiveNativeResize, ActivePressDrag, NATIVE_LAYOUT_ANIMATIONS,
        NATIVE_LAYOUT_FRAMES, NATIVE_LAYOUT_OVERRIDES, NativeLayoutAnimation, NativeLayoutOverride,
        PressDragTarget, RoundedOverflowClip, clear_native_layout_override,
        events_have_press_action, finish_pointer_gesture, get_scroll, inner_corner_radius,
        native_layout_animation_value, native_layout_has_animations, native_layout_override,
        press_drag_clear_release_target, press_drag_release_target_for_start,
        press_drag_should_target, remember_native_layout_frame, rounded_clip_radii_for_bounds,
        scroll_to, set_native_layout_override, stacked_child_indices_for,
        target_receives_captured_pointer_event, target_receives_pointer_up_event,
        track_drag_press_target_if_needed, update_native_resize,
    };
    use crate::elements::NativeResizeEdge;

    static NATIVE_LAYOUT_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
    static POINTER_GESTURE_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn native_layout_test_guard() -> MutexGuard<'static, ()> {
        NATIVE_LAYOUT_TEST_LOCK.lock().unwrap()
    }

    fn pointer_gesture_test_guard() -> MutexGuard<'static, ()> {
        POINTER_GESTURE_TEST_LOCK.lock().unwrap()
    }

    #[test]
    fn scroll_to_updates_each_axis_independently() {
        let id = 900_001;
        scroll_to(id, Some(42.0), None);
        let next = get_scroll(id);
        assert_eq!(next.x, 42.0);
        assert_eq!(next.y, 0.0);

        scroll_to(id, None, Some(77.0));
        let next = get_scroll(id);
        assert_eq!(next.x, 42.0);
        assert_eq!(next.y, 77.0);
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
    fn press_drag_target_repeats_on_hover_entry_and_stays_group_scoped() {
        let mut active = ActivePressDrag {
            start_id: 1,
            group: Some("files".to_string()),
            did_activate: false,
            left_start: false,
            start_events: Vec::new(),
            start_bounds: Bounds::default(),
            start_cancelled: false,
            release_target: None,
        };
        let files = Some("files".to_string());
        let sessions = Some("sessions".to_string());

        assert!(press_drag_should_target(&mut active, 2, &files));
        assert!(active.did_activate);
        assert!(active.left_start);
        assert!(press_drag_should_target(&mut active, 2, &files));
        assert!(press_drag_should_target(&mut active, 1, &files));
        assert!(!press_drag_should_target(&mut active, 3, &sessions));
        assert!(!press_drag_should_target(&mut active, 4, &None));
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
            release_target: None,
        };
        let files = Some("files".to_string());

        assert!(!press_drag_should_target(&mut active, 1, &files));
        active.left_start = true;
        assert!(press_drag_should_target(&mut active, 1, &files));
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
            release_target: None,
        };
        let files = Some("files".to_string());

        assert!(press_drag_should_target(&mut active, 2, &None));
        assert!(!press_drag_should_target(&mut active, 3, &files));
    }

    #[test]
    fn press_drag_records_release_target_without_immediate_action() {
        let _guard = pointer_gesture_test_guard();
        finish_pointer_gesture();
        let group = Some("project-picker-trigger".to_string());
        *ACTIVE_PRESS_DRAG.lock().unwrap() = Some(ActivePressDrag {
            start_id: 1,
            group: group.clone(),
            did_activate: false,
            left_start: false,
            start_events: Vec::new(),
            start_bounds: Bounds::default(),
            start_cancelled: false,
            release_target: None,
        });

        let target_events = vec!["responderRelease".to_string(), "press".to_string()];
        let target_bounds =
            Bounds::from_corners(point(px(10.0), px(20.0)), point(px(80.0), px(60.0)));

        assert!(track_drag_press_target_if_needed(
            2,
            &group,
            &target_events,
            point(px(32.0), px(44.0)),
            target_bounds,
            Modifiers::default(),
        ));

        let active = ACTIVE_PRESS_DRAG.lock().unwrap().clone().unwrap();
        assert!(active.did_activate);
        assert!(active.left_start);
        assert!(active.start_cancelled);
        let target = active.release_target.unwrap();
        assert_eq!(target.id, 2);
        assert_eq!(target.events, target_events);
        assert_eq!(target.bounds, target_bounds);

        let release_target = press_drag_release_target_for_start(1).unwrap();
        assert_eq!(release_target.id, 2);
        finish_pointer_gesture();
    }

    #[test]
    fn press_drag_clears_release_target_when_drag_leaves_row() {
        let _guard = pointer_gesture_test_guard();
        finish_pointer_gesture();
        *ACTIVE_PRESS_DRAG.lock().unwrap() = Some(ActivePressDrag {
            start_id: 1,
            group: Some("project-picker-trigger".to_string()),
            did_activate: true,
            left_start: true,
            start_events: Vec::new(),
            start_bounds: Bounds::default(),
            start_cancelled: true,
            release_target: Some(PressDragTarget {
                id: 2,
                events: vec!["responderRelease".to_string()],
                bounds: Bounds::from_corners(point(px(0.0), px(0.0)), point(px(10.0), px(10.0))),
            }),
        });

        press_drag_clear_release_target(3);
        assert!(press_drag_release_target_for_start(1).is_some());

        press_drag_clear_release_target(2);
        assert!(press_drag_release_target_for_start(1).is_none());
        finish_pointer_gesture();
    }

    #[test]
    fn inner_corner_radius_subtracts_largest_border() {
        assert_eq!(inner_corner_radius(px(10.0), px(1.0), px(2.0)), px(8.0));
        assert_eq!(inner_corner_radius(px(4.0), px(8.0), px(1.0)), px(0.0));
    }

    #[test]
    fn rounded_clip_radii_apply_only_to_children_touching_clip_edges() {
        let clip = RoundedOverflowClip {
            bounds: Bounds::from_corners(point(px(0.0), px(0.0)), point(px(100.0), px(60.0))),
            radii: Corners {
                top_left: px(10.0),
                top_right: px(11.0),
                bottom_right: px(12.0),
                bottom_left: px(13.0),
            },
        };

        let top_row = rounded_clip_radii_for_bounds(
            Bounds::from_corners(point(px(0.0), px(0.0)), point(px(100.0), px(20.0))),
            clip,
        );
        assert_eq!(top_row.top_left, px(10.0));
        assert_eq!(top_row.top_right, px(11.0));
        assert_eq!(top_row.bottom_right, px(0.0));
        assert_eq!(top_row.bottom_left, px(0.0));

        let middle_row = rounded_clip_radii_for_bounds(
            Bounds::from_corners(point(px(0.0), px(20.0)), point(px(100.0), px(40.0))),
            clip,
        );
        assert_eq!(middle_row, Corners::default());

        let bottom_row = rounded_clip_radii_for_bounds(
            Bounds::from_corners(point(px(0.0), px(40.0)), point(px(100.0), px(60.0))),
            clip,
        );
        assert_eq!(bottom_row.top_left, px(0.0));
        assert_eq!(bottom_row.top_right, px(0.0));
        assert_eq!(bottom_row.bottom_right, px(12.0));
        assert_eq!(bottom_row.bottom_left, px(13.0));
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
