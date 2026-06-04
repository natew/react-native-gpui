use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, HitboxBehavior, IntoElement, LayoutId,
    Pixels, Window,
};

use crate::elements::ReactElement;

// The service owns one persistent wry WebView per `<WebView>` id and publishes a
// snapshot here each render, so this (stateless) element can resolve its view by id
// and park it over the right layout bounds — the standard gpui + wry overlay pattern.
thread_local! {
    static WEBVIEWS: RefCell<HashMap<u64, Rc<wry::WebView>>> = RefCell::new(HashMap::new());
}

pub fn set_webviews(map: HashMap<u64, Rc<wry::WebView>>) {
    WEBVIEWS.with(|w| *w.borrow_mut() = map);
}

fn webview(id: u64) -> Option<Rc<wry::WebView>> {
    WEBVIEWS.with(|w| w.borrow().get(&id).cloned())
}

/// `<WebView source={{ uri }} />` / `source={{ html }}` → a native WebView child of
/// the gpui window, resized to its flex layout bounds every frame.
pub struct ReactWebViewElement {
    element: Arc<ReactElement>,
}

impl ReactWebViewElement {
    pub fn new(element: Arc<ReactElement>) -> Self {
        Self { element }
    }
}

impl IntoElement for ReactWebViewElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for ReactWebViewElement {
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
        // honor the node's flex style (flex:1, width/height, margin, …)
        let style = self.element.build_gpui_style(None);
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        _cx: &mut App,
    ) {
        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);

        // reserve the webview's rect for gpui hit-testing. insert_hitbox must run in
        // prepaint (gpui asserts the phase — in release the assert is compiled out,
        // which is why this only crashed debug builds). the native WKWebView
        // composites above the Metal layer and handles its own scroll/selection;
        // the hitbox just keeps gpui's occlusion/event routing aware of the region.
        window.insert_hitbox(bounds, HitboxBehavior::Normal);

        if let Some(view) = webview(self.element.global_id) {
            let _ = view.set_bounds(wry::Rect {
                position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(
                    bounds.origin.x.into(),
                    bounds.origin.y.into(),
                )),
                size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(
                    bounds.size.width.into(),
                    bounds.size.height.into(),
                )),
            });
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        _window: &mut Window,
        _: &mut App,
    ) {
        // nothing to paint: the WKWebView child draws itself. (hitbox is inserted in
        // prepaint.)
    }
}
