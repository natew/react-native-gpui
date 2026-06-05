use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, DefiniteLength, Display, Element, ElementId, FontStyle,
    GlobalElementId, HighlightStyle, Hsla, IntoElement, LayoutId, Length, ParentElement, Pixels,
    Styled, StyledText, Window, div, px,
};

use crate::elements::{ReactElement, report_layout};
use crate::style::ElementStyle;

pub struct ReactTextElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    _parent_style: Option<ElementStyle>,
    child: Option<AnyElement>,
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
            child: None,
        }
    }

    fn build_child(&self, window: &mut Window) -> AnyElement {
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

        let mut el = div()
            .whitespace_normal()
            .text_color(color)
            .text_size(px(size));
        el = apply_layout_style(el, style);
        if let Some(ref fam) = family {
            el = el.font_family(fam.clone());
        }
        if let Some(w) = weight {
            el = el.font_weight(w);
        }
        if let Some(lh) = style.line_height {
            el = el.line_height(px(lh));
        }
        el = apply_line_limit(el, self.element.number_of_lines);

        // No inline runs → plain text.
        if self.element.runs.is_empty() {
            return el.child(text).into_any_element();
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
            .into_any_element()
    }
}

fn apply_layout_style(mut el: gpui::Div, style: &ElementStyle) -> gpui::Div {
    if let Some(width) = style.width {
        el = el.w(width.to_length());
    }
    if let Some(min_width) = style.min_width {
        el = el.min_w(min_width.to_length());
    }
    if let Some(max_width) = style.max_width {
        el = el.max_w(max_width.to_length());
    }
    if let Some(flex) = style.flex {
        if flex > 0.0 {
            el.style().flex_grow = Some(flex);
            el.style().flex_shrink = Some(1.0);
            el.style().flex_basis = Some(Length::Definite(DefiniteLength::Fraction(0.0)));
        } else if flex == 0.0 {
            el.style().flex_grow = Some(0.0);
            el.style().flex_shrink = Some(0.0);
        } else {
            el.style().flex_grow = Some(0.0);
            el.style().flex_shrink = Some(1.0);
        }
    }
    if let Some(flex_grow) = style.flex_grow {
        el.style().flex_grow = Some(flex_grow);
    }
    if let Some(flex_shrink) = style.flex_shrink {
        el.style().flex_shrink = Some(flex_shrink);
    }
    if let Some(flex_basis) = style.flex_basis {
        el.style().flex_basis = Some(flex_basis.to_length());
    }
    el
}

fn apply_line_limit(el: gpui::Div, number_of_lines: Option<usize>) -> gpui::Div {
    match number_of_lines {
        Some(1) => el.truncate(),
        // gpui line_clamp is the multi-line truncation primitive; chaining
        // text_ellipsis() here switches to single-line overflow behavior and
        // collapses wrapped title widths.
        Some(lines) => el.overflow_hidden().line_clamp(lines),
        None => el,
    }
}

impl Element for ReactTextElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

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
        let style = self.element.build_gpui_style(None);
        if style.display == Display::None {
            self.child = None;
            return (window.request_layout(style, [], cx), ());
        }

        let mut child = self.build_child(window);
        let layout_id = child.request_layout(window, cx);
        self.child = Some(child);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.element.style.is_display_none() {
            return;
        }

        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);
        report_layout(&self.element, bounds);

        if let Some(child) = self.child.as_mut() {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.element.style.is_display_none() {
            return;
        }

        if let Some(child) = self.child.as_mut() {
            child.paint(window, cx);
        }
    }
}

impl IntoElement for ReactTextElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}
