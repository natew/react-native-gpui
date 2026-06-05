use cocoa::base::{id, nil};
use gpui::Window;
use objc::{msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

const BACKGROUND_WINDOW_LEVEL: isize = -1;

pub fn lower(window: &mut Window) {
    let Some(ns_window) = raw_ns_window(window) else {
        return;
    };

    unsafe {
        let _: () = msg_send![ns_window, setLevel: BACKGROUND_WINDOW_LEVEL];
        let _: () = msg_send![ns_window, orderBack: nil];
    }
}

fn raw_ns_window(window: &mut Window) -> Option<id> {
    let handle = window.window_handle().ok()?;
    let ns_view = match handle.as_raw() {
        RawWindowHandle::AppKit(handle) => handle.ns_view.as_ptr() as id,
        _ => return None,
    };
    unsafe {
        let ns_window: id = msg_send![ns_view, window];
        if ns_window == nil {
            None
        } else {
            Some(ns_window)
        }
    }
}
