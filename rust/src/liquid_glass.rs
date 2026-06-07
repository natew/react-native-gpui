use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use cocoa::appkit::{
    NSView, NSViewHeightSizable, NSViewWidthSizable, NSVisualEffectBlendingMode,
    NSVisualEffectMaterial, NSVisualEffectState,
};
use cocoa::base::{NO, YES, id, nil};
use cocoa::foundation::{NSPoint, NSRect};
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::window as cg_window;
use gpui::Window;
use objc::runtime::{BOOL, Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use once_cell::sync::Lazy;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

const NS_WINDOW_BELOW: i64 = -1;
const GLASS_VARIANT_CLEAR: i64 = 1;

static INSTALLED_CONTENT_VIEWS: Lazy<Mutex<HashSet<usize>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

pub fn install(window: &mut Window) {
    let Some(ns_view) = raw_ns_view(window) else {
        return;
    };

    unsafe {
        let ns_window: id = msg_send![ns_view, window];
        let content_view: id = if ns_window == nil {
            ns_view
        } else {
            msg_send![ns_window, contentView]
        };
        if content_view == nil {
            return;
        }

        configure_transparent_window(ns_window, content_view, ns_view);

        let key = content_view as usize;
        if !remember_content_view(key) {
            return;
        }

        let bounds: NSRect = msg_send![content_view, bounds];
        let glass_view = create_glass_view(bounds);
        if glass_view == nil {
            forget_content_view(key);
            return;
        }

        let _: () = msg_send![
            content_view,
            addSubview: glass_view
            positioned: NS_WINDOW_BELOW
            relativeTo: nil
        ];
    }
}

pub fn show_offscreen_test_window(window: &mut Window) -> bool {
    let Some(ns_view) = raw_ns_view(window) else {
        return false;
    };

    unsafe {
        let ns_window: id = msg_send![ns_view, window];
        if ns_window == nil {
            return false;
        }

        let _: () = msg_send![ns_window, setAlphaValue: 0.0f64];
        let _: () = msg_send![ns_window, setIgnoresMouseEvents: YES];
        move_ns_window_offscreen(ns_window);
        let _: () = msg_send![ns_window, orderFront: nil];

        for _ in 0..25 {
            move_ns_window_offscreen(ns_window);

            if ns_window_intersects_any_screen(ns_window) {
                debug_offscreen_test("appkit frame intersects a screen");
                let _: () = msg_send![ns_window, orderOut: nil];
                return false;
            }

            match ns_window_server_intersects_any_screen(ns_window) {
                Some(true) => {
                    debug_offscreen_test("windowserver rect intersects a screen");
                    let _: () = msg_send![ns_window, orderOut: nil];
                    return false;
                }
                Some(false) => {
                    // test windows only need to repaint for dump/webview
                    // acknowledgements; keep them invisible and noninteractive even
                    // after the offscreen verification succeeds.
                    return true;
                }
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }

        debug_offscreen_test("windowserver never published a window rect");
        let _: () = msg_send![ns_window, orderOut: nil];
        false
    }
}

// Reveal the window ON-screen but invisible, for pixel capture. macOS only
// composites a window's Metal surface while it is on a display, so the
// fully-offscreen test path above yields a blank screenshot. Here the window stays
// at its on-screen origin (so WindowServer composites it) but is made imperceptible:
// a tiny non-zero alpha, click-through, non-key. The in-process PNG capture
// (capture_png.rs) reads the WindowServer composite and divides this alpha back out
// to recover full-opacity chrome — so the alpha must be non-zero (a fully
// transparent alpha-0 window is occlusion-culled by macOS and never composites,
// yielding a blank grab). 0.02 is imperceptible yet keeps the surface live.
// RNGPUI_CAPTURE_ALPHA overrides it.
pub fn show_onscreen_capture_window(window: &mut Window) {
    let Some(ns_view) = raw_ns_view(window) else {
        return;
    };
    let alpha = std::env::var("RNGPUI_CAPTURE_ALPHA")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(0.02);
    unsafe {
        let ns_window: id = msg_send![ns_view, window];
        if ns_window == nil {
            return;
        }
        let _: () = msg_send![ns_window, setAlphaValue: alpha];
        let _: () = msg_send![ns_window, setIgnoresMouseEvents: YES];
        // order it in (so it composites) without making it the key/main window.
        let _: () = msg_send![ns_window, orderFrontRegardless];
    }
}

pub fn show_nonactivating_window(window: &mut Window) {
    let Some(ns_view) = raw_ns_view(window) else {
        return;
    };
    unsafe {
        let ns_window: id = msg_send![ns_view, window];
        if ns_window == nil {
            return;
        }
        let _: () = msg_send![ns_window, orderFrontRegardless];
    }
}

fn debug_offscreen_test(message: &str) {
    if std::env::var("RNGPUI_TEST_DEBUG").is_ok() {
        eprintln!("[rngpui test debug] {message}");
    }
}

unsafe fn move_ns_window_offscreen(ns_window: id) {
    let frame: NSRect = msg_send![ns_window, frame];
    let next = NSRect::new(NSPoint::new(-10000.0, -10000.0), frame.size);
    let _: () = msg_send![ns_window, setFrame: next display: NO];
}

unsafe fn ns_window_intersects_any_screen(ns_window: id) -> bool {
    let frame: NSRect = msg_send![ns_window, frame];
    let screens: id = msg_send![class!(NSScreen), screens];
    if screens == nil {
        return true;
    }

    let count: u64 = msg_send![screens, count];
    for index in 0..count {
        let screen: id = msg_send![screens, objectAtIndex: index];
        if screen == nil {
            continue;
        }
        let screen_frame: NSRect = msg_send![screen, frame];
        if rects_intersect(frame, screen_frame) {
            return true;
        }
    }
    false
}

fn rects_intersect(a: NSRect, b: NSRect) -> bool {
    a.origin.x < b.origin.x + b.size.width
        && a.origin.x + a.size.width > b.origin.x
        && a.origin.y < b.origin.y + b.size.height
        && a.origin.y + a.size.height > b.origin.y
}

#[derive(Clone, Copy)]
struct WindowServerRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

unsafe fn ns_window_server_intersects_any_screen(ns_window: id) -> Option<bool> {
    let Some(rect) = (unsafe { ns_window_server_rect(ns_window) }) else {
        return None;
    };

    let screens: id = msg_send![class!(NSScreen), screens];
    if screens == nil {
        return Some(true);
    }

    let count: u64 = msg_send![screens, count];
    for index in 0..count {
        let screen: id = msg_send![screens, objectAtIndex: index];
        if screen == nil {
            continue;
        }
        let frame: NSRect = msg_send![screen, frame];
        if window_server_rects_intersect(rect, frame) {
            return Some(true);
        }
    }
    Some(false)
}

unsafe fn ns_window_server_rect(ns_window: id) -> Option<WindowServerRect> {
    let window_number: i32 = msg_send![ns_window, windowNumber];
    if window_number <= 0 {
        return None;
    }

    let windows = cg_window::copy_window_info(
        cg_window::kCGWindowListOptionAll,
        cg_window::kCGNullWindowID,
    )?;
    let number_key = unsafe { CFString::wrap_under_get_rule(cg_window::kCGWindowNumber) };
    let bounds_key = unsafe { CFString::wrap_under_get_rule(cg_window::kCGWindowBounds) };

    for value in windows.get_all_values() {
        if value.is_null() {
            continue;
        }
        let info: CFDictionary<CFString, CFType> =
            unsafe { TCFType::wrap_under_get_rule(value as CFDictionaryRef) };
        let Some(number_value) = info.find(&number_key) else {
            continue;
        };
        let Some(number) = number_value
            .downcast::<CFNumber>()
            .and_then(|value| value.to_i32())
        else {
            continue;
        };
        if number != window_number {
            continue;
        }

        let bounds_value = info.find(&bounds_key)?;
        let bounds: CFDictionary<CFString, CFType> =
            unsafe { TCFType::wrap_under_get_rule(bounds_value.as_CFTypeRef() as CFDictionaryRef) };
        return Some(WindowServerRect {
            x: cf_dict_number(&bounds, "X")?,
            y: cf_dict_number(&bounds, "Y")?,
            width: cf_dict_number(&bounds, "Width")?,
            height: cf_dict_number(&bounds, "Height")?,
        });
    }

    None
}

fn cf_dict_number(dict: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<f64> {
    let key = CFString::from_static_string(key);
    dict.find(&key)?
        .downcast::<CFNumber>()
        .and_then(|value| value.to_f64())
}

fn window_server_rects_intersect(a: WindowServerRect, b: NSRect) -> bool {
    a.x < b.origin.x + b.size.width
        && a.x + a.width > b.origin.x
        && a.y < b.origin.y + b.size.height
        && a.y + a.height > b.origin.y
}

unsafe fn configure_transparent_window(ns_window: id, content_view: id, ns_view: id) {
    let clear_color: id = msg_send![class!(NSColor), clearColor];

    if ns_window != nil {
        let _: () = msg_send![ns_window, setOpaque: NO];
        let _: () = msg_send![ns_window, setBackgroundColor: clear_color];
        let _: () = msg_send![ns_window, setHasShadow: YES];
        let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: YES];
    }

    unsafe {
        configure_transparent_view(content_view, clear_color);
    }
    if ns_view != content_view {
        unsafe {
            configure_transparent_view(ns_view, clear_color);
        }
    }
}

unsafe fn configure_transparent_view(view: id, clear_color: id) {
    if view == nil {
        return;
    }

    let _: () = msg_send![view, setWantsLayer: YES];
    let layer: id = msg_send![view, layer];
    if layer == nil {
        return;
    }

    let clear_cg_color: id = msg_send![clear_color, CGColor];
    let _: () = msg_send![layer, setOpaque: NO];
    let _: () = msg_send![layer, setBackgroundColor: clear_cg_color];
}

fn raw_ns_view(window: &mut Window) -> Option<id> {
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(handle) => Some(handle.ns_view.as_ptr() as id),
        _ => None,
    }
}

/// The gpui Metal-backed NSView (its `makeBackingLayer` returns gpui's
/// CAMetalLayer). Used by the RNGPUI_CAPTURE_PNG path to read full-opacity
/// content via CARenderer. Returns the raw pointer as usize so it can be moved
/// across the `'static` capture task boundary.
pub fn gpui_ns_view_ptr(window: &mut Window) -> Option<usize> {
    raw_ns_view(window).map(|view| view as usize)
}

fn remember_content_view(key: usize) -> bool {
    INSTALLED_CONTENT_VIEWS
        .lock()
        .map(|mut installed| installed.insert(key))
        .unwrap_or(false)
}

fn forget_content_view(key: usize) {
    if let Ok(mut installed) = INSTALLED_CONTENT_VIEWS.lock() {
        installed.remove(&key);
    }
}

unsafe fn create_glass_view(bounds: NSRect) -> id {
    if let Some(class) = Class::get("NSGlassEffectView") {
        let glass: id = msg_send![class, alloc];
        let glass: id = msg_send![glass, initWithFrame: bounds];
        unsafe {
            configure_common_view(glass);
            set_i64_property(glass, "variant", GLASS_VARIANT_CLEAR);
        }
        return glass;
    }

    let visual: id = msg_send![class!(NSVisualEffectView), alloc];
    let visual: id = msg_send![visual, initWithFrame: bounds];
    unsafe {
        configure_common_view(visual);
    }
    let _: () = msg_send![visual, setBlendingMode: NSVisualEffectBlendingMode::BehindWindow];
    let _: () = msg_send![visual, setMaterial: NSVisualEffectMaterial::UnderWindowBackground];
    let _: () = msg_send![visual, setState: NSVisualEffectState::Active];
    visual
}

unsafe fn configure_common_view(view: id) {
    unsafe {
        view.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable);
    }
    let _: () = msg_send![view, setWantsLayer: YES];
}

unsafe fn set_i64_property(view: id, key: &str, value: i64) {
    let private_sel = Sel::register(&format!("set_{}:", key));
    if unsafe { send_i64_if_supported(view, private_sel, value) } {
        return;
    }

    let public_sel = Sel::register(&format!(
        "set{}{}:",
        key.chars().next().unwrap().to_uppercase(),
        &key[1..]
    ));
    let _ = unsafe { send_i64_if_supported(view, public_sel, value) };
}

unsafe fn send_i64_if_supported(view: *mut Object, selector: Sel, value: i64) -> bool {
    let responds: BOOL = msg_send![view, respondsToSelector: selector];
    if !responds {
        return false;
    }

    let _: () = unsafe { objc::__send_message(&*view, selector, (value,)).unwrap_or(()) };
    true
}
