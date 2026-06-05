use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use gpui::{
    App, Bounds, Display, Element, ElementId, FontStyle, FontWeight, GlobalElementId,
    HighlightStyle, Hsla, IntoElement, LayoutId, ParentElement as _, Pixels, StrikethroughStyle,
    Styled as _, StyledText, UnderlineStyle, Window, div, px, rgba,
};
use libghostty_vt::render::{CellIterator, RowIterator};
use libghostty_vt::style::{RgbColor, Underline};
use libghostty_vt::{RenderState, Terminal, TerminalOptions};

use crate::elements::{
    ReactElement, TerminalFrame, TerminalFrameKind, bounds_have_drawable_area, report_layout,
};

thread_local! {
    static TERMINALS: RefCell<HashMap<u64, TerminalState>> = RefCell::new(HashMap::new());
}

pub struct ReactGhosttyTerminalElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    child: Option<gpui::AnyElement>,
}

impl ReactGhosttyTerminalElement {
    pub fn new(element: Arc<ReactElement>, window_id: u64) -> Self {
        Self {
            element,
            _window_id: window_id,
            child: None,
        }
    }

    fn build_child(&self, window: &mut Window) -> gpui::AnyElement {
        let rows = terminal_rows(&self.element);
        let style = &self.element.style;
        let font_size = style.font_size.unwrap_or(12.0);
        let line_height = style.line_height.unwrap_or(18.0);
        let font_family = style.gpui_font_family().unwrap_or_else(|| "Menlo".into());
        let foreground = style.color.unwrap_or_else(|| color_from_hex(0xe4e4e7));
        let background = style
            .background_color
            .unwrap_or_else(|| color_from_hex(0x050507));

        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(background)
            .p(px(10.0));

        if rows.is_empty() {
            return root
                .text_color(color_from_hex(0xa1a1aa))
                .text_size(px(font_size))
                .font_family(font_family)
                .child("waiting for terminal snapshot")
                .into_any_element();
        }

        for row in rows {
            let mut text_style = window.text_style();
            text_style.color = foreground;
            text_style.font_size = px(font_size).into();
            text_style.line_height = px(line_height).into();
            text_style.font_family = font_family.clone();

            let line = StyledText::new(row.text).with_default_highlights(
                &text_style,
                row.highlights.into_iter().map(|highlight| {
                    (
                        highlight.range,
                        HighlightStyle {
                            color: highlight.fg,
                            background_color: highlight.bg,
                            font_weight: highlight.bold.then_some(FontWeight::BOLD),
                            font_style: highlight.italic.then_some(FontStyle::Italic),
                            underline: highlight.underline.then_some(UnderlineStyle {
                                thickness: px(1.0),
                                color: highlight.fg,
                                ..Default::default()
                            }),
                            strikethrough: highlight.strikethrough.then_some(StrikethroughStyle {
                                thickness: px(1.0),
                                color: highlight.fg,
                            }),
                            fade_out: highlight.faint.then_some(0.58),
                            ..Default::default()
                        },
                    )
                }),
            );
            root = root.child(
                div()
                    .h(px(line_height))
                    .whitespace_nowrap()
                    .text_size(px(font_size))
                    .line_height(px(line_height))
                    .font_family(font_family.clone())
                    .child(line),
            );
        }

        root.into_any_element()
    }
}

impl IntoElement for ReactGhosttyTerminalElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for ReactGhosttyTerminalElement {
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
        let child_layout = child.request_layout(window, cx);
        let layout_id = window.request_layout(style, std::iter::once(child_layout), cx);
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
        if !bounds_have_drawable_area(bounds) {
            return;
        }

        if let Some(child) = self.child.as_mut() {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.element.style.is_display_none() || !bounds_have_drawable_area(bounds) {
            return;
        }

        let style = self.element.build_gpui_style(None);
        style.paint(bounds, window, cx, |window, cx| {
            if let Some(child) = self.child.as_mut() {
                child.paint(window, cx);
            }
        });
    }
}

struct TerminalState {
    session_id: String,
    terminal: Terminal<'static, 'static>,
    render: RenderState<'static>,
    last_seq: u64,
    cols: u16,
    rows: u16,
}

struct RenderedRow {
    text: String,
    highlights: Vec<RowHighlight>,
}

struct RowHighlight {
    range: Range<usize>,
    fg: Option<Hsla>,
    bg: Option<Hsla>,
    bold: bool,
    italic: bool,
    underline: bool,
    strikethrough: bool,
    faint: bool,
}

fn terminal_rows(element: &ReactElement) -> Vec<RenderedRow> {
    let session_id = element
        .terminal_session_id
        .clone()
        .unwrap_or_else(|| "__terminal__".to_string());
    let mut rows = Vec::new();
    TERMINALS.with(|terminals| {
        let mut terminals = terminals.borrow_mut();
        let initial_cols = element
            .terminal_frames
            .iter()
            .rev()
            .find_map(|frame| frame.cols)
            .unwrap_or(100);
        let initial_rows = element
            .terminal_frames
            .iter()
            .rev()
            .find_map(|frame| frame.rows)
            .unwrap_or(30);

        let state = match terminals.get_mut(&element.global_id) {
            Some(state) if state.session_id == session_id => state,
            _ => {
                terminals.remove(&element.global_id);
                let Some(state) =
                    TerminalState::new(session_id.clone(), initial_cols, initial_rows)
                else {
                    return;
                };
                terminals.insert(element.global_id, state);
                terminals
                    .get_mut(&element.global_id)
                    .expect("terminal inserted")
            }
        };

        state.apply_frames(&element.terminal_frames);
        rows = state.render_rows().unwrap_or_default();
    });
    rows
}

impl TerminalState {
    fn new(session_id: String, cols: u16, rows: u16) -> Option<Self> {
        let terminal = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: 5000,
        })
        .ok()?;
        let render = RenderState::new().ok()?;
        Some(Self {
            session_id,
            terminal,
            render,
            last_seq: 0,
            cols,
            rows,
        })
    }

    fn apply_frames(&mut self, frames: &[TerminalFrame]) {
        for frame in frames {
            if frame.seq <= self.last_seq {
                continue;
            }
            match frame.kind {
                TerminalFrameKind::Snapshot => {
                    self.resize_if_needed(frame.cols, frame.rows);
                    self.terminal.reset();
                    if let Some(bytes) = decode_frame(frame) {
                        self.terminal.vt_write(&bytes);
                    }
                }
                TerminalFrameKind::Bytes => {
                    self.resize_if_needed(frame.cols, frame.rows);
                    if let Some(bytes) = decode_frame(frame) {
                        self.terminal.vt_write(&bytes);
                    }
                }
                TerminalFrameKind::Resize => {
                    self.resize_if_needed(frame.cols, frame.rows);
                }
            }
            self.last_seq = frame.seq;
        }
    }

    fn resize_if_needed(&mut self, cols: Option<u16>, rows: Option<u16>) {
        let cols = cols.unwrap_or(self.cols).max(1);
        let rows = rows.unwrap_or(self.rows).max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }
        if self.terminal.resize(cols, rows, 8, 16).is_ok() {
            self.cols = cols;
            self.rows = rows;
        }
    }

    fn render_rows(&mut self) -> Result<Vec<RenderedRow>, Box<dyn std::error::Error>> {
        let snapshot = self.render.update(&self.terminal)?;
        let colors = snapshot.colors()?;
        let default_fg = rgb_color(colors.foreground);
        let default_bg = rgb_color(colors.background);
        let cursor = if snapshot.cursor_visible()? {
            snapshot.cursor_viewport()?
        } else {
            None
        };
        let cursor_color = colors.cursor.map(rgb_color).unwrap_or(default_fg);
        let mut rows = RowIterator::new()?;
        let mut cells = CellIterator::new()?;
        let mut row_iter = rows.update(&snapshot)?;
        let mut rendered = Vec::new();
        let mut row_index = 0u16;

        while let Some(row) = row_iter.next() {
            let mut text = String::new();
            let mut highlights = Vec::new();
            let mut cell_iter = cells.update(row)?;
            let mut col_index = 0u16;
            while let Some(cell) = cell_iter.next() {
                let is_cursor =
                    cursor.is_some_and(|cursor| cursor.x == col_index && cursor.y == row_index);
                let graphemes = cell.graphemes()?;
                let style = cell.style()?;
                let mut fg = cell.fg_color()?.map(rgb_color).unwrap_or(default_fg);
                let mut bg = cell.bg_color()?.map(rgb_color);
                if style.inverse {
                    let previous_fg = fg;
                    fg = bg.unwrap_or(default_bg);
                    bg = Some(previous_fg);
                }
                if style.invisible {
                    fg = bg.unwrap_or(default_bg);
                }
                if is_cursor {
                    fg = default_bg;
                    bg = Some(cursor_color);
                }

                let start = text.len();
                if graphemes.is_empty() {
                    text.push(' ');
                } else {
                    for grapheme in graphemes {
                        text.push(grapheme);
                    }
                }
                let end = text.len();
                if fg != default_fg
                    || bg.is_some()
                    || style.bold
                    || style.italic
                    || style.underline != Underline::None
                    || style.strikethrough
                    || style.faint
                    || is_cursor
                {
                    highlights.push(RowHighlight {
                        range: start..end,
                        fg: Some(fg),
                        bg,
                        bold: style.bold,
                        italic: style.italic,
                        underline: style.underline != Underline::None,
                        strikethrough: style.strikethrough,
                        faint: style.faint,
                    });
                }
                col_index = col_index.saturating_add(1);
            }
            rendered.push(RenderedRow { text, highlights });
            row_index = row_index.saturating_add(1);
        }

        Ok(rendered)
    }
}

fn decode_frame(frame: &TerminalFrame) -> Option<Vec<u8>> {
    frame
        .data
        .as_deref()
        .and_then(|data| BASE64.decode(data).ok())
}

fn rgb_color(color: RgbColor) -> Hsla {
    Hsla::from(rgba(
        (u32::from(color.r) << 24) | (u32::from(color.g) << 16) | (u32::from(color.b) << 8) | 0xff,
    ))
}

fn color_from_hex(color: u32) -> Hsla {
    Hsla::from(rgba((color << 8) | 0xff))
}
