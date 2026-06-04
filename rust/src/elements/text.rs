use std::sync::Arc;

use gpui::{
    AnyElement, App, FontStyle, HighlightStyle, Hsla, IntoElement, ParentElement, RenderOnce,
    Styled, StyledText, Window, div, px,
};

use crate::elements::ReactElement;
use crate::style::ElementStyle;

pub struct ReactTextElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    _parent_style: Option<ElementStyle>,
}

impl ReactTextElement {
    pub fn new(
        element: Arc<ReactElement>,
        window_id: u64,
        parent_style: Option<ElementStyle>,
    ) -> Self {
        Self {
            element,
            _window_id: window_id,
            _parent_style: parent_style,
        }
    }
}

impl RenderOnce for ReactTextElement {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let style = &self.element.style;
        let color = style.color.unwrap_or(Hsla {
            h: 0.0,
            s: 0.0,
            l: 1.0,
            a: 1.0,
        });
        let size = style.font_size.unwrap_or(14.0);
        let family = style.gpui_font_family();
        let weight = style.gpui_font_weight();
        let text = self.element.text.clone().unwrap_or_default();

        let mut el = div().text_color(color).text_size(px(size));
        if let Some(ref fam) = family {
            el = el.font_family(fam.clone());
        }
        if let Some(w) = weight {
            el = el.font_weight(w);
        }
        if let Some(lh) = style.line_height {
            el = el.line_height(px(lh));
        }

        // No inline runs → plain text.
        if self.element.runs.is_empty() {
            return el.child(text);
        }

        // Nested `<Text>` → flowing styled runs. StyledText doesn't inherit the
        // div's text size/family, so build an explicit base TextStyle (otherwise
        // the text renders at a wrong default size), then override each run's
        // weight/color via highlights.
        let mut base = window.text_style();
        base.color = color;
        base.font_size = px(size).into();
        if let Some(ref fam) = family {
            base.font_family = fam.clone();
        }
        if let Some(w) = weight {
            base.font_weight = w;
        }
        if let Some(lh) = style.line_height {
            base.line_height = px(lh).into();
        }

        let flat: String = self.element.runs.iter().map(|r| r.text.as_str()).collect();
        let mut highlights: Vec<(std::ops::Range<usize>, HighlightStyle)> = Vec::new();
        let mut ix = 0usize;
        for r in &self.element.runs {
            let len = r.text.len();
            if len == 0 {
                continue;
            }
            highlights.push((
                ix..ix + len,
                HighlightStyle {
                    color: r.color,
                    font_weight: r
                        .font_weight
                        .as_deref()
                        .map(crate::style::parse_font_weight),
                    font_style: r.font_style.as_deref().and_then(|s| {
                        s.eq_ignore_ascii_case("italic")
                            .then_some(FontStyle::Italic)
                    }),
                    ..Default::default()
                },
            ));
            ix += len;
        }
        el.child(StyledText::new(flat).with_default_highlights(&base, highlights))
    }
}

impl IntoElement for ReactTextElement {
    type Element = AnyElement;
    fn into_element(self) -> Self::Element {
        gpui::Component::new(self).into_any_element()
    }
}
