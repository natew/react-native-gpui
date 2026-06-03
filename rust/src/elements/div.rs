use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gpui::{
    AnyElement, App, Bounds, ContentMask, DispatchPhase, Element, ElementId, GlobalElementId,
    HitboxBehavior, IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseUpEvent, Pixels,
    ScrollDelta, ScrollWheelEvent, Window, div, point, prelude::*, px, rgb,
};
use once_cell::sync::Lazy;

use crate::elements::{ReactElement, create_element};
use crate::style::ElementStyle;

// Scroll offset (in px from the top) per scroll-container id, persisted across the
// continuous re-render loop so wheel scrolling sticks.
static SCROLL: Lazy<Mutex<HashMap<u64, f32>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn get_scroll(id: u64) -> f32 {
    SCROLL.lock().unwrap().get(&id).copied().unwrap_or(0.0)
}
fn set_scroll(id: u64, v: f32) {
    SCROLL.lock().unwrap().insert(id, v);
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
    type PrepaintState = ();
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
                let text_color = self.element.style.color.unwrap_or(0xffffff);
                let text_size = self.element.style.font_size.unwrap_or(14.0);
                let te = div()
                    .text_color(rgb(text_color))
                    .text_size(px(text_size))
                    .child(text.clone());
                self.children.push(te.into_any_element());
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
    ) {
        let (_, scroll) = overflow_mode(&self.element.style);
        if scroll {
            // clamp the stored offset to the scrollable range, then shift children up
            // by it (in prepaint, so hit-testing matches what's painted).
            let content_h = Self::content_height(request_layout, window, bounds.top());
            let max_scroll: f32 = (content_h - bounds.size.height).max(px(0.0)).into();
            let off = get_scroll(self.element.global_id).clamp(0.0, max_scroll);
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
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
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
            let content_h = Self::content_height(request_layout, window, bounds.top());
            let max_scroll: f32 = (content_h - bounds.size.height).max(px(0.0)).into();
            let b = bounds;
            window.on_mouse_event(move |ev: &ScrollWheelEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble && b.contains(&ev.position) {
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

        // Pointer events: emit press / pressIn / pressOut to JS for any View whose
        // React node registered an onPress*-family handler. Bounds-gated; bubbling.
        let id = self.element.global_id;
        let press = self.element.listens("press") || self.element.listens("longPress");
        let press_in = self.element.listens("pressIn");
        let press_out = self.element.listens("pressOut");
        if press || press_in || press_out {
            let b = bounds;
            window.insert_hitbox(b, HitboxBehavior::Normal);
            if press_in {
                window.on_mouse_event(move |ev: &MouseDownEvent, phase, _w, _cx| {
                    if phase == DispatchPhase::Bubble
                        && ev.button == MouseButton::Left
                        && b.contains(&ev.position)
                    {
                        crate::bridge::event(id, "pressIn");
                    }
                });
            }
            if press || press_out {
                window.on_mouse_event(move |ev: &MouseUpEvent, phase, _w, _cx| {
                    if phase == DispatchPhase::Bubble
                        && ev.button == MouseButton::Left
                        && b.contains(&ev.position)
                    {
                        if press_out {
                            crate::bridge::event(id, "pressOut");
                        }
                        if press {
                            crate::bridge::event(id, "press");
                        }
                    }
                });
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
