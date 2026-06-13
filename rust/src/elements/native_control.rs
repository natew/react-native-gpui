//! `<NativeButton>` / `<NativeTextInput>` — REAL AppKit controls (`NSButton`,
//! `NSTextField`) hole-punched through gpui's Metal layer, the same native-underlay
//! pattern `webview.rs` uses for `WKWebView`. The control is parked directly BELOW the
//! transparent Metal view; `hit_passthrough::record_native_control` registers its rect so
//! `GPUIView`'s `hitTest:` declines there and AppKit routes the real click/keystroke
//! straight to the control. The gpui element paints nothing — the native control IS the
//! visual, so it gets the genuine macOS bezel, focus ring, IME, and accent color for free.
//!
//! Target/action + delegate callbacks fire back through `crate::bridge`: a button click →
//! `event(id, "press")`, a text edit → `change_text`/`change`, Return → `submit`, focus
//! changes → `focus`/`blur`. The element carries the node id on the control's `tag`, so a
//! single shared target object services every control.
//!
//! Known spike limitation (shared with WebView): the control tracks layout bounds but is
//! a separate layer, so it doesn't ride gpui's transform/animation stack and isn't clipped
//! by an ancestor's rounded/overflow clip. Best for chrome/forms, not dense scroll lists.

use std::sync::Arc;

use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior, IntoElement,
    LayoutId, Pixels, Window,
};

use crate::elements::{report_layout, ReactElement};

#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::collections::{HashMap, HashSet};
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

#[cfg(target_os = "macos")]
use cocoa::base::{id, nil, NO, YES};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
#[cfg(target_os = "macos")]
use objc::declare::ClassDecl;
#[cfg(target_os = "macos")]
use objc::runtime::{Class, Object, Sel};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

#[cfg(target_os = "macos")]
use crate::elements::webview::{bounds_close, set_child_frame, webview_parent};

// order a subview directly above a given sibling in the parent z-stack (AppKit's
// NSWindowAbove). Interactive native chrome sits ABOVE gpui's Metal view: the control
// paints over gpui content (so its bezel/field isn't occluded by the app background) and
// receives the real click/keystroke directly — unlike the non-interactive blur/webview
// underlays, which sit below the Metal layer in regions the app leaves transparent.
#[cfg(target_os = "macos")]
const NS_WINDOW_ABOVE: i64 = 1;

// Which AppKit control backs this node, derived from the element type (+ secure flag for
// inputs). A change forces a rebuild — NSTextField and NSSecureTextField are distinct
// classes that can't be reconfigured in place.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeKind {
    Button,
    Input { secure: bool },
}

#[cfg(target_os = "macos")]
fn kind_of(element: &ReactElement) -> NativeKind {
    if element.element_type == "nativebutton" {
        NativeKind::Button
    } else {
        NativeKind::Input {
            secure: element.secure_text_entry,
        }
    }
}

// Per-id native control views + the last props/geometry we applied, so we skip the
// per-frame setFrame/setTitle churn (same discipline as webview.rs / system.rs).
#[cfg(target_os = "macos")]
thread_local! {
    static VIEWS: RefCell<HashMap<u64, id>> = RefCell::new(HashMap::new());
    static KINDS: RefCell<HashMap<u64, NativeKind>> = RefCell::new(HashMap::new());
    static LAST_BOUNDS: RefCell<HashMap<u64, (f64, f64, f64, f64)>> = RefCell::new(HashMap::new());
    static LAST_TITLE: RefCell<HashMap<u64, String>> = RefCell::new(HashMap::new());
    static LAST_ENABLED: RefCell<HashMap<u64, bool>> = RefCell::new(HashMap::new());
    static LAST_PLACEHOLDER: RefCell<HashMap<u64, String>> = RefCell::new(HashMap::new());
    // last value we EMITTED to JS from a native edit, so a controlled `value` prop echoing
    // back doesn't clobber the live field (and jump the caret) — only a genuinely new
    // programmatic value re-sets stringValue. Standard echo-suppression.
    static LAST_EMITTED: RefCell<HashMap<u64, String>> = RefCell::new(HashMap::new());
    // the single shared target/delegate object that services every control by tag.
    static TARGET: RefCell<Option<id>> = RefCell::new(None);
}

// ── shared target / delegate (one object, routes by the control's `tag` = node id) ──────

#[cfg(target_os = "macos")]
extern "C" fn button_click(_this: &Object, _cmd: Sel, sender: id) {
    let tag: isize = unsafe { msg_send![sender, tag] };
    crate::bridge::event(tag as u64, "press");
}

#[cfg(target_os = "macos")]
extern "C" fn text_changed(_this: &Object, _cmd: Sel, notification: id) {
    unsafe {
        let field: id = msg_send![notification, object];
        let tag: isize = msg_send![field, tag];
        let value = read_ns_string(msg_send![field, stringValue]);
        LAST_EMITTED.with(|m| m.borrow_mut().insert(tag as u64, value.clone()));
        crate::bridge::change_text(tag as u64, &value);
        crate::bridge::change(tag as u64, &value);
    }
}

#[cfg(target_os = "macos")]
extern "C" fn text_submit(_this: &Object, _cmd: Sel, sender: id) {
    unsafe {
        let tag: isize = msg_send![sender, tag];
        let value = read_ns_string(msg_send![sender, stringValue]);
        crate::bridge::key_press(tag as u64, "Enter", false, false, false, false);
        crate::bridge::submit(tag as u64, &value);
    }
}

#[cfg(target_os = "macos")]
extern "C" fn text_did_begin(_this: &Object, _cmd: Sel, notification: id) {
    let tag: isize = unsafe {
        let field: id = msg_send![notification, object];
        msg_send![field, tag]
    };
    crate::bridge::event(tag as u64, "focus");
}

#[cfg(target_os = "macos")]
extern "C" fn text_did_end(_this: &Object, _cmd: Sel, notification: id) {
    let tag: isize = unsafe {
        let field: id = msg_send![notification, object];
        msg_send![field, tag]
    };
    crate::bridge::event(tag as u64, "blur");
}

#[cfg(target_os = "macos")]
fn target_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| unsafe {
        let superclass = class!(NSObject);
        let mut decl = ClassDecl::new("RNGPUINativeControlTarget", superclass)
            .unwrap_or_else(|| panic!("failed to declare RNGPUINativeControlTarget"));
        decl.add_method(
            sel!(rngpuiButtonClick:),
            button_click as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(rngpuiTextSubmit:),
            text_submit as extern "C" fn(&Object, Sel, id),
        );
        // NSTextFieldDelegate (informal — AppKit checks respondsToSelector:).
        decl.add_method(
            sel!(controlTextDidChange:),
            text_changed as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(controlTextDidBeginEditing:),
            text_did_begin as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(controlTextDidEndEditing:),
            text_did_end as extern "C" fn(&Object, Sel, id),
        );
        decl.register()
    })
}

#[cfg(target_os = "macos")]
fn shared_target() -> id {
    TARGET.with(|t| {
        let mut t = t.borrow_mut();
        if let Some(existing) = *t {
            return existing;
        }
        let obj: id = unsafe { msg_send![target_class(), new] };
        *t = Some(obj); // singleton, intentionally retained for the process lifetime.
        obj
    })
}

#[cfg(target_os = "macos")]
unsafe fn ns_string(s: &str) -> id {
    unsafe {
        let string = NSString::alloc(nil).init_str(s);
        let _: id = msg_send![string, autorelease];
        string
    }
}

#[cfg(target_os = "macos")]
unsafe fn read_ns_string(s: id) -> String {
    if s == nil {
        return String::new();
    }
    unsafe {
        let utf8: *const std::os::raw::c_char = msg_send![s, UTF8String];
        if utf8.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned()
    }
}

// ── native view lifecycle ───────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
unsafe fn set_aqua_appearance(view: id) {
    unsafe {
        let name = ns_string("NSAppearanceNameAqua");
        let aqua: id = msg_send![class!(NSAppearance), appearanceNamed: name];
        if aqua != nil {
            let _: () = msg_send![view, setAppearance: aqua];
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn create_view(kind: NativeKind, id: u64) -> id {
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    let target = shared_target();
    match kind {
        NativeKind::Button => {
            let btn: id = msg_send![class!(NSButton), alloc];
            let btn: id = msg_send![btn, initWithFrame: frame];
            let _: () = msg_send![btn, setBezelStyle: 1u64]; // NSBezelStyleRounded
            let _: () = msg_send![btn, setButtonType: 7u64]; // NSButtonTypeMomentaryPushIn
            let _: () = msg_send![btn, setBordered: YES];
            let _: () = msg_send![btn, setTag: id as isize];
            let _: () = msg_send![btn, setTarget: target];
            let _: () = msg_send![btn, setAction: sel!(rngpuiButtonClick:)];
            // Force the standard light (Aqua) appearance for a predictable native look.
            // TODO: follow the app/window theme instead of hardcoding light.
            unsafe { set_aqua_appearance(btn) };
            btn
        }
        NativeKind::Input { secure } => {
            let cls = if secure {
                class!(NSSecureTextField)
            } else {
                class!(NSTextField)
            };
            let tf: id = msg_send![cls, alloc];
            let tf: id = msg_send![tf, initWithFrame: frame];
            let _: () = msg_send![tf, setEditable: YES];
            let _: () = msg_send![tf, setSelectable: YES];
            let _: () = msg_send![tf, setBordered: YES];
            let _: () = msg_send![tf, setBezeled: YES];
            let _: () = msg_send![tf, setDrawsBackground: YES];
            let _: () = msg_send![tf, setTag: id as isize];
            let _: () = msg_send![tf, setDelegate: target];
            // Return fires the control's action → submit.
            let _: () = msg_send![tf, setTarget: target];
            let _: () = msg_send![tf, setAction: sel!(rngpuiTextSubmit:)];
            unsafe { set_aqua_appearance(tf) };
            tf
        }
    }
}

// Park the control directly ABOVE gpui's Metal view so it paints over app content and
// takes the real click/keystroke itself. Only reparents/reorders when the hierarchy is
// actually wrong — addSubview: on an existing subview is a remove+re-add that would flicker.
#[cfg(target_os = "macos")]
unsafe fn park_above_gpui(parent_view: id, view: id, gpui_view: id) {
    let current_parent: id = msg_send![view, superview];
    let subviews: id = msg_send![parent_view, subviews];
    let count: usize = msg_send![subviews, count];
    let topmost: id = if count > 0 {
        msg_send![subviews, objectAtIndex: count - 1]
    } else {
        nil
    };
    // already parented here and already on top → nothing to do (steady-state no-op).
    if current_parent == parent_view && topmost == view {
        return;
    }
    if current_parent != nil && current_parent != parent_view {
        let _: () = msg_send![view, removeFromSuperview];
    }
    let _: () = msg_send![
        parent_view,
        addSubview: view
        positioned: NS_WINDOW_ABOVE
        relativeTo: gpui_view
    ];
}

#[cfg(target_os = "macos")]
fn ensure_view(id: u64, kind: NativeKind, parent_view: id, gpui_view: id) -> id {
    let needs_rebuild = KINDS.with(|k| k.borrow().get(&id).map_or(false, |prev| *prev != kind));
    if needs_rebuild {
        VIEWS.with(|v| {
            if let Some(old) = v.borrow_mut().remove(&id) {
                unsafe {
                    let _: () = msg_send![old, removeFromSuperview];
                    let _: () = msg_send![old, release];
                }
            }
        });
        // drop stale prop caches so the rebuilt view re-applies everything.
        LAST_TITLE.with(|m| m.borrow_mut().remove(&id));
        LAST_ENABLED.with(|m| m.borrow_mut().remove(&id));
        LAST_PLACEHOLDER.with(|m| m.borrow_mut().remove(&id));
    }

    let view = VIEWS.with(|v| {
        *v.borrow_mut()
            .entry(id)
            .or_insert_with(|| unsafe { create_view(kind, id) })
    });
    KINDS.with(|k| k.borrow_mut().insert(id, kind));
    unsafe {
        park_above_gpui(parent_view, view, gpui_view);
    }
    view
}

#[cfg(target_os = "macos")]
unsafe fn apply_props(id: u64, view: id, kind: NativeKind, element: &ReactElement) {
    let enabled = element.editable;
    let enabled_changed = LAST_ENABLED.with(|m| m.borrow().get(&id).copied() != Some(enabled));
    if enabled_changed {
        let _: () = msg_send![view, setEnabled: if enabled { YES } else { NO }];
        LAST_ENABLED.with(|m| m.borrow_mut().insert(id, enabled));
    }

    match kind {
        NativeKind::Button => {
            let title = element.text.clone().unwrap_or_default();
            let changed = LAST_TITLE.with(|m| m.borrow().get(&id) != Some(&title));
            if changed {
                let title_ns = unsafe { ns_string(&title) };
                let _: () = msg_send![view, setTitle: title_ns];
                LAST_TITLE.with(|m| m.borrow_mut().insert(id, title));
            }
        }
        NativeKind::Input { .. } => {
            // `text` carries the placeholder for input nodes (overloaded on the wire).
            let placeholder = element.text.clone().unwrap_or_default();
            let changed = LAST_PLACEHOLDER.with(|m| m.borrow().get(&id) != Some(&placeholder));
            if changed {
                let placeholder_ns = unsafe { ns_string(&placeholder) };
                let _: () = msg_send![view, setPlaceholderString: placeholder_ns];
                LAST_PLACEHOLDER.with(|m| m.borrow_mut().insert(id, placeholder));
            }
            // controlled `value`: only push a programmatically-new value (not our own echo,
            // not what the field already shows) so native typing isn't clobbered mid-edit.
            if let Some(value) = element.value.clone() {
                let is_echo = LAST_EMITTED.with(|m| m.borrow().get(&id) == Some(&value));
                let live = unsafe { read_ns_string(msg_send![view, stringValue]) };
                if !is_echo && live != value {
                    let value_ns = unsafe { ns_string(&value) };
                    let _: () = msg_send![view, setStringValue: value_ns];
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn position(window: &mut Window, element: &ReactElement, bounds: Bounds<Pixels>) {
    let Some((parent_view, gpui_view)) = webview_parent(window) else {
        return;
    };
    let id = element.global_id;
    let kind = kind_of(element);
    let view = ensure_view(id, kind, parent_view, gpui_view);

    let x = f64::from(bounds.origin.x);
    let y = f64::from(bounds.origin.y);
    let width = f64::from(bounds.size.width);
    let height = f64::from(bounds.size.height);
    let new_bounds = (x, y, width, height);

    let bounds_changed = LAST_BOUNDS.with(|b| match b.borrow().get(&id) {
        Some(prev) => !bounds_close(*prev, new_bounds),
        None => true,
    });

    unsafe {
        if bounds_changed {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: YES];
            set_child_frame(parent_view, view, x, y, width, height);
            let _: () = msg_send![class!(CATransaction), commit];
            LAST_BOUNDS.with(|b| {
                b.borrow_mut().insert(id, new_bounds);
            });
        }
        apply_props(id, view, kind, element);
        let _: () = msg_send![view, setHidden: NO];
    }
}

/// Trigger a native control's real action by node id, as a genuine user click would:
/// `performClick:` on an NSButton fires its target/action (→ `bridge::event(id, "press")`).
/// Returns true if `id` is a known native control we handled, false otherwise (so the
/// caller can fall back to a normal gpui synth-tap). Used by the `do tap` debug path to
/// drive the real AppKit event route, which a gpui-internal synthetic tap can't reach.
#[cfg(target_os = "macos")]
pub fn perform_native_click(id: u64) -> bool {
    VIEWS.with(|views| match views.borrow().get(&id).copied() {
        Some(view) => {
            unsafe {
                let _: () = msg_send![view, performClick: nil];
            }
            true
        }
        None => false,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn perform_native_click(_id: u64) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn hide_view(id: u64) {
    VIEWS.with(|views| {
        if let Some(view) = views.borrow().get(&id).copied() {
            unsafe {
                let _: () = msg_send![view, setHidden: YES];
            }
        }
    });
}

/// Tear down native control views for any id that left the tree. Views are created lazily
/// in prepaint, so retaining present ids is all the GC needs. No-op off macOS.
#[cfg(target_os = "macos")]
pub fn retain_native_controls(present: &HashSet<u64>) {
    LAST_BOUNDS.with(|m| m.borrow_mut().retain(|id, _| present.contains(id)));
    LAST_TITLE.with(|m| m.borrow_mut().retain(|id, _| present.contains(id)));
    LAST_ENABLED.with(|m| m.borrow_mut().retain(|id, _| present.contains(id)));
    LAST_PLACEHOLDER.with(|m| m.borrow_mut().retain(|id, _| present.contains(id)));
    LAST_EMITTED.with(|m| m.borrow_mut().retain(|id, _| present.contains(id)));
    KINDS.with(|m| m.borrow_mut().retain(|id, _| present.contains(id)));
    VIEWS.with(|views| {
        views.borrow_mut().retain(|id, view| {
            if present.contains(id) {
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

#[cfg(not(target_os = "macos"))]
pub fn retain_native_controls(_present: &std::collections::HashSet<u64>) {}

/// `<NativeButton>` / `<NativeTextInput>` → a real AppKit control parked below gpui's
/// Metal layer and resized to its flex-layout bounds every frame. The gpui element paints
/// nothing; transparent window pixels in its rect read as the native control.
pub struct ReactNativeControlElement {
    element: Arc<ReactElement>,
}

impl ReactNativeControlElement {
    pub fn new(element: Arc<ReactElement>) -> Self {
        Self { element }
    }
}

impl IntoElement for ReactNativeControlElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for ReactNativeControlElement {
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
        // honor the node's flex style (width/height/flex/margin) so it occupies space; the
        // native control fills these bounds. (Native controls currently need explicit
        // sizing — gpui can't measure the AppKit intrinsic size.)
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
            #[cfg(target_os = "macos")]
            hide_view(self.element.global_id);
            let _ = window;
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

        // route real clicks/keystrokes over this rect to the native control below the Metal
        // layer (GPUIView's hitTest: declines here), unless a gpui overlay paints on top.
        #[cfg(target_os = "macos")]
        crate::hit_passthrough::record_native_control(
            bounds.origin.x.into(),
            bounds.origin.y.into(),
            bounds.size.width.into(),
            bounds.size.height.into(),
        );

        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);

        #[cfg(target_os = "macos")]
        position(window, &self.element, bounds);

        Some(hitbox)
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _: &mut (),
        _hitbox: &mut Self::PrepaintState,
        _window: &mut Window,
        _: &mut App,
    ) {
        // nothing to paint: the native control (below the Metal layer) is the entire visual.
    }
}
