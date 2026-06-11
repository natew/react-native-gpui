use std::path::PathBuf;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, Display, Element, ElementId, GlobalElementId, ImageSource,
    IntoElement, LayoutId, Pixels, Styled, Window, img, px,
};

use crate::elements::{ReactElement, report_layout};
use crate::style::Dim;

/// `<Image source={{ uri }} />` → a GPUI `img`. `http(s)` uris load over the
/// network via GPUI's image cache; anything else is treated as a local file path.
pub struct ReactImageElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    child: Option<AnyElement>,
}

impl ReactImageElement {
    pub fn new(element: Arc<ReactElement>, window_id: u64) -> Self {
        Self {
            element,
            _window_id: window_id,
            child: None,
        }
    }

    fn build_child(&self) -> AnyElement {
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

impl Element for ReactImageElement {
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
        let hidden_style = self.element.build_gpui_style(None);
        if hidden_style.display == Display::None {
            self.child = None;
            return (window.request_layout(hidden_style, [], cx), ());
        }

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
        if self.element.style.is_display_none() {
            return;
        }

        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);
        report_layout(&self.element, bounds);

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
        if self.element.style.is_display_none() {
            return;
        }

        if let Some(child) = self.child.as_mut() {
            // <Image opacity=…> fades the image; gpui's sprite paint multiplies by the
            // element-opacity stack, but nothing pushes it for a top-level image.
            window.with_element_opacity(self.element.style.opacity, |window| {
                child.paint(window, cx);
            });
        }
    }
}

impl IntoElement for ReactImageElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}
