mod div;
mod text;

pub use div::ReactDivElement;
pub use text::ReactTextElement;

use gpui::{AnyElement, IntoElement};
use std::sync::Arc;

use crate::style::ElementStyle;

/// The core element struct that represents a node in the element tree.
#[derive(Clone)]
pub struct ReactElement {
    pub global_id: u64,
    pub element_type: String,
    pub text: Option<String>,
    pub children: Vec<Arc<ReactElement>>,
    pub style: ElementStyle,
    pub event_handlers: Option<serde_json::Value>,
    pub cached_gpui_style: Option<gpui::Style>,
}

impl ReactElement {
    pub fn new(id: u64, element_type: &str, style: ElementStyle) -> Self {
        Self {
            global_id: id,
            element_type: element_type.to_string(),
            text: None,
            children: Vec::new(),
            style,
            event_handlers: None,
            cached_gpui_style: None,
        }
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
        "text" => ReactTextElement::new(element, window_id, parent_style).into_element(),
        _ => ReactDivElement::new(element, window_id, parent_style).into_element(),
    }
}
