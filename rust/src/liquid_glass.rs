use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use cocoa::appkit::{
    NSView, NSViewHeightSizable, NSViewWidthSizable, NSVisualEffectBlendingMode,
    NSVisualEffectMaterial, NSVisualEffectState,
};
use cocoa::base::{NO, YES, id, nil};
use cocoa::foundation::NSRect;
use gpui::Window;
use objc::declare::ClassDecl;
use objc::runtime::{BOOL, Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use once_cell::sync::Lazy;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

const NS_WINDOW_BELOW: i64 = -1;
const GLASS_VARIANT_CONTROL: i64 = 19;
const WINDOW_CORNER_RADIUS: f64 = 22.0;

static INSTALLED_CONTENT_VIEWS: Lazy<Mutex<HashSet<usize>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));
static CORNER_RADIUS: AtomicU64 = AtomicU64::new(0);

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
        apply_window_corner_radius(ns_window, WINDOW_CORNER_RADIUS);

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

extern "C" fn overridden_corner_radius(_this: &Object, _cmd: Sel) -> f64 {
    f64::from_bits(CORNER_RADIUS.load(Ordering::Relaxed))
}

unsafe extern "C" {
    fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
}

unsafe fn apply_window_corner_radius(ns_window: id, radius: f64) {
    if ns_window == nil || Class::get("NSGlassEffectView").is_none() {
        return;
    }

    CORNER_RADIUS.store(radius.to_bits(), Ordering::Relaxed);

    let content_view: id = msg_send![ns_window, contentView];
    if content_view == nil {
        return;
    }

    let frame_view: id = msg_send![content_view, superview];
    if frame_view == nil {
        return;
    }

    let original_class: *const Class = msg_send![frame_view, class];
    let original_name = unsafe { (*original_class).name() };
    let subclass_name = format!("_RNGPUIRoundedCorner_{original_name}");

    let subclass: &Class = if let Some(existing) = Class::get(&subclass_name) {
        existing
    } else if let Some(mut decl) = ClassDecl::new(&subclass_name, unsafe { &*original_class }) {
        unsafe {
            decl.add_method(
                Sel::register("_cornerRadius"),
                overridden_corner_radius as extern "C" fn(&Object, Sel) -> f64,
            );
            decl.add_method(
                Sel::register("_getCachedWindowCornerRadius"),
                overridden_corner_radius as extern "C" fn(&Object, Sel) -> f64,
            );
        }
        decl.register()
    } else {
        return;
    };

    let current_class: *const Class = msg_send![frame_view, class];
    if !std::ptr::eq(current_class, subclass) {
        unsafe {
            object_setClass(frame_view, subclass as *const Class);
        }
    }
}

fn raw_ns_view(window: &mut Window) -> Option<id> {
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(handle) => Some(handle.ns_view.as_ptr() as id),
        _ => None,
    }
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
            set_i64_property(glass, "variant", GLASS_VARIANT_CONTROL);
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
