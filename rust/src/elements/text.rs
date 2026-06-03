use std::sync::Arc;

use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled, Window, div, px, rgb};

use crate::elements::ReactElement;
use crate::style::ElementStyle;

pub struct ReactTextElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    _parent_style: Option<ElementStyle>,
}

impl ReactTextElement {
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

impl RenderOnce for ReactTextElement {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let color = self.element.style.color.unwrap_or(0xffffff);
        let size = self.element.style.font_size.unwrap_or(14.0);
        let text = self.element.text.clone().unwrap_or_default();
        let mut el = div().text_color(rgb(color)).text_size(px(size));
        if let Some(weight) = self.element.style.gpui_font_weight() {
            el = el.font_weight(weight);
        }
        if let Some(lh) = self.element.style.line_height {
            el = el.line_height(px(lh));
        }
        el.child(text)
    }
}

impl IntoElement for ReactTextElement {
    type Element = AnyElement;
    fn into_element(self) -> Self::Element {
        gpui::Component::new(self).into_any_element()
    }
}
