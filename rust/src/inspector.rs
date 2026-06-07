use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui::{
    AnyElement, App, ClipboardItem, IntoElement, Modifiers, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Position, Styled, div, point, px,
};
use once_cell::sync::Lazy;

use crate::bridge;
use crate::elements::ReactElement;

pub const WEBVIEW_INSPECTOR_SCRIPT: &str = r#"
(() => {
  if (window.__rngpuiInspectorInstalled) return;
  window.__rngpuiInspectorInstalled = true;

  const message = '{"__rngpuiInspector":true,"event":"copy"}';
  const holdMs = 500;
  let active = false;
  let altDown = false;
  let timer = 0;
  let token = 0;
  let overlay;

  const getOverlay = () => {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:none",
      "box-sizing:border-box",
      "border:2px solid #0a84ff",
      "background:rgba(10,132,255,0.10)",
      "display:none"
    ].join(";");
    document.documentElement.appendChild(overlay);
    return overlay;
  };

  const show = (active) => {
    getOverlay().style.display = active ? "block" : "none";
  };

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
  };

  const deactivate = () => {
    token += 1;
    altDown = false;
    active = false;
    clearTimer();
    show(false);
  };

  const arm = () => {
    if (active || timer) return;
    const current = ++token;
    timer = setTimeout(() => {
      timer = 0;
      if (!altDown || token !== current) return;
      active = true;
      show(true);
    }, holdMs);
  };

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Alt") return;
    altDown = true;
    arm();
  }, true);
  document.addEventListener("mousemove", (event) => {
    if (!event.altKey) {
      deactivate();
      return;
    }
    altDown = true;
    if (active) show(true);
    else arm();
  }, true);
  document.addEventListener("mouseleave", () => deactivate(), true);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Alt") deactivate();
  }, true);
  window.addEventListener("blur", () => deactivate(), true);
  document.addEventListener("mousedown", (event) => {
    if (!active || !event.altKey || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show(true);
    window.ipc.postMessage(message);
  }, true);
})();
"#;

const WEBVIEW_INSPECTOR_FLAG: &str = "__rngpuiInspector";
pub const INSPECTOR_ACTIVATION_HOLD: Duration = Duration::from_millis(500);

static SNAPSHOT_METADATA: Lazy<Mutex<HashMap<u64, SnapshotMetadata>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SNAPSHOT_CACHE: Lazy<Mutex<HashMap<u64, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

impl Rect {
    fn contains(self, position: Point<Pixels>) -> bool {
        let x: f32 = position.x.into();
        let y: f32 = position.y.into();
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }

    fn is_visible(self) -> bool {
        self.width > 0.5 && self.height > 0.5
    }

    fn area(self) -> f32 {
        self.width * self.height
    }
}

impl From<(f32, f32, f32, f32)> for Rect {
    fn from(value: (f32, f32, f32, f32)) -> Self {
        Self {
            x: value.0,
            y: value.1,
            width: value.2,
            height: value.3,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct NodeSummary {
    id: u64,
    element_type: String,
    role: Option<String>,
    label: Option<String>,
    identifier: Option<String>,
    identifier_source: Option<String>,
    native_id: Option<String>,
    test_id: Option<String>,
    prop_id: Option<String>,
    text: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct InspectorHit {
    target: NodeSummary,
    bounds: Rect,
    events: Vec<String>,
    value: Option<String>,
    style: Vec<String>,
    path: Vec<NodeSummary>,
    rank: u8,
    depth: usize,
    order: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct SnapshotMetadata {
    target: NodeSummary,
    events: Vec<String>,
    value: Option<String>,
    style: Vec<String>,
    path: Vec<NodeSummary>,
    rank: u8,
    depth: usize,
}

#[derive(Clone, Debug)]
pub struct InspectorState {
    enabled: bool,
    active: bool,
    alt_down: bool,
    hold_token: u64,
    last_position: Option<Point<Pixels>>,
    suppress_mouse_up: bool,
    hover: Option<InspectorHit>,
    copied_id: Option<u64>,
}

impl InspectorState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            active: false,
            alt_down: false,
            hold_token: 0,
            last_position: None,
            suppress_mouse_up: false,
            hover: None,
            copied_id: None,
        }
    }

    pub fn from_env() -> Self {
        Self::new(env_enabled("RNGPUI_INSPECTOR"))
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn handle_modifiers(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        modifiers: Modifiers,
    ) -> (bool, Option<u64>) {
        if !self.enabled {
            return (false, None);
        }
        self.update_alt_state(root, position, modifiers.alt)
    }

    pub fn handle_mouse_move(
        &mut self,
        root: &Arc<ReactElement>,
        event: &MouseMoveEvent,
    ) -> (bool, Option<u64>) {
        if !self.enabled {
            return (false, None);
        }
        self.update_alt_state(root, event.position, event.modifiers.alt)
    }

    pub fn handle_mouse_down(
        &mut self,
        root: &Arc<ReactElement>,
        event: &MouseDownEvent,
        cx: &mut App,
    ) -> bool {
        if !self.enabled || event.button != MouseButton::Left || !event.modifiers.alt {
            return false;
        }
        if !self.active {
            return false;
        }
        self.suppress_mouse_up = true;
        self.copy_active_at(root, event.position, cx);
        true
    }

    pub fn copy_at(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        cx: &mut App,
    ) -> bool {
        if !self.enabled {
            return false;
        }
        let previous_target = self.hover.as_ref().map(hit_key);
        self.last_position = Some(position);
        self.hover = hit_test(root, position);
        if let Some(hit) = self.hover.as_ref() {
            cx.write_to_clipboard(ClipboardItem::new_string(snapshot(hit)));
            self.copied_id = Some(hit.target.id);
        }
        previous_target != self.hover.as_ref().map(hit_key) || self.hover.is_some()
    }

    pub fn handle_mouse_up(&mut self, event: &MouseUpEvent) -> bool {
        if !self.enabled {
            self.suppress_mouse_up = false;
            return false;
        }
        let suppress = self.suppress_mouse_up || (self.active && event.modifiers.alt);
        self.suppress_mouse_up = false;
        suppress
    }

    pub fn activate_after_hold(
        &mut self,
        root: &Arc<ReactElement>,
        token: u64,
        alt_still_down: bool,
    ) -> bool {
        if !alt_still_down {
            return self.deactivate();
        }
        if !self.enabled || !self.alt_down || self.hold_token != token {
            return false;
        }
        let Some(position) = self.last_position else {
            return false;
        };
        self.set_hover(root, position, true)
    }

    pub fn deactivate(&mut self) -> bool {
        let previous_active = self.active;
        let previous_target = self.hover.as_ref().map(hit_key);
        let had_hold = self.alt_down;
        self.active = false;
        self.alt_down = false;
        self.hover = None;
        self.copied_id = None;
        self.last_position = None;
        if had_hold || previous_active {
            self.hold_token = self.hold_token.wrapping_add(1);
        }
        previous_active || previous_target.is_some()
    }

    pub fn overlay(&self) -> Option<AnyElement> {
        if !self.enabled || !self.active {
            return None;
        }
        let hit = self.hover.as_ref()?;
        let accent = crate::style::u32_to_hsla(0x0a84ff);
        let white = crate::style::u32_to_hsla(0xffffff);
        let mut label = div()
            .bg(accent)
            .text_color(white)
            .text_size(px(11.0))
            .child(overlay_label(hit, self.copied_id == Some(hit.target.id)));
        {
            let style = label.style();
            style.position = Some(Position::Absolute);
            style.inset.top = Some(px(0.0).into());
            style.inset.left = Some(px(0.0).into());
            style.padding.top = Some(px(3.0).into());
            style.padding.right = Some(px(6.0).into());
            style.padding.bottom = Some(px(3.0).into());
            style.padding.left = Some(px(6.0).into());
        }

        let mut outline = div()
            .border_2()
            .border_color(accent)
            .bg(accent.opacity(0.10))
            .child(label);
        {
            let style = outline.style();
            style.position = Some(Position::Absolute);
            style.inset.left = Some(px(hit.bounds.x).into());
            style.inset.top = Some(px(hit.bounds.y).into());
            style.size.width = Some(px(hit.bounds.width).into());
            style.size.height = Some(px(hit.bounds.height).into());
        }
        Some(outline.into_any_element())
    }

    fn set_hover(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        active: bool,
    ) -> bool {
        let previous_active = self.active;
        let previous_target = self.hover.as_ref().map(hit_key);
        self.active = active;
        if active {
            self.hover = hit_test(root, position);
        } else {
            self.hover = None;
            self.copied_id = None;
        }
        previous_active != self.active || previous_target != self.hover.as_ref().map(hit_key)
    }

    fn update_alt_state(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        alt: bool,
    ) -> (bool, Option<u64>) {
        if !alt {
            return (self.deactivate(), None);
        }
        self.last_position = Some(position);
        let activation_token = if self.alt_down {
            None
        } else {
            self.alt_down = true;
            self.hold_token = self.hold_token.wrapping_add(1);
            Some(self.hold_token)
        };
        let changed = if self.active {
            self.set_hover(root, position, true)
        } else {
            false
        };
        (changed, activation_token)
    }

    fn copy_active_at(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        cx: &mut App,
    ) -> bool {
        let changed = self.set_hover(root, position, true);
        if let Some(hit) = self.hover.as_ref() {
            cx.write_to_clipboard(ClipboardItem::new_string(snapshot(hit)));
            self.copied_id = Some(hit.target.id);
        }
        changed || self.hover.is_some()
    }
}

#[cfg(target_os = "macos")]
pub fn current_option_modifier_down() -> bool {
    use cocoa::appkit::NSEventModifierFlags;
    use cocoa::foundation::NSUInteger;
    use objc::{class, msg_send, sel, sel_impl};

    // AppKit's class-level "what modifiers are held right now" is `+[NSEvent
    // modifierFlags]`. There is no `currentModifierFlags` selector — sending it
    // throws NSInvalidArgumentException and crashes the app the first time the
    // inspector activation timer fires.
    unsafe {
        let flags: NSUInteger = msg_send![class!(NSEvent), modifierFlags];
        flags & NSEventModifierFlags::NSAlternateKeyMask.bits() != 0
    }
}

#[cfg(not(target_os = "macos"))]
pub fn current_option_modifier_down() -> bool {
    true
}

pub fn refresh_snapshot_cache(root: &Arc<ReactElement>) {
    let mut path = Vec::new();
    let mut metadata = HashMap::new();
    let mut snapshots = HashMap::new();
    collect_snapshots(root, &mut path, &mut metadata, &mut snapshots);
    *SNAPSHOT_METADATA.lock().unwrap() = metadata;
    *SNAPSHOT_CACHE.lock().unwrap() = snapshots;
}

pub fn refresh_layout_snapshot(id: u64, x: f32, y: f32, width: f32, height: f32) {
    let bounds = Rect {
        x,
        y,
        width,
        height,
    };
    if !bounds.is_visible() {
        return;
    }
    let Some(metadata) = SNAPSHOT_METADATA.lock().unwrap().get(&id).cloned() else {
        return;
    };
    SNAPSHOT_CACHE
        .lock()
        .unwrap()
        .insert(id, snapshot(&metadata.into_hit(bounds)));
}

pub fn handle_webview_ipc(id: u64, body: &str) -> bool {
    if !is_webview_inspector_message(body) {
        return false;
    }
    let Some(snapshot) = cached_snapshot(id) else {
        return true;
    };
    write_system_clipboard(&snapshot);
    true
}

fn cached_snapshot(id: u64) -> Option<String> {
    SNAPSHOT_CACHE.lock().unwrap().get(&id).cloned()
}

fn is_webview_inspector_message(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value
        .get(WEBVIEW_INSPECTOR_FLAG)
        .and_then(|value| value.as_bool())
        == Some(true)
        && value.get("event").and_then(|value| value.as_str()) == Some("copy")
}

impl SnapshotMetadata {
    fn into_hit(self, bounds: Rect) -> InspectorHit {
        InspectorHit {
            target: self.target,
            bounds,
            events: self.events,
            value: self.value,
            style: self.style,
            path: self.path,
            rank: self.rank,
            depth: self.depth,
            order: 0,
        }
    }
}

fn collect_snapshots(
    element: &Arc<ReactElement>,
    path: &mut Vec<NodeSummary>,
    metadata: &mut HashMap<u64, SnapshotMetadata>,
    snapshots: &mut HashMap<u64, String>,
) {
    if element.style.is_display_none() {
        return;
    }
    path.push(summary(element));
    let snapshot_metadata = SnapshotMetadata {
        target: summary(element),
        events: element.events.clone(),
        value: snippet(element.value.as_deref(), 120),
        style: style_facts(element),
        path: path.clone(),
        rank: inspect_rank(element),
        depth: path.len(),
    };
    if let Some(bounds) = bridge::cached_layout(element.global_id).map(Rect::from) {
        if bounds.is_visible() {
            let hit = snapshot_metadata.clone().into_hit(bounds);
            snapshots.insert(element.global_id, snapshot(&hit));
        }
    }
    metadata.insert(element.global_id, snapshot_metadata);
    for child in element.children.iter() {
        collect_snapshots(child, path, metadata, snapshots);
    }
    path.pop();
}

#[cfg(target_os = "macos")]
fn write_system_clipboard(text: &str) -> bool {
    use cocoa::appkit::{NSPasteboard, NSPasteboardTypeString};
    use cocoa::base::{YES, nil};
    use cocoa::foundation::NSString;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let pasteboard = NSPasteboard::generalPasteboard(nil);
        let _ = pasteboard.clearContents();
        let string = NSString::alloc(nil).init_str(text);
        let ok = pasteboard.setString_forType(string, NSPasteboardTypeString);
        let _: () = msg_send![string, release];
        ok == YES
    }
}

#[cfg(not(target_os = "macos"))]
fn write_system_clipboard(_text: &str) -> bool {
    false
}

fn env_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            !matches!(value.as_str(), "" | "0" | "false" | "off" | "no")
        })
        .unwrap_or(false)
}

fn hit_key(hit: &InspectorHit) -> (u64, Rect) {
    (hit.target.id, hit.bounds)
}

fn hit_test(root: &Arc<ReactElement>, position: Point<Pixels>) -> Option<InspectorHit> {
    let mut path = Vec::new();
    let mut hits = Vec::new();
    collect_hits(root, position, &mut path, &mut hits);
    hits.into_iter().max_by(compare_hits)
}

/// The innermost scroll container (overflow: scroll/auto) whose painted bounds contain
/// the point — the `rngpui do scroll` target. Returns its globalId.
pub fn scroll_container_at(root: &Arc<ReactElement>, x: f32, y: f32) -> Option<u64> {
    let position = point(px(x), px(y));
    fn walk(el: &Arc<ReactElement>, position: Point<Pixels>, found: &mut Option<u64>) {
        if el.style.is_display_none() {
            return;
        }
        let Some(bounds) = bridge::cached_layout(el.global_id).map(Rect::from) else {
            return;
        };
        if !bounds.is_visible() || !bounds.contains(position) {
            return;
        }
        if matches!(el.style.overflow.as_deref(), Some("scroll" | "auto")) {
            *found = Some(el.global_id);
        }
        for child in el.children.iter() {
            walk(child, position, found);
        }
    }
    let mut found = None;
    walk(root, position, &mut found);
    found
}

/// The topmost node at a point that listens for a press/click gesture, plus its
/// events and bounds — used to synthesize a `do tap`. Walks up the hit path so a tap
/// on a label inside a Pressable still finds the Pressable's handlers.
pub fn tap_target_at(
    root: &Arc<ReactElement>,
    x: f32,
    y: f32,
) -> Option<(u64, Vec<String>, (f32, f32, f32, f32))> {
    let position = point(px(x), px(y));
    let hit = hit_test(root, position)?;
    // the hit itself is the deepest interactive node when one exists (rank 100), but a
    // text leaf can win when nothing interactive is under the point; in that case walk
    // the captured path outward to the nearest press-handling ancestor.
    const PRESS: &[&str] = &[
        "press", "click", "pressIn", "pressOut", "longPress", "mouseDown", "pointerDown",
        "touchStart",
    ];
    let listens_press = |events: &[String]| events.iter().any(|e| PRESS.contains(&e.as_str()));
    if listens_press(&hit.events) {
        return Some((
            hit.target.id,
            hit.events,
            (
                hit.bounds.x,
                hit.bounds.y,
                hit.bounds.width,
                hit.bounds.height,
            ),
        ));
    }
    // no press handler directly under the point — fall back to the topmost node so the
    // caller can still report what is there (a tap on a non-interactive node is a no-op
    // event-wise, which the CLI surfaces).
    Some((
        hit.target.id,
        hit.events,
        (
            hit.bounds.x,
            hit.bounds.y,
            hit.bounds.width,
            hit.bounds.height,
        ),
    ))
}

fn collect_hits(
    element: &Arc<ReactElement>,
    position: Point<Pixels>,
    path: &mut Vec<NodeSummary>,
    hits: &mut Vec<InspectorHit>,
) {
    if element.style.is_display_none() {
        return;
    }
    let Some(bounds) = bridge::cached_layout(element.global_id).map(Rect::from) else {
        return;
    };
    if !bounds.is_visible() {
        return;
    }
    let contains = bounds.contains(position);
    let clips_children = matches!(
        element.style.overflow.as_deref(),
        Some("hidden" | "scroll" | "auto")
    );
    let children_allow = !clips_children || contains;

    path.push(summary(element));
    if children_allow {
        for child in element.children.iter().rev() {
            collect_hits(child, position, path, hits);
        }
    }

    if contains {
        hits.push(InspectorHit {
            target: summary(element),
            bounds,
            events: element.events.clone(),
            value: snippet(element.value.as_deref(), 120),
            style: style_facts(element),
            path: path.clone(),
            rank: inspect_rank(element),
            depth: path.len(),
            order: hits.len(),
        });
    }
    path.pop();
}

fn compare_hits(a: &InspectorHit, b: &InspectorHit) -> std::cmp::Ordering {
    a.rank
        .cmp(&b.rank)
        .then_with(|| a.depth.cmp(&b.depth))
        .then_with(|| {
            b.bounds
                .area()
                .partial_cmp(&a.bounds.area())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| b.order.cmp(&a.order))
}

fn inspect_rank(element: &ReactElement) -> u8 {
    if !element.events.is_empty() || element.native_resize.is_some() {
        return 100;
    }
    match element.element_type.as_str() {
        "textinput" | "textarea" | "webview" => return 90,
        _ => {}
    }
    if element.accessibility.role.is_some() {
        return 80;
    }
    if element.accessibility.identifier.is_some() {
        return 70;
    }
    if element.accessibility.test_id.is_some()
        || element.accessibility.native_id.is_some()
        || element.accessibility.prop_id.is_some()
    {
        return 70;
    }
    if element.native_layout_key.is_some() {
        return 60;
    }
    if element.accessibility.label.is_some() {
        return 40;
    }
    if element
        .text
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty())
    {
        return 30;
    }
    10
}

fn summary(element: &ReactElement) -> NodeSummary {
    NodeSummary {
        id: element.global_id,
        element_type: element.element_type.clone(),
        role: element.accessibility.role.clone(),
        label: element.accessibility.label.clone(),
        identifier: element.accessibility.identifier.clone(),
        identifier_source: element.accessibility.identifier_source.clone(),
        native_id: element.accessibility.native_id.clone(),
        test_id: element.accessibility.test_id.clone(),
        prop_id: element.accessibility.prop_id.clone(),
        text: snippet(element.text.as_deref(), 80),
    }
}

fn style_facts(element: &ReactElement) -> Vec<String> {
    let mut facts = Vec::new();
    if let Some(position) = element.style.position.as_ref() {
        facts.push(format!("position={position}"));
    }
    if let Some(display) = element.style.display.as_ref() {
        facts.push(format!("display={display}"));
    }
    if let Some(direction) = element.style.flex_direction.as_ref() {
        facts.push(format!("flexDirection={direction}"));
    }
    if let Some(overflow) = element.style.overflow.as_ref() {
        facts.push(format!("overflow={overflow}"));
    }
    if element.style.background_color.is_some() {
        facts.push("backgroundColor".to_string());
    }
    if element.style.border_width.is_some()
        || element.style.border_top_width.is_some()
        || element.style.border_right_width.is_some()
        || element.style.border_bottom_width.is_some()
        || element.style.border_left_width.is_some()
    {
        facts.push("border".to_string());
    }
    if element.style.cursor.is_some() {
        facts.push(format!(
            "cursor={}",
            element.style.cursor.as_deref().unwrap_or_default()
        ));
    }
    if let Some(key) = element.native_layout_key.as_ref() {
        facts.push(format!("nativeLayoutKey={key}"));
    }
    if element.native_resize.is_some() {
        facts.push("nativeResize".to_string());
    }
    facts
}

fn overlay_label(hit: &InspectorHit, copied: bool) -> String {
    let mut base = format!("{}#{}", hit.target.element_type, hit.target.id);
    if let Some(test_id) = hit.target.test_id.as_ref() {
        base.push_str(&format!(" testID={test_id}"));
    } else if let Some(native_id) = hit.target.native_id.as_ref() {
        base.push_str(&format!(" nativeID={native_id}"));
    } else if let Some(identifier) = hit.target.identifier.as_ref() {
        base.push_str(&format!(" identifier={identifier}"));
    }
    if let Some(label) = hit.target.label.as_ref().or(hit.target.text.as_ref()) {
        base.push_str(&format!(" {label}"));
    }
    if copied {
        format!("copied {base}")
    } else {
        base
    }
}

fn snapshot(hit: &InspectorHit) -> String {
    let mut lines = Vec::new();
    lines.push("# react-native-gpui inspector snapshot".to_string());
    lines.push(format!("id: {}", hit.target.id));
    lines.push(format!("type: {}", hit.target.element_type));
    lines.push(format!(
        "rect: {:.0},{:.0} {:.0}x{:.0}",
        hit.bounds.x, hit.bounds.y, hit.bounds.width, hit.bounds.height
    ));
    push_optional(&mut lines, "role", hit.target.role.as_deref());
    push_optional(&mut lines, "label", hit.target.label.as_deref());
    push_optional(&mut lines, "identifier", hit.target.identifier.as_deref());
    push_optional(
        &mut lines,
        "identifierSource",
        hit.target.identifier_source.as_deref(),
    );
    push_optional(&mut lines, "testID", hit.target.test_id.as_deref());
    push_optional(&mut lines, "nativeID", hit.target.native_id.as_deref());
    push_optional(&mut lines, "propID", hit.target.prop_id.as_deref());
    push_optional(&mut lines, "text", hit.target.text.as_deref());
    push_optional(&mut lines, "value", hit.value.as_deref());
    if !hit.events.is_empty() {
        lines.push(format!("events: {}", hit.events.join(", ")));
    }
    if !hit.style.is_empty() {
        lines.push(format!("style: {}", hit.style.join(", ")));
    }
    lines.push(format!(
        "path: {}",
        hit.path
            .iter()
            .map(path_label)
            .collect::<Vec<_>>()
            .join(" > ")
    ));
    lines.join("\n")
}

fn push_optional(lines: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        if !value.is_empty() {
            lines.push(format!("{key}: {value}"));
        }
    }
}

fn path_label(node: &NodeSummary) -> String {
    let mut out = format!("{}#{}", node.element_type, node.id);
    if let Some(role) = node.role.as_ref() {
        out.push_str(&format!("[{role}]"));
    }
    if let Some(test_id) = node.test_id.as_ref() {
        out.push_str(&format!("[testID={}]", escape_path_value(test_id)));
    } else if let Some(identifier) = node.identifier.as_ref() {
        out.push_str(&format!("[identifier={}]", escape_path_value(identifier)));
    }
    if let Some(label) = node.label.as_ref().or(node.text.as_ref()) {
        out.push_str(&format!(" \"{}\"", label.replace('"', "\\\"")));
    }
    out
}

fn escape_path_value(value: &str) -> String {
    value.replace(']', "\\]")
}

fn snippet(value: Option<&str>, limit: usize) -> Option<String> {
    let normalized = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    if normalized.chars().count() <= limit {
        Some(normalized)
    } else {
        Some(format!(
            "{}...",
            normalized
                .chars()
                .take(limit.saturating_sub(3))
                .collect::<String>()
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex, MutexGuard};

    use gpui::{Modifiers, point, px};

    use super::{
        InspectorState, cached_snapshot, hit_test, is_webview_inspector_message,
        refresh_layout_snapshot, refresh_snapshot_cache, snapshot,
    };
    use crate::bridge;
    use crate::elements::{AccessibilityInfo, ReactElement};
    use crate::style::ElementStyle;

    static INSPECTOR_TESTS: Mutex<()> = Mutex::new(());

    fn inspector_test_guard() -> MutexGuard<'static, ()> {
        INSPECTOR_TESTS.lock().unwrap()
    }

    fn node(id: u64, element_type: &str, children: Vec<Arc<ReactElement>>) -> Arc<ReactElement> {
        Arc::new(ReactElement {
            global_id: id,
            element_type: element_type.to_string(),
            text: None,
            number_of_lines: None,
            runs: Vec::new(),
            src: None,
            value: None,
            secure_text_entry: false,
            editable: true,
            events: Vec::new(),
            native_layout_key: None,
            native_resize: None,
            native_list_group: None,
            terminal_session_id: None,
            terminal_frames: Vec::new(),
            accessibility: AccessibilityInfo::default(),
            children,
            style: ElementStyle::default(),
            cached_gpui_style: None,
        })
    }

    #[test]
    fn hit_test_prefers_deepest_visible_node() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(1002, "text", Vec::new());
        let root = node(1001, "view", vec![child]);
        bridge::remember_layout(1001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(1002, 20.0, 30.0, 120.0, 40.0);

        let hit = hit_test(&root, point(px(35.0), px(42.0))).expect("expected hit");

        assert_eq!(hit.target.id, 1002);
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn hit_test_prefers_interactive_parent_over_text_label() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let mut label = (*node(3003, "text", Vec::new())).clone();
        label.text = Some("Increment".to_string());
        let label = Arc::new(label);
        let mut button = (*node(3002, "view", vec![label])).clone();
        button.events.push("press".to_string());
        button.accessibility.label = Some("Increment".to_string());
        let root = node(3001, "view", vec![Arc::new(button)]);
        bridge::remember_layout(3001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(3002, 10.0, 10.0, 160.0, 44.0);
        bridge::remember_layout(3003, 20.0, 20.0, 80.0, 20.0);

        let hit = hit_test(&root, point(px(35.0), px(30.0))).expect("expected hit");

        assert_eq!(hit.target.id, 3002);
        assert_eq!(hit.events, vec!["press"]);
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn hit_test_prefers_later_overlapping_sibling() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let lower = node(5002, "view", Vec::new());
        let upper = node(5003, "view", Vec::new());
        let root = node(5001, "view", vec![lower, upper]);
        bridge::remember_layout(5001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(5002, 10.0, 10.0, 160.0, 44.0);
        bridge::remember_layout(5003, 10.0, 10.0, 160.0, 44.0);

        let hit = hit_test(&root, point(px(35.0), px(30.0))).expect("expected hit");

        assert_eq!(hit.target.id, 5003);
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn snapshot_includes_accessibility_events_and_path() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let mut button = (*node(2002, "view", Vec::new())).clone();
        button.events.push("press".to_string());
        button.accessibility.label = Some("Run task".to_string());
        button.accessibility.role = Some("button".to_string());
        button.accessibility.identifier = Some("run-task-button".to_string());
        button.accessibility.identifier_source = Some("testID".to_string());
        button.accessibility.test_id = Some("run-task-button".to_string());
        let button = Arc::new(button);
        let root = node(2001, "view", vec![button]);
        bridge::remember_layout(2001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(2002, 10.0, 10.0, 100.0, 30.0);

        let hit = hit_test(&root, point(px(20.0), px(20.0))).expect("expected hit");
        let copied = snapshot(&hit);

        assert!(copied.contains("id: 2002"));
        assert!(copied.contains("role: button"));
        assert!(copied.contains("identifier: run-task-button"));
        assert!(copied.contains("identifierSource: testID"));
        assert!(copied.contains("testID: run-task-button"));
        assert!(copied.contains("events: press"));
        assert!(
            copied.contains(
                "path: view#2001 > view#2002[button][testID=run-task-button] \"Run task\""
            )
        );
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_waits_for_hold_token_before_activating() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(6002, "view", Vec::new());
        let root = node(6001, "view", vec![child]);
        bridge::remember_layout(6001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(6002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (changed, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");

        assert!(!changed);
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        assert!(!inspector.activate_after_hold(&root, token + 1, true));
        assert!(!inspector.active);

        assert!(inspector.activate_after_hold(&root, token, true));
        assert!(inspector.active);
        assert_eq!(
            inspector.hover.as_ref().map(|hit| hit.target.id),
            Some(6002)
        );
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_blur_invalidates_pending_hold() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(7002, "view", Vec::new());
        let root = node(7001, "view", vec![child]);
        bridge::remember_layout(7001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(7002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (_, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");

        assert!(!inspector.deactivate());
        assert!(!inspector.activate_after_hold(&root, token, true));
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_activation_timer_cannot_show_after_modifier_release() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(8002, "view", Vec::new());
        let root = node(8001, "view", vec![child]);
        bridge::remember_layout(8001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(8002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (_, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");

        assert!(!inspector.activate_after_hold(&root, token, false));
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_release_hides_active_overlay_immediately() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(9002, "view", Vec::new());
        let root = node(9001, "view", vec![child]);
        bridge::remember_layout(9001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(9002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (_, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");
        assert!(inspector.activate_after_hold(&root, token, true));
        assert!(inspector.active);
        assert!(inspector.hover.is_some());

        let (changed, activation_token) =
            inspector.handle_modifiers(&root, point(px(20.0), px(20.0)), Modifiers::default());

        assert!(changed);
        assert!(activation_token.is_none());
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn snapshot_cache_includes_webview_hosts() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let webview = node(4002, "webview", Vec::new());
        let root = node(4001, "view", vec![webview]);
        bridge::remember_layout(4001, 0.0, 0.0, 400.0, 300.0);

        refresh_snapshot_cache(&root);
        assert!(
            cached_snapshot(4002).is_none(),
            "webview snapshot should wait for layout"
        );

        refresh_layout_snapshot(4002, 50.0, 60.0, 180.0, 120.0);
        let copied = cached_snapshot(4002).expect("expected cached webview snapshot");

        assert!(copied.contains("id: 4002"));
        assert!(copied.contains("type: webview"));
        assert!(copied.contains("rect: 50,60 180x120"));
        assert!(copied.contains("path: view#4001 > webview#4002"));
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn webview_inspector_message_uses_private_envelope() {
        assert!(is_webview_inspector_message(
            r#"{"__rngpuiInspector":true,"event":"copy"}"#
        ));
        assert!(!is_webview_inspector_message("__rngpui_inspector_click__"));
        assert!(!is_webview_inspector_message(
            r#"{"__rngpuiInspector":true,"event":"message"}"#
        ));
    }
}
