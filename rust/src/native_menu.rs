use serde::Deserialize;

#[derive(Clone, Deserialize)]
pub(crate) struct NativeContextMenu {
    pub x: f32,
    pub y: f32,
    #[serde(default)]
    pub items: Vec<NativeContextMenuItem>,
    #[serde(rename = "closeId")]
    pub close_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind")]
pub(crate) enum NativeContextMenuItem {
    #[serde(rename = "action")]
    Action {
        id: String,
        label: String,
        #[serde(default)]
        disabled: bool,
        #[serde(default)]
        checked: bool,
        #[serde(default, rename = "destructive")]
        _destructive: bool,
    },
    #[serde(rename = "label")]
    Label { label: String },
    #[serde(rename = "separator")]
    Separator,
    #[serde(rename = "submenu")]
    Submenu {
        label: String,
        #[serde(default)]
        disabled: bool,
        #[serde(default)]
        items: Vec<NativeContextMenuItem>,
    },
}

#[cfg(target_os = "macos")]
mod macos {
    #![allow(unsafe_op_in_unsafe_fn)]

    use std::collections::HashMap;
    use std::sync::Mutex;

    use cocoa::base::{NO, YES, id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSInteger, NSPoint, NSRect, NSString};
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use once_cell::sync::Lazy;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use super::{NativeContextMenu, NativeContextMenuItem};

    static MENU_ACTIONS: Lazy<Mutex<HashMap<NSInteger, String>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));
    static MENU_TARGET: Lazy<usize> = Lazy::new(|| unsafe {
        let cls = target_class();
        let obj: id = msg_send![cls, new];
        obj as usize
    });

    pub(crate) fn show(window: &mut gpui::Window, menu: NativeContextMenu) {
        if menu.items.is_empty() {
            if let Some(close_id) = menu.close_id.as_deref() {
                crate::bridge::command(close_id);
            }
            return;
        }

        unsafe {
            let Some(content_view) = content_view(window) else {
                if let Some(close_id) = menu.close_id.as_deref() {
                    crate::bridge::command(close_id);
                }
                return;
            };

            MENU_ACTIONS.lock().unwrap().clear();

            let ns_menu: id = msg_send![class!(NSMenu), alloc];
            let ns_menu: id = msg_send![ns_menu, initWithTitle: ns_string("")];
            let target = *MENU_TARGET as id;
            let mut next_tag: NSInteger = 1;
            for item in &menu.items {
                add_menu_item(ns_menu, item, target, &mut next_tag);
            }

            let point = appkit_point(content_view, menu.x as f64, menu.y as f64);
            let _: bool = msg_send![
                ns_menu,
                popUpMenuPositioningItem: nil
                atLocation: point
                inView: content_view
            ];
            let _: () = msg_send![ns_menu, release];

            MENU_ACTIONS.lock().unwrap().clear();
            if let Some(close_id) = menu.close_id.as_deref() {
                crate::bridge::command(close_id);
            }
        }
    }

    unsafe fn add_menu_item(
        menu: id,
        item: &NativeContextMenuItem,
        target: id,
        next_tag: &mut NSInteger,
    ) {
        match item {
            NativeContextMenuItem::Action {
                id,
                label,
                disabled,
                checked,
                _destructive: _,
            } => {
                let ns_item = action_item(label, target, *next_tag, !*disabled, *checked);
                MENU_ACTIONS.lock().unwrap().insert(*next_tag, id.clone());
                *next_tag += 1;
                let _: () = msg_send![menu, addItem: ns_item];
                let _: () = msg_send![ns_item, release];
            }
            NativeContextMenuItem::Label { label } => {
                let ns_item = label_item(label);
                let _: () = msg_send![menu, addItem: ns_item];
                let _: () = msg_send![ns_item, release];
            }
            NativeContextMenuItem::Separator => {
                let ns_item: id = msg_send![class!(NSMenuItem), separatorItem];
                let _: () = msg_send![menu, addItem: ns_item];
            }
            NativeContextMenuItem::Submenu {
                label,
                disabled,
                items,
            } => {
                let ns_item: id = msg_send![class!(NSMenuItem), alloc];
                let ns_item: id = msg_send![ns_item, initWithTitle: ns_string(label) action: nil keyEquivalent: ns_string("")];
                let submenu: id = msg_send![class!(NSMenu), alloc];
                let submenu: id = msg_send![submenu, initWithTitle: ns_string(label)];
                for child in items {
                    add_menu_item(submenu, child, target, next_tag);
                }
                let _: () = msg_send![ns_item, setSubmenu: submenu];
                let _: () = msg_send![ns_item, setEnabled: if *disabled { NO } else { YES }];
                let _: () = msg_send![menu, addItem: ns_item];
                let _: () = msg_send![submenu, release];
                let _: () = msg_send![ns_item, release];
            }
        }
    }

    unsafe fn action_item(
        label: &str,
        target: id,
        tag: NSInteger,
        enabled: bool,
        checked: bool,
    ) -> id {
        let item: id = msg_send![class!(NSMenuItem), alloc];
        let item: id = msg_send![
            item,
            initWithTitle: ns_string(label)
            action: sel!(rngpuiContextMenuItem:)
            keyEquivalent: ns_string("")
        ];
        let _: () = msg_send![item, setTarget: target];
        let _: () = msg_send![item, setTag: tag];
        let _: () = msg_send![item, setEnabled: if enabled { YES } else { NO }];
        if checked {
            let _: () = msg_send![item, setState: 1isize];
        }
        item
    }

    unsafe fn label_item(label: &str) -> id {
        let item: id = msg_send![class!(NSMenuItem), alloc];
        let item: id = msg_send![
            item,
            initWithTitle: ns_string(label)
            action: nil
            keyEquivalent: ns_string("")
        ];
        let _: () = msg_send![item, setEnabled: NO];
        item
    }

    unsafe fn content_view(window: &mut gpui::Window) -> Option<id> {
        let handle = window.window_handle().ok()?;
        let gpui_view = match handle.as_raw() {
            RawWindowHandle::AppKit(handle) => handle.ns_view.as_ptr() as id,
            _ => return None,
        };
        let ns_window: id = msg_send![gpui_view, window];
        if ns_window == nil {
            return None;
        }
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            None
        } else {
            Some(content_view)
        }
    }

    unsafe fn appkit_point(view: id, x: f64, y: f64) -> NSPoint {
        let bounds: NSRect = msg_send![view, bounds];
        let flipped: objc::runtime::BOOL = msg_send![view, isFlipped];
        let local_y = if flipped == YES {
            y
        } else {
            bounds.size.height - y
        };
        NSPoint::new(x, local_y)
    }

    unsafe fn ns_string(value: &str) -> id {
        NSString::alloc(nil).init_str(value).autorelease()
    }

    unsafe fn target_class() -> &'static Class {
        static CLASS: Lazy<&'static Class> = Lazy::new(|| unsafe {
            let superclass = class!(NSObject);
            let mut decl = ClassDecl::new("RNGPUIContextMenuTarget", superclass)
                .expect("RNGPUIContextMenuTarget already registered");
            decl.add_method(
                sel!(rngpuiContextMenuItem:),
                perform_context_menu_item as extern "C" fn(&Object, Sel, id),
            );
            decl.register()
        });
        *CLASS
    }

    extern "C" fn perform_context_menu_item(_this: &Object, _cmd: Sel, sender: id) {
        unsafe {
            let tag: NSInteger = msg_send![sender, tag];
            let id = MENU_ACTIONS.lock().unwrap().get(&tag).cloned();
            if let Some(id) = id {
                crate::bridge::command(&id);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::NativeContextMenu;

    pub(crate) fn show(_window: &mut gpui::Window, menu: NativeContextMenu) {
        if let Some(close_id) = menu.close_id.as_deref() {
            crate::bridge::command(close_id);
        }
    }
}

pub(crate) use macos::show;
