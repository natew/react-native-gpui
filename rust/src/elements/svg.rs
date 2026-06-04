use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, Hsla, IntoElement, LayoutId,
    Pixels, Styled, Window, px, svg,
};

use crate::elements::ReactElement;
use crate::style::ElementStyle;

/// RN-bridge `<Svg name="…">` → a GPUI monochrome icon: an svg alpha-mask tinted
/// by `color`. Icon name comes from the node's `text`, size/color from style.
pub struct ReactSvgElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    _parent_style: Option<ElementStyle>,
    child: Option<AnyElement>,
}

impl ReactSvgElement {
    pub fn new(
        element: Arc<ReactElement>,
        window_id: u64,
        parent_style: Option<ElementStyle>,
    ) -> Self {
        Self {
            element,
            _window_id: window_id,
            _parent_style: parent_style,
            child: None,
        }
    }

    fn build_child(&self) -> AnyElement {
        let name = self.element.text.clone().unwrap_or_default();
        let size = self
            .element
            .style
            .width
            .or(self.element.style.height)
            .and_then(crate::style::Dim::as_px)
            .unwrap_or(16.0);
        let color = self.element.style.color.unwrap_or(Hsla {
            h: 0.0,
            s: 0.0,
            l: 0.0,
            a: 1.0,
        });
        svg()
            .path(name)
            .size(px(size))
            .text_color(color)
            .flex_none()
            .into_any_element()
    }
}

impl Element for ReactSvgElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Integer(self.element.global_id))
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut child = self.build_child();
        let layout_id = child.request_layout(window, cx);
        self.child = Some(child);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);

        if let Some(child) = self.child.as_mut() {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(child) = self.child.as_mut() {
            child.paint(window, cx);
        }
    }
}

impl IntoElement for ReactSvgElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}
