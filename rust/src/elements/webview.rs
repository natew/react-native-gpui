use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, Bounds, DispatchPhase, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior, Hsla,
    IntoElement, LayoutId, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, ScrollDelta,
    ScrollWheelEvent, Window,
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

// The service owns one persistent wry WebView per `<WebView>` id and publishes a
// snapshot here each render, so this (stateless) element can resolve its view by id
// and park it over the right layout bounds — the standard gpui + wry overlay pattern.
thread_local! {
    static WEBVIEWS: RefCell<HashMap<u64, Rc<wry::WebView>>> = RefCell::new(HashMap::new());
    static WEBVIEW_CONTENT: RefCell<HashMap<u64, WebViewContent>> = RefCell::new(HashMap::new());
    static WEBVIEW_LOADED_CONTENT: RefCell<HashMap<u64, WebViewContent>> = RefCell::new(HashMap::new());
    #[cfg(target_os = "macos")]
    static WEBVIEW_HOSTS: RefCell<HashMap<u64, id>> = RefCell::new(HashMap::new());
    #[cfg(target_os = "macos")]
    static WEBVIEW_BACKING_VIEWS: RefCell<HashMap<usize, id>> = RefCell::new(HashMap::new());
    // last native geometry we actually applied per webview id, so we can skip the
    // per-frame setFrame churn when nothing moved (see position_webview_host).
    #[cfg(target_os = "macos")]
    static WEBVIEW_LAST_BOUNDS: RefCell<HashMap<u64, (f64, f64, f64, f64)>> = RefCell::new(HashMap::new());
    #[cfg(target_os = "macos")]
    static WEBVIEW_LAST_HOST_STYLES: RefCell<HashMap<u64, WebViewHostStyle>> = RefCell::new(HashMap::new());
}

// Webviews composite *behind* gpui's Metal layer (see `ensure_host_view`), so the
// native view never receives AppKit mouse events — gpui consumes them first. Scroll
// wheels are forwarded into the page as injected JS; this set tracks ids whose
// scrollbar gutter is being dragged so the per-frame mouse handlers can keep
// translating drag motion into scroll position across frames.
thread_local! {
    static SCROLLBAR_DRAGS: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
}

// clickable width of the scrollbar gutter at the webview's right edge, in logical px.
// kept a touch wider than the page's rendered scrollbar so the thumb is easy to grab.
const WEBVIEW_SCROLLBAR_GUTTER: f32 = 16.0;

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct WebViewHostStyle {
    background_color: Option<(f32, f32, f32, f32)>,
    bottom_radius: f32,
}

fn scrollbar_dragging(id: u64) -> bool {
    SCROLLBAR_DRAGS.with(|d| d.borrow().contains(&id))
}

fn set_scrollbar_dragging(id: u64, on: bool) {
    SCROLLBAR_DRAGS.with(|d| {
        if on {
            d.borrow_mut().insert(id);
        } else {
            d.borrow_mut().remove(&id);
        }
    });
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

#[cfg(target_os = "macos")]
fn webview_object(view: &wry::WebView) -> id {
    let webview = view.webview();
    (&*webview) as *const _ as id
}

#[cfg(target_os = "macos")]
fn webview_parent(window: &mut Window) -> Option<(id, id)> {
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
            let bounds: NSRect = msg_send![parent_view, bounds];
            let _: () = msg_send![backing, setFrame: bounds];
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
                if std::env::var("RNGPUI_WEBVIEW_DEBUG").is_ok() {
                    eprintln!(
                        "[webview {id}] re-establishing underlay z-order (reparent={} topmost_wrong={})",
                        current_parent != parent_view,
                        topmost != gpui_view
                    );
                }
                if current_parent != nil && current_parent != parent_view {
                    let _: () = msg_send![host, removeFromSuperview];
                }
                if let Some(backing) = backing_view(parent_view) {
                    let _: () = msg_send![parent_view, addSubview: backing];
                }
                let _: () = msg_send![parent_view, addSubview: host];
                let _: () = msg_send![parent_view, addSubview: gpui_view];
            }
        }

        host
    })
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
        let reparented = current_parent != host;

        if reparented || changed || style_changed {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: YES];

            if reparented || changed {
                if reparented {
                    if std::env::var("RNGPUI_WEBVIEW_DEBUG").is_ok() {
                        eprintln!("[webview {id}] reparenting native view into underlay host");
                    }
                    let _: id = msg_send![webview, retain];
                    if current_parent != nil {
                        let _: () = msg_send![webview, removeFromSuperview];
                    }
                    let _: () = msg_send![host, addSubview: webview];
                    let _: () = msg_send![webview, release];
                }

                set_child_frame(parent_view, host, x, y, width, height);
                set_child_frame(host, webview, 0.0, 0.0, width, height);
                WEBVIEW_LAST_BOUNDS.with(|b| {
                    b.borrow_mut().insert(id, new_bounds);
                });
            }

            apply_host_layer_clip(host, style);
            apply_webview_base_color(webview, style.background_color);

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

#[cfg(target_os = "macos")]
fn bounds_close(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
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
        bottom_radius: webview_bottom_radius(style),
    }
}

#[cfg(target_os = "macos")]
unsafe fn set_child_frame(parent: id, child: id, x: f64, y: f64, width: f64, height: f64) {
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

#[cfg(target_os = "macos")]
unsafe fn configure_transparent_view(view: id) {
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
fn hide_webview_host(id: u64) {
    // drop the cached geometry so the next show re-applies the frame even if the
    // layout bounds are unchanged from before it was hidden.
    WEBVIEW_LAST_BOUNDS.with(|b| {
        b.borrow_mut().remove(&id);
    });
    WEBVIEW_LAST_HOST_STYLES.with(|s| {
        s.borrow_mut().remove(&id);
    });
    WEBVIEW_HOSTS.with(|hosts| {
        let Some(host) = hosts.borrow().get(&id).copied() else {
            return;
        };
        unsafe {
            let _: () = msg_send![host, setHidden: YES];
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_host_layer_clip(host: id, style: &ElementStyle) {
    let radius = webview_bottom_radius(style);

    unsafe {
        let _: () = msg_send![host, setWantsLayer: YES];
        let layer: id = msg_send![host, layer];
        if layer == nil {
            return;
        }

        apply_host_layer_background(layer, style.background_color);

        if radius > 0.0 {
            let bottom_corners = CA_LAYER_MIN_X_MIN_Y_CORNER | CA_LAYER_MAX_X_MIN_Y_CORNER;
            let _: () = msg_send![layer, setMasksToBounds: YES];
            let _: () = msg_send![layer, setCornerRadius: radius as f64];
            let _: () = msg_send![layer, setMaskedCorners: bottom_corners];
        } else {
            let _: () = msg_send![layer, setMasksToBounds: NO];
            let _: () = msg_send![layer, setCornerRadius: 0.0f64];
        }
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
    if std::env::var("RNGPUI_WEBVIEW_DEBUG").is_ok() {
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
    if std::env::var("RNGPUI_WEBVIEW_DEBUG").is_ok() {
        eprintln!(
            "[webview base-color] pinned underPageBackgroundColor srgb=({red:.3},{green:.3},{blue:.3},{alpha:.3})"
        );
    }
}

#[cfg(target_os = "macos")]
fn hsla_to_srgb(color: Hsla) -> (f64, f64, f64, f64) {
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

fn webview_bottom_radius(style: &ElementStyle) -> f32 {
    let shorthand = style.border_radius;
    let bottom_left = style.border_bottom_left_radius.or(shorthand).unwrap_or(0.0);
    let bottom_right = style
        .border_bottom_right_radius
        .or(shorthand)
        .unwrap_or(0.0);
    bottom_left.max(bottom_right)
}

fn webview_scroll_delta(delta: ScrollDelta) -> (f32, f32) {
    match delta {
        ScrollDelta::Lines(point) => (point.x * 32.0, point.y * 32.0),
        ScrollDelta::Pixels(point) => (point.x.into(), point.y.into()),
    }
}

fn webview_scroll_script(left: f32, top: f32) -> Option<String> {
    if !left.is_finite() || !top.is_finite() {
        return None;
    }
    Some(format!(
        "(()=>{{const s=document.scrollingElement||document.documentElement||document.body;if(!s)return;s.scrollLeft+={:.3};s.scrollTop+={:.3};}})();",
        left, top
    ))
}

// Pressing the scrollbar gutter starts a drag: figure out where the thumb is, record
// the grab offset (so the thumb tracks the cursor instead of jumping its center), and
// scroll once. `local_y` is the cursor's y relative to the webview's top edge.
fn webview_scrollbar_down_script(local_y: f32) -> Option<String> {
    if !local_y.is_finite() {
        return None;
    }
    Some(format!(
        "(()=>{{var s=document.scrollingElement||document.documentElement||document.body;if(!s)return;\
var ch=s.clientHeight,sh=s.scrollHeight,max=sh-ch;\
if(max<=0){{window.__rngpuiSbGrab=null;return;}}\
var thumb=Math.max(24,ch*ch/sh),span=ch-thumb;\
var top=span>0?(s.scrollTop/max)*span:0,y={:.3};\
window.__rngpuiSbGrab=(y>=top&&y<=top+thumb)?(y-top):(thumb/2);\
var nt=Math.max(0,Math.min(span,y-window.__rngpuiSbGrab));\
s.scrollTop=span>0?(nt/span)*max:0;}})();",
        local_y
    ))
}

// Each drag move maps the cursor's y back to a scroll position using the offset
// recorded on mouse-down, so the thumb follows the cursor like a real scrollbar.
fn webview_scrollbar_move_script(local_y: f32) -> Option<String> {
    if !local_y.is_finite() {
        return None;
    }
    Some(format!(
        "(()=>{{if(window.__rngpuiSbGrab==null)return;\
var s=document.scrollingElement||document.documentElement||document.body;if(!s)return;\
var ch=s.clientHeight,sh=s.scrollHeight,max=sh-ch;if(max<=0)return;\
var thumb=Math.max(24,ch*ch/sh),span=ch-thumb;\
var nt=Math.max(0,Math.min(span,{:.3}-window.__rngpuiSbGrab));\
s.scrollTop=span>0?(nt/span)*max:0;}})();",
        local_y
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
            #[cfg(target_os = "macos")]
            {
                load_if_needed(self.element.global_id, &view);
                position_webview_host(
                    window,
                    &view,
                    self.element.global_id,
                    bounds,
                    &self.element.style,
                );
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
            let id = self.element.global_id;

            // mouse-down: blur on outside clicks, and start a scrollbar drag when the
            // press lands in the right-edge gutter. don't stop propagation — gpui still
            // gets to focus the stage etc.; we only take over the motion on drag.
            let down_view = view.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, phase, _, _| {
                if !bounds.contains(&event.position) {
                    let _ = down_view.focus_parent();
                    return;
                }
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let right = f32::from(bounds.origin.x) + f32::from(bounds.size.width);
                if f32::from(event.position.x) >= right - WEBVIEW_SCROLLBAR_GUTTER {
                    set_scrollbar_dragging(id, true);
                    let local_y = f32::from(event.position.y) - f32::from(bounds.origin.y);
                    if let Some(script) = webview_scrollbar_down_script(local_y) {
                        let _ = down_view.evaluate_script(&script);
                    }
                }
            });

            // mouse-move: while a gutter drag is active, keep the thumb under the cursor.
            // tracked globally (not gated on bounds) so the drag survives the cursor
            // leaving the webview, exactly like a native scrollbar.
            let move_view = view.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                if phase != DispatchPhase::Bubble || !scrollbar_dragging(id) {
                    return;
                }
                let local_y = f32::from(event.position.y) - f32::from(bounds.origin.y);
                if let Some(script) = webview_scrollbar_move_script(local_y) {
                    let _ = move_view.evaluate_script(&script);
                }
                cx.stop_propagation();
            });

            // mouse-up: end any active gutter drag.
            window.on_mouse_event(move |_event: &MouseUpEvent, phase, _, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                if scrollbar_dragging(id) {
                    set_scrollbar_dragging(id, false);
                    cx.stop_propagation();
                }
            });

            window.on_mouse_event(move |event: &ScrollWheelEvent, phase, _, cx| {
                if phase != DispatchPhase::Bubble || !bounds.contains(&event.position) {
                    return;
                }
                let (dx, dy) = webview_scroll_delta(event.delta);
                let left = -dx;
                let top = -dy;
                if left.abs() <= 0.01 && top.abs() <= 0.01 {
                    return;
                }
                let Some(script) = webview_scroll_script(left, top) else {
                    return;
                };
                let _ = view.evaluate_script(&script);
                cx.stop_propagation();
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

    #[test]
    fn scrollbar_down_script_records_grab_and_scrolls() {
        assert!(webview_scrollbar_down_script(f32::NAN).is_none());
        let script = webview_scrollbar_down_script(48.0).expect("finite y produces a script");
        // records the grab offset so the thumb tracks the cursor instead of jumping,
        // and falls back to a non-scrollable no-op by nulling the grab.
        assert!(script.contains("window.__rngpuiSbGrab"));
        assert!(script.contains("48.000"));
        assert!(script.contains("s.scrollTop="));
    }

    #[test]
    fn scrollbar_move_script_requires_active_grab() {
        assert!(webview_scrollbar_move_script(f32::NEG_INFINITY).is_none());
        let script = webview_scrollbar_move_script(120.0).expect("finite y produces a script");
        // bails out unless a drag is in progress, then maps cursor y back to scrollTop.
        assert!(script.contains("if(window.__rngpuiSbGrab==null)return;"));
        assert!(script.contains("120.000"));
        assert!(script.contains("s.scrollTop="));
    }

    #[test]
    fn scrollbar_drag_state_round_trips() {
        assert!(!scrollbar_dragging(7));
        set_scrollbar_dragging(7, true);
        assert!(scrollbar_dragging(7));
        set_scrollbar_dragging(7, false);
        assert!(!scrollbar_dragging(7));
    }
}
