mod diff;
mod div;
mod image;
pub mod input;
pub mod native_control;
pub mod native_scroll;
mod svg;
pub mod system;
mod terminal;
mod text;
pub mod webview;

pub use diff::{DiffPayload, ReactDiffElement, retain_diff_state, scroll_diff_by};
#[cfg(not(target_os = "macos"))]
pub use div::scroll_by;
pub use div::{
    ReactDivElement, animate_native_layout_override, begin_pointer_frame, claim_native_scroll,
    clear_native_layout_override, ease_out_cubic, finish_pointer_gesture, lerp,
    listens_pointer_down, native_layout_has_animations, native_resize_active,
    retain_native_layout_keys, retain_pointer_state, retain_scroll_state, scroll_to, scroll_to_end,
    set_native_layout_override, stacked_child_indices_for, synth_drag_end, synth_drag_move,
    synth_drag_start, synth_tap,
};
pub use image::ReactImageElement;
pub use input::ReactInputElement;
pub use native_control::ReactNativeControlElement;
pub use svg::ReactSvgElement;
pub use system::ReactSystemElement;
pub use terminal::{
    ReactGhosttyTerminalElement, effective_presentation, painted_presentation, present_session,
    retain_presentations,
};
pub use text::ReactTextElement;
pub use webview::ReactWebViewElement;

use gpui::{AnyElement, Bounds, Hsla, IntoElement, Pixels, px};
use std::sync::Arc;

use crate::style::ElementStyle;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccessibilityInfo {
    pub accessible: Option<bool>,
    pub hidden: bool,
    pub label: Option<String>,
    pub role: Option<String>,
    pub hint: Option<String>,
    pub value: Option<String>,
    pub identifier: Option<String>,
    pub identifier_source: Option<String>,
    pub native_id: Option<String>,
    pub test_id: Option<String>,
    pub prop_id: Option<String>,
    pub disabled: bool,
    pub selected: bool,
    pub checked: Option<String>,
    pub expanded: Option<bool>,
}

/// An inline styled run within a `<Text>` — preserves nested `<Text>` styling
/// (bold lead-ins etc.) that would otherwise be flattened away.
#[derive(Clone, Debug, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub font_weight: Option<String>,
    pub color: Option<Hsla>,
    pub font_style: Option<String>,
    /// Painted as a quad behind the run's glyphs (gpui's run background). A run is
    /// part of a shaped line, so it can carry a colour and a corner radius but NOT
    /// padding — see the note in elements/text.rs.
    pub background_color: Option<Hsla>,
    pub background_radius: Option<f32>,
    pub font_family: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeResizeEdge {
    Left,
    Right,
    Top,
    Bottom,
}

impl NativeResizeEdge {
    pub fn is_horizontal(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }

    pub fn delta_sign(self) -> f32 {
        match self {
            Self::Right | Self::Bottom => 1.0,
            Self::Left | Self::Top => -1.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeResizeSpec {
    pub target: String,
    pub edge: NativeResizeEdge,
    pub min: Option<f32>,
    pub max: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalFrameKind {
    Snapshot,
    Bytes,
    Resize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalFrame {
    pub seq: u64,
    pub kind: TerminalFrameKind,
    /// base64-encoded PTY bytes for snapshot/bytes frames.
    pub data: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// A `<SystemView>` native outer drop shadow, parsed from the `shadow` prop. Colors
/// are an Hsla (alpha unused — opacity is carried separately the way CALayer wants it);
/// `offset_*` are in CSS screen-space (+y down), translated to layer geometry by the
/// element. `radius` is the CSS blur radius. `system.rs` resolves this into its native
/// CALayer-shadow representation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SystemShadowSpec {
    pub color: Hsla,
    pub radius: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub opacity: f32,
}

#[derive(Clone, PartialEq)]
pub struct TextPayload {
    pub number_of_lines: Option<usize>,
    pub selectable: bool,
    pub runs: Arc<[TextRun]>,
}

#[derive(Clone, PartialEq)]
pub struct InputPayload {
    pub value: Option<String>,
    pub default_value: Option<String>,
    pub secure_text_entry: bool,
    pub editable: bool,
    pub auto_focus: bool,
    pub placeholder_text_color: Option<Hsla>,
    pub most_recent_event_count: u64,
}

#[derive(Clone, PartialEq)]
pub struct SystemPayload {
    pub material: Option<String>,
    pub glass_variant: Option<String>,
    pub tint: Option<Hsla>,
    pub shadow: Option<SystemShadowSpec>,
    pub edge_fade: Option<f32>,
    pub top_fade_start: Option<f32>,
}

#[derive(Clone, PartialEq)]
pub struct TerminalPayload {
    pub session_id: Option<String>,
    pub frames: Arc<[TerminalFrame]>,
}

#[derive(Clone, PartialEq)]
pub enum SpecializedElement {
    Text(TextPayload),
    Image { src: Option<String> },
    Svg { path: gpui::SharedString },
    WebView { src: Option<String> },
    System(SystemPayload),
    Input(InputPayload),
    NativeControl(InputPayload),
    Terminal(TerminalPayload),
    Diff(DiffPayload),
}

#[derive(Clone, Copy, Default, PartialEq)]
pub struct ViewEffects {
    pub backdrop_blur_radius: Option<f32>,
    pub backdrop_tint: Option<Hsla>,
}

/// The core element struct that represents a node in the element tree.
#[derive(Clone)]
pub struct ReactElement {
    pub global_id: u64,
    pub element_type: String,
    pub text: Option<String>,
    /// arc-backed copy used by the immediate-mode text rebuild. metadata keeps the
    /// committed String while each draw clones this handle instead of its bytes.
    pub cached_text: gpui::SharedString,
    /// type-specific retained data. An ordinary view carries one empty pointer-sized
    /// option instead of storage for input, terminal, native-surface, image, and diff data.
    pub specialized: Option<Arc<SpecializedElement>>,
    /// optional view-only compositor effects. Allocated inline because these two values
    /// are small and can combine with every host kind.
    pub view_effects: ViewEffects,
    /// RN ScrollView overlay-scroller visibility; input/physics remain native.
    pub shows_vertical_scroll_indicator: bool,
    pub shows_horizontal_scroll_indicator: bool,
    /// event names this node listens to: "press", "changeText", "layout", …
    pub events: Arc<[String]>,
    /// bitset for every native event name. Hot paint and input paths answer common
    /// listener checks without scanning the event string slice.
    pub event_mask: u64,
    /// native-only key for runtime layout overrides, bypassing React commits.
    pub native_layout_key: Option<String>,
    /// native-only resize gesture applied to a keyed layout target.
    pub native_resize: Option<NativeResizeSpec>,
    /// native-only group that scopes drag selection across press-action descendants.
    pub native_list_group: Option<String>,
    pub accessibility: AccessibilityInfo,
    pub children: Vec<Arc<ReactElement>>,
    pub style: ElementStyle,
    /// the raw style JSON object this node was parsed from, retained so the
    /// animated-style overlay (`crate::anim_overlay`) can layer reanimated's per-frame
    /// keys over the committed style and re-parse through the same `from_json`. `None`
    /// for nodes with no `style` (the overlay only targets `<Animated.*>` nodes, which
    /// always carry a style).
    pub style_json: Option<serde_json::Value>,
    pub cached_gpui_style: Option<gpui::Style>,
    /// precomputed at parse: this node listens for any pointer/press event (the
    /// `POINTER_EVENTS` scan) — prepaint reads this once per frame per node, so the
    /// 28-name string scan must not run there.
    pub interactive: bool,
    /// opt-in (`pseudoEvents: true` prop): emit a coalesced `pseudo` host event to JS on
    /// every native hover/press flip of this node's hitbox, so a renderer-side driver
    /// (tamagui's platform driver) can drive pseudo state without a React-event lane.
    /// Opt-in so we never spam an event for every hitbox in the app.
    pub pseudo_events: bool,
}

/// Event names that make a node claim a hitbox (pointer/press input of any kind).
pub const POINTER_EVENTS: &[&str] = &[
    "click",
    "contextMenu",
    "mouseDown",
    "mouseUp",
    "mouseEnter",
    "mouseLeave",
    "mouseOver",
    "mouseOut",
    "mouseMove",
    "pointerDown",
    "pointerUp",
    "pointerEnter",
    "pointerLeave",
    "pointerMove",
    "touchStart",
    "touchMove",
    "touchEnd",
    "touchCancel",
    "startShouldSetResponder",
    "startShouldSetResponderCapture",
    "responderGrant",
    "responderMove",
    "responderRelease",
    "responderStart",
    "responderEnd",
    "responderTerminate",
    "responderTerminationRequest",
    "press",
    "longPress",
    "pressIn",
    "pressOut",
];

impl ReactElement {
    /// True if this node listens for the given event name.
    pub fn listens(&self, name: &str) -> bool {
        if let Some(bit) = event_bit(name) {
            return self.event_mask & (1 << bit) != 0;
        }
        self.events.iter().any(|e| e == name)
    }

    pub fn text_payload(&self) -> Option<&TextPayload> {
        match self.specialized.as_deref() {
            Some(SpecializedElement::Text(payload)) => Some(payload),
            _ => None,
        }
    }

    pub fn input_payload(&self) -> Option<&InputPayload> {
        match self.specialized.as_deref() {
            Some(SpecializedElement::Input(payload))
            | Some(SpecializedElement::NativeControl(payload)) => Some(payload),
            _ => None,
        }
    }

    pub fn src(&self) -> Option<&str> {
        match self.specialized.as_deref() {
            Some(SpecializedElement::Image { src }) | Some(SpecializedElement::WebView { src }) => {
                src.as_deref()
            }
            _ => None,
        }
    }

    pub fn system_payload(&self) -> Option<&SystemPayload> {
        match self.specialized.as_deref() {
            Some(SpecializedElement::System(payload)) => Some(payload),
            _ => None,
        }
    }

    pub fn terminal_payload(&self) -> Option<&TerminalPayload> {
        match self.specialized.as_deref() {
            Some(SpecializedElement::Terminal(payload)) => Some(payload),
            _ => None,
        }
    }

    pub fn terminal_session_id(&self) -> Option<&str> {
        self.terminal_payload()
            .and_then(|payload| payload.session_id.as_deref())
    }

    pub fn terminal_frames(&self) -> &[TerminalFrame] {
        self.terminal_payload()
            .map_or(&[], |payload| payload.frames.as_ref())
    }

    pub fn diff_payload(&self) -> Option<&DiffPayload> {
        match self.specialized.as_deref() {
            Some(SpecializedElement::Diff(payload)) => Some(payload),
            _ => None,
        }
    }

    pub fn source_text(&self) -> Option<&str> {
        self.diff_payload()
            .map(DiffPayload::source)
            .or(self.text.as_deref())
    }

    pub fn svg_path(&self) -> gpui::SharedString {
        match self.specialized.as_deref() {
            Some(SpecializedElement::Svg { path }) => path.clone(),
            _ => gpui::SharedString::new_static(""),
        }
    }

    pub fn build_gpui_style(&self, default_bg: Option<u32>) -> gpui::Style {
        let _t = crate::frame_trace::named(0);
        // animated fast path: when reanimated has a live per-frame override for this
        // node, merge it over the committed style and rebuild. This is the SINGLE style
        // path that feeds both yoga layout (request_layout) and paint, so a width/height
        // spring reflows and an opacity/color spring repaints — see `crate::anim_overlay`
        // (which caches the merged build, so a steady overlay costs a clone per frame).
        if let Some(ref base_json) = self.style_json
            && let Some(merged) =
                crate::anim_overlay::merged_gpui_style(self.global_id, base_json, default_bg)
        {
            return merged;
        }
        // cache holds the default_bg=None variant (the only one live callers use);
        // recompute for the rare explicit-default case so the cache can't go stale.
        if default_bg.is_none() {
            if let Some(ref cached) = self.cached_gpui_style {
                return cached.clone();
            }
        }
        self.style.build_gpui_style(default_bg)
    }
}

fn event_bit(name: &str) -> Option<u32> {
    Some(match name {
        "click" => 0,
        "contextMenu" => 1,
        "keyPress" => 2,
        "layout" => 3,
        "longPress" => 4,
        "mouseDown" => 5,
        "mouseEnter" => 6,
        "mouseLeave" => 7,
        "mouseMove" => 8,
        "mouseOut" => 9,
        "mouseOver" => 10,
        "mouseUp" => 11,
        "pointerDown" => 12,
        "pointerEnter" => 13,
        "pointerLeave" => 14,
        "pointerMove" => 15,
        "pointerUp" => 16,
        "press" => 17,
        "pressIn" => 18,
        "pressOut" => 19,
        "responderEnd" => 20,
        "responderGrant" => 21,
        "responderMove" => 22,
        "responderRelease" => 23,
        "responderStart" => 24,
        "responderTerminate" => 25,
        "responderTerminationRequest" => 26,
        "scroll" => 27,
        "startShouldSetResponder" => 28,
        "startShouldSetResponderCapture" => 29,
        "terminalText" => 30,
        "terminalViewport" => 31,
        "touchCancel" => 32,
        "touchEnd" => 33,
        "touchMove" => 34,
        "touchStart" => 35,
        "toggleFile" => 36,
        "showMore" => 37,
        "lineClick" => 38,
        _ => return None,
    })
}

pub fn event_mask(events: &[String]) -> u64 {
    events.iter().fold(0, |mask, event| {
        event_bit(event).map_or(mask, |bit| mask | (1 << bit))
    })
}

static TEXT_CHANGED_IDS: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashSet<u64>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));
static INCREMENTAL_ELIGIBLE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// True when this element's text content changed in the pending commit batch, so an
/// incremental frame must force a re-measure of its text child. Callers only query this
/// while the current frame is incremental.
pub fn text_changed(id: u64) -> bool {
    TEXT_CHANGED_IDS.lock().unwrap().contains(&id)
}

pub fn incremental_eligible() -> bool {
    INCREMENTAL_ELIGIBLE.load(std::sync::atomic::Ordering::Relaxed)
}

/// Fold one commit into the pending batch. Several React commits can land before GPUI
/// renders, so once any pending commit is structurally ineligible the whole batch is, and the
/// text-changed ids union across the batch.
pub fn accumulate_incremental(
    already_pending: bool,
    eligible: bool,
    text_changed: std::collections::HashSet<u64>,
) {
    use std::sync::atomic::Ordering;
    let next = if already_pending {
        INCREMENTAL_ELIGIBLE.load(Ordering::Relaxed) && eligible
    } else {
        eligible
    };
    INCREMENTAL_ELIGIBLE.store(next, Ordering::Relaxed);
    let mut ids = TEXT_CHANGED_IDS.lock().unwrap();
    if already_pending {
        ids.extend(text_changed);
    } else {
        *ids = text_changed;
    }
}

/// True when a commit preserves the exact host node GRAPH — same elements in the same order,
/// same child counts, same measured-child shape — even though styles and text CONTENT may
/// differ. That is the precondition for an incremental layout frame: the taffy tree can be
/// replayed positionally, with `set_style` pushed only where styles differ and re-measures
/// forced only where text changed (collected into `text_changed`).
///
/// Deliberately conservative: anything that could add, remove, or reshape a host node (a text
/// child appearing, styled runs, an image, an input's value) takes the full-layout path.
pub fn is_structure_preserving_tree_update(
    previous: &Arc<ReactElement>,
    next: &Arc<ReactElement>,
    text_changed: &mut std::collections::HashSet<u64>,
) -> bool {
    if Arc::ptr_eq(previous, next) {
        return true;
    }
    let has_text = |e: &ReactElement| e.text.as_ref().is_some_and(|t| !t.is_empty());
    if previous.global_id != next.global_id
        || previous.element_type != next.element_type
        // a text child node appearing/disappearing changes the node graph
        || has_text(previous) != has_text(next)
        || previous.specialized != next.specialized
        || previous.native_layout_key != next.native_layout_key
        || previous.native_resize != next.native_resize
        || previous.native_list_group != next.native_list_group
        || previous.shows_vertical_scroll_indicator != next.shows_vertical_scroll_indicator
        || previous.shows_horizontal_scroll_indicator != next.shows_horizontal_scroll_indicator
        || previous.children.len() != next.children.len()
    {
        return false;
    }
    if previous.text != next.text {
        text_changed.insert(next.global_id);
    }
    previous
        .children
        .iter()
        .zip(&next.children)
        .all(|(previous, next)| is_structure_preserving_tree_update(previous, next, text_changed))
}

/// True when a React commit preserves the exact host tree and changes only style
/// keys that paint in place. Delta refs make this proportional to the changed paths:
/// an unchanged subtree is the same Arc and returns immediately. Unknown fields and
/// style keys take the safe full-layout path. Terminal session/frame payloads are
/// paint content inside a fixed host box; if a resize changes the terminal's internal
/// row count, GPUI's retained-layout node-count guard rejects reuse automatically.
pub fn is_paint_only_tree_update(previous: &Arc<ReactElement>, next: &Arc<ReactElement>) -> bool {
    if Arc::ptr_eq(previous, next) {
        return true;
    }
    let diff_text_is_fixed_geometry = matches!(
        (previous.specialized.as_deref(), next.specialized.as_deref()),
        (Some(SpecializedElement::Diff(previous)), Some(SpecializedElement::Diff(next)))
            if previous.row_count() == next.row_count()
    );
    if previous.global_id != next.global_id
        || previous.element_type != next.element_type
        || (previous.text != next.text && !diff_text_is_fixed_geometry)
        || !specialized_change_is_paint_only(previous, next)
        || previous.view_effects != next.view_effects
        || previous.shows_vertical_scroll_indicator != next.shows_vertical_scroll_indicator
        || previous.shows_horizontal_scroll_indicator != next.shows_horizontal_scroll_indicator
        || previous.events != next.events
        || previous.native_layout_key != next.native_layout_key
        || previous.native_resize != next.native_resize
        || previous.native_list_group != next.native_list_group
        || previous.accessibility != next.accessibility
        || previous.interactive != next.interactive
        || previous.pseudo_events != next.pseudo_events
        || previous.children.len() != next.children.len()
        || !style_change_is_paint_only(previous.style_json.as_ref(), next.style_json.as_ref())
    {
        return false;
    }
    previous
        .children
        .iter()
        .zip(&next.children)
        .all(|(previous, next)| is_paint_only_tree_update(previous, next))
}

fn specialized_change_is_paint_only(previous: &ReactElement, next: &ReactElement) -> bool {
    match (previous.specialized.as_deref(), next.specialized.as_deref()) {
        (Some(SpecializedElement::Terminal(_)), Some(SpecializedElement::Terminal(_))) => true,
        (Some(SpecializedElement::Diff(previous)), Some(SpecializedElement::Diff(next))) => {
            previous.row_count() == next.row_count() && previous.diff_scroll == next.diff_scroll
        }
        (
            Some(SpecializedElement::Input(previous_input)),
            Some(SpecializedElement::Input(next_input)),
        ) if matches!(previous.element_type.as_str(), "textinput" | "textarea") => {
            previous_input.default_value == next_input.default_value
                && previous_input.secure_text_entry == next_input.secure_text_entry
                && previous_input.editable == next_input.editable
                && previous_input.auto_focus == next_input.auto_focus
                && previous_input.placeholder_text_color == next_input.placeholder_text_color
        }
        _ => previous.specialized == next.specialized,
    }
}

fn style_change_is_paint_only(
    previous: Option<&serde_json::Value>,
    next: Option<&serde_json::Value>,
) -> bool {
    if previous == next {
        return true;
    }
    let previous = previous.and_then(serde_json::Value::as_object);
    let next = next.and_then(serde_json::Value::as_object);
    match (previous, next) {
        (None, None) => true,
        (Some(previous), None) => previous
            .keys()
            .all(|key| crate::anim_overlay::is_paint_only_key(key)),
        (None, Some(next)) => next
            .keys()
            .all(|key| crate::anim_overlay::is_paint_only_key(key)),
        (Some(previous), Some(next)) => previous.keys().chain(next.keys()).all(|key| {
            previous.get(key) == next.get(key) || crate::anim_overlay::is_paint_only_key(key)
        }),
    }
}

pub fn report_layout(element: &ReactElement, bounds: Bounds<Pixels>) {
    let id = element.global_id;
    if element.listens("layout") {
        crate::bridge::layout_if_changed(
            id,
            bounds.origin.x.into(),
            bounds.origin.y.into(),
            bounds.size.width.into(),
            bounds.size.height.into(),
        );
    } else {
        crate::bridge::remember_layout(
            id,
            bounds.origin.x.into(),
            bounds.origin.y.into(),
            bounds.size.width.into(),
            bounds.size.height.into(),
        );
    }
}

pub fn bounds_have_drawable_area(bounds: Bounds<Pixels>) -> bool {
    bounds.size.width > px(0.0) && bounds.size.height > px(0.0)
}

/// Create a GPUI element from a ReactElement.
///
/// Every node's style is fully self-contained on `element.style` (text inheritance is
/// resolved by the reconciler before commit, not here), so no parent style is threaded
/// down — this used to clone a 63-field `ElementStyle` per child on every frame for a
/// value no builder ever read.
pub fn create_element(element: Arc<ReactElement>, window_id: u64) -> AnyElement {
    match element.element_type.as_str() {
        "text" => ReactTextElement::new(element, window_id, None).into_any_element(),
        "svg" => ReactSvgElement::new(element, window_id).into_any_element(),
        "image" => ReactImageElement::new(element, window_id).into_any_element(),
        "webview" => ReactWebViewElement::new(element).into_any_element(),
        "system" => ReactSystemElement::new(element).into_any_element(),
        "ghostty-terminal" => {
            ReactGhosttyTerminalElement::new(element, window_id).into_any_element()
        }
        "textinput" | "textarea" => {
            ReactInputElement::new(element, window_id, None).into_any_element()
        }
        "nativebutton" | "nativeinput" => {
            ReactNativeControlElement::new(element).into_any_element()
        }
        "diff" => ReactDiffElement::new(element).into_any_element(),
        _ => ReactDivElement::new(element, window_id).into_element(),
    }
}

#[cfg(test)]
mod paint_only_update_tests {
    use serde_json::json;

    use super::style_change_is_paint_only;

    #[test]
    fn accepts_only_geometry_stable_style_differences() {
        let previous = json!({ "width": 200, "backgroundColor": "#111111" });
        let paint = json!({ "width": 200, "backgroundColor": "#222222" });
        let layout = json!({ "width": 240, "backgroundColor": "#222222" });
        let unknown = json!({ "width": 200, "futureStyle": true });

        assert!(style_change_is_paint_only(Some(&previous), Some(&paint)));
        assert!(!style_change_is_paint_only(Some(&previous), Some(&layout)));
        assert!(!style_change_is_paint_only(Some(&previous), Some(&unknown)));
    }
}
