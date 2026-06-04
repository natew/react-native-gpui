use std::sync::Arc;

use gpui::{AnyElement, App, Hsla, IntoElement, RenderOnce, Styled, Window, px, svg};

use crate::elements::ReactElement;
use crate::style::ElementStyle;

/// RN-bridge `<Svg name="…">` → a GPUI monochrome icon: an svg alpha-mask tinted
/// by `color`. Icon name comes from the node's `text`, size/color from style.
pub struct ReactSvgElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    _parent_style: Option<ElementStyle>,
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
        }
    }
}

impl RenderOnce for ReactSvgElement {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
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
    }
}

impl IntoElement for ReactSvgElement {
    type Element = AnyElement;
    fn into_element(self) -> Self::Element {
        gpui::Component::new(self).into_any_element()
    }
}
