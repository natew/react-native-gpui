mod div;
mod image;
pub mod input;
mod svg;
mod text;
pub mod webview;

pub use div::{
    ReactDivElement, clear_native_layout_override, retain_native_layout_keys, scroll_to,
    scroll_to_end, set_native_layout_override,
};
pub use image::ReactImageElement;
pub use input::ReactInputElement;
pub use svg::ReactSvgElement;
pub use text::ReactTextElement;
pub use webview::ReactWebViewElement;

use gpui::{AnyElement, Bounds, Hsla, IntoElement, Pixels};
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

/// The core element struct that represents a node in the element tree.
#[derive(Clone)]
pub struct ReactElement {
    pub global_id: u64,
    pub element_type: String,
    pub text: Option<String>,
    /// RN Text `numberOfLines`; clamps text and ellipsizes overflow.
    pub number_of_lines: Option<usize>,
    /// inline styled runs, when a `<Text>` has nested `<Text>` children.
    pub runs: Vec<TextRun>,
    /// image / webview source uri (for `<Image>` / `<WebView>`).
    pub src: Option<String>,
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
    pub accessibility: AccessibilityInfo,
    pub children: Vec<Arc<ReactElement>>,
    pub style: ElementStyle,
    pub cached_gpui_style: Option<gpui::Style>,
}

impl ReactElement {
    /// True if this node listens for the given event name.
    pub fn listens(&self, name: &str) -> bool {
        self.events.iter().any(|e| e == name)
    }

    pub fn build_gpui_style(&self, default_bg: Option<u32>) -> gpui::Style {
        if let Some(ref cached) = self.cached_gpui_style {
            return cached.clone();
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

/// Create a GPUI element from a ReactElement.
pub fn create_element(
    element: Arc<ReactElement>,
    window_id: u64,
    parent_style: Option<ElementStyle>,
) -> AnyElement {
    match element.element_type.as_str() {
        "text" => ReactTextElement::new(element, window_id, parent_style).into_any_element(),
        "svg" => ReactSvgElement::new(element, window_id, parent_style).into_any_element(),
        "image" => ReactImageElement::new(element, window_id, parent_style).into_any_element(),
        "webview" => ReactWebViewElement::new(element).into_any_element(),
        "textinput" | "textarea" => {
            ReactInputElement::new(element, window_id, parent_style).into_any_element()
        }
        _ => ReactDivElement::new(element, window_id, parent_style).into_element(),
    }
}
