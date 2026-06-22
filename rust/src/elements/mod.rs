mod div;
mod image;
pub mod input;
pub mod native_control;
mod svg;
pub mod system;
mod terminal;
mod text;
pub mod webview;

pub use div::{
    ReactDivElement, animate_native_layout_override, clear_native_layout_override, ease_out_cubic,
    finish_pointer_gesture, lerp, native_layout_has_animations, native_resize_active,
    retain_native_layout_keys, retain_pointer_state, scroll_bounce_active, scroll_by,
    scroll_position, scroll_to, scroll_to_end, set_native_layout_override, smoke_recently_painted,
    synth_drag_end,
    synth_drag_move, synth_drag_start, synth_tap,
};
pub use image::ReactImageElement;
pub use input::ReactInputElement;
pub use native_control::ReactNativeControlElement;
pub use svg::ReactSvgElement;
pub use system::ReactSystemElement;
pub use terminal::ReactGhosttyTerminalElement;
pub use text::ReactTextElement;
pub use webview::ReactWebViewElement;

use gpui::{AnyElement, Bounds, Hsla, IntoElement, Pixels, px};
use std::sync::Arc;

use crate::style::ElementStyle;

#[derive(Clone, Debug, Default)]
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
#[derive(Clone, Debug)]
pub struct TextRun {
    pub text: String,
    pub font_weight: Option<String>,
    pub color: Option<Hsla>,
    pub font_style: Option<String>,
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

#[derive(Clone, Debug)]
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

/// The core element struct that represents a node in the element tree.
#[derive(Clone)]
pub struct ReactElement {
    pub global_id: u64,
    pub element_type: String,
    pub text: Option<String>,
    /// RN Text `numberOfLines`; clamps text and ellipsizes overflow.
    pub number_of_lines: Option<usize>,
    /// RN Text `selectable`; opts this text into the native drag selection + Cmd+C.
    pub selectable: bool,
    /// inline styled runs, when a `<Text>` has nested `<Text>` children.
    pub runs: Vec<TextRun>,
    /// image / webview source uri (for `<Image>` / `<WebView>`).
    pub src: Option<String>,
    /// NSVisualEffectView material name for `<SystemView>` (the AppKit semantic set:
    /// "titlebar" | "selection" | "menu" | … | "underPageBackground"). None → no blur.
    pub system_material: Option<String>,
    /// NSGlassEffectView liquid-glass variant name for `<SystemView>` (macOS 26+):
    /// "regular" | "clear" | … | "cartouchePopover". None → use `system_material`.
    pub system_glass_variant: Option<String>,
    /// optional tint color overlaid on a `<SystemView>` so foreground text stays legible.
    pub system_tint: Option<Hsla>,
    /// optional native outer drop shadow for `<SystemView>`, drawn below the surface.
    pub system_shadow: Option<SystemShadowSpec>,
    /// optional horizontal alpha fade applied to the native `<SystemView>` surface.
    pub system_edge_fade: Option<f32>,
    /// optional vertical alpha fade start applied to the native `<SystemView>` surface.
    pub system_top_fade_start: Option<f32>,
    /// in-app liquid-glass backdrop blur radius (logical-px Gaussian sigma) for a plain
    /// `<View>`. Blurs the gpui content drawn behind this node before its own background
    /// paints — unlike `<SystemView>`, which can only blur the desktop behind the window.
    pub backdrop_blur_radius: Option<f32>,
    /// tint color composited over the blurred backdrop (defaults to the node's own
    /// background-color when only `backdropBlur` is set).
    pub backdrop_tint: Option<Hsla>,
    /// text input value from react props.
    pub value: Option<String>,
    /// whether text input values render as password/secret text.
    pub secure_text_entry: bool,
    /// whether text input nodes accept editing. RN TextInput defaults to editable.
    pub editable: bool,
    /// event names this node listens to: "press", "changeText", "layout", …
    pub events: Vec<String>,
    /// native-only key for runtime layout overrides, bypassing React commits.
    pub native_layout_key: Option<String>,
    /// native-only resize gesture applied to a keyed layout target.
    pub native_resize: Option<NativeResizeSpec>,
    /// native-only group that scopes drag selection across press-action descendants.
    pub native_list_group: Option<String>,
    /// native terminal session key; changing it resets the Ghostty parser.
    pub terminal_session_id: Option<String>,
    /// ordered daemon terminal frames consumed by the native Ghostty parser.
    pub terminal_frames: Vec<TerminalFrame>,
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
        self.events.iter().any(|e| e == name)
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

pub fn report_layout(element: &ReactElement, bounds: Bounds<Pixels>) {
    let id = element.global_id;
    crate::bridge::remember_layout(
        id,
        bounds.origin.x.into(),
        bounds.origin.y.into(),
        bounds.size.width.into(),
        bounds.size.height.into(),
    );
    if element.listens("layout") {
        crate::bridge::layout_if_changed(
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
        _ => ReactDivElement::new(element, window_id).into_element(),
    }
}
