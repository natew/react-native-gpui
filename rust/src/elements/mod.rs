mod div;
mod image;
pub mod input;
mod svg;
mod text;
pub mod webview;

pub use div::{ReactDivElement, scroll_to, scroll_to_end};
pub use image::ReactImageElement;
pub use input::ReactInputElement;
pub use svg::ReactSvgElement;
pub use text::ReactTextElement;
pub use webview::ReactWebViewElement;

use gpui::{AnyElement, Hsla, IntoElement};
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
