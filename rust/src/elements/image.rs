use std::path::PathBuf;
use std::sync::Arc;

use gpui::{AnyElement, App, ImageSource, IntoElement, RenderOnce, Styled, Window, img, px};

use crate::elements::ReactElement;
use crate::style::{Dim, ElementStyle};

/// `<Image source={{ uri }} />` → a GPUI `img`. `http(s)` uris load over the
/// network via GPUI's image cache; anything else is treated as a local file path.
pub struct ReactImageElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    _parent_style: Option<ElementStyle>,
}

impl ReactImageElement {
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

impl RenderOnce for ReactImageElement {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let src = self
            .element
            .src
            .clone()
            .or_else(|| self.element.text.clone())
            .unwrap_or_default();
        let style = &self.element.style;

        let source: ImageSource = if src.starts_with("http://") || src.starts_with("https://") {
            src.into()
        } else {
            PathBuf::from(src).into()
        };

        let mut el = img(source);
        if let Some(w) = style.width.and_then(Dim::as_px) {
            el = el.w(px(w));
        }
        if let Some(h) = style.height.and_then(Dim::as_px) {
            el = el.h(px(h));
        }
        if let Some(r) = style.border_radius {
            el = el.rounded(px(r));
        }
        el.into_any_element()
    }
}

impl IntoElement for ReactImageElement {
    type Element = AnyElement;
    fn into_element(self) -> Self::Element {
        gpui::Component::new(self).into_any_element()
    }
}
