use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use gpui::{
    AnyElement, App, Bounds, ContentMask, DispatchPhase, Element, ElementId, GlobalElementId,
    Hitbox, HitboxBehavior, Hsla, IntoElement, LayoutId, MouseButton, MouseDownEvent,
    MouseExitEvent, MouseMoveEvent, MouseUpEvent, Pixels, ScrollDelta, ScrollWheelEvent, Window,
    div, point, prelude::*, px,
};
use once_cell::sync::Lazy;

use crate::elements::{ReactElement, create_element};
use crate::style::ElementStyle;

// Scroll offset (in px from the top) per scroll-container id, persisted across the
// continuous re-render loop so wheel scrolling sticks.
static SCROLL: Lazy<Mutex<HashMap<u64, f32>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static SCROLL_TO_END: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static HOVER: Lazy<Mutex<HashSet<u64>>> = Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(Clone, Default)]
pub struct DivPrepaintState {
    hitbox: Option<Hitbox>,
    max_scroll: f32,
}

fn get_scroll(id: u64) -> f32 {
    SCROLL.lock().unwrap().get(&id).copied().unwrap_or(0.0)
}
fn set_scroll(id: u64, v: f32) {
    SCROLL.lock().unwrap().insert(id, v);
}

pub fn scroll_to(id: u64, y: f32) {
    set_scroll(id, y.max(0.0));
}

pub fn scroll_to_end(id: u64) {
    SCROLL_TO_END.lock().unwrap().insert(id);
}

fn take_scroll_to_end(id: u64) -> bool {
    SCROLL_TO_END.lock().unwrap().remove(&id)
}

fn emit_if(id: u64, enabled: bool, name: &str) {
    if enabled {
        crate::bridge::event(id, name);
    }
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
    fn content_height(layout: &[LayoutId], window: &mut Window, top: Pixels) -> Pixels {
        let mut bottom = top;
        for lid in layout {
            let b = window.layout_bounds(*lid);
            if b.bottom() > bottom {
                bottom = b.bottom();
            }
        }
        (bottom - top).max(px(0.0))
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
        let style = self.element.build_gpui_style(None);
        let inherited = self.element.style.clone();

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
        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);

        let (_, scroll) = overflow_mode(&self.element.style);

        // claim a hitbox for any view that handles pointer or scroll input.
        // insert_hitbox must run in prepaint (gpui asserts the phase); mouse
        // listeners are wired in paint and query the hitbox's current hover state.
        let interactive = [
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
        let hitbox = if interactive || scroll {
            Some(window.insert_hitbox(bounds, HitboxBehavior::Normal))
        } else {
            None
        };

        let mut max_scroll = 0.0;
        if scroll {
            // clamp the stored offset to the scrollable range, then shift children up
            // by it (in prepaint, so hit-testing matches what's painted).
            let content_h = Self::content_height(request_layout, window, bounds.top());
            max_scroll = (content_h - bounds.size.height).max(px(0.0)).into();
            let off = if take_scroll_to_end(self.element.global_id) {
                max_scroll
            } else {
                get_scroll(self.element.global_id).clamp(0.0, max_scroll)
            };
            set_scroll(self.element.global_id, off);
            window.with_element_offset(point(px(0.0), px(-off)), |window| {
                for child in &mut self.children {
                    child.prepaint(window, cx);
                }
            });
        } else {
            for child in &mut self.children {
                child.prepaint(window, cx);
            }
        }

        DivPrepaintState { hitbox, max_scroll }
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
        let style = self.element.build_gpui_style(None);
        let (clip, scroll) = overflow_mode(&self.element.style);

        // Wheel handling: a listener that nudges the persisted offset and asks for a
        // repaint. Gated by `bounds.contains` (not `should_handle_scroll`, whose
        // hit-test set only stays fresh under continuous rendering — we render
        // on-demand). Bubble runs inner→outer; the inner scroller consumes and stops
        // propagation so an ancestor doesn't also move.
        if scroll {
            let id = self.element.global_id;
            let max_scroll = prepaint.max_scroll;
            let hitbox = prepaint.hitbox.clone();
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
                    let cur = get_scroll(id);
                    let next = (cur - dy).clamp(0.0, max_scroll);
                    if (next - cur).abs() > 0.01 {
                        set_scroll(id, next);
                        window.refresh(); // on-demand: repaint to reflect the new offset
                        cx.stop_propagation();
                    }
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
                    let hitbox = hitbox.clone();
                    window.on_mouse_event(move |ev: &MouseDownEvent, phase, window, _cx| {
                        if phase == DispatchPhase::Bubble
                            && ev.button == MouseButton::Left
                            && hitbox.is_hovered(window)
                        {
                            emit_if(id, mouse_down, "mouseDown");
                            emit_if(id, pointer_down, "pointerDown");
                            emit_if(id, touch_start, "touchStart");
                            emit_if(
                                id,
                                start_responder_capture,
                                "startShouldSetResponderCapture",
                            );
                            emit_if(id, start_responder, "startShouldSetResponder");
                            emit_if(id, responder_start, "responderStart");
                            emit_if(id, responder_grant, "responderGrant");
                            emit_if(id, press_in, "pressIn");
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
                    let hitbox = hitbox.clone();
                    window.on_mouse_event(move |ev: &MouseUpEvent, phase, window, _cx| {
                        if phase == DispatchPhase::Bubble
                            && ev.button == MouseButton::Left
                            && hitbox.is_hovered(window)
                        {
                            emit_if(id, mouse_up, "mouseUp");
                            emit_if(id, pointer_up, "pointerUp");
                            emit_if(id, touch_end, "touchEnd");
                            emit_if(id, responder_release, "responderRelease");
                            emit_if(id, responder_end, "responderEnd");
                            emit_if(id, press_out, "pressOut");
                            emit_if(id, press, "press");
                            emit_if(id, click, "click");
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
                    window.on_mouse_event(move |_ev: &MouseMoveEvent, phase, window, _cx| {
                        if phase != DispatchPhase::Bubble {
                            return;
                        }
                        let inside = hitbox_for_move.is_hovered(window);
                        let mut hover = HOVER.lock().unwrap();
                        let was_inside = hover.contains(&id);
                        if inside && !was_inside {
                            hover.insert(id);
                            drop(hover);
                            emit_if(id, mouse_enter, "mouseEnter");
                            emit_if(id, mouse_over, "mouseOver");
                            emit_if(id, pointer_enter, "pointerEnter");
                        } else if !inside && was_inside {
                            hover.remove(&id);
                            drop(hover);
                            emit_if(id, mouse_leave, "mouseLeave");
                            emit_if(id, mouse_out, "mouseOut");
                            emit_if(id, pointer_leave, "pointerLeave");
                        } else {
                            drop(hover);
                        }
                        if inside {
                            emit_if(id, mouse_move, "mouseMove");
                            emit_if(id, pointer_move, "pointerMove");
                            emit_if(id, touch_move, "touchMove");
                            emit_if(id, responder_move, "responderMove");
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

        // onLayout: report the measured rect (deduped per id across frames).
        if self.element.listens("layout") {
            crate::bridge::layout_if_changed(
                id,
                bounds.origin.x.into(),
                bounds.origin.y.into(),
                bounds.size.width.into(),
                bounds.size.height.into(),
            );
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
