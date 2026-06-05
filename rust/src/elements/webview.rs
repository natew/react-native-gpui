use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, Bounds, ContentMask, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior,
    IntoElement, LayoutId, MouseDownEvent, Pixels, Window,
};

use crate::elements::{ReactElement, report_layout};

// The service owns one persistent wry WebView per `<WebView>` id and publishes a
// snapshot here each render, so this (stateless) element can resolve its view by id
// and park it over the right layout bounds — the standard gpui + wry overlay pattern.
thread_local! {
    static WEBVIEWS: RefCell<HashMap<u64, Rc<wry::WebView>>> = RefCell::new(HashMap::new());
    static WEBVIEW_CONTENT: RefCell<HashMap<u64, WebViewContent>> = RefCell::new(HashMap::new());
    static WEBVIEW_LOADED_CONTENT: RefCell<HashMap<u64, WebViewContent>> = RefCell::new(HashMap::new());
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebViewContent {
    pub body: String,
    pub is_html: bool,
}

pub fn set_webviews(map: HashMap<u64, Rc<wry::WebView>>, content: HashMap<u64, WebViewContent>) {
    let live_ids: std::collections::HashSet<u64> = map.keys().copied().collect();
    WEBVIEWS.with(|w| *w.borrow_mut() = map);
    WEBVIEW_CONTENT.with(|c| *c.borrow_mut() = content);
    WEBVIEW_LOADED_CONTENT.with(|loaded| {
        loaded.borrow_mut().retain(|id, _| live_ids.contains(id));
    });
}

fn webview(id: u64) -> Option<Rc<wry::WebView>> {
    WEBVIEWS.with(|w| w.borrow().get(&id).cloned())
}

fn load_if_needed(id: u64, view: &wry::WebView) {
    let content = WEBVIEW_CONTENT.with(|c| c.borrow().get(&id).cloned());
    let Some(content) = content else {
        return;
    };
    let already_loaded = WEBVIEW_LOADED_CONTENT.with(|loaded| {
        loaded
            .borrow()
            .get(&id)
            .is_some_and(|loaded| loaded == &content)
    });
    if already_loaded {
        return;
    }

    let result = if content.is_html {
        view.load_html(&content.body)
    } else {
        view.load_url(&content.body)
    };
    if std::env::var("RNGPUI_WEBVIEW_DEBUG").is_ok() {
        eprintln!(
            "[webview {id}] load is_html={} len={} -> {:?}",
            content.is_html,
            content.body.len(),
            result.map(|_| "ok")
        );
    }
    WEBVIEW_LOADED_CONTENT.with(|loaded| {
        loaded.borrow_mut().insert(id, content);
    });
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
    type PrepaintState = Option<Hitbox>;

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
    ) -> Self::PrepaintState {
        if self.element.style.is_display_none() {
            if let Some(view) = webview(self.element.global_id) {
                let _ = view.set_visible(false);
            }
            return None;
        }

        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);
        report_layout(&self.element, bounds);
        crate::inspector::refresh_layout_snapshot(
            self.element.global_id,
            bounds.origin.x.into(),
            bounds.origin.y.into(),
            bounds.size.width.into(),
            bounds.size.height.into(),
        );

        // reserve the webview's rect for gpui hit-testing. insert_hitbox must run in
        // prepaint (gpui asserts the phase — in release the assert is compiled out,
        // which is why this only crashed debug builds). the native WKWebView
        // composites above the Metal layer and handles its own scroll/selection;
        // the hitbox just keeps gpui's occlusion/event routing aware of the region.
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);

        if let Some(view) = webview(self.element.global_id) {
            if std::env::var("RNGPUI_WEBVIEW_DEBUG").is_ok() {
                eprintln!(
                    "[webview {}] bounds x={} y={} w={} h={}",
                    self.element.global_id,
                    f32::from(bounds.origin.x),
                    f32::from(bounds.origin.y),
                    f32::from(bounds.size.width),
                    f32::from(bounds.size.height)
                );
            }
            let _ = view.set_visible(true);
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
            load_if_needed(self.element.global_id, &view);
        }
        Some(hitbox)
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        _: &mut App,
    ) {
        // The WKWebView child draws itself; the content mask tells GPUI to reserve
        // this native surface inside the current clipping region.
        let bounds = hitbox
            .as_ref()
            .map(|hitbox| hitbox.bounds)
            .unwrap_or(bounds);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if let Some(view) = webview(self.element.global_id) {
                window.on_mouse_event(move |event: &MouseDownEvent, _, _, _| {
                    if !bounds.contains(&event.position) {
                        let _ = view.focus_parent();
                    }
                });
            }
        });
    }
}
