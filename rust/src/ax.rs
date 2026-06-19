#![allow(unexpected_cfgs)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::collections::{HashMap, HashSet};
use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::{Arc, Mutex, OnceLock};

use cocoa::base::{NO, YES, id, nil};
use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
use gpui::{Bounds, Pixels, Window};
use objc::declare::ClassDecl;
use objc::runtime::{BOOL, Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use crate::elements::ReactElement;

const NODE_ID_IVAR: &str = "rngpuiNodeId";

#[derive(Clone, Copy, Default, PartialEq)]
struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone)]
struct AxDescriptor {
    id: u64,
    parent_id: Option<u64>,
    children: Vec<u64>,
    role: String,
    label: Option<String>,
    hint: Option<String>,
    value: Option<String>,
    identifier: String,
    disabled: bool,
    selected: bool,
    checked: Option<String>,
    expanded: Option<bool>,
    is_element: bool,
    events: Vec<String>,
}

struct AxNode {
    view: usize,
    parent_id: Option<u64>,
    children: Vec<u64>,
    role: String,
    label: Option<String>,
    hint: Option<String>,
    value: Option<String>,
    identifier: String,
    disabled: bool,
    selected: bool,
    checked: Option<String>,
    expanded: Option<bool>,
    is_element: bool,
    events: Vec<String>,
    frame: Option<Frame>,
    /// the (own frame, parent frame) pair last pushed to AppKit — `update_frame` runs for
    /// every div on every draw, so it must skip the NSView setFrame/attach calls when
    /// nothing moved (an unconditional setFrame on ~100 views was a fixed per-frame tax).
    applied: Option<(Frame, Frame)>,
}

#[derive(Default)]
struct AxState {
    content_view: usize,
    nodes: HashMap<u64, AxNode>,
}

static STATE: OnceLock<Mutex<AxState>> = OnceLock::new();

fn state() -> &'static Mutex<AxState> {
    STATE.get_or_init(|| Mutex::new(AxState::default()))
}

pub fn sync_tree(window: &mut Window, root: &Arc<ReactElement>) {
    let Some(content_view) = content_view(window) else {
        return;
    };

    let mut descriptors = Vec::new();
    collect_descriptors(root, None, &mut descriptors);
    let present = descriptors
        .iter()
        .map(|descriptor| descriptor.id)
        .collect::<HashSet<_>>();

    unsafe {
        let mut state = state().lock().unwrap();
        let content_ptr = content_view as usize;
        if state.content_view != 0 && state.content_view != content_ptr {
            clear_state(&mut state);
        }
        state.content_view = content_ptr;

        let stale = state
            .nodes
            .keys()
            .copied()
            .filter(|id| !present.contains(id))
            .collect::<Vec<_>>();
        for id in stale {
            if let Some(node) = state.nodes.remove(&id) {
                release_view(node.view as id);
            }
        }

        for descriptor in descriptors {
            let (frame, applied) = state
                .nodes
                .get(&descriptor.id)
                .map(|node| (node.frame, node.applied))
                .unwrap_or((None, None));
            let view = match state.nodes.get(&descriptor.id) {
                Some(node) => node.view,
                None => create_view(descriptor.id) as usize,
            };

            state.nodes.insert(
                descriptor.id,
                AxNode {
                    view,
                    parent_id: descriptor.parent_id,
                    children: descriptor.children,
                    role: descriptor.role,
                    label: descriptor.label,
                    hint: descriptor.hint,
                    value: descriptor.value,
                    identifier: descriptor.identifier,
                    disabled: descriptor.disabled,
                    selected: descriptor.selected,
                    checked: descriptor.checked,
                    expanded: descriptor.expanded,
                    is_element: descriptor.is_element,
                    events: descriptor.events,
                    frame,
                    applied,
                },
            );
        }

        let ids = state.nodes.keys().copied().collect::<Vec<_>>();
        for id in ids {
            let Some(node) = state.nodes.get(&id) else {
                continue;
            };
            let view = node.view as id;
            let parent_view = node
                .parent_id
                .and_then(|parent_id| state.nodes.get(&parent_id).map(|parent| parent.view as id))
                .unwrap_or(content_view);
            attach_to_parent(view, parent_view);
        }

        let roots = state
            .nodes
            .values()
            .filter(|node| node.parent_id.is_none())
            .map(|node| node.view as id)
            .collect::<Vec<_>>();
        set_accessibility_children(content_view, &roots);
        post_layout_changed(content_view);
    }
}

pub fn update_frame(_window: &mut Window, element: &ReactElement, bounds: Bounds<Pixels>) {
    let frame = Frame {
        x: bounds.origin.x.into(),
        y: bounds.origin.y.into(),
        width: bounds.size.width.into(),
        height: bounds.size.height.into(),
    };

    unsafe {
        let mut state = state().lock().unwrap();
        // fast reject before ANY objc work: this runs for every div on every draw, and
        // the overwhelming majority of nodes are not AX-registered.
        let Some(node) = state.nodes.get(&element.global_id) else {
            return;
        };
        let node_parent_id = node.parent_id;
        let node_view = node.view as id;
        let prev_applied = node.applied;

        // resolve the parent's frame/view; only fall back to the (objc-fetched) content
        // view geometry for root-level AX nodes or a missing parent — the common child
        // path stays free of AppKit calls entirely.
        let content_view_frame = |state: &AxState| -> Option<(Frame, id)> {
            let content_view = if state.content_view != 0 {
                state.content_view as id
            } else {
                return None;
            };
            let content_frame: NSRect = msg_send![content_view, frame];
            Some((
                Frame {
                    x: 0.0,
                    y: 0.0,
                    width: content_frame.size.width,
                    height: content_frame.size.height,
                },
                content_view,
            ))
        };
        let (parent_frame, parent_view) = match node_parent_id {
            Some(parent_id) => match state.nodes.get(&parent_id) {
                Some(parent) if parent.frame.is_some() => {
                    (parent.frame.unwrap(), parent.view as id)
                }
                Some(parent) => {
                    let Some((frame, _)) = content_view_frame(&state) else {
                        return;
                    };
                    (frame, parent.view as id)
                }
                None => {
                    let Some((frame, view)) = content_view_frame(&state) else {
                        return;
                    };
                    (frame, view)
                }
            },
            None => {
                let Some((frame, view)) = content_view_frame(&state) else {
                    return;
                };
                (frame, view)
            }
        };

        if let Some(node) = state.nodes.get_mut(&element.global_id) {
            node.frame = Some(frame);
        }
        // skip the AppKit attach/setFrame when neither this node nor its parent moved —
        // an unconditional NSView setFrame on every AX node was a fixed per-frame tax.
        if prev_applied == Some((frame, parent_frame)) {
            return;
        }
        if let Some(node) = state.nodes.get_mut(&element.global_id) {
            node.applied = Some((frame, parent_frame));
        }

        let local_x = frame.x - parent_frame.x;
        let local_top = frame.y - parent_frame.y;
        let local_y = parent_frame.height - local_top - frame.height;
        let rect = NSRect::new(
            NSPoint::new(local_x, local_y),
            NSSize::new(frame.width.max(0.0), frame.height.max(0.0)),
        );
        attach_to_parent(node_view, parent_view);
        let _: () = msg_send![node_view, setFrame: rect];
    }
}

fn collect_descriptors(
    element: &Arc<ReactElement>,
    parent_id: Option<u64>,
    out: &mut Vec<AxDescriptor>,
) {
    if element.accessibility.hidden {
        return;
    }

    let children = element
        .children
        .iter()
        .filter(|child| !child.accessibility.hidden)
        .map(|child| child.global_id)
        .collect::<Vec<_>>();

    out.push(AxDescriptor {
        id: element.global_id,
        parent_id,
        children,
        role: ax_role(element),
        label: ax_label(element),
        hint: element.accessibility.hint.clone(),
        value: ax_value(element),
        identifier: element
            .accessibility
            .identifier
            .clone()
            .unwrap_or_else(|| format!("rngpui-{}", element.global_id)),
        disabled: element.accessibility.disabled,
        selected: element.accessibility.selected,
        checked: element.accessibility.checked.clone(),
        expanded: element.accessibility.expanded,
        is_element: ax_is_element(element),
        events: element.events.clone(),
    });

    for child in &element.children {
        collect_descriptors(child, Some(element.global_id), out);
    }
}

fn ax_role(element: &ReactElement) -> String {
    if let Some(role) = element.accessibility.role.as_deref() {
        return match role {
            "button" | "keyboardkey" | "imagebutton" => "AXButton",
            "link" => "AXLink",
            "search" => "AXSearchField",
            "image" => "AXImage",
            "text" | "header" | "summary" | "alert" | "timer" => "AXStaticText",
            "adjustable" | "progressbar" | "scrollbar" => "AXSlider",
            "checkbox" | "switch" => "AXCheckBox",
            "radio" => "AXRadioButton",
            "combobox" | "menu" | "menuitem" => "AXMenuButton",
            "option" if events_have_press_action(&element.events) => "AXButton",
            "option" => "AXStaticText",
            "tablist" => "AXTabGroup",
            "tab" => "AXRadioButton",
            "toolbar" | "menubar" | "radiogroup" => "AXGroup",
            "none" => "AXGroup",
            _ => "AXGroup",
        }
        .to_string();
    }

    match element.element_type.as_str() {
        "text" => "AXStaticText",
        "textinput" | "textarea" => "AXTextField",
        "image" | "svg" => "AXImage",
        "webview" => "AXWebArea",
        _ if events_have_press_action(&element.events) => "AXButton",
        _ if matches!(
            element.style.overflow.as_deref(),
            Some("scroll") | Some("auto")
        ) =>
        {
            "AXScrollArea"
        }
        _ => "AXGroup",
    }
    .to_string()
}

fn ax_is_element(element: &ReactElement) -> bool {
    if element.accessibility.accessible == Some(false) {
        return false;
    }
    if element.element_type == "svg"
        && element.accessibility.accessible != Some(true)
        && element.accessibility.label.is_none()
        && element.accessibility.role.is_none()
    {
        return false;
    }
    true
}

fn ax_label(element: &ReactElement) -> Option<String> {
    if let Some(label) = element.accessibility.label.as_ref() {
        if !label.is_empty() {
            return Some(label.clone());
        }
    }

    match element.element_type.as_str() {
        "text" => element.text.clone().filter(|text| !text.is_empty()),
        "textinput" | "textarea" => element.text.clone().filter(|text| !text.is_empty()),
        "image" => element.text.clone().filter(|text| !text.is_empty()),
        _ if element.accessibility.accessible == Some(true)
            || element.accessibility.role.is_some()
            || element.listens("press")
            || element.listens("click") =>
        {
            let text = subtree_text(element);
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn ax_value(element: &ReactElement) -> Option<String> {
    let value = element
        .accessibility
        .value
        .clone()
        .or_else(|| element.value.clone())?;
    if element.secure_text_entry
        && (element.element_type == "textinput" || element.element_type == "textarea")
    {
        Some("*".repeat(value.chars().count()))
    } else {
        Some(value)
    }
}

fn subtree_text(element: &ReactElement) -> String {
    let mut out = String::new();
    if element.element_type == "text"
        && let Some(text) = element.text.as_ref()
    {
        out.push_str(text);
    }
    for child in &element.children {
        let child_text = subtree_text(child);
        if child_text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&child_text);
    }
    out.trim().to_string()
}

fn content_view(window: &mut Window) -> Option<id> {
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(handle) => Some(handle.ns_view.as_ptr() as id),
        _ => None,
    }
}

unsafe fn clear_state(state: &mut AxState) {
    for (_, node) in state.nodes.drain() {
        release_view(node.view as id);
    }
    state.content_view = 0;
}

unsafe fn create_view(node_id: u64) -> id {
    let class = ax_view_class();
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    let view: id = msg_send![class, alloc];
    let view: id = msg_send![view, initWithFrame: frame];
    (*view).set_ivar(NODE_ID_IVAR, node_id);
    let _: () = msg_send![view, setAccessibilityElement: YES];
    let _: () = msg_send![view, setHidden: NO];
    view
}

unsafe fn release_view(view: id) {
    let _: () = msg_send![view, removeFromSuperview];
    let _: () = msg_send![view, release];
}

unsafe fn attach_to_parent(view: id, parent: id) {
    let superview: id = msg_send![view, superview];
    if superview != parent {
        if superview != nil {
            let _: () = msg_send![view, removeFromSuperview];
        }
        let _: () = msg_send![parent, addSubview: view];
    }
}

unsafe fn set_accessibility_children(view: id, children: &[id]) {
    let array: id = msg_send![class!(NSMutableArray), arrayWithCapacity: children.len()];
    for child in children {
        let _: () = msg_send![array, addObject: *child];
    }
    let _: () = msg_send![view, setAccessibilityChildren: array];
}

unsafe fn post_layout_changed(element: id) {
    let notification = ns_string("AXLayoutChanged");
    NSAccessibilityPostNotification(element, notification);
}

unsafe fn node_id(this: &Object) -> u64 {
    *this.get_ivar::<u64>(NODE_ID_IVAR)
}

fn with_node<T>(this: &Object, f: impl FnOnce(&AxNode) -> T, default: T) -> T {
    let id = unsafe { node_id(this) };
    let state = state().lock().unwrap();
    state.nodes.get(&id).map(f).unwrap_or(default)
}

fn is_text_node(node: &AxNode) -> bool {
    node.role == "AXTextField" || node.role == "AXTextArea" || node.role == "AXSearchField"
}

unsafe fn ns_string_to_string(value: id) -> Option<String> {
    if value == nil {
        return None;
    }
    let ptr: *const c_char = msg_send![value, UTF8String];
    if ptr.is_null() {
        return None;
    }
    Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
}

fn set_text_node_value(this: &Object, text: String, insert_at_cursor: bool) {
    let id = unsafe { node_id(this) };
    let next = {
        let mut state = state().lock().unwrap();
        let Some(node) = state.nodes.get_mut(&id) else {
            return;
        };
        if !is_text_node(node) || node.disabled {
            return;
        }
        let next = if insert_at_cursor {
            let mut current = node.value.clone().unwrap_or_default();
            current.push_str(&text);
            current
        } else {
            text
        };
        node.value = Some(next.clone());
        next
    };
    crate::bridge::change_text(id, &next);
}

extern "C" fn hit_test(_: &Object, _: Sel, _: NSPoint) -> id {
    nil
}

extern "C" fn accepts_first_responder(_: &Object, _: Sel) -> BOOL {
    NO
}

extern "C" fn is_accessibility_element(this: &Object, _: Sel) -> BOOL {
    if with_node(this, |node| node.is_element, false) {
        YES
    } else {
        NO
    }
}

extern "C" fn accessibility_role(this: &Object, _: Sel) -> id {
    let role = with_node(this, |node| node.role.clone(), "AXGroup".to_string());
    unsafe { ns_string(&role) }
}

extern "C" fn accessibility_label(this: &Object, _: Sel) -> id {
    let label = with_node(this, |node| node.label.clone(), None);
    match label {
        Some(label) => unsafe { ns_string(&label) },
        None => nil,
    }
}

extern "C" fn accessibility_title(this: &Object, _: Sel) -> id {
    accessibility_label(this, sel!(accessibilityLabel))
}

extern "C" fn accessibility_help(this: &Object, _: Sel) -> id {
    let hint = with_node(this, |node| node.hint.clone(), None);
    match hint {
        Some(hint) => unsafe { ns_string(&hint) },
        None => nil,
    }
}

extern "C" fn accessibility_value(this: &Object, _: Sel) -> id {
    let value = with_node(this, |node| node.value.clone(), None);
    match value {
        Some(value) => unsafe { ns_string(&value) },
        None => nil,
    }
}

extern "C" fn accessibility_identifier(this: &Object, _: Sel) -> id {
    let identifier = with_node(this, |node| node.identifier.clone(), String::new());
    unsafe { ns_string(&identifier) }
}

extern "C" fn accessibility_enabled(this: &Object, _: Sel) -> BOOL {
    if with_node(this, |node| !node.disabled, true) {
        YES
    } else {
        NO
    }
}

extern "C" fn accessibility_selected(this: &Object, _: Sel) -> BOOL {
    if with_node(this, |node| node.selected, false) {
        YES
    } else {
        NO
    }
}

extern "C" fn accessibility_expanded(this: &Object, _: Sel) -> BOOL {
    if with_node(this, |node| node.expanded.unwrap_or(false), false) {
        YES
    } else {
        NO
    }
}

extern "C" fn accessibility_children(this: &Object, _: Sel) -> id {
    let id = unsafe { node_id(this) };
    let state = state().lock().unwrap();
    let Some(node) = state.nodes.get(&id) else {
        return nil;
    };

    unsafe {
        let array: id = msg_send![class!(NSMutableArray), arrayWithCapacity: node.children.len()];
        for child_id in &node.children {
            if let Some(child) = state.nodes.get(child_id) {
                let child_view = child.view as id;
                let _: () = msg_send![array, addObject: child_view];
            }
        }
        array
    }
}

extern "C" fn accessibility_parent(this: &Object, _: Sel) -> id {
    let id = unsafe { node_id(this) };
    let state = state().lock().unwrap();
    let Some(node) = state.nodes.get(&id) else {
        return nil;
    };
    if let Some(parent_id) = node.parent_id
        && let Some(parent) = state.nodes.get(&parent_id)
    {
        return parent.view as id;
    }
    let view = node.view as id;
    unsafe { msg_send![view, superview] }
}

fn dispatch_press_action(this: &Object) -> bool {
    let (id, events, is_text_node, disabled) = {
        let id = unsafe { node_id(this) };
        let state = state().lock().unwrap();
        let node = state.nodes.get(&id);
        let events = node.map(|node| node.events.clone()).unwrap_or_default();
        let is_text_node = node.map(is_text_node).unwrap_or(false);
        let disabled = node.map(|node| node.disabled).unwrap_or(false);
        (id, events, is_text_node, disabled)
    };

    if disabled {
        return false;
    }
    if events_have_press_action(&events) {
        dispatch_press_sequence(id, &events);
        true
    } else if is_text_node {
        crate::bridge::event(id, "focus");
        true
    } else {
        false
    }
}

fn events_have_press_action(events: &[String]) -> bool {
    events.iter().any(|event| {
        matches!(
            event.as_str(),
            "press" | "click" | "responderRelease" | "touchEnd" | "mouseUp" | "pointerUp"
        )
    })
}

fn dispatch_press_sequence(id: u64, events: &[String]) {
    for name in [
        "mouseDown",
        "pointerDown",
        "touchStart",
        "startShouldSetResponderCapture",
        "startShouldSetResponder",
        "responderStart",
        "responderGrant",
        "pressIn",
        "mouseUp",
        "pointerUp",
        "touchEnd",
        "responderRelease",
        "responderEnd",
        "pressOut",
        "press",
        "click",
    ] {
        if events.iter().any(|event| event == name) {
            crate::bridge::event(id, name);
        }
    }
}

extern "C" fn accessibility_action_names(this: &Object, _: Sel) -> id {
    let events = with_node(this, |node| node.events.clone(), Vec::new());
    unsafe {
        let array: id = msg_send![class!(NSMutableArray), array];
        let is_text = with_node(this, is_text_node, false);
        let enabled = with_node(this, |node| !node.disabled, false);
        if enabled && (events_have_press_action(&events) || is_text) {
            let press = ns_string("AXPress");
            let _: () = msg_send![array, addObject: press];
        }
        array
    }
}

extern "C" fn accessibility_action_description(_: &Object, _: Sel, action: id) -> id {
    action
}

extern "C" fn accessibility_perform_action(this: &Object, _: Sel, action: id) {
    unsafe {
        let press = ns_string("AXPress");
        let is_press: BOOL = msg_send![action, isEqualToString: press];
        if is_press == YES {
            dispatch_press_action(this);
        }
    }
}

extern "C" fn accessibility_checked(this: &Object, _: Sel) -> id {
    let checked = with_node(this, |node| node.checked.clone(), None);
    match checked {
        Some(checked) => unsafe { ns_string(&checked) },
        None => nil,
    }
}

extern "C" fn accessibility_selected_text(_: &Object, _: Sel) -> id {
    unsafe { ns_string("") }
}

extern "C" fn set_accessibility_selected_text(this: &Object, _: Sel, value: id) {
    let text = unsafe { ns_string_to_string(value) }.unwrap_or_default();
    set_text_node_value(this, text, true);
}

extern "C" fn set_accessibility_value(this: &Object, _: Sel, value: id) {
    let text = unsafe { ns_string_to_string(value) }.unwrap_or_default();
    set_text_node_value(this, text, false);
}

extern "C" fn accessibility_focused(this: &Object, _: Sel) -> BOOL {
    if with_node(this, is_text_node, false) {
        YES
    } else {
        NO
    }
}

extern "C" fn set_accessibility_focused(this: &Object, _: Sel, focused: BOOL) {
    if focused == YES {
        let id = unsafe { node_id(this) };
        let can_focus = with_node(this, |node| is_text_node(node) && !node.disabled, false);
        if can_focus {
            crate::bridge::event(id, "focus");
        }
    }
}

extern "C" fn accessibility_is_attribute_settable(this: &Object, _: Sel, attribute: id) -> BOOL {
    let attr = unsafe { ns_string_to_string(attribute) }.unwrap_or_default();
    let settable = with_node(
        this,
        |node| {
            is_text_node(node)
                && !node.disabled
                && matches!(attr.as_str(), "AXValue" | "AXSelectedText" | "AXFocused")
        },
        false,
    );
    if settable { YES } else { NO }
}

extern "C" fn accessibility_set_value_for_attribute(
    this: &Object,
    _: Sel,
    value: id,
    attribute: id,
) {
    let attr = unsafe { ns_string_to_string(attribute) }.unwrap_or_default();
    match attr.as_str() {
        "AXValue" => set_accessibility_value(this, sel!(setAccessibilityValue:), value),
        "AXSelectedText" => {
            set_accessibility_selected_text(this, sel!(setAccessibilitySelectedText:), value)
        }
        "AXFocused" => {
            let focused: BOOL = unsafe { msg_send![value, boolValue] };
            set_accessibility_focused(this, sel!(setAccessibilityFocused:), focused);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{ax_is_element, ax_label, ax_role, events_have_press_action};
    use crate::elements::{AccessibilityInfo, ReactElement};
    use crate::style::ElementStyle;

    fn events(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    fn element(
        element_type: &str,
        text: Option<&str>,
        accessibility: AccessibilityInfo,
    ) -> ReactElement {
        ReactElement {
            global_id: 1,
            element_type: element_type.to_string(),
            text: text.map(String::from),
            number_of_lines: None,
            selectable: false,
            runs: Vec::new(),
            src: None,
            system_material: None,
            system_glass_variant: None,
            system_tint: None,
            system_shadow: None,
            system_edge_fade: None,
            system_top_fade_start: None,
            backdrop_blur_radius: None,
            backdrop_tint: None,
            value: None,
            secure_text_entry: false,
            editable: true,
            events: Vec::new(),
            native_layout_key: None,
            native_resize: None,
            native_list_group: None,
            terminal_session_id: None,
            terminal_frames: Vec::new(),
            accessibility,
            children: Vec::new(),
            style: ElementStyle::default(),
            style_json: None,
            cached_gpui_style: None,
            interactive: false,
            pseudo_events: false,
        }
    }

    #[test]
    fn exposes_press_for_native_and_responder_events() {
        assert!(events_have_press_action(&events(&["press"])));
        assert!(events_have_press_action(&events(&["click"])));
        assert!(events_have_press_action(&events(&["responderRelease"])));
        assert!(events_have_press_action(&events(&["touchEnd"])));
        assert!(events_have_press_action(&events(&["mouseUp"])));
        assert!(events_have_press_action(&events(&["pointerUp"])));
    }

    #[test]
    fn ignores_non_activation_events() {
        assert!(!events_have_press_action(&events(&["mouseEnter"])));
        assert!(!events_have_press_action(&events(&["pressIn", "pressOut"])));
        assert!(!events_have_press_action(&events(&["responderGrant"])));
    }

    #[test]
    fn responder_release_controls_map_to_ax_buttons() {
        let mut item = element("div", None, AccessibilityInfo::default());
        item.events = events(&["responderGrant", "responderRelease"]);

        assert_eq!(ax_role(&item), "AXButton");
    }

    #[test]
    fn pressable_options_map_to_ax_buttons() {
        let mut item = element(
            "div",
            None,
            AccessibilityInfo {
                role: Some("option".to_string()),
                ..AccessibilityInfo::default()
            },
        );
        item.events = events(&["responderGrant", "responderRelease"]);

        assert_eq!(ax_role(&item), "AXButton");
    }

    #[test]
    fn unlabeled_svg_is_decorative_for_accessibility() {
        let svg = element(
            "svg",
            Some("<svg><path /></svg>"),
            AccessibilityInfo::default(),
        );

        assert!(!ax_is_element(&svg));
        assert_eq!(ax_label(&svg), None);
    }

    #[test]
    fn labeled_svg_can_be_exposed_for_accessibility() {
        let svg = element(
            "svg",
            Some("<svg><path /></svg>"),
            AccessibilityInfo {
                label: Some("Search".to_string()),
                ..AccessibilityInfo::default()
            },
        );

        assert!(ax_is_element(&svg));
        assert_eq!(ax_label(&svg), Some("Search".to_string()));
    }
}

unsafe fn ns_string(s: &str) -> id {
    let string = NSString::alloc(nil).init_str(s);
    let _: id = msg_send![string, autorelease];
    string
}

fn ax_view_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| unsafe {
        let superclass = class!(NSView);
        let mut decl = ClassDecl::new("RNGPUIAccessibilityView", superclass)
            .unwrap_or_else(|| panic!("failed to declare RNGPUIAccessibilityView"));
        decl.add_ivar::<u64>(NODE_ID_IVAR);
        decl.add_method(
            sel!(hitTest:),
            hit_test as extern "C" fn(&Object, Sel, NSPoint) -> id,
        );
        decl.add_method(
            sel!(acceptsFirstResponder),
            accepts_first_responder as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(isAccessibilityElement),
            is_accessibility_element as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(accessibilityRole),
            accessibility_role as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityLabel),
            accessibility_label as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityTitle),
            accessibility_title as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityHelp),
            accessibility_help as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityValue),
            accessibility_value as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityIdentifier),
            accessibility_identifier as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityEnabled),
            accessibility_enabled as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(accessibilitySelected),
            accessibility_selected as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(accessibilityExpanded),
            accessibility_expanded as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(accessibilityChildren),
            accessibility_children as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityParent),
            accessibility_parent as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityActionNames),
            accessibility_action_names as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilityActionDescription:),
            accessibility_action_description as extern "C" fn(&Object, Sel, id) -> id,
        );
        decl.add_method(
            sel!(accessibilityPerformAction:),
            accessibility_perform_action as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(accessibilityChecked),
            accessibility_checked as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(accessibilitySelectedText),
            accessibility_selected_text as extern "C" fn(&Object, Sel) -> id,
        );
        decl.add_method(
            sel!(setAccessibilitySelectedText:),
            set_accessibility_selected_text as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(setAccessibilityValue:),
            set_accessibility_value as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(accessibilityFocused),
            accessibility_focused as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(setAccessibilityFocused:),
            set_accessibility_focused as extern "C" fn(&Object, Sel, BOOL),
        );
        decl.add_method(
            sel!(accessibilityIsAttributeSettable:),
            accessibility_is_attribute_settable as extern "C" fn(&Object, Sel, id) -> BOOL,
        );
        decl.add_method(
            sel!(accessibilitySetValue:forAttribute:),
            accessibility_set_value_for_attribute as extern "C" fn(&Object, Sel, id, id),
        );
        decl.register()
    })
}

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSAccessibilityPostNotification(element: id, notification: id);
}
