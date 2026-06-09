use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior, Hsla, IntoElement,
    LayoutId, MouseDownEvent, Pixels, Window,
};

use crate::elements::{ReactElement, report_layout};
use crate::style::ElementStyle;

#[cfg(target_os = "macos")]
use cocoa::appkit::{NSViewHeightSizable, NSViewWidthSizable};
#[cfg(target_os = "macos")]
use cocoa::base::{NO, YES, id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSPoint, NSRect, NSSize};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
#[cfg(target_os = "macos")]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(target_os = "macos")]
use wry::WebViewExtMacOS;

#[cfg(target_os = "macos")]
const CA_LAYER_MIN_X_MIN_Y_CORNER: u64 = 1 << 0;
#[cfg(target_os = "macos")]
const CA_LAYER_MAX_X_MIN_Y_CORNER: u64 = 1 << 1;
#[cfg(target_os = "macos")]
const CA_LAYER_MIN_X_MAX_Y_CORNER: u64 = 1 << 2;
#[cfg(target_os = "macos")]
const CA_LAYER_MAX_X_MAX_Y_CORNER: u64 = 1 << 3;

#[cfg(target_os = "macos")]
#[allow(non_snake_case)]
unsafe extern "C" {
    // CoreGraphics: a rounded-rect CGPath for the decoration layer's `shadowPath`, so
    // the drop shadow is a crisp rounded-card silhouette independent of view content.
    fn CGPathCreateWithRoundedRect(
        rect: cocoa::foundation::NSRect,
        corner_width: f64,
        corner_height: f64,
        transform: *const std::ffi::c_void,
    ) -> id;
    fn CGPathRelease(path: id);
}
// The service owns one persistent wry WebView per `<WebView>` id and publishes a
// snapshot here each render, so this (stateless) element can resolve its view by id
// and park it over the right layout bounds — the standard gpui + wry overlay pattern.
thread_local! {
    static WEBVIEWS: RefCell<HashMap<u64, Rc<wry::WebView>>> = RefCell::new(HashMap::new());
    static WEBVIEW_CONTENT: RefCell<HashMap<u64, WebViewContent>> = RefCell::new(HashMap::new());
    static WEBVIEW_LOADED_CONTENT: RefCell<HashMap<u64, WebViewContent>> = RefCell::new(HashMap::new());
    #[cfg(target_os = "macos")]
    static WEBVIEW_HOSTS: RefCell<HashMap<u64, id>> = RefCell::new(HashMap::new());
    // A general "below-webview decoration" NSView per webview id, ordered in the parent
    // z-stack directly BELOW the host (backing → DECOR → host → gpui_view). It carries
    // native decoration that must sit UNDER the page — today the rounded card drop
    // shadow, and it's deliberately reusable so fill / border / gradient could ride the
    // same layer later. Because the opaque WebView in front covers the decoration's
    // center, only its outward spill (the shadow) is ever visible — it can never bleed
    // over the page interior the way a gpui boxShadow painted in the Metal layer above
    // the underlay does. This is the doc's recommended Approach C (native-view
    // interleaving), the same move rngpui already makes for the glass + backing views.
    #[cfg(target_os = "macos")]
    static WEBVIEW_DECOR_VIEWS: RefCell<HashMap<u64, id>> = RefCell::new(HashMap::new());
    #[cfg(target_os = "macos")]
    static WEBVIEW_BACKING_VIEWS: RefCell<HashMap<usize, id>> = RefCell::new(HashMap::new());
    // last native geometry we actually applied per webview id, so we can skip the
    // per-frame setFrame churn when nothing moved (see position_webview_host).
    #[cfg(target_os = "macos")]
    static WEBVIEW_LAST_BOUNDS: RefCell<HashMap<u64, (f64, f64, f64, f64)>> = RefCell::new(HashMap::new());
    #[cfg(target_os = "macos")]
    static WEBVIEW_LAST_HOST_STYLES: RefCell<HashMap<u64, WebViewHostStyle>> = RefCell::new(HashMap::new());
    // last (width, height, shadow) the decor was actually applied at, so a resize
    // (size changes, shadow style does not) only re-traces the size-dependent
    // shadowPath and skips re-setting color/opacity/radius/offset (which each
    // allocate an NSColor/CGColor) every frame. see apply_webview_decor.
    #[cfg(target_os = "macos")]
    static WEBVIEW_LAST_DECOR_APPLIED: RefCell<HashMap<u64, (f64, f64, WebViewShadow)>> = RefCell::new(HashMap::new());
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct WebViewHostStyle {
    background_color: Option<(f32, f32, f32, f32)>,
    corner_clip: WebViewCornerClip,
    decor: WebViewDecor,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct WebViewCornerClip {
    radius: f32,
    masked_corners: u64,
}

// The resolved "below-webview decoration": currently just the rounded card drop
// shadow, derived from the webview element's `boxShadow`. `None` shadow → no decoration
// (the decor view stays hidden). Folded into WebViewHostStyle so position_webview_host
// re-applies the decoration when the style changes (same gate as the corner clip).
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct WebViewDecor {
    shadow: Option<WebViewShadow>,
}

// One CALayer drop shadow: an opaque srgb color + separate opacity (the way CALayer
// wants them), a blur radius, a screen-space offset, and the rounded-rect corner the
// `shadowPath` traces so the silhouette matches the card.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct WebViewShadow {
    color: (f32, f32, f32),
    opacity: f32,
    radius: f32,
    offset_x: f32,
    offset_y: f32,
    corner_radius: f32,
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
    #[cfg(target_os = "macos")]
    WEBVIEW_LAST_BOUNDS.with(|b| {
        b.borrow_mut().retain(|id, _| live_ids.contains(id));
    });
    #[cfg(target_os = "macos")]
    WEBVIEW_LAST_HOST_STYLES.with(|s| {
        s.borrow_mut().retain(|id, _| live_ids.contains(id));
    });
    #[cfg(target_os = "macos")]
    WEBVIEW_HOSTS.with(|hosts| {
        hosts.borrow_mut().retain(|id, host| {
            if live_ids.contains(id) {
                return true;
            }
            unsafe {
                let _: () = msg_send![*host, removeFromSuperview];
                let _: () = msg_send![*host, release];
            }
            false
        });
    });
    #[cfg(target_os = "macos")]
    WEBVIEW_DECOR_VIEWS.with(|decor| {
        decor.borrow_mut().retain(|id, view| {
            if live_ids.contains(id) {
                return true;
            }
            unsafe {
                let _: () = msg_send![*view, removeFromSuperview];
                let _: () = msg_send![*view, release];
            }
            false
        });
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

#[cfg(target_os = "macos")]
fn raw_ns_view(window: &mut Window) -> Option<id> {
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(handle) => Some(handle.ns_view.as_ptr() as id),
        _ => None,
    }
}

// CoreGraphics scroll-event FFI used only by the native-scroll proof command. Builds a
// real pixel-unit scroll-wheel CGEvent we can lift into an NSEvent and hand to AppKit's
// `scrollWheel:` — the same kind of event WebKit's scroll machinery consumes from a
// trackpad, so the page scrolls natively with zero rngpui JS forwarding.
#[cfg(target_os = "macos")]
#[allow(non_snake_case)]
unsafe extern "C" {
    fn CGEventCreateScrollWheelEvent(
        source: *const std::ffi::c_void,
        units: u32,
        wheelCount: u32,
        wheel1: i32,
        ...
    ) -> id;
    fn CFRelease(cf: id);
}

// kCGScrollEventUnitPixel — pixel-precise scroll, matching a trackpad gesture.
#[cfg(target_os = "macos")]
const CG_SCROLL_UNIT_PIXEL: u32 = 0;

/// Ground-truth proof that native scroll routing works: run the REAL AppKit `hitTest:`
/// at (x, y) in the gpui window and report which view class wins, then deliver a real
/// scroll-wheel `NSEvent` to that view via `scrollWheel:`. No `evaluate_script`, no
/// `webview_scroll_script` — if the hit-test passthrough is doing its job the resolved
/// view is the WKWebView (its content scroll view), not `GPUIView`, and WebKit scrolls
/// the page from a genuine native event. Returns (hit_view_class, dispatched).
#[cfg(target_os = "macos")]
pub(crate) fn native_scroll_proof(window: &mut Window, x: f64, y: f64, dy: f64) -> (String, bool) {
    let Some(gpui_view) = raw_ns_view(window) else {
        return ("<no-ns-view>".into(), false);
    };
    unsafe {
        let ns_window: id = msg_send![gpui_view, window];
        if ns_window == nil {
            return ("<no-window>".into(), false);
        }
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return ("<no-content-view>".into(), false);
        }
        // hitTest: takes a point in the receiver's SUPERVIEW coords. The content view's
        // superview is the window's theme frame; for a borderless test window the content
        // view fills it, so a content-local top-left point maps to the same value flipped
        // into AppKit's bottom-left origin. Convert (x, y) — gpui top-left logical px —
        // into the content view's superview space.
        let bounds: NSRect = msg_send![content_view, bounds];
        let flipped: objc::runtime::BOOL = msg_send![content_view, isFlipped];
        let local_y = if flipped == YES {
            y
        } else {
            bounds.size.height - y
        };
        let local = NSPoint::new(x, local_y);
        let superview: id = msg_send![content_view, superview];
        let point_in_super: NSPoint = if superview != nil {
            msg_send![content_view, convertPoint: local toView: superview]
        } else {
            local
        };
        // the REAL hitTest: — this invokes GPUIView's overridden hit_test (hit_passthrough),
        // so a webview region returns nil and AppKit walks down to the WKWebView sibling.
        let hit: id = msg_send![content_view, hitTest: point_in_super];
        let class_name = if hit == nil {
            "<nil>".to_string()
        } else {
            // object_getClassName returns the instance's class name as a C string —
            // unlike `[[obj class] name]`, which sends `name` to the class object (not
            // every class responds to +name, and WryWebView does not).
            unsafe extern "C" {
                fn object_getClassName(obj: id) -> *const std::os::raw::c_char;
            }
            let name_ptr = object_getClassName(hit);
            if name_ptr.is_null() {
                "<unknown>".to_string()
            } else {
                std::ffi::CStr::from_ptr(name_ptr)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        if hit == nil {
            return (class_name, false);
        }

        // build a real pixel-unit scroll-wheel CGEvent and lift it into an NSEvent. dy>0
        // scrolls the page DOWN; an AppKit scroll wheel uses the opposite sign (content
        // moves with the wheel), so negate.
        let cg_event: id =
            CGEventCreateScrollWheelEvent(std::ptr::null(), CG_SCROLL_UNIT_PIXEL, 1, -(dy as i32));
        if cg_event == nil {
            return (class_name, false);
        }
        let ns_event: id = msg_send![class!(NSEvent), eventWithCGEvent: cg_event];
        CFRelease(cg_event);
        if ns_event == nil {
            return (class_name, false);
        }
        // deliver the scroll-wheel event natively to the hit view's responder chain.
        let _: () = msg_send![hit, scrollWheel: ns_event];
        (class_name, true)
    }
}

#[cfg(target_os = "macos")]
fn webview_object(view: &wry::WebView) -> id {
    let webview = view.webview();
    (&*webview) as *const _ as id
}

// Shared with blur.rs: resolve gpui's Metal NSView's parent + the Metal view itself,
// installing the transparent-window backing if needed. Both native-underlay elements
// (webview, blur) park their child views in this parent BELOW the Metal view.
#[cfg(target_os = "macos")]
pub(crate) fn webview_parent(window: &mut Window) -> Option<(id, id)> {
    let gpui_view = raw_ns_view(window)?;

    unsafe {
        let direct_parent: id = msg_send![gpui_view, superview];
        if direct_parent != nil {
            ensure_backing_view(direct_parent, gpui_view);
            return Some((direct_parent, gpui_view));
        }

        let ns_window: id = msg_send![gpui_view, window];
        if ns_window == nil {
            return None;
        }

        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return None;
        }

        if content_view != gpui_view {
            ensure_backing_view(content_view, gpui_view);
            return Some((content_view, gpui_view));
        }

        let parent_view = wrap_gpui_content_view(ns_window, gpui_view);
        ensure_backing_view(parent_view, gpui_view);
        Some((parent_view, gpui_view))
    }
}

#[cfg(target_os = "macos")]
unsafe fn wrap_gpui_content_view(ns_window: id, gpui_view: id) -> id {
    let frame: NSRect = msg_send![gpui_view, frame];
    let bounds: NSRect = msg_send![gpui_view, bounds];
    let container: id = msg_send![class!(NSView), alloc];
    let container: id = msg_send![container, initWithFrame: frame];

    unsafe {
        configure_transparent_view(container);
        configure_transparent_view(gpui_view);
    }
    let autoresize = NSViewWidthSizable | NSViewHeightSizable;
    let _: () = msg_send![container, setAutoresizingMask: autoresize];
    let _: () = msg_send![container, setAutoresizesSubviews: YES];

    let _: id = msg_send![gpui_view, retain];
    let _: () = msg_send![ns_window, setContentView: container];
    let _: () = msg_send![gpui_view, setFrame: bounds];
    let _: () = msg_send![gpui_view, setAutoresizingMask: autoresize];
    let _: () = msg_send![container, addSubview: gpui_view];
    let _: () = msg_send![gpui_view, release];

    container
}

#[cfg(target_os = "macos")]
unsafe fn ensure_backing_view(parent_view: id, gpui_view: id) {
    if parent_view == nil || gpui_view == nil {
        return;
    }

    let key = parent_view as usize;
    WEBVIEW_BACKING_VIEWS.with(|backings| {
        let mut backings = backings.borrow_mut();
        let backing = *backings.entry(key).or_insert_with(|| unsafe {
            let bounds: NSRect = msg_send![parent_view, bounds];
            let backing: id = msg_send![class!(NSView), alloc];
            let backing: id = msg_send![backing, initWithFrame: bounds];
            configure_backing_view(backing);
            backing
        });

        unsafe {
            let current_parent: id = msg_send![backing, superview];
            if current_parent != nil && current_parent != parent_view {
                let _: () = msg_send![backing, removeFromSuperview];
            }
            if current_parent != parent_view {
                let _: () = msg_send![parent_view, addSubview: backing];
            }
            // The backing view is a layer-backed, full-window NSView whose setFrame runs
            // on every prepaint (webview_parent is called each frame). Re-setting an
            // unchanged frame each frame is wasted work, and an implicit CoreAnimation
            // bounds tween on this clear full-window layer adds to the per-frame resize
            // cost. Skip when the parent bounds are unchanged, and disable implicit
            // actions so the resize step that does change lands synchronously.
            let bounds: NSRect = msg_send![parent_view, bounds];
            let current: NSRect = msg_send![backing, frame];
            let same = (current.origin.x - bounds.origin.x).abs() < 0.01
                && (current.origin.y - bounds.origin.y).abs() < 0.01
                && (current.size.width - bounds.size.width).abs() < 0.01
                && (current.size.height - bounds.size.height).abs() < 0.01;
            if !same {
                let _: () = msg_send![class!(CATransaction), begin];
                let _: () = msg_send![class!(CATransaction), setDisableActions: YES];
                let _: () = msg_send![backing, setFrame: bounds];
                let _: () = msg_send![class!(CATransaction), commit];
            }
            let _: () = msg_send![backing, setHidden: NO];
        }
    });
}

#[cfg(target_os = "macos")]
fn ensure_host_view(id: u64, parent_view: id, gpui_view: id) -> id {
    WEBVIEW_HOSTS.with(|hosts| {
        let mut hosts = hosts.borrow_mut();
        let host = *hosts.entry(id).or_insert_with(|| unsafe {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
            let host: id = msg_send![class!(NSView), alloc];
            let host: id = msg_send![host, initWithFrame: frame];
            configure_transparent_view(host);
            // The host must NOT autoresize the WKWebView. We drive the webview's frame
            // explicitly every changed prepaint (see position_webview_host). If the host
            // also resized it via the autoresizing machinery, there'd be two competing
            // sizing authorities running in the same layout pass during a continuous
            // resize: AppKit's proportional autoresize (off the OLD host bounds) and our
            // hard setFrame (the NEW bounds). They momentarily disagree, and since the
            // WebContent process re-lays-out async across XPC, the page's right-edge
            // scrollbar oscillates "further and closer" + lags the native frame — exactly
            // the reported jitter. One source of truth = our setFrame, so turn host
            // autoresizing off here once.
            let _: () = msg_send![host, setAutoresizesSubviews: NO];
            host
        });

        unsafe {
            let current_parent: id = msg_send![host, superview];
            // Is the Metal view already the topmost subview (the invariant we want)?
            let subviews: id = msg_send![parent_view, subviews];
            let count: usize = msg_send![subviews, count];
            let topmost: id = if count > 0 {
                msg_send![subviews, objectAtIndex: count - 1]
            } else {
                nil
            };
            // Only (re)establish the underlay hierarchy + z-order when it's actually
            // wrong. `addSubview:` on an existing subview removes-and-re-adds it, so
            // doing this every prepaint tears the Metal view (the whole app UI) out of
            // the window and re-inserts it on EVERY repaint — that's the "whole app
            // flickers away on mousemove near the webview edge" report (mousemove drives
            // repaints; idle has none, so it only flickers while moving). Once set up the
            // order is stable, so the steady-state path here is a cheap no-op.
            if current_parent != parent_view || topmost != gpui_view {
                if std::env::var("RNGPUI_WEBVIEW_GEOMETRY_DEBUG").is_ok() {
                    eprintln!(
                        "[webview {id}] re-establishing underlay z-order (reparent={} topmost_wrong={})",
                        current_parent != parent_view,
                        topmost != gpui_view
                    );
                }
                if current_parent != nil && current_parent != parent_view {
                    let _: () = msg_send![host, removeFromSuperview];
                }
                // re-stack bottom→top: backing, then the below-webview decoration
                // (shadow), then the webview host, then gpui's Metal view on top.
                // `addSubview:` appends, so this order yields exactly this z-order.
                if let Some(backing) = backing_view(parent_view) {
                    let _: () = msg_send![parent_view, addSubview: backing];
                }
                let decor = ensure_decor_view(id);
                let _: () = msg_send![parent_view, addSubview: decor];
                let _: () = msg_send![parent_view, addSubview: host];
                let _: () = msg_send![parent_view, addSubview: gpui_view];
            }
        }

        host
    })
}

// The per-webview below-webview decoration view (created lazily). Layer-backed, clear,
// `masksToBounds=NO` so its CALayer drop shadow can spill past its frame. It holds no
// content — its job is the shadow (and, in future, fill/border), so it draws regardless
// of what is painted in front of it.
#[cfg(target_os = "macos")]
fn ensure_decor_view(id: u64) -> id {
    WEBVIEW_DECOR_VIEWS.with(|decor| {
        let mut decor = decor.borrow_mut();
        *decor.entry(id).or_insert_with(|| unsafe {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
            let view: id = msg_send![class!(NSView), alloc];
            let view: id = msg_send![view, initWithFrame: frame];
            let _: () = msg_send![view, setWantsLayer: YES];
            let layer: id = msg_send![view, layer];
            if layer != nil {
                let clear: id = msg_send![class!(NSColor), clearColor];
                let clear_cg: id = msg_send![clear, CGColor];
                let _: () = msg_send![layer, setMasksToBounds: NO];
                let _: () = msg_send![layer, setBackgroundColor: clear_cg];
            }
            view
        })
    })
}

#[cfg(target_os = "macos")]
fn decor_view(id: u64) -> Option<id> {
    WEBVIEW_DECOR_VIEWS.with(|decor| decor.borrow().get(&id).copied())
}

#[cfg(target_os = "macos")]
fn backing_view(parent_view: id) -> Option<id> {
    let key = parent_view as usize;
    WEBVIEW_BACKING_VIEWS.with(|backings| backings.borrow().get(&key).copied())
}

#[cfg(target_os = "macos")]
pub fn ensure_webview_host(window: &mut Window, id: u64) -> Option<id> {
    let (parent_view, gpui_view) = webview_parent(window)?;
    Some(ensure_host_view(id, parent_view, gpui_view))
}

#[cfg(target_os = "macos")]
fn position_webview_host(
    window: &mut Window,
    view: &wry::WebView,
    id: u64,
    bounds: Bounds<Pixels>,
    style: &ElementStyle,
) {
    let Some((parent_view, gpui_view)) = webview_parent(window) else {
        return;
    };

    let host = ensure_host_view(id, parent_view, gpui_view);
    let webview = webview_object(view);
    let x = f64::from(bounds.origin.x);
    let y = f64::from(bounds.origin.y);
    let width = f64::from(bounds.size.width);
    let height = f64::from(bounds.size.height);

    let new_bounds = (x, y, width, height);
    let new_host_style = webview_host_style(style);
    // Re-applying the WKWebView's frame every prepaint is what causes the resize
    // flicker + divider-drag lag: each setFrame on a layer-backed view kicks off an
    // implicit CoreAnimation pass, and under continuous resize those stack so the web
    // content stays perpetually mid-animation (it blanks out — "flickers invisible").
    // It's also a full web reflow per frame. So only touch the native geometry when it
    // actually changed (or we just had to reparent), and apply it with implicit actions
    // disabled so the resize lands in one synchronous, flicker-free step.
    let changed = WEBVIEW_LAST_BOUNDS.with(|b| match b.borrow().get(&id) {
        Some(prev) => !bounds_close(*prev, new_bounds),
        None => true,
    });
    let style_changed = WEBVIEW_LAST_HOST_STYLES.with(|s| match s.borrow().get(&id) {
        Some(prev) => prev != &new_host_style,
        None => true,
    });

    unsafe {
        let current_parent: id = msg_send![webview, superview];
        // The WKWebView lives *inside* the `host` NSView, which `ensure_host_view`
        // keeps below gpui's Metal view in the same window — a true underlay. lb-wry
        // (the Longbridge wry fork, see rust/Cargo.toml) is what makes a WKWebView
        // composite correctly as a sibling under gpui's Metal layer, so transparent
        // GPUI regions show the page through and any opaque GPUI sibling painted later
        // (composer, dialogs) covers it. A separate child NSWindow ordered above the
        // parent — the previous approach — can never be covered by parent-window Metal
        // chrome, which is exactly what made the composer/dialogs disappear behind it.
        let reparented = current_parent != host;

        if reparented || changed || style_changed {
            // Every geometry/layer mutation below goes through one CATransaction with
            // implicit actions disabled, so a resize step lands in a single synchronous
            // commit with no implicit CoreAnimation tween on frame, cornerRadius, or
            // backgroundColor. Without this, each `setFrame`/`cornerRadius` on these
            // layer-backed views kicks off an implicit animation, leaving the page
            // perpetually mid-tween under a continuous resize (lag + blank flicker).
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: YES];

            if reparented || changed {
                if reparented {
                    if std::env::var("RNGPUI_WEBVIEW_GEOMETRY_DEBUG").is_ok() {
                        eprintln!("[webview {id}] reparenting native view into underlay host");
                    }
                    let _: id = msg_send![webview, retain];
                    if current_parent != nil {
                        let _: () = msg_send![webview, removeFromSuperview];
                    }
                    let _: () = msg_send![host, addSubview: webview];
                    let _: () = msg_send![webview, release];
                    // No autoresizing on the WKWebView: we set its frame explicitly on
                    // every changed prepaint, so an autoresizing mask would be a second,
                    // conflicting sizing authority (it resizes off the host's OLD bounds
                    // while we hard-set the NEW bounds in the same pass). Under a
                    // continuous resize those two disagree frame-to-frame and the page's
                    // right-edge scrollbar jitters/lags. Pin the mask to None so the only
                    // thing that ever moves the webview is the set_child_frame below.
                    let _: () = msg_send![webview, setAutoresizingMask: 0u64];
                }

                set_child_frame(parent_view, host, x, y, width, height);
                // the webview fills its host exactly; host-local coords (host is a plain
                // non-flipped NSView, set_child_frame flips y to match its geometry).
                set_child_frame(host, webview, 0.0, 0.0, width, height);
                // the decoration view shares the host's exact frame so its rounded-rect
                // shadowPath lines up with the webview; it sits one level below the host.
                let decor = ensure_decor_view(id);
                set_child_frame(parent_view, decor, x, y, width, height);
                WEBVIEW_LAST_BOUNDS.with(|b| {
                    b.borrow_mut().insert(id, new_bounds);
                });
            }

            // Layer-clip + base-color set animatable layer props (cornerRadius,
            // maskedCorners, backgroundColor, isOpaque) and each allocates an NSColor.
            // None of them depend on size, so on a pure resize (changed but not
            // style_changed) they'd re-set identical values every frame for nothing —
            // pure churn that also re-touches animatable layer state mid-resize. Gate
            // them on a real style change. The decor's own size-dependent shadowPath is
            // gated internally (apply_webview_decor), so it must still run on resize.
            if style_changed {
                apply_host_layer_clip(host, style);
                apply_webview_layer_clip(webview, style);
                apply_webview_base_color(webview, style.background_color);
            }
            apply_webview_decor(id, width, height, style);

            let _: () = msg_send![class!(CATransaction), commit];

            WEBVIEW_LAST_HOST_STYLES.with(|s| {
                s.borrow_mut().insert(id, new_host_style);
            });
        }

        // cheap + idempotent; keep asserting visibility every frame regardless.
        let _: () = msg_send![host, setHidden: NO];
        let _: () = msg_send![webview, setHidden: NO];
    }
}

// Shared with blur.rs: per-frame change detection so we only re-setFrame native
// views when their geometry actually moved (avoids CoreAnimation churn / flicker).
#[cfg(target_os = "macos")]
pub(crate) fn bounds_close(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
    const EPS: f64 = 0.01;
    (a.0 - b.0).abs() < EPS
        && (a.1 - b.1).abs() < EPS
        && (a.2 - b.2).abs() < EPS
        && (a.3 - b.3).abs() < EPS
}

#[cfg(target_os = "macos")]
fn webview_host_style(style: &ElementStyle) -> WebViewHostStyle {
    WebViewHostStyle {
        background_color: style.background_color.map(|c| (c.h, c.s, c.l, c.a)),
        corner_clip: webview_corner_clip(style),
        decor: webview_decor_style(style),
    }
}

// Resolve the below-webview decoration from the element's style — today, the rounded
// card drop shadow from `boxShadow`.
#[cfg(target_os = "macos")]
fn webview_decor_style(style: &ElementStyle) -> WebViewDecor {
    WebViewDecor {
        shadow: webview_shadow_style(style),
    }
}

// The webview element's `boxShadow` → the native drop shadow. CSS can list several
// layers; CALayer has one shadow, so take the layer with the largest visual footprint
// (offset magnitude + blur) — the "main" drop shadow. `None` → no shadow decoration.
#[cfg(target_os = "macos")]
fn webview_shadow_style(style: &ElementStyle) -> Option<WebViewShadow> {
    let css = style.box_shadow.as_deref()?;
    let main = crate::style::parse_box_shadows(css)
        .into_iter()
        .max_by(|a, b| {
            let weight = |s: &gpui::BoxShadow| {
                f32::from(s.offset.x).abs() + f32::from(s.offset.y).abs() + f32::from(s.blur_radius)
            };
            weight(a)
                .partial_cmp(&weight(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })?;
    let (r, g, b, a) = hsla_to_srgb(main.color);
    if a <= 0.0 {
        return None;
    }
    Some(WebViewShadow {
        color: (r as f32, g as f32, b as f32),
        opacity: a as f32,
        // CSS blur ≈ 2× the CALayer shadowRadius (CSS blur is the full gaussian
        // diameter; shadowRadius is the standard-deviation-ish radius).
        radius: f32::from(main.blur_radius) / 2.0,
        offset_x: f32::from(main.offset.x),
        // CALayer shadowOffset is in the layer's geometry. The decoration view's layer
        // is non-flipped (AppKit default, +y UP), so a CSS "shadow below the box" (+y
        // down) is a NEGATIVE shadowOffset.height — verified on-capture (the shadow
        // lands below the card, not above it behind the mode bar).
        offset_y: -f32::from(main.offset.y),
        corner_radius: webview_corner_clip(style).radius,
    })
}

// Shared with blur.rs: set a child view's frame in the parent's coordinate space,
// flipping y when the parent uses AppKit's default bottom-left origin.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn set_child_frame(
    parent: id,
    child: id,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    let flipped: bool = msg_send![parent, isFlipped];
    let origin_y = if flipped {
        y
    } else {
        let frame: NSRect = msg_send![parent, frame];
        frame.size.height - y - height
    };
    let frame = NSRect::new(NSPoint::new(x, origin_y), NSSize::new(width, height));
    let _: () = msg_send![child, setFrame: frame];
}

// Shared with blur.rs: make an NSView layer-backed + fully transparent so gpui's
// Metal content and the desktop behind both show through where nothing is drawn.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn configure_transparent_view(view: id) {
    if view == nil {
        return;
    }

    let clear_color: id = msg_send![class!(NSColor), clearColor];
    let clear_cg_color: id = msg_send![clear_color, CGColor];
    let _: () = msg_send![view, setWantsLayer: YES];
    let layer: id = msg_send![view, layer];
    if layer == nil {
        return;
    }
    let _: () = msg_send![layer, setOpaque: NO];
    let _: () = msg_send![layer, setBackgroundColor: clear_cg_color];
}

#[cfg(target_os = "macos")]
unsafe fn configure_backing_view(view: id) {
    if view == nil {
        return;
    }

    let _: () = msg_send![view, setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable];
    let _: () = msg_send![view, setWantsLayer: YES];
    let layer: id = msg_send![view, layer];
    if layer == nil {
        return;
    }

    // keep this underlay backing CLEAR so the NSGlassEffectView behind the window shows
    // through the chrome. an opaque `windowBackgroundColor` fill here is a full-window
    // grey layer painted *above* the glass — it covers the glass entirely (the "grey bg,
    // no glass" regression). the webview's own page body is opaque, so the underlay still
    // has a solid base wherever a webview is actually mounted.
    let clear_color: id = msg_send![class!(NSColor), clearColor];
    let clear_cg_color: id = msg_send![clear_color, CGColor];
    let _: () = msg_send![layer, setOpaque: NO];
    let _: () = msg_send![layer, setBackgroundColor: clear_cg_color];
}

#[cfg(target_os = "macos")]
pub fn hide_webview_host(id: u64) {
    WEBVIEW_HOSTS.with(|hosts| {
        let Some(host) = hosts.borrow().get(&id).copied() else {
            return;
        };
        unsafe {
            let _: () = msg_send![host, setHidden: YES];
        }
    });
    if let Some(decor) = decor_view(id) {
        unsafe {
            let _: () = msg_send![decor, setHidden: YES];
        }
    }
}

#[cfg(target_os = "macos")]
fn apply_host_layer_clip(host: id, style: &ElementStyle) {
    let clip = webview_corner_clip(style);

    unsafe {
        let _: () = msg_send![host, setWantsLayer: YES];
        let layer: id = msg_send![host, layer];
        if layer == nil {
            return;
        }

        apply_host_layer_background(layer, style.background_color);
        apply_layer_corner_clip(layer, clip);
    }
}

// Round the WKWebView's own backing layer so the page corners follow the stage
// card's `borderRadius`. The host layer is clipped too (apply_host_layer_clip) — the
// host's themed opaque fill is what shows at the very corner pixels where the layer
// mask rounds the page away, so the rounding reads as a clean clip against the body
// color rather than a transparent notch.
#[cfg(target_os = "macos")]
unsafe fn apply_webview_layer_clip(webview: id, style: &ElementStyle) {
    if webview == nil {
        return;
    }
    let clip = webview_corner_clip(style);
    let _: () = msg_send![webview, setWantsLayer: YES];
    let webview_layer: id = msg_send![webview, layer];
    if webview_layer != nil {
        unsafe {
            apply_layer_corner_clip(webview_layer, clip);
        }
    }
}

// Drive the below-webview decoration view from the element's resolved style: today, the
// rounded card drop shadow. The view already shares the webview's frame and sits one
// level below the host; here we set its CALayer shadow properties + a rounded-rect
// `shadowPath` so it casts a real shadow. The opaque WebView in front covers the
// interior, so only the outward edge spill shows — it can never bleed over the page.
// With no boxShadow (chrome webviews, or a webview without a card shadow) the decoration
// view is left transparent + hidden.
#[cfg(target_os = "macos")]
fn apply_webview_decor(id: u64, width: f64, height: f64, style: &ElementStyle) {
    let Some(view) = decor_view(id) else {
        return;
    };
    let shadow = webview_decor_style(style).shadow;
    unsafe {
        let layer: id = msg_send![view, layer];
        if layer == nil {
            return;
        }
        let Some(shadow) = shadow else {
            let _: () = msg_send![layer, setShadowOpacity: 0.0f32];
            let _: () = msg_send![layer, setShadowPath: nil];
            let _: () = msg_send![view, setHidden: YES];
            WEBVIEW_LAST_DECOR_APPLIED.with(|m| m.borrow_mut().remove(&id));
            return;
        };

        // Split the work: a window/divider resize changes the SIZE every frame but
        // leaves the shadow STYLE (color/opacity/radius/offset) untouched. Re-setting
        // the style each frame allocates an NSColor + CGColor and fires four extra
        // msg_sends per frame for nothing — the decoration regression that made resize
        // lag. So only re-set style when it actually changed, and only re-trace the
        // size-dependent shadowPath when the size (or corner) changed.
        let (style_same, size_same) =
            WEBVIEW_LAST_DECOR_APPLIED.with(|m| match m.borrow().get(&id) {
                Some((lw, lh, last)) => (
                    *last == shadow,
                    (lw - width).round() == 0.0 && (lh - height).round() == 0.0,
                ),
                None => (false, false),
            });
        if style_same && size_same {
            return; // nothing visual changed — skip the shadow re-rasterization entirely
        }

        if !style_same {
            let ns_color: id = msg_send![
                class!(NSColor),
                colorWithSRGBRed: shadow.color.0 as f64
                green: shadow.color.1 as f64
                blue: shadow.color.2 as f64
                alpha: 1.0f64
            ];
            let cg_color: id = msg_send![ns_color, CGColor];
            let _: () = msg_send![layer, setShadowColor: cg_color];
            let _: () = msg_send![layer, setShadowOpacity: shadow.opacity];
            let _: () = msg_send![layer, setShadowRadius: shadow.radius as f64];
            let offset = NSSize::new(shadow.offset_x as f64, shadow.offset_y as f64);
            let _: () = msg_send![layer, setShadowOffset: offset];
        }

        // the rounded-rect shadowPath depends only on size + corner (corner lives in
        // `shadow`, so a corner change shows up as !style_same). re-tracing it is what
        // forces CA to re-rasterize the blur, so gate it on a real size/corner change.
        if !size_same || !style_same {
            let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
            let r = shadow.corner_radius.max(0.0) as f64;
            let path: id = CGPathCreateWithRoundedRect(rect, r, r, std::ptr::null());
            let _: () = msg_send![layer, setShadowPath: path];
            if path != nil {
                CGPathRelease(path);
            }
        }
        let _: () = msg_send![view, setHidden: NO];
        WEBVIEW_LAST_DECOR_APPLIED.with(|m| m.borrow_mut().insert(id, (width, height, shadow)));

        if std::env::var("RNGPUI_WEBVIEW_GEOMETRY_DEBUG").is_ok() {
            eprintln!(
                "[webview {id} decor-shadow] color=({:.2},{:.2},{:.2}) opacity={:.2} radius={:.1} offset=({:.1},{:.1}) corner={:.1}",
                shadow.color.0,
                shadow.color.1,
                shadow.color.2,
                shadow.opacity,
                shadow.radius,
                shadow.offset_x,
                shadow.offset_y,
                shadow.corner_radius,
            );
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn apply_layer_corner_clip(layer: id, clip: WebViewCornerClip) {
    if layer == nil {
        return;
    }
    if clip.radius > 0.0 && clip.masked_corners != 0 {
        let _: () = msg_send![layer, setMasksToBounds: YES];
        let _: () = msg_send![layer, setCornerRadius: clip.radius as f64];
        let _: () = msg_send![layer, setMaskedCorners: clip.masked_corners];
    } else {
        let _: () = msg_send![layer, setMasksToBounds: NO];
        let _: () = msg_send![layer, setCornerRadius: 0.0f64];
        let _: () = msg_send![layer, setMaskedCorners: 0u64];
    }
}

#[cfg(target_os = "macos")]
unsafe fn apply_host_layer_background(layer: id, color: Option<Hsla>) {
    let (red, green, blue, alpha) = color.map(hsla_to_srgb).unwrap_or((0.0, 0.0, 0.0, 0.0));
    let ns_color: id = msg_send![
        class!(NSColor),
        colorWithSRGBRed: red
        green: green
        blue: blue
        alpha: alpha
    ];
    let cg_color: id = msg_send![ns_color, CGColor];
    let opaque = if alpha >= 1.0 { YES } else { NO };
    let _: () = msg_send![layer, setOpaque: opaque];
    let _: () = msg_send![layer, setBackgroundColor: cg_color];
    if std::env::var("RNGPUI_WEBVIEW_GEOMETRY_DEBUG").is_ok() {
        eprintln!(
            "[webview host-layer] bg srgb=({red:.3},{green:.3},{blue:.3},{alpha:.3}) opaque={} has_color={}",
            opaque == YES,
            color.is_some(),
        );
    }
}

// Drive the WKWebView's compositing base from the element's themed background, not
// the window's NSAppearance. A WKWebView built with `transparent=false` is opaque and
// paints `underPageBackgroundColor` behind the page; that color is a dynamic system
// color that follows the NSWindow appearance (which tracks the macOS *system* theme,
// not the app's resolved color scheme). When the app scheme and the system appearance
// disagree — and at the rounded-corner clip / pre-first-paint frame even when they
// agree — WebKit can composite the page over that appearance base instead of the page
// body, so the light app's `#ffffff` body doesn't fill and the glass shows through
// ("see-through stage, only the shadow draws"). Pinning underPageBackgroundColor to the
// same opaque themed color the host layer uses makes the base match the page in every
// appearance, so the stage is always solid. Dark already matched by coincidence (dark
// base ≈ dark body), which is why only light looked broken.
#[cfg(target_os = "macos")]
unsafe fn apply_webview_base_color(webview: id, color: Option<Hsla>) {
    if webview == nil {
        return;
    }
    let Some(color) = color else {
        return;
    };
    let (red, green, blue, alpha) = hsla_to_srgb(color);
    // only pin an opaque base; a translucent element bg means "let the underlay/glass
    // show through" (chrome webviews), which must stay appearance-default.
    if alpha < 1.0 {
        return;
    }
    let ns_color: id = msg_send![
        class!(NSColor),
        colorWithSRGBRed: red
        green: green
        blue: blue
        alpha: alpha
    ];
    let cg_color: id = msg_send![ns_color, CGColor];
    // Force the content WKWebView fully opaque and paint the themed base on its own
    // backing layer. `transparent=false` should already leave isOpaque YES, but in
    // practice the page was compositing over the translucent glass — and white over
    // glass reads as a flat GREY, not white (exactly the "stage isn't white" report).
    // Pinning isOpaque + the layer backgroundColor makes the content stage a solid
    // themed fill; underPageBackgroundColor matches the overscroll/rubber-band area.
    // Translucent chrome webviews returned above and keep their appearance-default.
    let _: () = msg_send![webview, setOpaque: YES];
    let responds: bool = msg_send![webview, respondsToSelector: sel!(setUnderPageBackgroundColor:)];
    if responds {
        let _: () = msg_send![webview, setUnderPageBackgroundColor: ns_color];
    }
    let _: () = msg_send![webview, setWantsLayer: YES];
    let layer: id = msg_send![webview, layer];
    if layer != nil {
        let _: () = msg_send![layer, setOpaque: YES];
        let _: () = msg_send![layer, setBackgroundColor: cg_color];
    }
    if std::env::var("RNGPUI_WEBVIEW_GEOMETRY_DEBUG").is_ok() {
        eprintln!(
            "[webview base-color] pinned underPageBackgroundColor srgb=({red:.3},{green:.3},{blue:.3},{alpha:.3})"
        );
    }
}

// Shared with blur.rs: convert a gpui Hsla into straight sRGB components for NSColor.
#[cfg(target_os = "macos")]
pub(crate) fn hsla_to_srgb(color: Hsla) -> (f64, f64, f64, f64) {
    let h = f64::from(color.h.rem_euclid(1.0));
    let s = f64::from(color.s.clamp(0.0, 1.0));
    let l = f64::from(color.l.clamp(0.0, 1.0));
    let a = f64::from(color.a.clamp(0.0, 1.0));

    if s == 0.0 {
        return (l, l, l, a);
    }

    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - (l * s)
    };
    let p = (2.0 * l) - q;
    (
        hue_to_srgb(p, q, h + (1.0 / 3.0)),
        hue_to_srgb(p, q, h),
        hue_to_srgb(p, q, h - (1.0 / 3.0)),
        a,
    )
}

#[cfg(target_os = "macos")]
fn hue_to_srgb(p: f64, q: f64, mut t: f64) -> f64 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + ((q - p) * 6.0 * t);
    }
    if t < 1.0 / 2.0 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + ((q - p) * ((2.0 / 3.0) - t) * 6.0);
    }
    p
}

#[cfg(not(target_os = "macos"))]
fn set_webview_bounds_direct(view: &wry::WebView, bounds: Bounds<Pixels>) {
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

#[cfg(target_os = "macos")]
fn webview_corner_clip(style: &ElementStyle) -> WebViewCornerClip {
    let shorthand = style.border_radius;
    let top_left = style.border_top_left_radius.or(shorthand).unwrap_or(0.0);
    let top_right = style.border_top_right_radius.or(shorthand).unwrap_or(0.0);
    let bottom_left = style.border_bottom_left_radius.or(shorthand).unwrap_or(0.0);
    let bottom_right = style
        .border_bottom_right_radius
        .or(shorthand)
        .unwrap_or(0.0);
    let mut masked_corners = 0;
    if bottom_left > 0.0 {
        masked_corners |= CA_LAYER_MIN_X_MIN_Y_CORNER;
    }
    if bottom_right > 0.0 {
        masked_corners |= CA_LAYER_MAX_X_MIN_Y_CORNER;
    }
    if top_left > 0.0 {
        masked_corners |= CA_LAYER_MIN_X_MAX_Y_CORNER;
    }
    if top_right > 0.0 {
        masked_corners |= CA_LAYER_MAX_X_MAX_Y_CORNER;
    }
    WebViewCornerClip {
        radius: top_left.max(top_right).max(bottom_left).max(bottom_right),
        masked_corners,
    }
}

// Synthetic page-scroll script. The product NEVER uses this — real wheel/momentum
// scroll goes natively to the WKWebView via the hitTest passthrough. It exists ONLY for
// the offscreen webview-overlay conformance, whose invisible/click-through test window
// can't receive a posted CGEvent, so it drives a scroll through `scrollAt` instead.
pub(crate) fn webview_scroll_script(left: f32, top: f32) -> Option<String> {
    if !left.is_finite() || !top.is_finite() {
        return None;
    }
    Some(format!(
        "(()=>{{window.scrollBy({:.3},{:.3});\
const s=document.scrollingElement||document.documentElement||document.body;\
if(s){{s.scrollLeft+={:.3};s.scrollTop+={:.3};}}\
if(document.body&&document.body!==s){{document.body.scrollLeft+={:.3};document.body.scrollTop+={:.3};}}}})();",
        left, top, left, top, left, top
    ))
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
                #[cfg(target_os = "macos")]
                hide_webview_host(self.element.global_id);
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

        // register this webview's rect so GPUIView's hitTest: passes native events
        // (selection, scrollbar drag, momentum scroll) through to the WKWebView below,
        // except where a gpui overlay is painted on top of it.
        crate::hit_passthrough::record_webview(
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
            if std::env::var("RNGPUI_WEBVIEW_GEOMETRY_DEBUG").is_ok() {
                eprintln!(
                    "[webview {}] bounds x={} y={} w={} h={}",
                    self.element.global_id,
                    f32::from(bounds.origin.x),
                    f32::from(bounds.origin.y),
                    f32::from(bounds.size.width),
                    f32::from(bounds.size.height)
                );
            }
            #[cfg(target_os = "macos")]
            {
                position_webview_host(
                    window,
                    &view,
                    self.element.global_id,
                    bounds,
                    &self.element.style,
                );
                load_if_needed(self.element.global_id, &view);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = view.set_visible(true);
                set_webview_bounds_direct(&view, bounds);
                load_if_needed(self.element.global_id, &view);
            }
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
        // The WKWebView host sits below GPUI on macOS so later GPUI siblings can
        // paint over it. A content mask would punch a hole through those overlays.
        let bounds = hitbox
            .as_ref()
            .map(|hitbox| hitbox.bounds)
            .unwrap_or(bounds);
        if let Some(view) = webview(self.element.global_id) {
            // Scroll, momentum, rubber-band, native text selection, and the grabbable
            // overlay scrollbar all happen NATIVELY: GPUIView's `hitTest:` returns nil
            // over this webview's rect (see hit_passthrough + the record_webview call in
            // prepaint), so AppKit delivers the real NSEvent straight to the WKWebView
            // sibling below the Metal layer. The page's own scroller handles it — no JS
            // delta-forwarding, no synthetic scrollbar emulation. (Where a gpui surface
            // — composer, dialogs, inspector menu — paints OVER the webview, that surface
            // is the top-most painted element so hitTest keeps the event in gpui.)
            //
            // The one event we still want gpui-side is a click OUTSIDE the webview: it
            // blurs the page's focus so a click elsewhere in the app moves focus off the
            // stage. An outside click reaches GPUIView (no passthrough there), so this
            // global handler runs; a click INSIDE never reaches gpui (passthrough), which
            // is exactly right — the page keeps it.
            window.on_mouse_event(move |event: &MouseDownEvent, _phase, _, _| {
                if !bounds.contains(&event.position) {
                    let _ = view.focus_parent();
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_script_rejects_non_finite() {
        assert!(webview_scroll_script(f32::NAN, 1.0).is_none());
        assert!(webview_scroll_script(1.0, f32::INFINITY).is_none());
        let script = webview_scroll_script(-3.0, 12.0).expect("finite deltas produce a script");
        assert!(script.contains("scrollLeft+=-3.000"));
        assert!(script.contains("scrollTop+=12.000"));
    }
}
