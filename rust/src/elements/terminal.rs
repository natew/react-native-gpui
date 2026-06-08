use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use gpui::{
    App, Bounds, Display, Element, ElementId, FontStyle, FontWeight, GlobalElementId,
    HighlightStyle, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent, LayoutId,
    MouseButton, MouseDownEvent, ParentElement as _, Pixels, ScrollDelta, ScrollWheelEvent,
    StrikethroughStyle, Styled as _, StyledText, UnderlineStyle, Window, div, px, rgba,
};
use libghostty_vt::render::{CellIterator, RowIterator};
use libghostty_vt::style::{RgbColor, Underline};
use libghostty_vt::terminal::ScrollViewport;
use libghostty_vt::{RenderState, Terminal, TerminalOptions};

use crate::elements::{
    ReactElement, TerminalFrame, TerminalFrameKind, bounds_have_drawable_area, report_layout,
};

thread_local! {
    // Keyed by SESSION id (not the React element's `global_id`): the single
    // GhosttyTerminal element keeps a stable `global_id` while its
    // `terminal_session_id` prop swaps as the user switches tabs. Keying by
    // global_id meant every switch evicted the previous session's fully-built
    // ghostty grid and rebuilt the next one from scratch — replaying the whole
    // retained frame buffer (~90ms for a busy session) on EVERY switch, even
    // when switching back to a session whose state we just discarded. Keying by
    // session id keeps each session's terminal warm, so a switch is just the
    // few new frames + a cached render. Bounded by an LRU cap so idle sessions
    // don't leak.
    static TERMINALS: RefCell<HashMap<String, TerminalState>> = RefCell::new(HashMap::new());
    static TERMINAL_FOCUS: RefCell<HashMap<u64, gpui::FocusHandle>> = RefCell::new(HashMap::new());
    static TERMINAL_CLOCK: RefCell<u64> = const { RefCell::new(0) };
}

// Keep at most this many warm per-session terminals; evict least-recently-used.
const MAX_WARM_TERMINALS: usize = 12;

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

    fn build_child(&self, window: &mut Window, cx: &mut App) -> gpui::AnyElement {
        let rows = terminal_rows(&self.element);
        let style = &self.element.style;
        let font_size = style.font_size.unwrap_or(12.0);
        let line_height = style.line_height.unwrap_or(18.0);
        let font_family = style.gpui_font_family().unwrap_or_else(|| "Menlo".into());
        let foreground = style.color.unwrap_or_else(|| color_from_hex(0xe4e4e7));
        let background = style
            .background_color
            .unwrap_or_else(|| color_from_hex(0x050507));
        let focus_handle = terminal_focus_handle(self.element.global_id, cx);
        let click_focus_handle = focus_handle.clone();
        let listens_key_press = self.element.listens("keyPress");
        let listens_press = self.element.listens("press");
        let element_id = self.element.global_id;
        let press_element_id = element_id;
        let scroll_session_id = self
            .element
            .terminal_session_id
            .clone()
            .unwrap_or_else(|| "__terminal__".to_string());

        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(background)
            .p(px(10.0))
            .track_focus(&focus_handle)
            .on_mouse_down(
                MouseButton::Left,
                move |_: &MouseDownEvent, window: &mut Window, _: &mut App| {
                    click_focus_handle.focus(window);
                    if listens_press {
                        crate::bridge::event(press_element_id, "press");
                    }
                },
            )
            .on_scroll_wheel(
                move |event: &ScrollWheelEvent, window: &mut Window, cx: &mut App| {
                    let rows = scroll_delta_rows(&event.delta, line_height);
                    if rows.abs() < 0.01 || !scroll_terminal_viewport(&scroll_session_id, rows) {
                        return;
                    }
                    window.refresh();
                    cx.stop_propagation();
                },
            )
            .on_key_down(move |event: &KeyDownEvent, _: &mut Window, cx: &mut App| {
                if !listens_key_press || event.keystroke.modifiers.platform {
                    return;
                }
                crate::bridge::key_press(
                    element_id,
                    &js_key(&event.keystroke),
                    event.keystroke.modifiers.shift,
                    event.keystroke.modifiers.control,
                    event.keystroke.modifiers.alt,
                    event.keystroke.modifiers.platform,
                );
                cx.stop_propagation();
            });

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

        let mut child = self.build_child(window, cx);
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
    terminal: Terminal<'static, 'static>,
    render: RenderState<'static>,
    last_seq: u64,
    cols: u16,
    rows: u16,
    scroll_remainder: f32,
    /// Bumped whenever a wheel scroll actually moves the viewport, so the row
    /// cache invalidates even though scrolling doesn't advance `last_seq`.
    scroll_epoch: u64,
    /// Monotonic tick of the last access, for LRU eviction of warm terminals.
    last_used: u64,
    /// Cached output of the last `render_rows()`, with the state it was
    /// computed for. `build_child` runs in `request_layout`, which fires on
    /// EVERY full tree re-render (input-cursor blink, the periodic session
    /// poll, mouse moves, an unrelated scroll, …) — not just when terminal
    /// bytes arrive. Re-running ghostty's `render.update` + full cell
    /// iteration each of those times is wasted O(rows*cols) work and was the
    /// dominant terminal-stage cost. Cache the rows and reuse them whenever
    /// nothing relevant changed.
    cache: Option<RenderCache>,
}

struct RenderCache {
    /// Highest applied frame seq + viewport the rows were rendered for. A
    /// scroll bumps `epoch` so wheel scrolling still re-renders.
    seq: u64,
    cols: u16,
    rows: u16,
    epoch: u64,
    rows_out: Vec<RenderedRow>,
}

#[derive(Clone)]
struct RenderedRow {
    text: String,
    highlights: Vec<RowHighlight>,
}

#[derive(Clone)]
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
    let tick = TERMINAL_CLOCK.with(|clock| {
        let mut clock = clock.borrow_mut();
        *clock = clock.wrapping_add(1);
        *clock
    });
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

        if !terminals.contains_key(&session_id) {
            let Some(state) = TerminalState::new(initial_cols, initial_rows) else {
                return;
            };
            terminals.insert(session_id.clone(), state);
            evict_lru(&mut terminals, &session_id);
        }
        let state = terminals.get_mut(&session_id).expect("terminal inserted");
        state.last_used = tick;
        state.apply_frames(&element.terminal_frames);
        rows = state.rows_for_render().unwrap_or_default();
    });
    rows
}

/// Drop the least-recently-used warm terminals once the map exceeds the cap,
/// never evicting the session being rendered this frame.
fn evict_lru(terminals: &mut HashMap<String, TerminalState>, keep: &str) {
    while terminals.len() > MAX_WARM_TERMINALS {
        let victim = terminals
            .iter()
            .filter(|(id, _)| id.as_str() != keep)
            .min_by_key(|(_, state)| state.last_used)
            .map(|(id, _)| id.clone());
        match victim {
            Some(id) => {
                terminals.remove(&id);
            }
            None => break,
        }
    }
}

impl TerminalState {
    fn new(cols: u16, rows: u16) -> Option<Self> {
        let terminal = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: 5000,
        })
        .ok()?;
        let render = RenderState::new().ok()?;
        Some(Self {
            terminal,
            render,
            last_seq: 0,
            cols,
            rows,
            scroll_remainder: 0.0,
            scroll_epoch: 0,
            last_used: 0,
            cache: None,
        })
    }

    /// Return the rows for this render. Reuses the cached `Vec<RenderedRow>`
    /// when nothing relevant changed since the last `render_rows()`
    /// (same applied seq, same viewport, same scroll epoch), so the common
    /// idle re-render skips ghostty's `render.update` + cell iteration.
    fn rows_for_render(&mut self) -> Result<Vec<RenderedRow>, Box<dyn std::error::Error>> {
        if let Some(cache) = &self.cache
            && cache.seq == self.last_seq
            && cache.cols == self.cols
            && cache.rows == self.rows
            && cache.epoch == self.scroll_epoch
        {
            return Ok(cache.rows_out.clone());
        }
        let rows_out = self.render_rows()?;
        self.cache = Some(RenderCache {
            seq: self.last_seq,
            cols: self.cols,
            rows: self.rows,
            epoch: self.scroll_epoch,
            rows_out: rows_out.clone(),
        });
        Ok(rows_out)
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

fn scroll_terminal_viewport(session_id: &str, rows: f32) -> bool {
    TERMINALS.with(|terminals| {
        let mut terminals = terminals.borrow_mut();
        let Some(state) = terminals.get_mut(session_id) else {
            return false;
        };
        state.scroll_viewport(rows)
    })
}

fn scroll_delta_rows(delta: &ScrollDelta, line_height: f32) -> f32 {
    let line_height = line_height.max(1.0);
    match delta {
        ScrollDelta::Lines(point) => -point.y,
        ScrollDelta::Pixels(point) => {
            let pixels: f32 = point.y.into();
            -pixels / line_height
        }
    }
}

impl TerminalState {
    fn scroll_viewport(&mut self, rows: f32) -> bool {
        self.scroll_remainder += rows;
        let whole = if self.scroll_remainder > 0.0 {
            self.scroll_remainder.floor()
        } else {
            self.scroll_remainder.ceil()
        };
        if whole == 0.0 {
            return false;
        }
        self.terminal
            .scroll_viewport(ScrollViewport::Delta(whole as isize));
        self.scroll_remainder -= whole;
        self.scroll_epoch = self.scroll_epoch.wrapping_add(1);
        true
    }
}

fn terminal_focus_handle(id: u64, cx: &mut App) -> gpui::FocusHandle {
    TERMINAL_FOCUS.with(|handles| {
        let mut handles = handles.borrow_mut();
        handles
            .entry(id)
            .or_insert_with(|| cx.focus_handle().tab_index(0).tab_stop(true))
            .clone()
    })
}

fn js_key(keystroke: &gpui::Keystroke) -> String {
    if keystroke.key == "enter" || keystroke.key_char.as_deref() == Some("\n") {
        "Enter".to_string()
    } else {
        keystroke
            .key_char
            .clone()
            .unwrap_or_else(|| js_named_key(&keystroke.key))
    }
}

fn js_named_key(key: &str) -> String {
    match key {
        "escape" => "Escape",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        other => other,
    }
    .to_string()
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

#[cfg(test)]
mod tests {
    use super::{js_named_key, scroll_delta_rows};
    use gpui::{ScrollDelta, point, px};

    #[test]
    fn maps_gpui_navigation_keys_to_js_names() {
        assert_eq!(js_named_key("escape"), "Escape");
        assert_eq!(js_named_key("tab"), "Tab");
        assert_eq!(js_named_key("backspace"), "Backspace");
        assert_eq!(js_named_key("delete"), "Delete");
        assert_eq!(js_named_key("up"), "ArrowUp");
        assert_eq!(js_named_key("down"), "ArrowDown");
        assert_eq!(js_named_key("left"), "ArrowLeft");
        assert_eq!(js_named_key("right"), "ArrowRight");
        assert_eq!(js_named_key("home"), "Home");
        assert_eq!(js_named_key("end"), "End");
        assert_eq!(js_named_key("pageup"), "PageUp");
        assert_eq!(js_named_key("pagedown"), "PageDown");
    }

    #[test]
    fn maps_scroll_wheel_delta_to_terminal_rows() {
        assert_eq!(
            scroll_delta_rows(&ScrollDelta::Lines(point(0.0, -3.0)), 18.0),
            3.0
        );
        assert_eq!(
            scroll_delta_rows(&ScrollDelta::Pixels(point(px(0.0), px(36.0))), 18.0),
            -2.0
        );
    }

    use super::{MAX_WARM_TERMINALS, TerminalFrame, TerminalFrameKind, TerminalState, evict_lru};
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as B64;
    use std::collections::HashMap;

    fn bytes_frame(seq: u64, text: &str) -> TerminalFrame {
        TerminalFrame {
            seq,
            kind: TerminalFrameKind::Bytes,
            data: Some(B64.encode(text.as_bytes())),
            cols: None,
            rows: None,
        }
    }

    fn row_texts(state: &mut TerminalState) -> Vec<String> {
        state
            .rows_for_render()
            .unwrap()
            .into_iter()
            .map(|r| r.text.trim_end().to_string())
            .collect()
    }

    #[test]
    fn caches_rows_until_a_new_frame_advances_seq() {
        let mut state = TerminalState::new(20, 4).unwrap();
        state.apply_frames(&[bytes_frame(1, "hello")]);

        // first render builds + caches; a second idle render returns the cache.
        let first = row_texts(&mut state);
        assert!(first.iter().any(|l| l.contains("hello")));
        assert!(state.cache.is_some());
        let cached_seq = state.cache.as_ref().unwrap().seq;

        // an idle re-render (no new frames) must reuse the cache: same seq, same rows.
        let second = row_texts(&mut state);
        assert_eq!(first, second);
        assert_eq!(state.cache.as_ref().unwrap().seq, cached_seq);

        // a new frame advances last_seq -> cache misses and rebuilds with new content.
        state.apply_frames(&[bytes_frame(2, "\r\nworld")]);
        let third = row_texts(&mut state);
        assert!(third.iter().any(|l| l.contains("world")));
        assert_eq!(state.cache.as_ref().unwrap().seq, 2);
    }

    #[test]
    fn scroll_invalidates_the_row_cache() {
        let mut state = TerminalState::new(20, 4).unwrap();
        // fill enough lines to have scrollback to move into.
        for seq in 1..=40 {
            state.apply_frames(&[bytes_frame(seq, &format!("line {seq}\r\n"))]);
        }
        let _ = row_texts(&mut state);
        let epoch_before = state.scroll_epoch;
        assert_eq!(state.cache.as_ref().unwrap().epoch, epoch_before);

        // a real scroll bumps the epoch, so the next render must rebuild.
        assert!(state.scroll_viewport(-5.0));
        assert_ne!(state.scroll_epoch, epoch_before);
        let _ = row_texts(&mut state);
        assert_eq!(state.cache.as_ref().unwrap().epoch, state.scroll_epoch);
    }

    #[test]
    fn evict_lru_drops_oldest_and_keeps_active_session() {
        let mut terminals: HashMap<String, TerminalState> = HashMap::new();
        for i in 0..(MAX_WARM_TERMINALS + 3) {
            let mut s = TerminalState::new(20, 4).unwrap();
            s.last_used = i as u64; // session "0" is least-recently-used
            terminals.insert(format!("session-{i}"), s);
        }
        let active = format!("session-{}", MAX_WARM_TERMINALS + 2);
        evict_lru(&mut terminals, &active);

        assert_eq!(terminals.len(), MAX_WARM_TERMINALS);
        assert!(terminals.contains_key(&active), "active session evicted");
        assert!(
            !terminals.contains_key("session-0"),
            "least-recently-used session was not evicted"
        );
    }
}
