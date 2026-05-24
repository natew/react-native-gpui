use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, IntoElement,
    LayoutId, Pixels, Window, div, prelude::*, px, rgb,
};

use crate::elements::{ReactElement, create_element};
use crate::style::ElementStyle;

/// The main RN View / container element in GPUI.
pub struct ReactDivElement {
    element: Arc<ReactElement>,
    window_id: u64,
    parent_style: Option<ElementStyle>,
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
            parent_style,
            children: Vec::new(),
        }
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
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) {
        for child in &mut self.children {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let style = self.element.build_gpui_style(None);
        style.paint(bounds, window, cx, |window, cx| {
            for child in &mut self.children {
                child.paint(window, cx);
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
