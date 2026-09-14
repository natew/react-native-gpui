use std::path::PathBuf;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, Display, Element, ElementId, GlobalElementId, ImageSource,
    IntoElement, LayoutId, Pixels, Styled, StyledImage, Window, img, px,
};

use crate::elements::{ReactElement, report_layout};

/// `<Image source={{ uri }} />` → a GPUI `img`. `http(s)` uris load over the
/// network via GPUI's image cache; anything else is treated as a local file path.
///
/// The element lays out through its OWN style, exactly like a `View`, and the
/// `img` fills that box. It used to be the img itself, sized only from
/// `style.width`/`style.height` when both were pixel values, so every RN-shaped
/// image (`flex: 1`, `width: '100%'`, an absolutely positioned fill) laid out at
/// 0x0 and never appeared. `resizeMode` then decides how the picture fills that
/// box, defaulting to RN's `cover`.
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
            .src()
            .map(String::from)
            .or_else(|| self.element.text.clone())
            .unwrap_or_default();
        let style = &self.element.style;

        let source: ImageSource = if src.starts_with("http://") || src.starts_with("https://") {
            src.into()
        } else {
            PathBuf::from(src).into()
        };

        let mut el = img(source)
            .size_full()
            .object_fit(self.element.image_resize_mode().object_fit());
        if let Some(r) = style.border_radius {
            el = el.rounded(px(r));
        }
        el.into_any_element()
    }
}

impl Element for ReactImageElement {
    type RequestLayoutState = ();
    type PrepaintState = Option<gpui::Hitbox>;

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
        let style = self.element.build_gpui_style(None);
        if style.display == Display::None {
            self.child = None;
            return (window.request_layout(style, [], cx), ());
        }

        let mut child = self.build_child();
        let child_layout = child.request_layout(window, cx);
        self.child = Some(child);
        (window.request_layout(style, [child_layout], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        if self.element.style.is_display_none() {
            return None;
        }

        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);
        report_layout(&self.element, bounds);

        if let Some(child) = self.child.as_mut() {
            child.prepaint(window, cx);
        }

        // insert_hitbox must run in prepaint. Only content images that opted in
        // get a drag hitbox. Normal so this does not occlude a parent pressable;
        // we also skip pointer spans so the parent still wins JS onPress.
        #[cfg(target_os = "macos")]
        {
            let src = self.element.src().unwrap_or("");
            if self.element.image_drag_out()
                && !src.is_empty()
                && bounds.size.width > px(0.0)
                && bounds.size.height > px(0.0)
            {
                return Some(window.insert_hitbox(bounds, gpui::HitboxBehavior::Normal));
            }
        }
        None
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut Self::PrepaintState,
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
        #[cfg(target_os = "macos")]
        if self.element.image_drag_out() {
            if let (Some(src), Some(hitbox)) = (self.element.src(), prepaint.as_ref()) {
                crate::drag_out::wire_image_drag_out(
                    src,
                    self.element.image_drag_file_name(),
                    bounds,
                    hitbox,
                    window,
                );
            }
        }
    }
}

impl IntoElement for ReactImageElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}
