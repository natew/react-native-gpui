use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Bounds, ContentMask, CursorStyle, DispatchPhase, Display, Element, ElementId,
    GlobalElementId, Hitbox, HitboxBehavior, Hsla, IntoElement, LayoutId, Modifiers, MouseButton,
    MouseDownEvent, MouseExitEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, ScrollDelta,
    ScrollWheelEvent, Window, div, point, prelude::*, px,
};
use once_cell::sync::Lazy;

use crate::elements::{NativeResizeEdge, ReactElement, create_element, report_layout};
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

static SCROLL: Lazy<Mutex<HashMap<u64, ScrollOffset>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static SCROLL_TO_END: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static HOVER: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static ACTIVE_MOUSE_TARGET: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
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

pub fn set_native_layout_override(key: &str, width: Option<f32>, height: Option<f32>) {
    if key.is_empty() {
        return;
    }
    NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().remove(key);
    set_native_layout_override_now(key, width, height);
}

pub fn animate_native_layout_override(
    key: &str,
    width: Option<f32>,
    height: Option<f32>,
    duration_ms: f32,
) {
    if key.is_empty() {
        return;
    }
    if duration_ms <= 0.0 || (!duration_ms.is_finite()) {
        set_native_layout_override(key, width, height);
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
    NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().insert(
        key.to_string(),
        NativeLayoutAnimation {
            from_width,
            to_width: width,
            from_height,
            to_height: height,
            start: Instant::now(),
            duration: Duration::from_secs_f32((duration_ms / 1000.0).max(0.001)),
        },
    );
}

fn set_native_layout_override_now(key: &str, width: Option<f32>, height: Option<f32>) {
    let mut overrides = NATIVE_LAYOUT_OVERRIDES.lock().unwrap();
    let mut next = overrides.get(key).copied().unwrap_or_default();
    if width.is_some() {
        next.width = width;
    }
    if height.is_some() {
        next.height = height;
    }
    if next.width.is_none() && next.height.is_none() {
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
            set_native_layout_override_now(key, animation.to_width, animation.to_height);
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

fn native_layout_is_animating(key: &str) -> bool {
    NATIVE_LAYOUT_ANIMATIONS.lock().unwrap().contains_key(key)
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
            set_native_layout_override(&active.target, Some(next), None);
        }
        changed
    } else {
        let changed = current
            .height
            .is_none_or(|value| (value - next).abs() > 0.5);
        if changed {
            set_native_layout_override(&active.target, None, Some(next));
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
    children: Vec<AnyElement>,
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
            if native_layout_is_animating(key) {
                window.refresh();
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
            .map(|child| create_element(child.clone(), self.window_id, Some(inherited.clone())))
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
                self.children
                    .push(te.child(text.clone()).into_any_element());
            }
        }

        let child_ids: Vec<_> = self
            .children
            .iter_mut()
            .map(|c| c.request_layout(window, cx))
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

        let mut max_scroll_x = 0.0;
        let mut max_scroll_y = 0.0;
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
                for child in &mut self.children {
                    child.prepaint(window, cx);
                }
            });
        } else {
            for child in &mut self.children {
                child.prepaint(window, cx);
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

        let style = self.element.build_gpui_style(None);
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
                {
                    let event_bounds = hitbox.bounds.intersect(&hitbox.content_mask.bounds);
                    let layout_bounds = bounds;
                    window.on_mouse_event(move |ev: &MouseDownEvent, phase, _window, _cx| {
                        if phase == DispatchPhase::Bubble
                            && ev.button == MouseButton::Left
                            && event_bounds.contains(&ev.position)
                        {
                            let mut active = ACTIVE_MOUSE_TARGET.lock().unwrap();
                            if active.is_none() {
                                *active = Some(id);
                            }
                            drop(active);
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
                        let captured = ACTIVE_MOUSE_TARGET.lock().unwrap().as_ref() == Some(&id);
                        if !inside && !captured {
                            return;
                        }
                        if captured {
                            *ACTIVE_MOUSE_TARGET.lock().unwrap() = None;
                        }
                        emit_mouse_if(
                            id,
                            mouse_up,
                            "mouseUp",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            pointer_up,
                            "pointerUp",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            touch_end,
                            "touchEnd",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        emit_mouse_if(
                            id,
                            responder_release,
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
                            press_out,
                            "pressOut",
                            ev.position,
                            layout_bounds,
                            ev.modifiers,
                        );
                        if inside {
                            emit_mouse_if(
                                id,
                                press,
                                "press",
                                ev.position,
                                layout_bounds,
                                ev.modifiers,
                            );
                            emit_mouse_if(
                                id,
                                click,
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
                {
                    let hitbox_for_move = hitbox.clone();
                    let layout_bounds = bounds;
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
                        } else if !inside && was_inside {
                            hover.remove(&id);
                            drop(hover);
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
                        }
                        let captured = ACTIVE_MOUSE_TARGET.lock().unwrap().as_ref() == Some(&id);
                        if inside || captured {
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

        style.paint(bounds, window, cx, |window, cx| {
            if clip {
                window.with_content_mask(Some(ContentMask { bounds }), |window| {
                    for child in &mut self.children {
                        child.paint(window, cx);
                    }
                });
            } else {
                for child in &mut self.children {
                    child.paint(window, cx);
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

    use gpui::px;
    use once_cell::sync::Lazy;

    use super::{
        ActiveNativeResize, NATIVE_LAYOUT_ANIMATIONS, NATIVE_LAYOUT_FRAMES,
        NATIVE_LAYOUT_OVERRIDES, NativeLayoutAnimation, NativeLayoutOverride,
        clear_native_layout_override, get_scroll, native_layout_animation_value,
        native_layout_override, remember_native_layout_frame, scroll_to,
        set_native_layout_override, update_native_resize,
    };
    use crate::elements::NativeResizeEdge;

    static NATIVE_LAYOUT_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn native_layout_test_guard() -> MutexGuard<'static, ()> {
        NATIVE_LAYOUT_TEST_LOCK.lock().unwrap()
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
    fn native_layout_override_updates_axes_independently() {
        let _guard = native_layout_test_guard();
        clear_native_layout_override("pane-a");
        set_native_layout_override("pane-a", Some(240.0), None);
        set_native_layout_override("pane-a", None, Some(120.0));
        let next = native_layout_override("pane-a");
        assert_eq!(next.width, Some(240.0));
        assert_eq!(next.height, Some(120.0));
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
            start,
            duration: Duration::from_millis(100),
        };

        let (initial, done) = native_layout_animation_value(animation, start);
        assert_eq!(initial.width, Some(100.0));
        assert_eq!(initial.height, Some(60.0));
        assert!(!done);

        let (mid, done) =
            native_layout_animation_value(animation, start + Duration::from_millis(50));
        assert!(mid.width.unwrap() > 100.0);
        assert!(mid.width.unwrap() < 200.0);
        assert!(mid.height.unwrap() > 60.0);
        assert!(mid.height.unwrap() < 120.0);
        assert!(!done);

        let (final_size, done) =
            native_layout_animation_value(animation, start + Duration::from_millis(100));
        assert_eq!(final_size.width, Some(200.0));
        assert_eq!(final_size.height, Some(120.0));
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
        set_native_layout_override("keep", Some(10.0), None);
        set_native_layout_override("drop", Some(20.0), None);
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
