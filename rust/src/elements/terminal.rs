use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use gpui::{
    App, Bounds, Display, Element, ElementId, ExternalPaths, FontStyle, FontWeight,
    GlobalElementId, HighlightStyle, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent,
    LayoutId, MouseButton, MouseDownEvent, ParentElement as _, Pixels, ScrollDelta,
    ScrollWheelEvent, StrikethroughStyle, Styled as _, StyledText, UnderlineStyle, Window, div, px,
    rgba,
};
use libghostty_vt::render::{CellIterator, RowIterator};
use libghostty_vt::style::{RgbColor, Underline};
use libghostty_vt::terminal::ScrollViewport;
use libghostty_vt::{RenderState, Terminal, TerminalOptions};

use crate::elements::{
    ReactElement, TerminalFrame, TerminalFrameKind, bounds_have_drawable_area, report_layout,
};

// the inner padding around the terminal grid (matches the root `.p(px(PAD))`).
const PAD: f32 = 10.0;

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
    // imperative session changes sit above the last committed React props until
    // that tree catches up. This keeps the stable host on the native hot path.
    static TERMINAL_PRESENTATIONS: RefCell<HashMap<u64, TerminalPresentation>> = RefCell::new(HashMap::new());
    static TERMINAL_PAINTED_PRESENTATIONS: RefCell<HashMap<u64, PaintedTerminalPresentation>> = RefCell::new(HashMap::new());
    static TERMINAL_FOCUS: RefCell<HashMap<u64, gpui::FocusHandle>> = RefCell::new(HashMap::new());
    static TERMINAL_CLOCK: RefCell<u64> = const { RefCell::new(0) };
    // last (cols, rows) the element measured from its own bounds and reported to
    // JS, per element global_id. The element is the source of truth for size:
    // it measures real font cell metrics against its painted bounds, so the grid
    // fits the stage exactly instead of relying on a JS pixel-per-col guess.
    static TERMINAL_MEASURED: RefCell<HashMap<u64, (u16, u16)>> = RefCell::new(HashMap::new());
}

// Keep at most this many warm per-session terminals; evict least-recently-used.
const MAX_WARM_TERMINALS: usize = 12;

struct TerminalPresentation {
    session_id: String,
    frames: Arc<Vec<TerminalFrame>>,
    last_seq: u64,
}

#[derive(Clone)]
pub struct PaintedTerminalPresentation {
    pub session_id: String,
    pub frame_count: usize,
    pub paint_count: u64,
}

pub fn present_session(global_id: u64, session_id: String, frames: Vec<TerminalFrame>) {
    let last_seq = frames.last().map(|frame| frame.seq).unwrap_or(0);
    TERMINAL_PRESENTATIONS.with(|presentations| {
        presentations.borrow_mut().insert(
            global_id,
            TerminalPresentation {
                session_id,
                frames: Arc::new(frames),
                last_seq,
            },
        );
    });
}

pub fn retain_presentations(present: &HashSet<u64>) {
    TERMINAL_PRESENTATIONS.with(|presentations| {
        presentations
            .borrow_mut()
            .retain(|global_id, _| present.contains(global_id));
    });
    TERMINAL_PAINTED_PRESENTATIONS.with(|presentations| {
        presentations
            .borrow_mut()
            .retain(|global_id, _| present.contains(global_id));
    });
}

pub fn painted_presentation(global_id: u64) -> Option<PaintedTerminalPresentation> {
    TERMINAL_PAINTED_PRESENTATIONS
        .with(|presentations| presentations.borrow().get(&global_id).cloned())
}

fn note_painted(global_id: u64, session_id: &str, frame_count: usize) {
    TERMINAL_PAINTED_PRESENTATIONS.with(|presentations| {
        let mut presentations = presentations.borrow_mut();
        let paint_count = presentations
            .get(&global_id)
            .map_or(1, |presentation| presentation.paint_count.wrapping_add(1));
        presentations.insert(
            global_id,
            PaintedTerminalPresentation {
                session_id: session_id.to_string(),
                frame_count,
                paint_count,
            },
        );
    });
}

pub fn effective_presentation(element: &ReactElement) -> (String, usize) {
    let (session_id, frames) = resolve_presentation(element);
    (
        session_id,
        frames
            .as_ref()
            .map_or(element.terminal_frames.len(), |frames| frames.len()),
    )
}

fn resolve_presentation(element: &ReactElement) -> (String, Option<Arc<Vec<TerminalFrame>>>) {
    let authored_session_id = element
        .terminal_session_id
        .clone()
        .unwrap_or_else(|| "__terminal__".to_string());
    let authored_last_seq = element
        .terminal_frames
        .last()
        .map(|frame| frame.seq)
        .unwrap_or(0);
    TERMINAL_PRESENTATIONS.with(|presentations| {
        let mut presentations = presentations.borrow_mut();
        let caught_up = presentations
            .get(&element.global_id)
            .is_some_and(|presentation| {
                authored_session_id == presentation.session_id
                    && authored_last_seq >= presentation.last_seq
            });
        if caught_up {
            presentations.remove(&element.global_id);
        }
        presentations
            .get(&element.global_id)
            .map(|presentation| {
                (
                    presentation.session_id.clone(),
                    Some(presentation.frames.clone()),
                )
            })
            .unwrap_or((authored_session_id, None))
    })
}

pub struct ReactGhosttyTerminalElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    child: Option<gpui::AnyElement>,
    presented_session_id: String,
    presented_frame_count: usize,
}

impl ReactGhosttyTerminalElement {
    pub fn new(element: Arc<ReactElement>, window_id: u64) -> Self {
        Self {
            element,
            _window_id: window_id,
            child: None,
            presented_session_id: String::new(),
            presented_frame_count: 0,
        }
    }

    fn build_child(&mut self, window: &mut Window, cx: &mut App) -> gpui::AnyElement {
        let (scroll_session_id, frame_count, rows, translate_y) = terminal_rows(
            &self.element,
            self.element.style.line_height.unwrap_or(18.0),
        );
        self.presented_session_id = scroll_session_id.clone();
        self.presented_frame_count = frame_count;
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
        let listens_text = self.element.listens("terminalText");
        let element_id = self.element.global_id;
        let press_element_id = element_id;
        let drop_element_id = element_id;
        // the element's resolved corner radii. The outer `style.paint` (in this
        // element's `paint`) already paints a rounded background + drop shadow from
        // `corner_radii`, but this inner root paints its OWN `size_full` background
        // that would square those corners back off — so it must round to the SAME
        // radii. That also turns its `overflow_hidden` into a rounded clip, so the
        // grid text never paints past the rounded edge.
        let (r_tl, r_tr, r_bl, r_br) = terminal_corner_radii(style);
        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(background);
        if r_tl > 0.0 {
            root = root.rounded_tl(px(r_tl));
        }
        if r_tr > 0.0 {
            root = root.rounded_tr(px(r_tr));
        }
        if r_bl > 0.0 {
            root = root.rounded_bl(px(r_bl));
        }
        if r_br > 0.0 {
            root = root.rounded_br(px(r_br));
        }
        let root = root
            .p(px(PAD))
            .track_focus(&focus_handle)
            // give the focused terminal a "Terminal" key context (parallel to gpui-component's
            // "Input" on text fields). App-level bare-key bindings (enter/tab/arrows) scope
            // themselves `!Input && !Terminal` so they never intercept a key the terminal owns
            // and forwards to the PTY — otherwise a bare `enter` binding (focus.activate) eats
            // the terminal's submit while every unbound key still types through.
            .key_context("Terminal")
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
                    let dy = scroll_delta_pixels(&event.delta, line_height);
                    if dy.abs() < 0.01 || !scroll_terminal_pixels(&scroll_session_id, dy) {
                        return;
                    }
                    window.refresh();
                    cx.stop_propagation();
                },
            )
            .on_key_down(move |event: &KeyDownEvent, _: &mut Window, cx: &mut App| {
                let keystroke = &event.keystroke;
                let modifiers = keystroke.modifiers;
                // Cmd+V: paste the macOS clipboard straight into the PTY. The
                // raw keystroke path below drops every Cmd chord (those belong to
                // the app's menu/command layer), so paste has to be special-cased
                // here or it never reaches the terminal.
                if modifiers.platform
                    && !modifiers.control
                    && !modifiers.alt
                    && keystroke.key == "v"
                {
                    if listens_text
                        && let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
                        && !text.is_empty()
                    {
                        crate::bridge::terminal_text(element_id, &text);
                        cx.stop_propagation();
                    }
                    return;
                }
                // Other Cmd chords stay with the app (menus/shortcuts). Plain
                // keys, Ctrl chords (Ctrl-W &c.), and Alt chords forward to the
                // PTY through the keymap path.
                if !listens_key_press || modifiers.platform {
                    return;
                }
                crate::bridge::key_press(
                    element_id,
                    &js_key(keystroke),
                    modifiers.shift,
                    modifiers.control,
                    modifiers.alt,
                    modifiers.platform,
                    false,
                );
                cx.stop_propagation();
            })
            .on_drop::<ExternalPaths>(
                move |paths: &ExternalPaths, window: &mut Window, _: &mut App| {
                    if !listens_text {
                        return;
                    }
                    let payload = quote_dropped_paths(paths.paths());
                    if !payload.is_empty() {
                        crate::bridge::terminal_text(drop_element_id, &payload);
                        window.refresh();
                    }
                },
            );

        if rows.is_empty() {
            return root
                .text_color(color_from_hex(0xa1a1aa))
                .text_size(px(font_size))
                .font_family(font_family)
                .child("waiting for terminal snapshot")
                .into_any_element();
        }

        // the grid lives in an inner column so the sub-row scroll offset
        // (translate_y, 0..-line_height) can slide it smoothly inside the clipped
        // root without moving the background/padding. translate_y is 0 while
        // pinned to the live tail (the fast path).
        let mut grid = div().flex().flex_col();
        if translate_y.abs() > 0.01 {
            grid = grid.mt(px(translate_y));
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
            grid = grid.child(
                div()
                    .h(px(line_height))
                    .whitespace_nowrap()
                    .text_size(px(font_size))
                    .line_height(px(line_height))
                    .font_family(font_family.clone())
                    .child(line),
            );
        }

        root.child(grid).into_any_element()
    }

    /// Measure the available grid from the painted bounds and the real font cell
    /// advance, then report the resulting (cols, rows) to JS so it can size the
    /// PTY. This is the single source of truth for terminal size: the grid fits
    /// the stage exactly instead of trusting a JS pixels-per-column estimate.
    fn measure_viewport(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        if !self.element.listens("terminalViewport") {
            return;
        }
        let style = &self.element.style;
        let font_size = style.font_size.unwrap_or(12.0);
        let line_height = style.line_height.unwrap_or(18.0).max(1.0);
        let font_family = style.gpui_font_family().unwrap_or_else(|| "Menlo".into());
        let font = gpui::font(font_family);
        let text_system = window.text_system();
        let font_id = text_system.resolve_font(&font);
        let cell_width: f32 = text_system
            .em_advance(font_id, px(font_size))
            .map(Into::into)
            .unwrap_or(font_size * 0.6)
            .max(1.0);

        let width: f32 = bounds.size.width.into();
        let height: f32 = bounds.size.height.into();
        let cols = (((width - PAD * 2.0).max(0.0)) / cell_width)
            .floor()
            .max(2.0) as u16;
        let rows = (((height - PAD * 2.0).max(0.0)) / line_height)
            .floor()
            .max(1.0) as u16;

        let id = self.element.global_id;
        let changed = TERMINAL_MEASURED.with(|measured| {
            let mut measured = measured.borrow_mut();
            if measured.get(&id) == Some(&(cols, rows)) {
                return false;
            }
            measured.insert(id, (cols, rows));
            true
        });
        if changed {
            crate::bridge::terminal_viewport(id, cols, rows);
        }
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

        self.measure_viewport(bounds, window);

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
        note_painted(
            self.element.global_id,
            &self.presented_session_id,
            self.presented_frame_count,
        );
    }
}

struct TerminalState {
    terminal: Terminal<'static, 'static>,
    render: RenderState<'static>,
    last_seq: u64,
    cols: u16,
    rows: u16,
    /// Pixel height of one rendered row, kept in sync with the element style so
    /// the wheel handler (which only has the style line height) and the renderer
    /// agree on the px<->row mapping.
    line_height: f32,
    /// Pixels scrolled up from the live tail. 0 == following the bottom (new
    /// output keeps the view pinned); > 0 == parked in scrollback.
    scroll_px: f32,
    /// The ghostty viewport's current whole-row offset from the bottom. Tracked
    /// so `position_viewport` knows where it left the viewport.
    settled_rows: u16,
    /// Monotonic tick of the last access, for LRU eviction of warm terminals.
    last_used: u64,
    /// Cached output of the last `render_rows()`, with the state it was computed
    /// for. `build_child` runs in `request_layout`, which fires on EVERY full
    /// tree re-render (input-cursor blink, the periodic session poll, mouse
    /// moves, …) — not just when terminal bytes arrive. Re-running ghostty's
    /// `render.update` + full cell iteration each time is wasted O(rows*cols)
    /// work. Cache the rows and reuse them whenever nothing relevant changed.
    cache: Option<RenderCache>,
}

struct RenderCache {
    /// Highest applied frame seq + viewport + scrollback position the rows were
    /// rendered for. The sub-row pixel offset is NOT part of the key: it only
    /// affects the paint-time translate, so smooth scrolling within one row
    /// reuses the cached rows.
    seq: u64,
    cols: u16,
    rows: u16,
    settled: u16,
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

/// Build the rows to display plus the sub-row pixel translate to apply. Returns
/// `(rows, translate_y)` where translate_y is 0 while pinned to the bottom and
/// in `(-line_height, 0]` while scrolled (slides the grid up so the extra
/// history row prepended at the top fills in smoothly).
fn terminal_rows(
    element: &ReactElement,
    line_height: f32,
) -> (String, usize, Vec<RenderedRow>, f32) {
    let (session_id, presented_frames) = resolve_presentation(element);
    let frames = presented_frames
        .as_ref()
        .map(|frames| frames.as_slice())
        .unwrap_or(element.terminal_frames.as_slice());
    let mut result = (Vec::new(), 0.0);
    let tick = TERMINAL_CLOCK.with(|clock| {
        let mut clock = clock.borrow_mut();
        *clock = clock.wrapping_add(1);
        *clock
    });
    TERMINALS.with(|terminals| {
        let mut terminals = terminals.borrow_mut();
        let initial_cols = frames
            .iter()
            .rev()
            .find_map(|frame| frame.cols)
            .unwrap_or(100);
        let initial_rows = frames
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
        state.line_height = line_height.max(1.0);
        state.apply_frames(frames);
        result = state.rows_for_render().unwrap_or((Vec::new(), 0.0));
    });
    (session_id, frames.len(), result.0, result.1)
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
            line_height: 18.0,
            scroll_px: 0.0,
            settled_rows: 0,
            last_used: 0,
            cache: None,
        })
    }

    fn following(&self) -> bool {
        self.scroll_px <= 0.5
    }

    fn scrollback_rows(&self) -> usize {
        self.terminal.scrollback_rows().unwrap_or(0)
    }

    /// Apply an incoming pixel scroll delta (dy > 0 reveals history). Returns
    /// whether the scroll position actually moved.
    fn scroll_pixels(&mut self, dy: f32) -> bool {
        let max_px = self.scrollback_rows() as f32 * self.line_height.max(1.0);
        let next = (self.scroll_px + dy).clamp(0.0, max_px);
        if (next - self.scroll_px).abs() < 0.01 {
            return false;
        }
        self.scroll_px = next;
        true
    }

    /// Move the ghostty viewport to `settled` whole rows up from the bottom,
    /// using Bottom as a known reference so it is correct regardless of where the
    /// viewport was left (e.g. after output auto-scrolled it).
    fn position_viewport(&mut self, settled: u16) {
        self.terminal.scroll_viewport(ScrollViewport::Bottom);
        if settled > 0 {
            self.terminal
                .scroll_viewport(ScrollViewport::Delta(-(settled as isize)));
        }
        self.settled_rows = settled;
    }

    /// Return the rows to display + the sub-row translate. Reuses the cached
    /// rows when the seq/size/scrollback position are unchanged; the translate
    /// is always recomputed from the live pixel offset so smooth scrolling
    /// within a single row stays cheap.
    fn rows_for_render(&mut self) -> Result<(Vec<RenderedRow>, f32), Box<dyn std::error::Error>> {
        let line_height = self.line_height.max(1.0);
        let scrollback = self.scrollback_rows();
        let max_px = scrollback as f32 * line_height;
        self.scroll_px = self.scroll_px.clamp(0.0, max_px);

        if self.following() {
            // fast path: pinned to the live tail.
            let rows = self.cached_or_render(0, |state| {
                state.position_viewport(0);
                state.render_rows()
            })?;
            return Ok((rows, 0.0));
        }

        let settled = ((self.scroll_px / line_height).floor() as usize).min(scrollback) as u16;
        let frac = self.scroll_px - settled as f32 * line_height;

        // the row just above the settled viewport, fetched by rendering one row
        // higher, so the grid can slide it in as `frac` grows toward a full row.
        let has_extra = (settled as usize) < scrollback;
        let translate = if has_extra {
            -(line_height - frac)
        } else {
            0.0
        };

        let rows = self.cached_or_render(settled, |state| {
            let extra_top = if has_extra {
                state.position_viewport(settled + 1);
                state.render_rows()?.into_iter().next()
            } else {
                None
            };
            state.position_viewport(settled);
            let main = state.render_rows()?;
            let mut out = Vec::with_capacity(main.len() + 1);
            if let Some(top) = extra_top {
                out.push(top);
            }
            out.extend(main);
            Ok(out)
        })?;

        Ok((rows, translate))
    }

    fn cached_or_render(
        &mut self,
        settled: u16,
        build: impl FnOnce(&mut Self) -> Result<Vec<RenderedRow>, Box<dyn std::error::Error>>,
    ) -> Result<Vec<RenderedRow>, Box<dyn std::error::Error>> {
        if let Some(cache) = &self.cache
            && cache.seq == self.last_seq
            && cache.cols == self.cols
            && cache.rows == self.rows
            && cache.settled == settled
        {
            return Ok(cache.rows_out.clone());
        }
        let rows_out = build(self)?;
        self.cache = Some(RenderCache {
            seq: self.last_seq,
            cols: self.cols,
            rows: self.rows,
            settled,
            rows_out: rows_out.clone(),
        });
        Ok(rows_out)
    }

    fn apply_frames(&mut self, frames: &[TerminalFrame]) {
        let before_total = self.terminal.total_rows().unwrap_or(0);
        let mut wrote = false;
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
                    wrote = true;
                }
                TerminalFrameKind::Bytes => {
                    self.resize_if_needed(frame.cols, frame.rows);
                    if let Some(bytes) = decode_frame(frame) {
                        self.terminal.vt_write(&bytes);
                    }
                    wrote = true;
                }
                TerminalFrameKind::Resize => {
                    self.resize_if_needed(frame.cols, frame.rows);
                }
            }
            self.last_seq = frame.seq;
        }
        if wrote {
            if self.following() {
                // keep the view pinned to the live tail as output streams in.
                // ghostty only auto-follows if the viewport is already at the
                // bottom, so pin it explicitly when the user hasn't scrolled away.
                self.scroll_px = 0.0;
                self.position_viewport(0);
            } else {
                // parked in scrollback: keep the SAME content in view as new
                // lines push the bottom down, instead of letting the view drift.
                let after_total = self.terminal.total_rows().unwrap_or(before_total);
                let added = after_total.saturating_sub(before_total);
                if added > 0 {
                    let max_px = self.scrollback_rows() as f32 * self.line_height.max(1.0);
                    self.scroll_px = (self.scroll_px + added as f32 * self.line_height).min(max_px);
                }
            }
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
            // a reflow leaves the viewport at an arbitrary spot, which showed up
            // as stale "garbage" rows below the real content. Snap back to the
            // live tail so the prompt is where it belongs.
            self.scroll_px = 0.0;
            self.position_viewport(0);
            self.cache = None;
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

fn scroll_terminal_pixels(session_id: &str, dy: f32) -> bool {
    TERMINALS.with(|terminals| {
        let mut terminals = terminals.borrow_mut();
        let Some(state) = terminals.get_mut(session_id) else {
            return false;
        };
        state.scroll_pixels(dy)
    })
}

/// Convert a wheel/trackpad delta into pixels of terminal scroll. Trackpad
/// deltas arrive as pixels (with the OS momentum tail) and pass straight
/// through; wheel "lines" become whole rows. GPUI reports the content-motion
/// delta, while the terminal tracks distance upward from the live tail, so the
/// signs are opposite: a natural upward gesture must increase scrollback.
fn scroll_delta_pixels(delta: &ScrollDelta, line_height: f32) -> f32 {
    let line_height = line_height.max(1.0);
    match delta {
        ScrollDelta::Lines(point) => -point.y * line_height,
        ScrollDelta::Pixels(point) => -f32::from(point.y),
    }
}

/// Shell-quote dropped file paths the way a real terminal does, so the dropped
/// text can be used as an argument. Single-quote wrap, escaping embedded quotes.
fn quote_dropped_paths(paths: &[std::path::PathBuf]) -> String {
    let mut out = String::new();
    for path in paths {
        let raw = path.to_string_lossy();
        if !out.is_empty() {
            out.push(' ');
        }
        if raw.is_empty() {
            continue;
        }
        out.push('\'');
        out.push_str(&raw.replace('\'', "'\\''"));
        out.push('\'');
    }
    if !out.is_empty() {
        out.push(' ');
    }
    out
}

/// Resolve the four corner radii (top-left, top-right, bottom-left, bottom-right)
/// from the element style: per-corner overrides fall back to the `borderRadius`
/// shorthand, else 0. Mirrors the webview's `webview_corner_clip` so the terminal
/// rounds to the same radius the stage card uses.
fn terminal_corner_radii(style: &crate::style::ElementStyle) -> (f32, f32, f32, f32) {
    let r = style.border_radius;
    (
        style.border_top_left_radius.or(r).unwrap_or(0.0).max(0.0),
        style.border_top_right_radius.or(r).unwrap_or(0.0).max(0.0),
        style
            .border_bottom_left_radius
            .or(r)
            .unwrap_or(0.0)
            .max(0.0),
        style
            .border_bottom_right_radius
            .or(r)
            .unwrap_or(0.0)
            .max(0.0),
    )
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
    use super::{js_named_key, quote_dropped_paths, scroll_delta_pixels};
    use gpui::{ScrollDelta, point, px};
    use std::path::PathBuf;

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
    fn natural_wheel_direction_reveals_terminal_history() {
        // GPUI's negative content-motion delta for a natural upward trackpad
        // gesture becomes positive distance into terminal scrollback.
        assert_eq!(
            scroll_delta_pixels(&ScrollDelta::Pixels(point(px(0.0), px(-7.5))), 18.0),
            7.5
        );
        // wheel lines use the same direction and map to whole terminal rows.
        assert_eq!(
            scroll_delta_pixels(&ScrollDelta::Lines(point(0.0, -3.0)), 18.0),
            54.0
        );
    }

    #[test]
    fn quotes_dropped_paths_for_the_shell() {
        assert_eq!(
            quote_dropped_paths(&[PathBuf::from("/tmp/a b.txt")]),
            "'/tmp/a b.txt' "
        );
        assert_eq!(
            quote_dropped_paths(&[PathBuf::from("/a"), PathBuf::from("/b")]),
            "'/a' '/b' "
        );
        assert_eq!(
            quote_dropped_paths(&[PathBuf::from("/it's")]),
            "'/it'\\''s' "
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
            .0
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
    fn scrolling_up_parks_in_history_then_following_returns_to_bottom() {
        let mut state = TerminalState::new(20, 4).unwrap();
        state.line_height = 18.0;
        for seq in 1..=40 {
            state.apply_frames(&[bytes_frame(seq, &format!("line {seq}\r\n"))]);
        }
        // streaming output keeps us pinned to the live tail.
        assert!(state.following());
        let (_, translate) = state.rows_for_render().unwrap();
        assert_eq!(translate, 0.0);

        // scrolling up by a few rows parks in scrollback with a sub-row offset.
        assert!(state.scroll_pixels(45.0));
        assert!(!state.following());
        let (_, translate) = state.rows_for_render().unwrap();
        assert!(
            translate < 0.0 && translate > -18.0,
            "translate={translate}"
        );

        // scrolling back to the bottom re-follows; new output snaps to the tail.
        assert!(state.scroll_pixels(-1000.0));
        assert!(state.following());
        state.apply_frames(&[bytes_frame(41, "line 41\r\n")]);
        assert!(state.following());
        assert_eq!(state.scroll_px, 0.0);
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
