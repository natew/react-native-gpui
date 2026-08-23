use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ops::Range;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, Display, Element, ElementId, GlobalElementId, HighlightStyle, Hsla,
    IntoElement, LayoutId, MouseButton, MouseDownEvent, ParentElement as _, Pixels,
    ScrollWheelEvent, Styled as _, StyledText, Window, div, px,
};

use crate::elements::{ReactElement, bounds_have_drawable_area, report_layout};

const MAX_DIFF_BYTES: usize = 16 * 1024 * 1024;
const MAX_DIFF_LINES: usize = 250_000;
const OVERSCAN_LINES: usize = 12;
const MAX_CACHED_ROWS_PER_DIFF: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiffKind {
    File,
    Hunk,
    Context,
    Addition,
    Deletion,
    Metadata,
    ShowMore,
}

#[derive(Clone, Debug, PartialEq)]
struct DiffRow {
    range: Range<usize>,
    kind: DiffKind,
    old_line: Option<u32>,
    new_line: Option<u32>,
    path: Option<Arc<str>>,
    word_range: Option<Range<usize>>,
}

#[derive(Clone, PartialEq)]
pub struct DiffPayload {
    source: Arc<str>,
    rows: Arc<[DiffRow]>,
    pub word_diff: bool,
    pub diff_scroll: bool,
    pub truncated: bool,
}

impl DiffPayload {
    pub fn parse(
        mut patch: String,
        word_diff: bool,
        collapsed_paths: &HashSet<String>,
        diff_scroll: bool,
        max_lines: usize,
    ) -> Self {
        let original_bytes = patch.len();
        let mut source_end = original_bytes.min(MAX_DIFF_BYTES);
        while !patch.is_char_boundary(source_end) {
            source_end -= 1;
        }
        patch.truncate(source_end);
        let source: Arc<str> = Arc::from(patch);
        let requested_lines = max_lines.clamp(1, MAX_DIFF_LINES);
        let mut rows = Vec::with_capacity(requested_lines.min(4096));
        let mut old_line = None;
        let mut new_line = None;
        let mut current_path: Option<Arc<str>> = None;
        let mut collapsed = false;
        let mut offset = 0usize;

        while offset < source.len() && rows.len() < requested_lines {
            let end = source[offset..]
                .find('\n')
                .map_or(source.len(), |relative| offset + relative + 1);
            let line = source[offset..end].trim_end_matches('\n');
            let mut kind = DiffKind::Metadata;
            let mut row_old = None;
            let mut row_new = None;

            if line.starts_with("diff --git ") {
                current_path = parse_file_path(line).map(Arc::from);
                collapsed = current_path
                    .as_deref()
                    .is_some_and(|path| collapsed_paths.contains(path));
                kind = DiffKind::File;
                old_line = None;
                new_line = None;
            } else if collapsed {
                offset = end;
                continue;
            } else if line.starts_with("@@") {
                if let Some((old, new)) = parse_hunk_header(line) {
                    old_line = Some(old);
                    new_line = Some(new);
                }
                kind = DiffKind::Hunk;
            } else if line.starts_with('+') && !line.starts_with("+++") {
                kind = DiffKind::Addition;
                row_new = new_line;
                new_line = new_line.map(|line| line.saturating_add(1));
            } else if line.starts_with('-') && !line.starts_with("---") {
                kind = DiffKind::Deletion;
                row_old = old_line;
                old_line = old_line.map(|line| line.saturating_add(1));
            } else if line.starts_with(' ') {
                kind = DiffKind::Context;
                row_old = old_line;
                row_new = new_line;
                old_line = old_line.map(|line| line.saturating_add(1));
                new_line = new_line.map(|line| line.saturating_add(1));
            }

            rows.push(DiffRow {
                range: offset..end,
                kind,
                old_line: row_old,
                new_line: row_new,
                path: (kind == DiffKind::File)
                    .then(|| current_path.clone())
                    .flatten(),
                word_range: None,
            });
            offset = end;
        }

        if word_diff {
            annotate_word_changes(&source, &mut rows);
        }
        let truncated = offset < source.len() || original_bytes > source.len();
        if truncated {
            rows.push(DiffRow {
                range: 0..0,
                kind: DiffKind::ShowMore,
                old_line: None,
                new_line: None,
                path: None,
                word_range: None,
            });
        }
        Self {
            source,
            rows: rows.into(),
            word_diff,
            diff_scroll,
            truncated,
        }
    }

    fn text(&self, row: &DiffRow) -> &str {
        if row.kind == DiffKind::ShowMore {
            "Show more…"
        } else {
            self.source[row.range.clone()].trim_end_matches('\n')
        }
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    pub fn source(&self) -> &str {
        &self.source
    }
}

fn parse_file_path(line: &str) -> Option<&str> {
    let path = line.split_whitespace().nth(3)?;
    Some(path.strip_prefix("b/").unwrap_or(path))
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let mut parts = line.split_whitespace();
    parts.next()?;
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    let start = |part: &str| part.split(',').next()?.parse().ok();
    Some((start(old)?, start(new)?))
}

fn annotate_word_changes(source: &str, rows: &mut [DiffRow]) {
    let mut index = 0;
    while index + 1 < rows.len() {
        if rows[index].kind != DiffKind::Deletion || rows[index + 1].kind != DiffKind::Addition {
            index += 1;
            continue;
        }
        let old = source[rows[index].range.clone()]
            .trim_end_matches('\n')
            .strip_prefix('-')
            .unwrap_or("");
        let new = source[rows[index + 1].range.clone()]
            .trim_end_matches('\n')
            .strip_prefix('+')
            .unwrap_or("");
        let prefix = old
            .char_indices()
            .zip(new.chars())
            .take_while(|((_, left), right)| left == right)
            .map(|((offset, character), _)| offset + character.len_utf8())
            .last()
            .unwrap_or(0);
        let suffix = old[prefix..]
            .char_indices()
            .rev()
            .zip(new[prefix..].chars().rev())
            .take_while(|((_, left), right)| left == right)
            .map(|((offset, _), _)| old.len() - prefix - offset)
            .last()
            .unwrap_or(0)
            .min(old.len().saturating_sub(prefix))
            .min(new.len().saturating_sub(prefix));
        rows[index].word_range = Some(prefix + 1..1 + old.len().saturating_sub(suffix));
        rows[index + 1].word_range = Some(prefix + 1..1 + new.len().saturating_sub(suffix));
        index += 2;
    }
}

#[derive(Default)]
struct DiffState {
    scroll_y: f32,
    max_scroll_y: f32,
    payload_rows: Option<Arc<[DiffRow]>>,
    rows: HashMap<usize, gpui::SharedString>,
    row_lru: VecDeque<usize>,
}

thread_local! {
    static STATES: RefCell<HashMap<u64, DiffState>> = RefCell::new(HashMap::new());
}

pub fn retain_diff_state(present: &HashSet<u64>) {
    STATES.with(|states| states.borrow_mut().retain(|id, _| present.contains(id)));
}

pub fn scroll_diff_by(id: u64, delta_y: f32) -> bool {
    STATES.with(|states| {
        let mut states = states.borrow_mut();
        let Some(state) = states.get_mut(&id) else {
            return false;
        };
        state.scroll_y = (state.scroll_y - delta_y).clamp(0.0, state.max_scroll_y);
        true
    })
}

fn display_row(id: u64, index: usize, row: &DiffRow, payload: &DiffPayload) -> gpui::SharedString {
    STATES.with(|states| {
        let mut states = states.borrow_mut();
        let state = states.entry(id).or_default();
        if !state
            .payload_rows
            .as_ref()
            .is_some_and(|rows| Arc::ptr_eq(rows, &payload.rows))
        {
            state.payload_rows = Some(payload.rows.clone());
            state.rows.clear();
            state.row_lru.clear();
        }
        if let Some(text) = state.rows.get(&index).cloned() {
            return text;
        }
        let old = row
            .old_line
            .map_or_else(String::new, |line| line.to_string());
        let new = row
            .new_line
            .map_or_else(String::new, |line| line.to_string());
        let text = gpui::SharedString::from(format!("{old:>6} {new:>6} │ {}", payload.text(row)));
        state.rows.insert(index, text.clone());
        state.row_lru.push_back(index);
        while state.row_lru.len() > MAX_CACHED_ROWS_PER_DIFF {
            if let Some(victim) = state.row_lru.pop_front() {
                state.rows.remove(&victim);
            }
        }
        text
    })
}

#[derive(Clone, Copy)]
struct DiffPalette {
    surface: Hsla,
    foreground: Hsla,
    addition: Hsla,
    deletion: Hsla,
    file: Hsla,
    hunk: Hsla,
    show_more: Hsla,
    addition_word: Hsla,
    deletion_word: Hsla,
}

fn diff_palette(element: &ReactElement, window: &Window) -> DiffPalette {
    let dark = matches!(
        window.appearance(),
        gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark
    );
    let surface = element.style.background_color.unwrap_or_else(|| {
        if dark {
            gpui::rgba(0x111216ff).into()
        } else {
            gpui::rgba(0xffffffff).into()
        }
    });
    let foreground = element.style.color.unwrap_or_else(|| {
        if dark {
            gpui::rgba(0xc8cbd1ff).into()
        } else {
            gpui::rgba(0x1f2328ff).into()
        }
    });
    let overlay = |color| surface.blend(Hsla::from(gpui::rgba(color)));
    DiffPalette {
        surface,
        foreground,
        addition: overlay(if dark { 0x2da44e2e } else { 0x1a7f3730 }),
        deletion: overlay(if dark { 0xf8514938 } else { 0xcf222e29 }),
        file: overlay(if dark { 0x8b949e1f } else { 0x57606a14 }),
        hunk: overlay(if dark { 0x388bfd38 } else { 0x0969da24 }),
        show_more: overlay(if dark { 0x8b949e24 } else { 0x57606a1f }),
        addition_word: overlay(if dark { 0x2ea04380 } else { 0x2da44e61 }),
        deletion_word: overlay(if dark { 0xf8514980 } else { 0xcf222e52 }),
    }
}

fn row_colors(kind: DiffKind, palette: DiffPalette) -> (Hsla, Hsla) {
    match kind {
        DiffKind::Addition => (palette.addition, palette.foreground),
        DiffKind::Deletion => (palette.deletion, palette.foreground),
        DiffKind::File => (palette.file, palette.foreground),
        DiffKind::Hunk => (palette.hunk, palette.foreground),
        DiffKind::ShowMore => (palette.show_more, palette.foreground),
        DiffKind::Context | DiffKind::Metadata => (palette.surface, palette.foreground),
    }
}

pub struct ReactDiffElement {
    element: Arc<ReactElement>,
    child: Option<AnyElement>,
    layouts: Vec<(u64, gpui::TextLayout)>,
    line_height: f32,
    visible_start: usize,
    internal_scroll_y: f32,
}

impl ReactDiffElement {
    pub fn new(element: Arc<ReactElement>) -> Self {
        Self {
            element,
            child: None,
            layouts: Vec::new(),
            line_height: 18.0,
            visible_start: 0,
            internal_scroll_y: 0.0,
        }
    }

    fn build_child(&mut self, window: &mut Window) -> AnyElement {
        let Some(payload) = self.element.diff_payload() else {
            return div().into_any_element();
        };
        let font_size = self.element.style.font_size.unwrap_or(12.0);
        self.line_height = self
            .element
            .style
            .line_height
            .unwrap_or((font_size * 1.5).ceil())
            .max(1.0);
        let cached_layout = crate::bridge::cached_layout(self.element.global_id);
        let viewport_height = cached_layout
            .map(|(_, _, _, height)| height)
            .filter(|height| *height > 0.0)
            .unwrap_or_else(|| f32::from(window.viewport_size().height));
        let external_scroll = cached_layout
            .map(|(_, y, _, _)| (-y).max(0.0))
            .unwrap_or(0.0);
        let own_scroll = STATES.with(|states| {
            let mut states = states.borrow_mut();
            let state = states.entry(self.element.global_id).or_default();
            state.max_scroll_y =
                (payload.rows.len() as f32 * self.line_height - viewport_height).max(0.0);
            state.scroll_y = state.scroll_y.clamp(0.0, state.max_scroll_y);
            state.scroll_y
        });
        let scroll_y = if payload.diff_scroll {
            own_scroll
        } else {
            external_scroll
        };
        self.internal_scroll_y = if payload.diff_scroll { scroll_y } else { 0.0 };
        let first = (scroll_y / self.line_height).floor().max(0.0) as usize;
        let visible = (viewport_height / self.line_height).ceil() as usize;
        self.visible_start = first.saturating_sub(OVERSCAN_LINES);
        let end = (first + visible + OVERSCAN_LINES).min(payload.rows.len());
        self.layouts.clear();

        let mut rows = div()
            .absolute()
            .top(px(
                self.visible_start as f32 * self.line_height - self.internal_scroll_y
            ))
            .left(px(0.0))
            .right(px(0.0))
            .flex()
            .flex_col();
        let family = self
            .element
            .style
            .gpui_font_family()
            .unwrap_or_else(|| "Menlo".into());
        let palette = diff_palette(&self.element, window);
        for index in self.visible_start..end {
            let row = &payload.rows[index];
            let (background, foreground) = row_colors(row.kind, palette);
            let text = display_row(self.element.global_id, index, row, payload);
            let mut text_style = window.text_style();
            text_style.color = foreground;
            text_style.font_size = px(font_size).into();
            text_style.line_height = px(self.line_height).into();
            text_style.font_family = family.clone();
            let highlights = row.word_range.as_ref().and_then(|range| {
                let prefix = text.len().saturating_sub(payload.text(row).len());
                let start = prefix + range.start;
                let end = (prefix + range.end).min(text.len());
                (start < end).then_some((
                    start..end,
                    HighlightStyle {
                        background_color: Some(match row.kind {
                            DiffKind::Addition => palette.addition_word,
                            DiffKind::Deletion => palette.deletion_word,
                            _ => background,
                        }),
                        ..Default::default()
                    },
                ))
            });
            let styled =
                StyledText::new(text).with_default_highlights(&text_style, highlights.into_iter());
            self.layouts.push((
                self.element
                    .global_id
                    .wrapping_mul(1_000_003)
                    .wrapping_add(index as u64),
                styled.layout().clone(),
            ));
            rows = rows.child(
                div()
                    .h(px(self.line_height))
                    .flex_none()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .bg(background)
                    .text_color(foreground)
                    .text_size(px(font_size))
                    .line_height(px(self.line_height))
                    .font_family(family.clone())
                    .child(styled),
            );
        }
        let container = div().relative().overflow_hidden();
        if payload.diff_scroll {
            container.size_full().child(rows).into_any_element()
        } else {
            container
                .h(px(payload.rows.len() as f32 * self.line_height))
                .child(rows)
                .into_any_element()
        }
    }
}

impl Element for ReactDiffElement {
    type RequestLayoutState = ();
    type PrepaintState = Option<gpui::Hitbox>;

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
        let layout = window.request_layout(style, std::iter::once(child_layout), cx);
        self.child = Some(child);
        (layout, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Option<gpui::Hitbox> {
        if self.element.style.is_display_none() {
            return None;
        }
        report_layout(&self.element, bounds);
        if !bounds_have_drawable_area(bounds) {
            return None;
        }
        if let Some(child) = self.child.as_mut() {
            child.prepaint(window, cx);
        }
        Some(window.insert_hitbox(bounds, gpui::HitboxBehavior::Normal))
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        hitbox: &mut Option<gpui::Hitbox>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(payload) = self.element.diff_payload() else {
            return;
        };
        let Some(hitbox) = hitbox.as_ref() else {
            return;
        };
        for (id, layout) in &self.layouts {
            super::text::paint_selection_segment(*id, layout, window);
        }
        super::text::wire_native_selection(hitbox, window);
        if let Some(child) = self.child.as_mut() {
            child.paint(window, cx);
        }

        let id = self.element.global_id;
        let listens_toggle = self.element.listens("toggleFile");
        let listens_show_more = self.element.listens("showMore");
        let listens_line_click = self.element.listens("lineClick");
        let payload = payload.clone();
        let rows = payload.rows.clone();
        let line_height = self.line_height;
        let internal_scroll_y = self.internal_scroll_y;
        let click_payload = payload.clone();
        let click_hitbox = hitbox.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, _cx| {
            if !phase.bubble()
                || event.button != MouseButton::Left
                || !click_hitbox.is_hovered(window)
            {
                return;
            }
            let local = ((f32::from(event.position.y - bounds.origin.y) + internal_scroll_y)
                / line_height)
                .floor()
                .max(0.0) as usize;
            let Some(row) = rows.get(local) else {
                return;
            };
            match row.kind {
                DiffKind::File if listens_toggle => crate::bridge::diff_event(
                    id,
                    "toggleFile",
                    row.path.as_deref(),
                    row.old_line,
                    row.new_line,
                ),
                DiffKind::ShowMore if listens_show_more => crate::bridge::diff_event(
                    id,
                    "showMore",
                    Some(click_payload.text(row)),
                    None,
                    None,
                ),
                DiffKind::File | DiffKind::ShowMore => {}
                _ if listens_line_click => crate::bridge::diff_event(
                    id,
                    "lineClick",
                    Some(click_payload.text(row)),
                    row.old_line,
                    row.new_line,
                ),
                _ => {}
            }
        });
        if payload.diff_scroll {
            let rows = payload.rows.len();
            let scroll_hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &ScrollWheelEvent, phase, window, _cx| {
                if !phase.bubble() || !scroll_hitbox.is_hovered(window) {
                    return;
                }
                let dy: f32 = match event.delta {
                    gpui::ScrollDelta::Pixels(delta) => delta.y.into(),
                    gpui::ScrollDelta::Lines(delta) => delta.y * line_height,
                };
                let viewport = f32::from(bounds.size.height);
                let max_scroll = (rows as f32 * line_height - viewport).max(0.0);
                STATES.with(|states| {
                    let mut states = states.borrow_mut();
                    let state = states.entry(id).or_default();
                    state.scroll_y = (state.scroll_y - dy).clamp(0.0, max_scroll);
                });
                window.refresh();
            });
        }
    }
}

impl IntoElement for ReactDiffElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}
