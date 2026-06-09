use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui::{
    AnyElement, App, ClipboardItem, Div, FontWeight, IntoElement, Modifiers, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Position, Styled,
    div, point, px,
};
use once_cell::sync::Lazy;

use crate::bridge;
use crate::elements::ReactElement;

pub const WEBVIEW_INSPECTOR_SCRIPT: &str = r#"
(() => {
  if (window.__rngpuiInspectorInstalled) return;
  window.__rngpuiInspectorInstalled = true;

  const message = '{"__rngpuiInspector":true,"event":"copy"}';
  const holdMs = 500;
  let active = false;
  let altDown = false;
  let timer = 0;
  let token = 0;
  let overlay;

  const getOverlay = () => {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:none",
      "box-sizing:border-box",
      "border:2px solid #0a84ff",
      "background:rgba(10,132,255,0.10)",
      "display:none"
    ].join(";");
    document.documentElement.appendChild(overlay);
    return overlay;
  };

  const show = (active) => {
    getOverlay().style.display = active ? "block" : "none";
  };

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
  };

  const deactivate = () => {
    token += 1;
    altDown = false;
    active = false;
    clearTimer();
    show(false);
  };

  const arm = () => {
    if (active || timer) return;
    const current = ++token;
    timer = setTimeout(() => {
      timer = 0;
      if (!altDown || token !== current) return;
      active = true;
      show(true);
    }, holdMs);
  };

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Alt") return;
    altDown = true;
    arm();
  }, true);
  document.addEventListener("mousemove", (event) => {
    if (!event.altKey) {
      deactivate();
      return;
    }
    altDown = true;
    if (active) show(true);
    else arm();
  }, true);
  document.addEventListener("mouseleave", () => deactivate(), true);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Alt") deactivate();
  }, true);
  window.addEventListener("blur", () => deactivate(), true);
  document.addEventListener("mousedown", (event) => {
    if (!active || !event.altKey || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show(true);
    window.ipc.postMessage(message);
  }, true);
})();
"#;

const WEBVIEW_INSPECTOR_FLAG: &str = "__rngpuiInspector";
pub const INSPECTOR_ACTIVATION_HOLD: Duration = Duration::from_millis(500);

static SNAPSHOT_METADATA: Lazy<Mutex<HashMap<u64, SnapshotMetadata>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SNAPSHOT_CACHE: Lazy<Mutex<HashMap<u64, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Authored JSX source locations ("<abs-path>:<line>:<col>") keyed by globalId, stamped
/// at bundle time by the babel source-location plugin and carried through the reconciler.
/// Held in a side-table (mirroring `anim_overlay`) rather than on `ReactElement`, so
/// source provenance doesn't touch the shared element struct or its construction sites.
/// Repopulated each full tree apply (see `clear_sources` + `service::parse_json_tree`).
static SOURCE_TABLE: Lazy<Mutex<HashMap<u64, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

impl Rect {
    fn contains(self, position: Point<Pixels>) -> bool {
        let x: f32 = position.x.into();
        let y: f32 = position.y.into();
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }

    fn is_visible(self) -> bool {
        self.width > 0.5 && self.height > 0.5
    }

    fn area(self) -> f32 {
        self.width * self.height
    }
}

impl From<(f32, f32, f32, f32)> for Rect {
    fn from(value: (f32, f32, f32, f32)) -> Self {
        Self {
            x: value.0,
            y: value.1,
            width: value.2,
            height: value.3,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct NodeSummary {
    id: u64,
    element_type: String,
    role: Option<String>,
    label: Option<String>,
    identifier: Option<String>,
    identifier_source: Option<String>,
    native_id: Option<String>,
    test_id: Option<String>,
    prop_id: Option<String>,
    text: Option<String>,
    /// authored JSX source location ("<abs-path>:<line>:<col>"), stamped at bundle time
    /// by the babel source-location plugin and carried through the reconciler. Drives the
    /// inspector menu's "open in editor" and the ancestor chain's file labels.
    source: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct InspectorHit {
    target: NodeSummary,
    bounds: Rect,
    events: Vec<String>,
    native_list_group: Option<String>,
    value: Option<String>,
    style: Vec<String>,
    path: Vec<NodeSummary>,
    rank: u8,
    depth: usize,
    order: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct SnapshotMetadata {
    target: NodeSummary,
    events: Vec<String>,
    value: Option<String>,
    style: Vec<String>,
    path: Vec<NodeSummary>,
    rank: u8,
    depth: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TapTarget {
    pub id: u64,
    pub events: Vec<String>,
    pub bounds: (f32, f32, f32, f32),
    pub native_list_group: Option<String>,
    pub focusable_input: bool,
}

// ─── option+click menu ──────────────────────────────────────────────────────────
// Option+click no longer copies straight to the clipboard; it opens a small native
// popup (parity with the ~/one web devtool): a header for the selected node, Open /
// Copy actions, and a clickable ancestor chain. Each node carries its authored source
// location, so Open launches the editor at the exact file:line:col.
//
// Rows are positioned by exact precomputed rects (window coordinates), so click
// hit-testing in `menu_action_at` matches what `render_menu` paints — no flex drift.

const MENU_WIDTH: f32 = 340.0;
const MENU_PAD: f32 = 8.0;
const MENU_HEADER_H: f32 = 34.0;
const MENU_ACTION_H: f32 = 28.0;
const MENU_ROW_H: f32 = 28.0;
const MENU_GAP: f32 = 6.0;
const MENU_BTN_W: f32 = 78.0;
const MENU_MAX_ROWS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
enum MenuAction {
    Select(usize),
    Open,
    Copy,
    Close,
}

#[derive(Clone, Debug, PartialEq)]
struct MenuItem {
    action: MenuAction,
    rect: Rect,
}

#[derive(Clone, Debug)]
struct MenuEntry {
    summary: NodeSummary,
    bounds: Option<Rect>,
}

#[derive(Clone, Debug)]
struct InspectorMenu {
    /// the originally clicked hit (innermost), kept for its rich events/style/value facts.
    hit: InspectorHit,
    /// innermost-first chain: chain[0] is the clicked node, last is the root-ward ancestor.
    chain: Vec<MenuEntry>,
    selected: usize,
    hover: Option<usize>,
    copied: bool,
    panel: Rect,
    items: Vec<MenuItem>,
}

impl InspectorMenu {
    fn selected_source(&self) -> Option<&str> {
        self.chain
            .get(self.selected)
            .and_then(|entry| entry.summary.source.as_deref())
    }

    /// The element rect to draw the highlight outline around — the hovered row if any,
    /// otherwise the selected row.
    fn highlight_bounds(&self) -> Option<Rect> {
        let idx = self.hover.unwrap_or(self.selected);
        self.chain.get(idx).and_then(|entry| entry.bounds)
    }
}

fn clampf(value: f32, lo: f32, hi: f32) -> f32 {
    value.max(lo).min(hi)
}

/// Build the popup at `anchor`, clamped inside `viewport`. Layout is frozen here: the
/// chain length is fixed and every clickable region gets a window-coordinate rect that
/// `render_menu` and `menu_action_at` both read, so paint and hit-testing never disagree.
fn build_menu(hit: InspectorHit, anchor: Point<Pixels>, viewport: (f32, f32)) -> InspectorMenu {
    let mut chain: Vec<MenuEntry> = hit
        .path
        .iter()
        .rev()
        .map(|summary| MenuEntry {
            summary: summary.clone(),
            bounds: bridge::cached_layout(summary.id)
                .map(Rect::from)
                .filter(|bounds| bounds.is_visible()),
        })
        .collect();
    if chain.len() > MENU_MAX_ROWS {
        chain.truncate(MENU_MAX_ROWS);
    }
    let rows = chain.len().max(1);

    let panel_h = MENU_PAD
        + MENU_HEADER_H
        + MENU_GAP
        + MENU_ACTION_H
        + MENU_GAP
        + (rows as f32) * MENU_ROW_H
        + MENU_PAD;
    let (vw, vh) = viewport;
    let ax: f32 = anchor.x.into();
    let ay: f32 = anchor.y.into();
    let panel_x = clampf(ax, MENU_PAD, (vw - MENU_WIDTH - MENU_PAD).max(MENU_PAD));
    let panel_y = clampf(ay, MENU_PAD, (vh - panel_h - MENU_PAD).max(MENU_PAD));
    let panel = Rect {
        x: panel_x,
        y: panel_y,
        width: MENU_WIDTH,
        height: panel_h,
    };

    let inner_x = panel_x + MENU_PAD;
    let inner_w = MENU_WIDTH - MENU_PAD * 2.0;
    let mut items = Vec::new();

    let actions_y = panel_y + MENU_PAD + MENU_HEADER_H + MENU_GAP;
    items.push(MenuItem {
        action: MenuAction::Open,
        rect: Rect {
            x: inner_x,
            y: actions_y,
            width: MENU_BTN_W,
            height: MENU_ACTION_H,
        },
    });
    items.push(MenuItem {
        action: MenuAction::Copy,
        rect: Rect {
            x: inner_x + MENU_BTN_W + MENU_GAP,
            y: actions_y,
            width: MENU_BTN_W,
            height: MENU_ACTION_H,
        },
    });
    items.push(MenuItem {
        action: MenuAction::Close,
        rect: Rect {
            x: inner_x + inner_w - MENU_ACTION_H,
            y: actions_y,
            width: MENU_ACTION_H,
            height: MENU_ACTION_H,
        },
    });

    let rows_y = actions_y + MENU_ACTION_H + MENU_GAP;
    for i in 0..chain.len() {
        items.push(MenuItem {
            action: MenuAction::Select(i),
            rect: Rect {
                x: inner_x,
                y: rows_y + (i as f32) * MENU_ROW_H,
                width: inner_w,
                height: MENU_ROW_H,
            },
        });
    }

    InspectorMenu {
        hit,
        chain,
        selected: 0,
        hover: None,
        copied: false,
        panel,
        items,
    }
}

fn menu_action_at(menu: &InspectorMenu, position: Point<Pixels>) -> Option<MenuAction> {
    menu.items
        .iter()
        .find(|item| item.rect.contains(position))
        .map(|item| item.action)
}

fn menu_row_index_at(menu: &InspectorMenu, position: Point<Pixels>) -> Option<usize> {
    match menu_action_at(menu, position) {
        Some(MenuAction::Select(i)) => Some(i),
        _ => None,
    }
}

/// The clipboard text for the currently selected node: the rich hit snapshot for the
/// innermost node, or a lighter summary-derived snapshot for a selected ancestor.
fn menu_snapshot(menu: &InspectorMenu) -> String {
    if menu.selected == 0 {
        return snapshot(&menu.hit);
    }
    let Some(entry) = menu.chain.get(menu.selected) else {
        return snapshot(&menu.hit);
    };
    let summary = &entry.summary;
    let mut lines = Vec::new();
    lines.push("# react-native-gpui inspector snapshot".to_string());
    lines.push(format!("id: {}", summary.id));
    lines.push(format!("type: {}", summary.element_type));
    if let Some(bounds) = entry.bounds {
        lines.push(format!(
            "rect: {:.0},{:.0} {:.0}x{:.0}",
            bounds.x, bounds.y, bounds.width, bounds.height
        ));
    }
    push_optional(&mut lines, "role", summary.role.as_deref());
    push_optional(&mut lines, "label", summary.label.as_deref());
    push_optional(&mut lines, "identifier", summary.identifier.as_deref());
    push_optional(&mut lines, "testID", summary.test_id.as_deref());
    push_optional(&mut lines, "text", summary.text.as_deref());
    push_optional(&mut lines, "source", summary.source.as_deref());
    // root → selected node (chain is innermost-first, so reverse the tail at `selected`).
    let path_nodes: Vec<String> = menu.chain[menu.selected..]
        .iter()
        .rev()
        .map(|entry| path_label(&entry.summary))
        .collect();
    lines.push(format!("path: {}", path_nodes.join(" > ")));
    lines.join("\n")
}

// ─── open in editor ─────────────────────────────────────────────────────────────

/// Split "<path>:<line>:<col>" into its parts, peeling up to two trailing numeric
/// segments so a path that itself contains ':' (Windows drive) is preserved.
fn parse_source(source: &str) -> (String, Option<u32>, Option<u32>) {
    let mut path = source;
    let mut nums: Vec<u32> = Vec::new();
    for _ in 0..2 {
        let Some(idx) = path.rfind(':') else { break };
        let tail = &path[idx + 1..];
        if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_digit()) {
            break;
        }
        let Ok(n) = tail.parse::<u32>() else { break };
        nums.push(n);
        path = &path[..idx];
    }
    // nums is [col, line] (col peeled first) when both present.
    let (line, col) = match nums.as_slice() {
        [col, line] => (Some(*line), Some(*col)),
        [line] => (Some(*line), None),
        _ => (None, None),
    };
    (path.to_string(), line, col)
}

/// The editor command, from RNGPUI_EDITOR / LAUNCH_EDITOR / EDITOR / VISUAL, defaulting
/// to VS Code (`code`). Mirrors the ~/one devtool's resolution order.
fn resolve_editor() -> String {
    for key in ["RNGPUI_EDITOR", "LAUNCH_EDITOR", "EDITOR", "VISUAL"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    "code".to_string()
}

fn editor_basename(editor: &str) -> &str {
    editor.rsplit('/').next().unwrap_or(editor)
}

/// Per-editor argv to jump to file:line:col, keyed on the command basename.
fn editor_args(editor: &str, path: &str, line: Option<u32>, col: Option<u32>) -> Vec<String> {
    let base = editor_basename(editor);
    let line = line.unwrap_or(1);
    let col = col.unwrap_or(1);
    match base {
        "code" | "code-insiders" | "codium" | "vscodium" | "cursor" | "windsurf" | "positron" => {
            vec!["-g".to_string(), format!("{path}:{line}:{col}")]
        }
        "zed" | "subl" | "sublime_text" => vec![format!("{path}:{line}:{col}")],
        "webstorm" | "idea" | "phpstorm" | "pstorm" | "rubymine" | "goland" | "clion" => vec![
            "--line".to_string(),
            line.to_string(),
            "--column".to_string(),
            col.to_string(),
            path.to_string(),
        ],
        "vim" | "nvim" | "mvim" | "gvim" => vec![format!("+{line}"), path.to_string()],
        "emacs" | "emacsclient" => vec![format!("+{line}:{col}"), path.to_string()],
        _ => vec![path.to_string()],
    }
}

/// Spawn `editor` at the parsed source location, fully detached. Split out from
/// `open_in_editor` so tests can drive a recorder script without mutating the process env.
fn spawn_editor(editor: &str, source: &str) -> std::io::Result<std::process::Child> {
    let (path, line, col) = parse_source(source);
    let args = editor_args(editor, &path, line, col);
    std::process::Command::new(editor)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
}

/// Open the resolved editor at the given source location. Returns the child so tests can
/// wait on it; production callers fire and forget.
fn open_in_editor(source: &str) -> std::io::Result<std::process::Child> {
    spawn_editor(&resolve_editor(), source)
}

// ─── menu rendering ─────────────────────────────────────────────────────────────

fn truncate_str(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn node_title(node: &NodeSummary) -> String {
    let mut title = node.element_type.clone();
    let detail = node
        .identifier
        .as_deref()
        .or(node.test_id.as_deref())
        .or(node.label.as_deref())
        .or(node.text.as_deref())
        .filter(|s| !s.is_empty());
    if let Some(detail) = detail {
        title.push_str("  ");
        title.push_str(detail);
    }
    title
}

/// "RightPanel.tsx:42" — the filename + line, for the right side of a row.
fn source_label(source: &str) -> String {
    let (path, line, _col) = parse_source(source);
    let base = path.rsplit('/').next().unwrap_or(&path);
    match line {
        Some(line) => format!("{base}:{line}"),
        None => base.to_string(),
    }
}

/// "agentbus/RightPanel.tsx:42" — last two path segments + line, for the header.
fn source_label_full(source: &str) -> String {
    let (path, line, _col) = parse_source(source);
    let mut segs: Vec<&str> = path.rsplit('/').take(2).collect();
    segs.reverse();
    let tail = segs.join("/");
    match line {
        Some(line) => format!("{tail}:{line}"),
        None => tail,
    }
}

/// A child div positioned absolutely inside `panel` at the window-coordinate rect `r`,
/// with a small horizontal inset so text doesn't touch the edges.
fn abs_child(panel: Rect, r: Rect) -> Div {
    let mut d = div();
    let style = d.style();
    style.position = Some(Position::Absolute);
    style.inset.left = Some(px(r.x - panel.x).into());
    style.inset.top = Some(px(r.y - panel.y).into());
    style.size.width = Some(px(r.width).into());
    style.size.height = Some(px(r.height).into());
    style.padding.left = Some(px(8.0).into());
    style.padding.right = Some(px(8.0).into());
    d
}

fn render_menu(menu: &InspectorMenu) -> AnyElement {
    let accent = crate::style::u32_to_hsla(0x0a84ff);
    let panel_bg = crate::style::u32_to_hsla(0x26262b);
    let text_col = crate::style::u32_to_hsla(0xe6e6ea);
    let dim_col = crate::style::u32_to_hsla(0x9aa0a6);
    let btn_bg = crate::style::u32_to_hsla(0x3a3a42);
    let sel_bg = accent.opacity(0.30);
    let hov_bg = crate::style::u32_to_hsla(0xffffff).opacity(0.08);
    let border_col = crate::style::u32_to_hsla(0xffffff).opacity(0.12);
    let white = crate::style::u32_to_hsla(0xffffff);

    let panel = menu.panel;

    // event-transparent full-window container holding the highlight + the panel.
    let mut container = div().size_full();
    {
        let style = container.style();
        style.position = Some(Position::Absolute);
        style.inset.top = Some(px(0.0).into());
        style.inset.left = Some(px(0.0).into());
    }

    if let Some(bounds) = menu.highlight_bounds() {
        let mut outline = div()
            .border_2()
            .border_color(accent)
            .bg(accent.opacity(0.08));
        let style = outline.style();
        style.position = Some(Position::Absolute);
        style.inset.left = Some(px(bounds.x).into());
        style.inset.top = Some(px(bounds.y).into());
        style.size.width = Some(px(bounds.width).into());
        style.size.height = Some(px(bounds.height).into());
        container = container.child(outline);
    }

    let mut panel_div = div()
        .bg(panel_bg)
        .border_1()
        .border_color(border_col)
        .rounded(px(10.0));
    {
        let style = panel_div.style();
        style.position = Some(Position::Absolute);
        style.inset.left = Some(px(panel.x).into());
        style.inset.top = Some(px(panel.y).into());
        style.size.width = Some(px(panel.width).into());
        style.size.height = Some(px(panel.height).into());
    }

    // header: selected node title + source location.
    let selected = &menu.chain[menu.selected].summary;
    let header_rect = Rect {
        x: panel.x + MENU_PAD,
        y: panel.y + MENU_PAD,
        width: panel.width - MENU_PAD * 2.0,
        height: MENU_HEADER_H,
    };
    let header_source = selected
        .source
        .as_deref()
        .map(source_label_full)
        .unwrap_or_else(|| "no source — pick an ancestor".to_string());
    let header = abs_child(panel, header_rect)
        .flex()
        .flex_col()
        .justify_center()
        .child(
            div()
                .text_color(text_col)
                .text_size(px(13.0))
                .font_weight(FontWeight::SEMIBOLD)
                .child(truncate_str(&node_title(selected), 42)),
        )
        .child(
            div()
                .text_color(dim_col)
                .text_size(px(11.0))
                .child(truncate_str(&header_source, 46)),
        );
    panel_div = panel_div.child(header);

    // action buttons + ancestor rows, all driven from the frozen item rects.
    for item in &menu.items {
        let child = match item.action {
            MenuAction::Open => {
                let enabled = menu.selected_source().is_some();
                let fg = if enabled { white } else { dim_col };
                abs_child(panel, item.rect)
                    .bg(if enabled {
                        accent.opacity(0.85)
                    } else {
                        btn_bg
                    })
                    .rounded(px(6.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .text_color(fg)
                            .text_size(px(12.0))
                            .child("Open".to_string()),
                    )
            }
            MenuAction::Copy => abs_child(panel, item.rect)
                .bg(btn_bg)
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_color(text_col)
                        .text_size(px(12.0))
                        .child(if menu.copied { "Copied" } else { "Copy" }.to_string()),
                ),
            MenuAction::Close => abs_child(panel, item.rect)
                .bg(btn_bg)
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_color(dim_col)
                        .text_size(px(14.0))
                        .child("✕".to_string()),
                ),
            MenuAction::Select(i) => {
                let entry = &menu.chain[i];
                let row_bg = if i == menu.selected {
                    sel_bg
                } else if menu.hover == Some(i) {
                    hov_bg
                } else {
                    crate::style::u32_to_hsla(0x000000).opacity(0.0)
                };
                let src_text = entry
                    .summary
                    .source
                    .as_deref()
                    .map(source_label)
                    .unwrap_or_default();
                abs_child(panel, item.rect)
                    .bg(row_bg)
                    .rounded(px(6.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_color(text_col)
                            .text_size(px(12.0))
                            .child(truncate_str(&node_title(&entry.summary), 30)),
                    )
                    .child(
                        div()
                            .text_color(dim_col)
                            .text_size(px(11.0))
                            .child(truncate_str(&src_text, 18)),
                    )
            }
        };
        panel_div = panel_div.child(child);
    }

    container = container.child(panel_div);
    container.into_any_element()
}

#[derive(Clone, Debug)]
pub struct InspectorState {
    enabled: bool,
    active: bool,
    alt_down: bool,
    hold_token: u64,
    last_position: Option<Point<Pixels>>,
    suppress_mouse_up: bool,
    hover: Option<InspectorHit>,
    copied_id: Option<u64>,
    /// when Some, the popup menu is open and owns all mouse input until dismissed.
    menu: Option<InspectorMenu>,
}

impl InspectorState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            active: false,
            alt_down: false,
            hold_token: 0,
            last_position: None,
            suppress_mouse_up: false,
            hover: None,
            copied_id: None,
            menu: None,
        }
    }

    pub fn from_env() -> Self {
        Self::new(env_enabled("RNGPUI_INSPECTOR"))
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) -> bool {
        if self.enabled == enabled {
            return false;
        }
        self.enabled = enabled;
        if !enabled {
            let had_menu = self.menu.take().is_some();
            self.deactivate() || had_menu
        } else {
            true
        }
    }

    pub fn handle_modifiers(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        modifiers: Modifiers,
    ) -> (bool, Option<u64>) {
        if !self.enabled {
            return (false, None);
        }
        // while the popup is open it owns the screen — alt press/release must not tear
        // down the menu (you release option to read it, like the ~/one dialog).
        if self.menu.is_some() {
            return (false, None);
        }
        self.update_alt_state(root, position, modifiers.alt)
    }

    pub fn handle_mouse_move(
        &mut self,
        root: &Arc<ReactElement>,
        event: &MouseMoveEvent,
    ) -> (bool, Option<u64>) {
        if !self.enabled {
            return (false, None);
        }
        // menu open: hovering a row highlights its element instead of re-hit-testing.
        if self.menu.is_some() {
            return (self.update_menu_hover(event.position), None);
        }
        self.update_alt_state(root, event.position, event.modifiers.alt)
    }

    pub fn handle_mouse_down(
        &mut self,
        root: &Arc<ReactElement>,
        event: &MouseDownEvent,
        viewport: (f32, f32),
        cx: &mut App,
    ) -> bool {
        if !self.enabled {
            return false;
        }
        // menu open: every click is ours. Left clicks dispatch the item under the cursor
        // (or dismiss on an outside-click); any other button dismisses.
        if self.menu.is_some() {
            self.suppress_mouse_up = true;
            if event.button == MouseButton::Left {
                self.dispatch_menu_click(event.position, cx);
            } else {
                self.menu = None;
            }
            return true;
        }
        // option+click on an active hover opens the menu (replacing the old straight-to-
        // clipboard copy — copy is now a menu action).
        if event.button != MouseButton::Left || !event.modifiers.alt || !self.active {
            return false;
        }
        self.suppress_mouse_up = true;
        self.open_menu(root, event.position, viewport);
        true
    }

    pub fn copy_at(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        cx: &mut App,
    ) -> bool {
        if !self.enabled {
            return false;
        }
        let previous_target = self.hover.as_ref().map(hit_key);
        self.last_position = Some(position);
        self.hover = hit_test(root, position);
        if let Some(hit) = self.hover.as_ref() {
            cx.write_to_clipboard(ClipboardItem::new_string(snapshot(hit)));
            self.copied_id = Some(hit.target.id);
        }
        previous_target != self.hover.as_ref().map(hit_key) || self.hover.is_some()
    }

    pub fn handle_mouse_up(&mut self, event: &MouseUpEvent) -> bool {
        if !self.enabled {
            self.suppress_mouse_up = false;
            return false;
        }
        let suppress = self.suppress_mouse_up || (self.active && event.modifiers.alt);
        self.suppress_mouse_up = false;
        suppress
    }

    pub fn activate_after_hold(
        &mut self,
        root: &Arc<ReactElement>,
        token: u64,
        alt_still_down: bool,
    ) -> bool {
        if !alt_still_down {
            return self.deactivate();
        }
        if !self.enabled || !self.alt_down || self.hold_token != token {
            return false;
        }
        let Some(position) = self.last_position else {
            return false;
        };
        self.set_hover(root, position, true)
    }

    pub fn deactivate(&mut self) -> bool {
        let previous_active = self.active;
        let previous_target = self.hover.as_ref().map(hit_key);
        let had_hold = self.alt_down;
        self.active = false;
        self.alt_down = false;
        self.hover = None;
        self.copied_id = None;
        self.last_position = None;
        if had_hold || previous_active {
            self.hold_token = self.hold_token.wrapping_add(1);
        }
        previous_active || previous_target.is_some()
    }

    pub fn overlay(&self) -> Option<AnyElement> {
        if !self.enabled {
            return None;
        }
        if let Some(menu) = self.menu.as_ref() {
            return Some(render_menu(menu));
        }
        if !self.active {
            return None;
        }
        let hit = self.hover.as_ref()?;
        let accent = crate::style::u32_to_hsla(0x0a84ff);
        let white = crate::style::u32_to_hsla(0xffffff);
        let mut label = div()
            .bg(accent)
            .text_color(white)
            .text_size(px(11.0))
            .child(overlay_label(hit, self.copied_id == Some(hit.target.id)));
        {
            let style = label.style();
            style.position = Some(Position::Absolute);
            style.inset.top = Some(px(0.0).into());
            style.inset.left = Some(px(0.0).into());
            style.padding.top = Some(px(3.0).into());
            style.padding.right = Some(px(6.0).into());
            style.padding.bottom = Some(px(3.0).into());
            style.padding.left = Some(px(6.0).into());
        }

        let mut outline = div()
            .border_2()
            .border_color(accent)
            .bg(accent.opacity(0.10))
            .child(label);
        {
            let style = outline.style();
            style.position = Some(Position::Absolute);
            style.inset.left = Some(px(hit.bounds.x).into());
            style.inset.top = Some(px(hit.bounds.y).into());
            style.size.width = Some(px(hit.bounds.width).into());
            style.size.height = Some(px(hit.bounds.height).into());
        }
        Some(outline.into_any_element())
    }

    fn set_hover(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        active: bool,
    ) -> bool {
        let previous_active = self.active;
        let previous_target = self.hover.as_ref().map(hit_key);
        self.active = active;
        if active {
            self.hover = hit_test(root, position);
        } else {
            self.hover = None;
            self.copied_id = None;
        }
        previous_active != self.active || previous_target != self.hover.as_ref().map(hit_key)
    }

    fn update_alt_state(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        alt: bool,
    ) -> (bool, Option<u64>) {
        if !alt {
            return (self.deactivate(), None);
        }
        self.last_position = Some(position);
        let activation_token = if self.alt_down {
            None
        } else {
            self.alt_down = true;
            self.hold_token = self.hold_token.wrapping_add(1);
            Some(self.hold_token)
        };
        let changed = if self.active {
            self.set_hover(root, position, true)
        } else {
            false
        };
        (changed, activation_token)
    }

    fn open_menu(
        &mut self,
        root: &Arc<ReactElement>,
        position: Point<Pixels>,
        viewport: (f32, f32),
    ) {
        let Some(hit) = hit_test(root, position) else {
            return;
        };
        // the menu draws its own highlight, so retire the hover overlay state.
        self.active = false;
        self.hover = None;
        self.copied_id = None;
        self.menu = Some(build_menu(hit, position, viewport));
    }

    fn dispatch_menu_click(&mut self, position: Point<Pixels>, cx: &mut App) {
        let Some(menu) = self.menu.as_ref() else {
            return;
        };
        if !menu.panel.contains(position) {
            self.menu = None;
            return;
        }
        let Some(action) = menu_action_at(menu, position) else {
            return; // inside the panel but on no item: keep it open
        };
        match action {
            MenuAction::Select(i) => {
                if let Some(menu) = self.menu.as_mut()
                    && i < menu.chain.len()
                {
                    menu.selected = i;
                    menu.copied = false;
                }
            }
            MenuAction::Copy => {
                if let Some(text) = self.menu.as_ref().map(menu_snapshot) {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                    if let Some(menu) = self.menu.as_mut() {
                        menu.copied = true;
                    }
                }
            }
            MenuAction::Open => {
                let source = self
                    .menu
                    .as_ref()
                    .and_then(|menu| menu.selected_source().map(str::to_string));
                self.menu = None;
                if let Some(source) = source {
                    let _ = open_in_editor(&source);
                }
            }
            MenuAction::Close => {
                self.menu = None;
            }
        }
    }

    fn update_menu_hover(&mut self, position: Point<Pixels>) -> bool {
        let Some(menu) = self.menu.as_mut() else {
            return false;
        };
        let next = menu_row_index_at(menu, position);
        if menu.hover != next {
            menu.hover = next;
            true
        } else {
            false
        }
    }
}

#[cfg(target_os = "macos")]
pub fn current_option_modifier_down() -> bool {
    use cocoa::appkit::NSEventModifierFlags;
    use cocoa::foundation::NSUInteger;
    use objc::{class, msg_send, sel, sel_impl};

    // AppKit's class-level "what modifiers are held right now" is `+[NSEvent
    // modifierFlags]`. There is no `currentModifierFlags` selector — sending it
    // throws NSInvalidArgumentException and crashes the app the first time the
    // inspector activation timer fires.
    unsafe {
        let flags: NSUInteger = msg_send![class!(NSEvent), modifierFlags];
        flags & NSEventModifierFlags::NSAlternateKeyMask.bits() != 0
    }
}

#[cfg(not(target_os = "macos"))]
pub fn current_option_modifier_down() -> bool {
    true
}

pub fn refresh_snapshot_cache(root: &Arc<ReactElement>) {
    let mut path = Vec::new();
    let mut metadata = HashMap::new();
    let mut snapshots = HashMap::new();
    collect_snapshots(root, &mut path, &mut metadata, &mut snapshots);
    *SNAPSHOT_METADATA.lock().unwrap() = metadata;
    *SNAPSHOT_CACHE.lock().unwrap() = snapshots;
}

pub fn refresh_layout_snapshot(id: u64, x: f32, y: f32, width: f32, height: f32) {
    let bounds = Rect {
        x,
        y,
        width,
        height,
    };
    if !bounds.is_visible() {
        return;
    }
    let Some(metadata) = SNAPSHOT_METADATA.lock().unwrap().get(&id).cloned() else {
        return;
    };
    SNAPSHOT_CACHE
        .lock()
        .unwrap()
        .insert(id, snapshot(&metadata.into_hit(bounds)));
}

pub fn handle_webview_ipc(id: u64, body: &str) -> bool {
    if !is_webview_inspector_message(body) {
        return false;
    }
    let Some(snapshot) = cached_snapshot(id) else {
        return true;
    };
    write_system_clipboard(&snapshot);
    true
}

fn cached_snapshot(id: u64) -> Option<String> {
    SNAPSHOT_CACHE.lock().unwrap().get(&id).cloned()
}

/// Record a node's authored source location, keyed by globalId. Called per node from
/// `service::parse_json_tree` while it walks a freshly serialized tree.
pub fn remember_source(id: u64, source: &str) {
    SOURCE_TABLE.lock().unwrap().insert(id, source.to_string());
}

/// Drop all recorded sources. Called at the start of each full tree apply so the table
/// reflects only the current commit (globalIds are reused across commits, so a stale
/// entry would mislabel a different node).
pub fn clear_sources() {
    SOURCE_TABLE.lock().unwrap().clear();
}

pub fn source_for(id: u64) -> Option<String> {
    SOURCE_TABLE.lock().unwrap().get(&id).cloned()
}

fn is_webview_inspector_message(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value
        .get(WEBVIEW_INSPECTOR_FLAG)
        .and_then(|value| value.as_bool())
        == Some(true)
        && value.get("event").and_then(|value| value.as_str()) == Some("copy")
}

impl SnapshotMetadata {
    fn into_hit(self, bounds: Rect) -> InspectorHit {
        InspectorHit {
            target: self.target,
            bounds,
            events: self.events,
            native_list_group: None,
            value: self.value,
            style: self.style,
            path: self.path,
            rank: self.rank,
            depth: self.depth,
            order: 0,
        }
    }
}

fn collect_snapshots(
    element: &Arc<ReactElement>,
    path: &mut Vec<NodeSummary>,
    metadata: &mut HashMap<u64, SnapshotMetadata>,
    snapshots: &mut HashMap<u64, String>,
) {
    if element.style.is_display_none() {
        return;
    }
    path.push(summary(element));
    let snapshot_metadata = SnapshotMetadata {
        target: summary(element),
        events: element.events.clone(),
        value: snippet(element.value.as_deref(), 120),
        style: style_facts(element),
        path: path.clone(),
        rank: inspect_rank(element),
        depth: path.len(),
    };
    if let Some(bounds) = bridge::cached_layout(element.global_id).map(Rect::from)
        && bounds.is_visible()
    {
        let hit = snapshot_metadata.clone().into_hit(bounds);
        snapshots.insert(element.global_id, snapshot(&hit));
    }
    metadata.insert(element.global_id, snapshot_metadata);
    for child in element.children.iter() {
        collect_snapshots(child, path, metadata, snapshots);
    }
    path.pop();
}

#[cfg(target_os = "macos")]
fn write_system_clipboard(text: &str) -> bool {
    use cocoa::appkit::{NSPasteboard, NSPasteboardTypeString};
    use cocoa::base::{YES, nil};
    use cocoa::foundation::NSString;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let pasteboard = NSPasteboard::generalPasteboard(nil);
        let _ = pasteboard.clearContents();
        let string = NSString::alloc(nil).init_str(text);
        let ok = pasteboard.setString_forType(string, NSPasteboardTypeString);
        let _: () = msg_send![string, release];
        ok == YES
    }
}

#[cfg(not(target_os = "macos"))]
fn write_system_clipboard(_text: &str) -> bool {
    false
}

fn env_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            !matches!(value.as_str(), "" | "0" | "false" | "off" | "no")
        })
        .unwrap_or(false)
}

fn hit_key(hit: &InspectorHit) -> (u64, Rect) {
    (hit.target.id, hit.bounds)
}

fn hit_test(root: &Arc<ReactElement>, position: Point<Pixels>) -> Option<InspectorHit> {
    let mut path = Vec::new();
    let mut hits = Vec::new();
    collect_hits(root, position, &mut path, &mut hits);
    hits.into_iter().max_by(compare_hits)
}

/// The innermost scroll container (overflow: scroll/auto) whose painted bounds contain
/// the point — the `rngpui do scroll` target. Returns its globalId.
pub fn scroll_container_at(root: &Arc<ReactElement>, x: f32, y: f32) -> Option<u64> {
    let position = point(px(x), px(y));
    fn walk(el: &Arc<ReactElement>, position: Point<Pixels>, found: &mut Option<u64>) {
        if el.style.is_display_none() {
            return;
        }
        let Some(bounds) = bridge::cached_layout(el.global_id).map(Rect::from) else {
            return;
        };
        if !bounds.is_visible() || !bounds.contains(position) {
            return;
        }
        if matches!(el.style.overflow.as_deref(), Some("scroll" | "auto")) {
            *found = Some(el.global_id);
        }
        for child in el.children.iter() {
            walk(child, position, found);
        }
    }
    let mut found = None;
    walk(root, position, &mut found);
    found
}

/// The topmost WebView at a point, when no GPUI surface is painted over it. Used by
/// `rngpui do scroll` to drive native WebView content in a kept debug session.
pub fn webview_at(root: &Arc<ReactElement>, x: f32, y: f32) -> Option<u64> {
    let position = point(px(x), px(y));
    let hit = hit_test(root, position)?;
    if hit.target.element_type == "webview" {
        Some(hit.target.id)
    } else {
        None
    }
}

/// The topmost node at a point that listens for a press/click gesture, plus its
/// events and bounds — used to synthesize a `do tap`. Walks up the hit path so a tap
/// on a label inside a Pressable still finds the Pressable's handlers.
pub fn tap_target_at(root: &Arc<ReactElement>, x: f32, y: f32) -> Option<TapTarget> {
    let position = point(px(x), px(y));
    let mut path = Vec::new();
    let mut hits = Vec::new();
    collect_hits(root, position, &mut path, &mut hits);
    // the visual hit itself may be a text leaf inside a row. choose the topmost
    // press/responder target under the point first, then fall back to the visual hit
    // so the caller can still report what is there.
    const PRESS: &[&str] = &[
        "press",
        "click",
        "pressIn",
        "pressOut",
        "longPress",
        "mouseDown",
        "mouseUp",
        "pointerDown",
        "pointerUp",
        "touchStart",
        "touchEnd",
        "responderRelease",
    ];
    let listens_press = |events: &[String]| events.iter().any(|e| PRESS.contains(&e.as_str()));
    let hit = hits
        .iter()
        .filter(|hit| listens_press(&hit.events))
        .max_by(|a, b| compare_hits(a, b))
        .or_else(|| hits.iter().max_by(|a, b| compare_hits(a, b)))?;
    Some(TapTarget {
        id: hit.target.id,
        focusable_input: is_input_type(&hit.target.element_type),
        events: hit.events.clone(),
        native_list_group: hit.native_list_group.clone(),
        bounds: (
            hit.bounds.x,
            hit.bounds.y,
            hit.bounds.width,
            hit.bounds.height,
        ),
    })
}

fn is_input_type(element_type: &str) -> bool {
    matches!(element_type, "textinput" | "textarea")
}

fn collect_hits(
    element: &Arc<ReactElement>,
    position: Point<Pixels>,
    path: &mut Vec<NodeSummary>,
    hits: &mut Vec<InspectorHit>,
) {
    if element.style.is_display_none() {
        return;
    }
    let Some(bounds) = bridge::cached_layout(element.global_id).map(Rect::from) else {
        return;
    };
    if !bounds.is_visible() {
        return;
    }
    let contains = bounds.contains(position);
    let clips_children = matches!(
        element.style.overflow.as_deref(),
        Some("hidden" | "scroll" | "auto")
    );
    let children_allow = !clips_children || contains;

    path.push(summary(element));
    if children_allow {
        for child in element.children.iter().rev() {
            collect_hits(child, position, path, hits);
        }
    }

    if contains {
        hits.push(InspectorHit {
            target: summary(element),
            bounds,
            events: element.events.clone(),
            native_list_group: element.native_list_group.clone(),
            value: snippet(element.value.as_deref(), 120),
            style: style_facts(element),
            path: path.clone(),
            rank: inspect_rank(element),
            depth: path.len(),
            order: hits.len(),
        });
    }
    path.pop();
}

fn compare_hits(a: &InspectorHit, b: &InspectorHit) -> std::cmp::Ordering {
    a.rank
        .cmp(&b.rank)
        .then_with(|| a.depth.cmp(&b.depth))
        .then_with(|| {
            b.bounds
                .area()
                .partial_cmp(&a.bounds.area())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| b.order.cmp(&a.order))
}

fn inspect_rank(element: &ReactElement) -> u8 {
    if !element.events.is_empty() || element.native_resize.is_some() {
        return 100;
    }
    match element.element_type.as_str() {
        "textinput" | "textarea" | "webview" => return 90,
        _ => {}
    }
    if element.accessibility.role.is_some() {
        return 80;
    }
    if element.accessibility.identifier.is_some() {
        return 70;
    }
    if element.accessibility.test_id.is_some()
        || element.accessibility.native_id.is_some()
        || element.accessibility.prop_id.is_some()
    {
        return 70;
    }
    if element.native_layout_key.is_some() {
        return 60;
    }
    if element.accessibility.label.is_some() {
        return 40;
    }
    if element
        .text
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty())
    {
        return 30;
    }
    10
}

fn summary(element: &ReactElement) -> NodeSummary {
    NodeSummary {
        id: element.global_id,
        element_type: element.element_type.clone(),
        role: element.accessibility.role.clone(),
        label: element.accessibility.label.clone(),
        identifier: element.accessibility.identifier.clone(),
        identifier_source: element.accessibility.identifier_source.clone(),
        native_id: element.accessibility.native_id.clone(),
        test_id: element.accessibility.test_id.clone(),
        prop_id: element.accessibility.prop_id.clone(),
        text: snippet(element.text.as_deref(), 80),
        source: source_for(element.global_id),
    }
}

fn style_facts(element: &ReactElement) -> Vec<String> {
    let mut facts = Vec::new();
    if let Some(position) = element.style.position.as_ref() {
        facts.push(format!("position={position}"));
    }
    if let Some(display) = element.style.display.as_ref() {
        facts.push(format!("display={display}"));
    }
    if let Some(direction) = element.style.flex_direction.as_ref() {
        facts.push(format!("flexDirection={direction}"));
    }
    if let Some(overflow) = element.style.overflow.as_ref() {
        facts.push(format!("overflow={overflow}"));
    }
    if element.style.background_color.is_some() {
        facts.push("backgroundColor".to_string());
    }
    if element.style.border_width.is_some()
        || element.style.border_top_width.is_some()
        || element.style.border_right_width.is_some()
        || element.style.border_bottom_width.is_some()
        || element.style.border_left_width.is_some()
    {
        facts.push("border".to_string());
    }
    if element.style.cursor.is_some() {
        facts.push(format!(
            "cursor={}",
            element.style.cursor.as_deref().unwrap_or_default()
        ));
    }
    if let Some(key) = element.native_layout_key.as_ref() {
        facts.push(format!("nativeLayoutKey={key}"));
    }
    if element.native_resize.is_some() {
        facts.push("nativeResize".to_string());
    }
    facts
}

fn overlay_label(hit: &InspectorHit, copied: bool) -> String {
    let mut base = format!("{}#{}", hit.target.element_type, hit.target.id);
    if let Some(test_id) = hit.target.test_id.as_ref() {
        base.push_str(&format!(" testID={test_id}"));
    } else if let Some(native_id) = hit.target.native_id.as_ref() {
        base.push_str(&format!(" nativeID={native_id}"));
    } else if let Some(identifier) = hit.target.identifier.as_ref() {
        base.push_str(&format!(" identifier={identifier}"));
    }
    if let Some(label) = hit.target.label.as_ref().or(hit.target.text.as_ref()) {
        base.push_str(&format!(" {label}"));
    }
    if copied {
        format!("copied {base}")
    } else {
        base
    }
}

fn snapshot(hit: &InspectorHit) -> String {
    let mut lines = Vec::new();
    lines.push("# react-native-gpui inspector snapshot".to_string());
    lines.push(format!("id: {}", hit.target.id));
    lines.push(format!("type: {}", hit.target.element_type));
    lines.push(format!(
        "rect: {:.0},{:.0} {:.0}x{:.0}",
        hit.bounds.x, hit.bounds.y, hit.bounds.width, hit.bounds.height
    ));
    push_optional(&mut lines, "role", hit.target.role.as_deref());
    push_optional(&mut lines, "label", hit.target.label.as_deref());
    push_optional(&mut lines, "identifier", hit.target.identifier.as_deref());
    push_optional(
        &mut lines,
        "identifierSource",
        hit.target.identifier_source.as_deref(),
    );
    push_optional(&mut lines, "testID", hit.target.test_id.as_deref());
    push_optional(&mut lines, "nativeID", hit.target.native_id.as_deref());
    push_optional(&mut lines, "propID", hit.target.prop_id.as_deref());
    push_optional(&mut lines, "text", hit.target.text.as_deref());
    push_optional(&mut lines, "source", hit.target.source.as_deref());
    push_optional(&mut lines, "value", hit.value.as_deref());
    if !hit.events.is_empty() {
        lines.push(format!("events: {}", hit.events.join(", ")));
    }
    if !hit.style.is_empty() {
        lines.push(format!("style: {}", hit.style.join(", ")));
    }
    lines.push(format!(
        "path: {}",
        hit.path
            .iter()
            .map(path_label)
            .collect::<Vec<_>>()
            .join(" > ")
    ));
    lines.join("\n")
}

fn push_optional(lines: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value
        && !value.is_empty()
    {
        lines.push(format!("{key}: {value}"));
    }
}

fn path_label(node: &NodeSummary) -> String {
    let mut out = format!("{}#{}", node.element_type, node.id);
    if let Some(role) = node.role.as_ref() {
        out.push_str(&format!("[{role}]"));
    }
    if let Some(test_id) = node.test_id.as_ref() {
        out.push_str(&format!("[testID={}]", escape_path_value(test_id)));
    } else if let Some(identifier) = node.identifier.as_ref() {
        out.push_str(&format!("[identifier={}]", escape_path_value(identifier)));
    }
    if let Some(label) = node.label.as_ref().or(node.text.as_ref()) {
        out.push_str(&format!(" \"{}\"", label.replace('"', "\\\"")));
    }
    out
}

fn escape_path_value(value: &str) -> String {
    value.replace(']', "\\]")
}

fn snippet(value: Option<&str>, limit: usize) -> Option<String> {
    let normalized = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    if normalized.chars().count() <= limit {
        Some(normalized)
    } else {
        Some(format!(
            "{}...",
            normalized
                .chars()
                .take(limit.saturating_sub(3))
                .collect::<String>()
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex, MutexGuard};

    use gpui::{Modifiers, point, px};

    use super::{
        InspectorHit, InspectorState, MenuAction, NodeSummary, Rect, build_menu, cached_snapshot,
        editor_args, hit_test, is_webview_inspector_message, menu_action_at, menu_snapshot,
        parse_source, refresh_layout_snapshot, refresh_snapshot_cache, snapshot, source_label,
        spawn_editor, tap_target_at,
    };
    use crate::bridge;
    use crate::elements::{AccessibilityInfo, ReactElement};
    use crate::style::ElementStyle;

    static INSPECTOR_TESTS: Mutex<()> = Mutex::new(());

    fn inspector_test_guard() -> MutexGuard<'static, ()> {
        INSPECTOR_TESTS.lock().unwrap()
    }

    fn node(id: u64, element_type: &str, children: Vec<Arc<ReactElement>>) -> Arc<ReactElement> {
        Arc::new(ReactElement {
            global_id: id,
            element_type: element_type.to_string(),
            text: None,
            number_of_lines: None,
            runs: Vec::new(),
            src: None,
            system_material: None,
            system_glass_variant: None,
            system_tint: None,
            system_shadow: None,
            value: None,
            secure_text_entry: false,
            editable: true,
            events: Vec::new(),
            native_layout_key: None,
            native_resize: None,
            native_list_group: None,
            terminal_session_id: None,
            terminal_frames: Vec::new(),
            accessibility: AccessibilityInfo::default(),
            children,
            style: ElementStyle::default(),
            style_json: None,
            cached_gpui_style: None,
        })
    }

    #[test]
    fn hit_test_prefers_deepest_visible_node() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(1002, "text", Vec::new());
        let root = node(1001, "view", vec![child]);
        bridge::remember_layout(1001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(1002, 20.0, 30.0, 120.0, 40.0);

        let hit = hit_test(&root, point(px(35.0), px(42.0))).expect("expected hit");

        assert_eq!(hit.target.id, 1002);
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn hit_test_prefers_interactive_parent_over_text_label() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let mut label = (*node(3003, "text", Vec::new())).clone();
        label.text = Some("Increment".to_string());
        let label = Arc::new(label);
        let mut button = (*node(3002, "view", vec![label])).clone();
        button.events.push("press".to_string());
        button.accessibility.label = Some("Increment".to_string());
        let root = node(3001, "view", vec![Arc::new(button)]);
        bridge::remember_layout(3001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(3002, 10.0, 10.0, 160.0, 44.0);
        bridge::remember_layout(3003, 20.0, 20.0, 80.0, 20.0);

        let hit = hit_test(&root, point(px(35.0), px(30.0))).expect("expected hit");

        assert_eq!(hit.target.id, 3002);
        assert_eq!(hit.events, vec!["press"]);
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn tap_target_uses_press_ancestor_when_visual_hit_is_text() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let mut label = (*node(3103, "text", Vec::new())).clone();
        label.text = Some("Select project".to_string());
        let label = Arc::new(label);
        let mut row = (*node(3102, "view", vec![label])).clone();
        row.events.push("responderRelease".to_string());
        row.accessibility.label = Some("Select project soot".to_string());
        let root = node(3101, "view", vec![Arc::new(row)]);
        bridge::remember_layout(3101, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(3102, 10.0, 10.0, 200.0, 54.0);
        bridge::remember_layout(3103, 24.0, 24.0, 120.0, 18.0);

        let target = tap_target_at(&root, 40.0, 30.0).expect("expected tap target");

        assert_eq!(target.id, 3102);
        assert_eq!(target.events, vec!["responderRelease"]);
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn hit_test_prefers_later_overlapping_sibling() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let lower = node(5002, "view", Vec::new());
        let upper = node(5003, "view", Vec::new());
        let root = node(5001, "view", vec![lower, upper]);
        bridge::remember_layout(5001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(5002, 10.0, 10.0, 160.0, 44.0);
        bridge::remember_layout(5003, 10.0, 10.0, 160.0, 44.0);

        let hit = hit_test(&root, point(px(35.0), px(30.0))).expect("expected hit");

        assert_eq!(hit.target.id, 5003);
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn snapshot_includes_accessibility_events_and_path() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let mut button = (*node(2002, "view", Vec::new())).clone();
        button.events.push("press".to_string());
        button.accessibility.label = Some("Run task".to_string());
        button.accessibility.role = Some("button".to_string());
        button.accessibility.identifier = Some("run-task-button".to_string());
        button.accessibility.identifier_source = Some("testID".to_string());
        button.accessibility.test_id = Some("run-task-button".to_string());
        let button = Arc::new(button);
        let root = node(2001, "view", vec![button]);
        bridge::remember_layout(2001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(2002, 10.0, 10.0, 100.0, 30.0);

        let hit = hit_test(&root, point(px(20.0), px(20.0))).expect("expected hit");
        let copied = snapshot(&hit);

        assert!(copied.contains("id: 2002"));
        assert!(copied.contains("role: button"));
        assert!(copied.contains("identifier: run-task-button"));
        assert!(copied.contains("identifierSource: testID"));
        assert!(copied.contains("testID: run-task-button"));
        assert!(copied.contains("events: press"));
        assert!(
            copied.contains(
                "path: view#2001 > view#2002[button][testID=run-task-button] \"Run task\""
            )
        );
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_waits_for_hold_token_before_activating() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(6002, "view", Vec::new());
        let root = node(6001, "view", vec![child]);
        bridge::remember_layout(6001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(6002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (changed, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");

        assert!(!changed);
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        assert!(!inspector.activate_after_hold(&root, token + 1, true));
        assert!(!inspector.active);

        assert!(inspector.activate_after_hold(&root, token, true));
        assert!(inspector.active);
        assert_eq!(
            inspector.hover.as_ref().map(|hit| hit.target.id),
            Some(6002)
        );
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_blur_invalidates_pending_hold() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(7002, "view", Vec::new());
        let root = node(7001, "view", vec![child]);
        bridge::remember_layout(7001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(7002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (_, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");

        assert!(!inspector.deactivate());
        assert!(!inspector.activate_after_hold(&root, token, true));
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_activation_timer_cannot_show_after_modifier_release() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(8002, "view", Vec::new());
        let root = node(8001, "view", vec![child]);
        bridge::remember_layout(8001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(8002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (_, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");

        assert!(!inspector.activate_after_hold(&root, token, false));
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn inspector_release_hides_active_overlay_immediately() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let child = node(9002, "view", Vec::new());
        let root = node(9001, "view", vec![child]);
        bridge::remember_layout(9001, 0.0, 0.0, 400.0, 300.0);
        bridge::remember_layout(9002, 12.0, 14.0, 80.0, 40.0);

        let mut inspector = InspectorState::new(true);
        let (_, token) = inspector.handle_modifiers(
            &root,
            point(px(20.0), px(20.0)),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        );
        let token = token.expect("alt hold should schedule activation");
        assert!(inspector.activate_after_hold(&root, token, true));
        assert!(inspector.active);
        assert!(inspector.hover.is_some());

        let (changed, activation_token) =
            inspector.handle_modifiers(&root, point(px(20.0), px(20.0)), Modifiers::default());

        assert!(changed);
        assert!(activation_token.is_none());
        assert!(!inspector.active);
        assert!(inspector.hover.is_none());
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn snapshot_cache_includes_webview_hosts() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let webview = node(4002, "webview", Vec::new());
        let root = node(4001, "view", vec![webview]);
        bridge::remember_layout(4001, 0.0, 0.0, 400.0, 300.0);

        refresh_snapshot_cache(&root);
        assert!(
            cached_snapshot(4002).is_none(),
            "webview snapshot should wait for layout"
        );

        refresh_layout_snapshot(4002, 50.0, 60.0, 180.0, 120.0);
        let copied = cached_snapshot(4002).expect("expected cached webview snapshot");

        assert!(copied.contains("id: 4002"));
        assert!(copied.contains("type: webview"));
        assert!(copied.contains("rect: 50,60 180x120"));
        assert!(copied.contains("path: view#4001 > webview#4002"));
        bridge::retain_layout(&HashSet::new());
    }

    #[test]
    fn webview_inspector_message_uses_private_envelope() {
        assert!(is_webview_inspector_message(
            r#"{"__rngpuiInspector":true,"event":"copy"}"#
        ));
        assert!(!is_webview_inspector_message("__rngpui_inspector_click__"));
        assert!(!is_webview_inspector_message(
            r#"{"__rngpuiInspector":true,"event":"message"}"#
        ));
    }

    // ─── option+click menu ──────────────────────────────────────────────────────

    fn ns(id: u64, element_type: &str, source: Option<&str>) -> NodeSummary {
        NodeSummary {
            id,
            element_type: element_type.to_string(),
            role: None,
            label: None,
            identifier: None,
            identifier_source: None,
            native_id: None,
            test_id: None,
            prop_id: None,
            text: None,
            source: source.map(str::to_string),
        }
    }

    fn hit_with_path(path: Vec<NodeSummary>, bounds: Rect) -> InspectorHit {
        InspectorHit {
            target: path.last().expect("path is non-empty").clone(),
            bounds,
            events: Vec::new(),
            native_list_group: None,
            value: None,
            style: Vec::new(),
            path,
            rank: 10,
            depth: 0,
            order: 0,
        }
    }

    #[test]
    fn parse_source_peels_line_and_column() {
        assert_eq!(
            parse_source("/a/b.tsx:42:7"),
            ("/a/b.tsx".to_string(), Some(42), Some(7))
        );
        assert_eq!(
            parse_source("/a/b.tsx:42"),
            ("/a/b.tsx".to_string(), Some(42), None)
        );
        assert_eq!(
            parse_source("/a/b.tsx"),
            ("/a/b.tsx".to_string(), None, None)
        );
        // a non-numeric ':' segment in the path is preserved, not mistaken for a line.
        assert_eq!(
            parse_source("/a/b:c.tsx"),
            ("/a/b:c.tsx".to_string(), None, None)
        );
    }

    #[test]
    fn editor_args_match_each_editor_cli() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            editor_args("code", "/x.tsx", Some(4), Some(2)),
            s(&["-g", "/x.tsx:4:2"])
        );
        // a fully-qualified path still matches on the basename.
        assert_eq!(
            editor_args("/usr/local/bin/cursor", "/x.tsx", Some(4), Some(2)),
            s(&["-g", "/x.tsx:4:2"])
        );
        assert_eq!(
            editor_args("zed", "/x.tsx", Some(4), Some(2)),
            s(&["/x.tsx:4:2"])
        );
        assert_eq!(
            editor_args("nvim", "/x.tsx", Some(4), None),
            s(&["+4", "/x.tsx"])
        );
        assert_eq!(
            editor_args("idea", "/x.tsx", Some(4), Some(2)),
            s(&["--line", "4", "--column", "2", "/x.tsx"])
        );
        // an unknown editor just gets the bare file path.
        assert_eq!(
            editor_args("ed", "/x.tsx", Some(4), Some(2)),
            s(&["/x.tsx"])
        );
    }

    #[test]
    fn spawn_editor_execs_with_resolved_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = inspector_test_guard();
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        let marker = dir.join(format!("rngpui-editor-args-{pid}.txt"));
        let script = dir.join(format!("rngpui-fake-editor-{pid}.sh"));
        let _ = std::fs::remove_file(&marker);
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\n",
                marker.display()
            ),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let mut child = spawn_editor(
            script.to_str().unwrap(),
            "/Users/n8/agentbus/gui/interface/agentbus/RightPanel.tsx:42:7",
        )
        .expect("spawn editor");
        child.wait().unwrap();

        let recorded = std::fs::read_to_string(&marker).unwrap();
        // an unknown basename → bare file path, so the editor received exactly the file.
        assert_eq!(
            recorded.trim(),
            "/Users/n8/agentbus/gui/interface/agentbus/RightPanel.tsx"
        );
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn spawn_editor_passes_vscode_goto_args() {
        // Proves the exact argv real VS Code would receive (`code -g <file>:<line>:<col>`)
        // without opening a window: the recorder script is *named* `code` (so the basename
        // resolves the -g flavor) but spawned by absolute path, so our script runs — not the
        // real `code` on PATH.
        use std::os::unix::fs::PermissionsExt;
        let _guard = inspector_test_guard();
        let dir = std::env::temp_dir().join(format!("rngpui-ed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("args.txt");
        let script = dir.join("code"); // basename "code" → editor_args yields the -g flavor
        let _ = std::fs::remove_file(&marker);
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\n",
                marker.display()
            ),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let mut child = spawn_editor(
            script.to_str().unwrap(),
            "/Users/n8/agentbus/gui/interface/agentbus/RightPanel.tsx:42:7",
        )
        .expect("spawn editor");
        child.wait().unwrap();

        let recorded = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(
            recorded,
            "-g\n/Users/n8/agentbus/gui/interface/agentbus/RightPanel.tsx:42:7\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_menu_chain_is_innermost_first() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let app = ns(1, "view", Some("/a/App.tsx:1:1"));
        let panel = ns(2, "view", Some("/a/Panel.tsx:5:3"));
        let button = ns(3, "pressable", Some("/a/Button.tsx:9:7"));
        bridge::remember_layout(3, 10.0, 20.0, 100.0, 30.0);
        let hit = hit_with_path(
            vec![app, panel, button],
            Rect {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 30.0,
            },
        );

        let menu = build_menu(hit, point(px(50.0), px(60.0)), (1200.0, 800.0));

        assert_eq!(menu.chain[0].summary.id, 3, "clicked node is innermost");
        assert_eq!(menu.chain[1].summary.id, 2);
        assert_eq!(menu.chain[2].summary.id, 1, "root is last");
        assert_eq!(menu.selected, 0);
        assert_eq!(menu.selected_source(), Some("/a/Button.tsx:9:7"));
        // the clicked node's bounds came from the layout cache (drives the highlight).
        assert_eq!(
            menu.chain[0].bounds.map(|b| (b.x, b.height)),
            Some((10.0, 30.0))
        );
    }

    #[test]
    fn menu_action_at_resolves_every_clickable_region() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let hit = hit_with_path(
            vec![
                ns(1, "view", Some("/a/App.tsx:1:1")),
                ns(2, "pressable", Some("/a/Button.tsx:9:7")),
            ],
            Rect {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0,
            },
        );
        let menu = build_menu(hit, point(px(40.0), px(40.0)), (1200.0, 800.0));

        // the center of every frozen item rect resolves back to that item's action.
        for item in &menu.items {
            let cx = item.rect.x + item.rect.width / 2.0;
            let cy = item.rect.y + item.rect.height / 2.0;
            assert_eq!(
                menu_action_at(&menu, point(px(cx), px(cy))),
                Some(item.action),
                "item {:?} should be hit at its center",
                item.action
            );
        }
        // Open / Copy / Close are always present.
        assert!(menu.items.iter().any(|i| i.action == MenuAction::Open));
        assert!(menu.items.iter().any(|i| i.action == MenuAction::Copy));
        assert!(menu.items.iter().any(|i| i.action == MenuAction::Close));
        // a point well outside the panel hits nothing.
        let outside = point(
            px(menu.panel.x + menu.panel.width + 80.0),
            px(menu.panel.y + menu.panel.height + 80.0),
        );
        assert_eq!(menu_action_at(&menu, outside), None);
    }

    #[test]
    fn menu_snapshot_is_rich_for_leaf_and_light_for_ancestor() {
        let _guard = inspector_test_guard();
        bridge::retain_layout(&HashSet::new());
        let mut button = ns(3, "pressable", Some("/a/Button.tsx:9:7"));
        button.test_id = Some("run-task".to_string());
        let hit = hit_with_path(
            vec![
                ns(1, "view", Some("/a/App.tsx:1:1")),
                ns(2, "view", Some("/a/Panel.tsx:5:3")),
                button,
            ],
            Rect {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0,
            },
        );
        let mut menu = build_menu(hit, point(px(10.0), px(10.0)), (1200.0, 800.0));

        // selected == leaf → the rich hit snapshot, including its source line.
        let leaf_snapshot = menu_snapshot(&menu);
        assert!(leaf_snapshot.contains("id: 3"));
        assert!(leaf_snapshot.contains("source: /a/Button.tsx:9:7"));

        // select an ancestor → a lighter snapshot scoped to that node, root→node path.
        menu.selected = 1;
        let ancestor_snapshot = menu_snapshot(&menu);
        assert!(ancestor_snapshot.contains("id: 2"));
        assert!(ancestor_snapshot.contains("source: /a/Panel.tsx:5:3"));
        assert!(ancestor_snapshot.contains("path: view#1 > view#2"));
    }

    #[test]
    fn source_label_shows_basename_and_line() {
        assert_eq!(
            source_label("/Users/n8/agentbus/gui/interface/RightPanel.tsx:42:7"),
            "RightPanel.tsx:42"
        );
        assert_eq!(source_label("/a/App.tsx"), "App.tsx");
    }

    #[test]
    fn summary_reads_source_from_side_table() {
        let _guard = inspector_test_guard();
        super::clear_sources();
        super::remember_source(54321, "/a/Widget.tsx:8:3");
        let element = node(54321, "view", Vec::new());
        assert_eq!(
            super::summary(&element).source.as_deref(),
            Some("/a/Widget.tsx:8:3")
        );
        // a node with no recorded source has none.
        let other = node(99999, "view", Vec::new());
        assert_eq!(super::summary(&other).source, None);
        super::clear_sources();
    }
}
