#![allow(unexpected_cfgs)]

use std::io::{self, BufRead};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use gpui::{
    App, AppContext, Bounds, Context, Entity, InteractiveElement as _, IntoElement, KeyBinding,
    Menu, MenuItem, ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, Pixels, Point, Render, Styled, TitlebarOptions, Window,
    WindowBounds, WindowOptions, actions, point, px, size,
};
use gpui_component::input::{Enter, InputEvent, InputState, Position};
use gpui_component::theme::{Theme, ThemeMode};
use serde::Deserialize;

actions!(rngpui, [Quit]);

#[derive(Clone, PartialEq, Eq, Deserialize, gpui::Action)]
#[action(namespace = rngpui, no_json)]
struct InvokeCommand {
    id: String,
}

#[cfg(target_os = "macos")]
mod ax;
mod bridge;
mod elements;
mod hit_passthrough;
mod icons;
mod inspector;
#[cfg(target_os = "macos")]
mod liquid_glass;
mod style;

use elements::webview::WebViewContent;
use elements::{AccessibilityInfo, ReactElement, create_element};
use elements::{NativeResizeEdge, NativeResizeSpec, TerminalFrame, TerminalFrameKind};
use raw_window_handle::HasWindowHandle;
use style::{Dim, ElementStyle};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

// Injected into every <WebView> before its content loads: the React Native bridge
// global, so existing RN web content (and our own pages) can post to the host with
// `window.ReactNativeWebView.postMessage(data)`. It tunnels through wry's IPC, which
// the service forwards to the node's onMessage handler.
const RN_WEBVIEW_SHIM: &str = "window.ReactNativeWebView={postMessage:function(d){\
    window.ipc.postMessage(typeof d==='string'?d:JSON.stringify(d))}};";

fn parse_json_tree(value: &serde_json::Value) -> Option<Arc<ReactElement>> {
    let obj = value.as_object()?;
    let element_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("div");
    let global_id = obj
        .get("globalId")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(next_id);
    // `text` is overloaded by node type: text content, input placeholder, svg icon
    // name, or webview html — whichever the serializer set.
    let text = obj
        .get("text")
        .or_else(|| obj.get("placeholder"))
        .or_else(|| obj.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let number_of_lines = obj
        .get("numberOfLines")
        .and_then(|v| v.as_u64())
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0);
    let src = obj
        .get("src")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let value = obj
        .get("value")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let secure_text_entry = obj
        .get("secureTextEntry")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let editable = obj
        .get("editable")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let events = obj
        .get("events")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let accessibility = obj
        .get("accessibility")
        .and_then(parse_accessibility)
        .unwrap_or_default();
    let native_layout_key = obj
        .get("nativeLayoutKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let native_resize = obj.get("nativeResize").and_then(parse_native_resize);
    let native_list_group = obj
        .get("nativeListGroup")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let terminal_session_id = obj
        .get("terminalSessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let terminal_frames = obj
        .get("terminalFrames")
        .and_then(|v| v.as_array())
        .map(|frames| frames.iter().filter_map(parse_terminal_frame).collect())
        .unwrap_or_default();
    let style = obj
        .get("style")
        .map(ElementStyle::from_json)
        .unwrap_or_default();
    let children: Vec<Arc<ReactElement>> = obj
        .get("children")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(parse_json_tree).collect())
        .unwrap_or_default();

    let runs = obj
        .get("runs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let o = r.as_object()?;
                    Some(crate::elements::TextRun {
                        text: o.get("text").and_then(|v| v.as_str())?.to_string(),
                        font_weight: o
                            .get("fontWeight")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        color: o
                            .get("color")
                            .and_then(|v| v.as_str())
                            .and_then(crate::style::parse_css_color),
                        font_style: o
                            .get("fontStyle")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // precompute the GPUI style once per React commit. the element is an immutable
    // Arc reused across every frame, and build_gpui_style is a pure function of the
    // (also immutable) style — so caching it here turns the ~280-line per-frame
    // rebuild (run in both request_layout and paint, for every element) into a clone.
    let cached_gpui_style = Some(style.build_gpui_style(None));
    Some(Arc::new(ReactElement {
        global_id,
        element_type: element_type.to_string(),
        text,
        number_of_lines,
        runs,
        src,
        value,
        secure_text_entry,
        editable,
        events,
        native_layout_key,
        native_resize,
        native_list_group,
        terminal_session_id,
        terminal_frames,
        accessibility,
        children,
        style,
        cached_gpui_style,
    }))
}

fn parse_terminal_frame(value: &serde_json::Value) -> Option<TerminalFrame> {
    let obj = value.as_object()?;
    let seq = obj.get("seq")?.as_u64()?;
    if seq == 0 {
        return None;
    }
    let kind = match obj.get("kind")?.as_str()? {
        "snapshot" => TerminalFrameKind::Snapshot,
        "bytes" => TerminalFrameKind::Bytes,
        "resize" => TerminalFrameKind::Resize,
        _ => return None,
    };
    let data = obj
        .get("data")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let cols = obj
        .get("cols")
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| *v > 0);
    let rows = obj
        .get("rows")
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| *v > 0);
    Some(TerminalFrame {
        seq,
        kind,
        data,
        cols,
        rows,
    })
}

fn parse_native_resize(value: &serde_json::Value) -> Option<NativeResizeSpec> {
    let obj = value.as_object()?;
    let target = obj.get("target").and_then(|v| v.as_str())?;
    if target.is_empty() {
        return None;
    }
    let edge = match obj.get("edge").and_then(|v| v.as_str())? {
        "left" => NativeResizeEdge::Left,
        "right" => NativeResizeEdge::Right,
        "top" => NativeResizeEdge::Top,
        "bottom" => NativeResizeEdge::Bottom,
        _ => return None,
    };
    Some(NativeResizeSpec {
        target: target.to_string(),
        edge,
        min: obj.get("min").and_then(|v| v.as_f64()).map(|v| v as f32),
        max: obj.get("max").and_then(|v| v.as_f64()).map(|v| v as f32),
    })
}

fn parse_point_env(name: &str) -> Option<Point<Pixels>> {
    let value = std::env::var(name).ok()?;
    let mut parts = value.split(',').map(str::trim);
    let x = parts.next()?.parse::<f32>().ok()?;
    let y = parts.next()?.parse::<f32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(point(px(x), px(y)))
}

fn parse_accessibility(value: &serde_json::Value) -> Option<AccessibilityInfo> {
    let obj = value.as_object()?;
    let checked = match obj.get("checked") {
        Some(v) if v.is_boolean() => Some(v.as_bool().unwrap().to_string()),
        Some(v) => v.as_str().map(String::from),
        None => None,
    };
    Some(AccessibilityInfo {
        accessible: obj.get("accessible").and_then(|v| v.as_bool()),
        hidden: obj.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false),
        label: obj.get("label").and_then(|v| v.as_str()).map(String::from),
        role: obj.get("role").and_then(|v| v.as_str()).map(String::from),
        hint: obj.get("hint").and_then(|v| v.as_str()).map(String::from),
        value: obj.get("value").and_then(|v| v.as_str()).map(String::from),
        identifier: obj
            .get("identifier")
            .and_then(|v| v.as_str())
            .map(String::from),
        identifier_source: obj
            .get("identifierSource")
            .and_then(|v| v.as_str())
            .map(String::from),
        native_id: obj
            .get("nativeID")
            .and_then(|v| v.as_str())
            .map(String::from),
        test_id: obj.get("testID").and_then(|v| v.as_str()).map(String::from),
        prop_id: obj.get("propID").and_then(|v| v.as_str()).map(String::from),
        disabled: obj
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        selected: obj
            .get("selected")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        checked,
        expanded: obj.get("expanded").and_then(|v| v.as_bool()),
    })
}

/// Make the root element fill the window so the layout reflows on resize. We keep
/// its width/height only for the *initial* window size, then strip them and let it
/// grow to the window's content box (RN's root behaves like `flex: 1`).
fn fill_root(root: Arc<ReactElement>) -> Arc<ReactElement> {
    let mut r = (*root).clone();
    r.style.width = None;
    r.style.height = None;
    // grow to the window's content box but collapse the base size to 0 (flex:1),
    // so the root is bounded by the window height — not by its (taller) content —
    // which is what lets a `flex:1` ScrollView inside it actually scroll.
    r.style.flex_grow = Some(1.0);
    r.style.flex_basis = Some(Dim::Pct(0.0));
    r.style.align_self = Some("stretch".to_string());
    // CRITICAL: we just mutated the style after parse_json_tree cached it, so the
    // cache is stale (it still holds the root's fixed initial width/height). Rebuild
    // it from the filled style — otherwise build_gpui_style returns the cached fixed
    // size and the root stops flex-filling the window, so layout no longer reflows on
    // resize (it only catches up when JS sends a fresh tree). Regression from caching.
    r.cached_gpui_style = Some(r.style.build_gpui_style(None));
    Arc::new(r)
}

fn root_theme_mode(root: &ReactElement) -> ThemeMode {
    let default_background = crate::style::u32_to_hsla(0xe9e9ec);
    let background = root.style.background_color.unwrap_or(default_background);
    let lightness = background.l * background.a + default_background.l * (1.0 - background.a);
    if lightness >= 0.5 {
        ThemeMode::Light
    } else {
        ThemeMode::Dark
    }
}

struct ServiceApp {
    root: Arc<ReactElement>,
    last_w: f64,
    last_h: f64,
    // persistent gpui-component input state, one per <TextInput>/<TextArea> id.
    inputs: HashMap<u64, Entity<InputState>>,
    input_values: HashMap<u64, Option<String>>,
    input_secure: HashMap<u64, bool>,
    suppressed_input_changes: HashMap<u64, VecDeque<String>>,
    // persistent native WebView, one per <WebView> id.
    webviews: HashMap<u64, Rc<wry::WebView>>,
    inspector: inspector::InspectorState,
}

type InputSpec = (u64, String, Option<String>, bool, bool);

fn schedule_inspector_activation(cx: &mut Context<ServiceApp>, token: u64) {
    cx.spawn(async move |this, cx| {
        cx.background_executor()
            .timer(inspector::INSPECTOR_ACTIVATION_HOLD)
            .await;
        let changed = this
            .update(cx, |this, cx| {
                let root = this.root.clone();
                let changed = this.inspector.activate_after_hold(
                    &root,
                    token,
                    inspector::current_option_modifier_down(),
                );
                if changed {
                    cx.notify();
                }
                changed
            })
            .unwrap_or(false);
        if changed {
            let _ = cx.update(|cx| cx.refresh_windows());
        }
    })
    .detach();
}

/// collect (id, placeholder, value, multiline, secure) for every text-input node in the tree.
fn collect_inputs(el: &Arc<ReactElement>, out: &mut Vec<InputSpec>) {
    if el.element_type == "textinput" || el.element_type == "textarea" {
        let multiline = el.element_type == "textarea";
        out.push((
            el.global_id,
            el.text.clone().unwrap_or_default(),
            el.value.clone(),
            multiline,
            el.secure_text_entry && !multiline,
        ));
    }
    for c in &el.children {
        collect_inputs(c, out);
    }
}

fn position_for_byte_offset(text: &str, byte_offset: usize) -> Position {
    let mut line = 0;
    let mut character = 0;
    for (index, ch) in text.char_indices() {
        if index >= byte_offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            character = 0;
        } else {
            character += ch.len_utf16() as u32;
        }
    }
    Position { line, character }
}

fn value_without_submit_newline(input: &InputState) -> Option<(String, Position)> {
    let value = input.value().to_string();
    let cursor = input.cursor().min(value.len());
    let newline_start = cursor.checked_sub(1)?;
    if value.get(newline_start..cursor) != Some("\n") {
        return None;
    }
    let mut next = value;
    next.replace_range(newline_start..cursor, "");
    let cursor_position = position_for_byte_offset(&next, newline_start);
    Some((next, cursor_position))
}

fn suppress_next_input_change(
    suppressed: &mut HashMap<u64, VecDeque<String>>,
    id: u64,
    value: String,
) {
    suppressed.entry(id).or_default().push_back(value);
}

fn consume_suppressed_input_change(
    suppressed: &mut HashMap<u64, VecDeque<String>>,
    id: u64,
    value: &str,
) -> bool {
    let Some(values) = suppressed.get_mut(&id) else {
        return false;
    };
    let Some(index) = values.iter().position(|expected| expected == value) else {
        return false;
    };
    values.remove(index);
    let empty = values.is_empty();
    if empty {
        suppressed.remove(&id);
    }
    true
}

/// Collect (id, content, is_html) for every webview node. Prefers a `src` uri;
/// falls back to inline html carried in `text`.
fn collect_webviews(el: &Arc<ReactElement>, out: &mut Vec<(u64, String, bool)>) {
    if el.element_type == "webview" {
        if let Some(uri) = el.src.clone() {
            out.push((el.global_id, uri, false));
        } else if let Some(html) = el.text.clone() {
            out.push((el.global_id, html, true));
        }
    }
    for c in &el.children {
        collect_webviews(c, out);
    }
}

/// Collect ids of every node that listens for onLayout, to GC stale dedup state.
fn collect_layout_ids(el: &Arc<ReactElement>, out: &mut HashSet<u64>) {
    if el.listens("layout") {
        out.insert(el.global_id);
    }
    for c in &el.children {
        collect_layout_ids(c, out);
    }
}

/// Map gpui's window appearance to the JS color-scheme name the bridge speaks.
fn appearance_scheme(appearance: gpui::WindowAppearance) -> &'static str {
    match appearance {
        gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => "dark",
        gpui::WindowAppearance::Light | gpui::WindowAppearance::VibrantLight => "light",
    }
}

fn emit_definite_cached_layouts(el: &Arc<ReactElement>) {
    if el.listens("layout") {
        if let Some((x, y, cached_w, cached_h)) = bridge::cached_layout(el.global_id) {
            let width = el.style.width.and_then(Dim::as_px).unwrap_or(cached_w);
            let height = el.style.height.and_then(Dim::as_px).unwrap_or(cached_h);
            if (width - cached_w).abs() > 0.5 || (height - cached_h).abs() > 0.5 {
                bridge::remember_layout(el.global_id, x, y, width, height);
                bridge::emit_layout(el.global_id, x, y, width, height);
            }
        }
    }
    for c in &el.children {
        emit_definite_cached_layouts(c);
    }
}

fn collect_node_ids(el: &Arc<ReactElement>, out: &mut HashSet<u64>) {
    out.insert(el.global_id);
    for c in &el.children {
        collect_node_ids(c, out);
    }
}

fn collect_native_layout_keys(el: &Arc<ReactElement>, out: &mut HashSet<String>) {
    if let Some(key) = el.native_layout_key.as_ref() {
        out.insert(key.clone());
    }
    for c in &el.children {
        collect_native_layout_keys(c, out);
    }
}

impl Render for ServiceApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        // reset the per-frame hit-test passthrough registry before this frame's prepaint
        // pass repopulates it (webview rects + occluder rects, for native webview events).
        hit_passthrough::begin_frame();
        // The tree is applied (and a re-render scheduled) by the stdin pump task in
        // `main`, not polled here — rendering is fully on-demand: this runs only on a
        // new tree, input, scroll, or resize, so the app idles at ~0fps.
        let theme_mode = root_theme_mode(&self.root);
        if Theme::global(cx).mode != theme_mode {
            Theme::change(theme_mode, Some(window), cx);
        }
        Theme::global_mut(cx).background = gpui::Hsla::transparent_black();

        // Emit a `resize` event whenever the content size changes, so the JS side
        // can update Dimensions and re-render. Bridges RN's Dimensions API.
        let vs = window.viewport_size();
        let w: f64 = vs.width.into();
        let h: f64 = vs.height.into();
        if (w - self.last_w).abs() > 0.5 || (h - self.last_h).abs() > 0.5 {
            self.last_w = w;
            self.last_h = h;
            bridge::resize(w as f32, h as f32);
        }

        // Ensure a persistent InputState entity exists for every text-input node,
        // subscribing once so edits stream back to JS as `changeText`, and observing
        // it so this view re-renders (and the edit shows) when the input changes.
        let mut specs = Vec::new();
        collect_inputs(&self.root, &mut specs);
        let present: HashSet<u64> = specs.iter().map(|(id, _, _, _, _)| *id).collect();
        self.inputs.retain(|id, _| present.contains(id));
        self.input_values.retain(|id, _| present.contains(id));
        self.input_secure.retain(|id, _| present.contains(id));
        self.suppressed_input_changes
            .retain(|id, _| present.contains(id));
        for (id, placeholder, value, multiline, secure) in specs {
            if !self.inputs.contains_key(&id) {
                let initial_value = value.clone();
                let state = cx.new(|cx| {
                    let mut s = InputState::new(window, cx).placeholder(placeholder.clone());
                    if multiline {
                        s = s.multi_line(true);
                    }
                    if secure {
                        s = s.masked(true);
                    }
                    if let Some(value) = initial_value {
                        s = s.default_value(value);
                    }
                    s
                });
                cx.subscribe_in(
                    &state,
                    window,
                    move |this, input, ev: &InputEvent, window, cx| match ev {
                        InputEvent::Change => {
                            let value = input.read(cx).value().to_string();
                            if consume_suppressed_input_change(
                                &mut this.suppressed_input_changes,
                                id,
                                &value,
                            ) {
                                return;
                            }
                            bridge::change_text(id, value.as_ref());
                            bridge::change(id, value.as_ref());
                        }
                        InputEvent::PressEnter { secondary } => {
                            bridge::key_press(id, "Enter", *secondary, false, false, false);
                            if multiline {
                                if *secondary {
                                    let value = input.read(cx).value().to_string();
                                    bridge::change_text(id, value.as_ref());
                                    bridge::change(id, value.as_ref());
                                    return;
                                }
                                let next = value_without_submit_newline(input.read(cx));
                                if let Some((next, cursor_position)) = next {
                                    let submitted = next.clone();
                                    bridge::change_text(id, next.as_ref());
                                    bridge::change(id, next.as_ref());
                                    suppress_next_input_change(
                                        &mut this.suppressed_input_changes,
                                        id,
                                        next.clone(),
                                    );
                                    input.update(cx, |input, cx| {
                                        input.set_value(next, window, cx);
                                        input.set_cursor_position(cursor_position, window, cx);
                                    });
                                    bridge::submit(id, submitted.as_ref());
                                    return;
                                }
                                let value = input.read(cx).value().to_string();
                                bridge::submit(id, value.as_ref());
                            } else {
                                let value = input.read(cx).value().to_string();
                                bridge::submit(id, value.as_ref());
                            }
                        }
                        InputEvent::Focus => bridge::event(id, "focus"),
                        InputEvent::Blur => bridge::event(id, "blur"),
                    },
                )
                .detach();
                // re-render this view when the input's contents/cursor change
                cx.observe(&state, |_this, _input, cx| cx.notify()).detach();
                self.inputs.insert(id, state);
                self.input_values.insert(id, value);
                self.input_secure.insert(id, secure);
            } else if self.input_values.get(&id) != Some(&value) {
                if let Some(next_value) = value.clone() {
                    if let Some(state) = self.inputs.get(&id) {
                        state.update(cx, |input, cx| {
                            if input.value().as_ref() != next_value.as_str() {
                                let cursor_position =
                                    position_for_byte_offset(&next_value, next_value.len());
                                suppress_next_input_change(
                                    &mut self.suppressed_input_changes,
                                    id,
                                    next_value.clone(),
                                );
                                input.set_value(next_value, window, cx);
                                input.set_cursor_position(cursor_position, window, cx);
                            }
                        });
                    }
                }
                self.input_values.insert(id, value);
            }
            if self.input_secure.get(&id).copied() != Some(secure) {
                if let Some(state) = self.inputs.get(&id) {
                    state.update(cx, |input, cx| {
                        input.set_masked(secure, window, cx);
                    });
                }
                self.input_secure.insert(id, secure);
            }
        }
        elements::input::set_entities(self.inputs.clone());

        // Same lifecycle for <WebView>: create a native child view per id, then
        // let the element resize and load it once layout has real bounds.
        let mut wv_specs = Vec::new();
        collect_webviews(&self.root, &mut wv_specs);
        let present_wv: HashSet<u64> = wv_specs.iter().map(|(id, _, _)| *id).collect();
        self.webviews.retain(|id, _| present_wv.contains(id));
        let mut webview_content = HashMap::new();
        for (id, content, is_html) in wv_specs {
            webview_content.insert(
                id,
                WebViewContent {
                    body: content,
                    is_html,
                },
            );
            let view = self.webviews.entry(id).or_insert_with(|| {
                let dbg = std::env::var("RNGPUI_WEBVIEW_DEBUG").is_ok();
                let inspector_enabled = self.inspector.enabled();
                let initialization_script = if inspector_enabled {
                    format!("{RN_WEBVIEW_SHIM}\n{}", inspector::WEBVIEW_INSPECTOR_SCRIPT)
                } else {
                    RN_WEBVIEW_SHIM.to_string()
                };
                let builder = wry::WebViewBuilder::new()
                    .with_transparent(false)
                    // RN-compatible bridge so page code can talk to the host:
                    // window.ReactNativeWebView.postMessage(d) → the node's onMessage.
                    .with_initialization_script(initialization_script)
                    // page → host: forward every posted message to the JS side, where
                    // it's dispatched to the node's onMessage handler by id.
                    .with_ipc_handler(move |req| {
                        let body = req.body();
                        if dbg {
                            eprintln!("[webview {id}] message: {body}");
                        }
                        if inspector_enabled && inspector::handle_webview_ipc(id, body) {
                            return;
                        }
                        bridge::webview_message(id, body);
                    })
                    // page finished loading → fire the node's onLoad. Under DEBUG this is
                    // also the quickest way to distinguish load from compositing issues.
                    .with_on_page_load_handler(move |event, _url| {
                        if matches!(event, wry::PageLoadEvent::Finished) {
                            if dbg {
                                eprintln!("[webview {id}] page-load finished");
                            }
                            bridge::event(id, "load");
                        }
                    });
                #[cfg(target_os = "macos")]
                let wv = {
                    elements::webview::ensure_webview_host(window, id)
                        .expect("failed to create webview host");
                    let window_handle = window.window_handle().expect("No window handle");
                    builder.build_as_child(&window_handle)
                };
                #[cfg(not(target_os = "macos"))]
                let wv = {
                    let window_handle = window.window_handle().expect("No window handle");
                    builder.build_as_child(&window_handle)
                };
                let wv = wv.expect("failed to create webview");
                let _ = wv.set_visible(true);
                Rc::new(wv)
            });
            let _ = view.set_visible(true);
        }
        elements::webview::set_webviews(self.webviews.clone(), webview_content);
        if self.inspector.enabled() {
            inspector::refresh_snapshot_cache(&self.root);
        }

        // GC layout-dedup state for nodes that left the tree.
        let mut node_ids = HashSet::new();
        collect_node_ids(&self.root, &mut node_ids);
        bridge::retain_layout(&node_ids);
        let mut native_layout_keys = HashSet::new();
        collect_native_layout_keys(&self.root, &mut native_layout_keys);
        elements::retain_native_layout_keys(&native_layout_keys);

        let mut layout_ids = HashSet::new();
        collect_layout_ids(&self.root, &mut layout_ids);
        bridge::emit_cached_layout_for_new_subscribers(&layout_ids);

        #[cfg(target_os = "macos")]
        ax::sync_tree(window, &self.root);

        let root = create_element(self.root.clone(), 0, None);
        let mut frame = gpui::div()
            .size_full()
            .flex()
            .flex_col()
            .on_action(|action: &InvokeCommand, _window, _cx| {
                bridge::command(&action.id);
            })
            .on_mouse_up(MouseButton::Left, |_event: &MouseUpEvent, _window, _cx| {
                elements::finish_pointer_gesture();
            })
            .on_mouse_up_out(MouseButton::Left, |_event: &MouseUpEvent, _window, _cx| {
                elements::finish_pointer_gesture();
            })
            .child(root);

        if self.inspector.enabled() {
            frame = frame
                .on_modifiers_changed(cx.listener(
                    |this, event: &ModifiersChangedEvent, window, cx| {
                        let root = this.root.clone();
                        let (changed, activation_token) = this.inspector.handle_modifiers(
                            &root,
                            window.mouse_position(),
                            event.modifiers,
                        );
                        if let Some(token) = activation_token {
                            schedule_inspector_activation(cx, token);
                        }
                        if changed {
                            cx.notify();
                            window.refresh();
                        }
                    },
                ))
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                    let root = this.root.clone();
                    let (changed, activation_token) =
                        this.inspector.handle_mouse_move(&root, event);
                    if let Some(token) = activation_token {
                        schedule_inspector_activation(cx, token);
                    }
                    if changed {
                        cx.notify();
                        window.refresh();
                    }
                }))
                .capture_any_mouse_down(cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    let root = this.root.clone();
                    if this.inspector.handle_mouse_down(&root, event, cx) {
                        cx.stop_propagation();
                        cx.notify();
                        window.refresh();
                    }
                }))
                .capture_any_mouse_up(cx.listener(|this, event: &MouseUpEvent, window, cx| {
                    if this.inspector.handle_mouse_up(event) {
                        cx.stop_propagation();
                        cx.notify();
                        window.refresh();
                    }
                }));
            if let Some(overlay) = self.inspector.overlay() {
                frame = frame.child(overlay);
            }
        }

        frame.into_any_element()
    }
}

fn fallback_root() -> Arc<ReactElement> {
    Arc::new(ReactElement {
        global_id: 1,
        element_type: "div".to_string(),
        text: None,
        number_of_lines: None,
        runs: Vec::new(),
        src: None,
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
        children: vec![],
        style: ElementStyle {
            width: Some(Dim::Px(720.0)),
            height: Some(Dim::Px(800.0)),
            flex_direction: Some("column".to_string()),
            ..Default::default()
        },
        cached_gpui_style: None,
    })
}

#[derive(Clone, Deserialize)]
struct AppCommandConfig {
    #[serde(default)]
    bindings: Vec<AppCommandBinding>,
    #[serde(default)]
    menus: Vec<AppCommandMenu>,
}

#[derive(Clone, Deserialize)]
struct AppCommandBinding {
    id: String,
    key: String,
    context: Option<String>,
}

#[derive(Clone, Deserialize)]
struct AppCommandMenu {
    label: String,
    #[serde(default)]
    items: Vec<AppCommandMenuItem>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind")]
enum AppCommandMenuItem {
    #[serde(rename = "action")]
    Action { id: String, label: String },
    #[serde(rename = "separator")]
    Separator,
    #[serde(rename = "submenu")]
    Submenu {
        label: String,
        #[serde(default)]
        items: Vec<AppCommandMenuItem>,
    },
}

/// A message from the JS side over stdin: either a new element tree to render, or a
/// command targeting a live `<WebView>` (host → frame: ref.injectJavaScript / reload).
enum Incoming {
    Tree(Arc<ReactElement>),
    Eval {
        id: u64,
        js: String,
    },
    Reload {
        id: u64,
    },
    ScrollTo {
        id: u64,
        x: Option<f32>,
        y: Option<f32>,
    },
    ScrollToEnd {
        id: u64,
    },
    NativeLayout {
        key: String,
        width: Option<f32>,
        height: Option<f32>,
        x: Option<f32>,
        y: Option<f32>,
        animate_ms: Option<f32>,
        clear: bool,
    },
    FocusInput {
        id: u64,
    },
    BlurInput,
    AppCommands(AppCommandConfig),
}

/// Parse one stdin line into an `Incoming`. A `$cmd` object is a webview command;
/// anything else is parsed as an element tree.
fn parse_incoming(v: &serde_json::Value) -> Option<Incoming> {
    if let Some(cmd) = v.get("$cmd").and_then(|c| c.as_str()) {
        let id = v.get("id").and_then(|x| x.as_u64());
        return match cmd {
            "eval" => match (id, v.get("js").and_then(|x| x.as_str())) {
                (Some(id), Some(js)) => Some(Incoming::Eval {
                    id,
                    js: js.to_string(),
                }),
                _ => None,
            },
            "reload" => id.map(|id| Incoming::Reload { id }),
            "scrollTo" => id.map(|id| Incoming::ScrollTo {
                id,
                x: v.get("x").and_then(|x| x.as_f64()).map(|x| x as f32),
                y: v.get("y").and_then(|x| x.as_f64()).map(|x| x as f32),
            }),
            "scrollToEnd" => id.map(|id| Incoming::ScrollToEnd { id }),
            "nativeLayout" => {
                let key = v.get("key").and_then(|x| x.as_str())?;
                Some(Incoming::NativeLayout {
                    key: key.to_string(),
                    width: v.get("width").and_then(|x| x.as_f64()).map(|x| x as f32),
                    height: v.get("height").and_then(|x| x.as_f64()).map(|x| x as f32),
                    x: v.get("x").and_then(|x| x.as_f64()).map(|x| x as f32),
                    y: v.get("y").and_then(|x| x.as_f64()).map(|x| x as f32),
                    animate_ms: v
                        .get("animateMs")
                        .and_then(|x| x.as_f64())
                        .map(|x| x as f32),
                    clear: v.get("clear").and_then(|x| x.as_bool()).unwrap_or(false),
                })
            }
            "focusInput" => id.map(|id| Incoming::FocusInput { id }),
            "blurInput" => Some(Incoming::BlurInput),
            "appCommands" => serde_json::from_value(v.clone())
                .ok()
                .map(Incoming::AppCommands),
            _ => None,
        };
    }
    parse_json_tree(v).map(Incoming::Tree)
}

fn install_app_commands(config: AppCommandConfig, cx: &mut App) {
    let bindings = config.bindings.into_iter().filter_map(|binding| {
        if binding.id.is_empty() || binding.key.is_empty() {
            return None;
        }
        Some(KeyBinding::new(
            &binding.key,
            InvokeCommand { id: binding.id },
            binding.context.as_deref(),
        ))
    });
    cx.bind_keys(bindings);

    let mut menus = vec![Menu {
        name: "react-native-gpui".into(),
        items: vec![MenuItem::action("Quit", Quit)],
    }];
    menus.extend(config.menus.into_iter().map(build_app_menu));
    cx.set_menus(menus);
}

fn build_app_menu(menu: AppCommandMenu) -> Menu {
    Menu {
        name: menu.label.into(),
        items: menu.items.into_iter().map(build_app_menu_item).collect(),
    }
}

fn build_app_menu_item(item: AppCommandMenuItem) -> MenuItem {
    match item {
        AppCommandMenuItem::Action { id, label } => MenuItem::action(label, InvokeCommand { id }),
        AppCommandMenuItem::Separator => MenuItem::separator(),
        AppCommandMenuItem::Submenu { label, items } => MenuItem::submenu(Menu {
            name: label.into(),
            items: items.into_iter().map(build_app_menu_item).collect(),
        }),
    }
}

fn main() {
    // Background thread continuously reads JSON from stdin (one message per line) and
    // hands each to a flume channel. The first tree bootstraps the window size; the
    // rest are applied by a foreground task that calls cx.notify() — no polling.
    let (tree_tx, tree_rx) = flume::unbounded::<Incoming>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(msg) = parse_incoming(&v) {
                if tree_tx.send(msg).is_err() {
                    break; // window closed
                }
            }
        }
    });

    // first tree bootstraps the window; ignore any commands that arrive before it.
    let initial = loop {
        match tree_rx.recv() {
            Ok(Incoming::Tree(t)) => break t,
            Ok(_) => continue,
            Err(_) => break fallback_root(),
        }
    };

    // Window opens at the root's declared width/height; after that it fills.
    let win_w = initial.style.width.and_then(Dim::as_px).unwrap_or(720.0);
    let win_h = initial.style.height.and_then(Dim::as_px).unwrap_or(800.0);
    // debug override: RNGPUI_WINDOW_SIZE="w,h" forces a fixed window size — e.g. a
    // small corner window for non-focus-stealing visual debugging (a backgrounded
    // window must be unoccluded to render + be screenshotted on macOS).
    let (win_w, win_h) = parse_point_env("RNGPUI_WINDOW_SIZE")
        .map(|p| (f32::from(p.x), f32::from(p.y)))
        .unwrap_or((win_w, win_h));
    let app_root = fill_root(initial);

    bridge::ready(win_w, win_h);

    // test mode keeps conformance windows backgrounded and off the main screen.
    let test_mode = std::env::var("RNGPUI_TEST_MODE").is_ok();
    let test_onscreen = std::env::var("RNGPUI_TEST_ONSCREEN").is_ok();
    let background = test_mode || std::env::var("RNGPUI_NO_ACTIVATE").is_ok();
    let inspector_copy_at = parse_point_env("RNGPUI_INSPECTOR_COPY_AT");
    let offscreen_test_window = test_mode && !test_onscreen && inspector_copy_at.is_none();
    let window_origin = if offscreen_test_window {
        point(px(-10000.0), px(-10000.0))
    } else {
        // debug override: RNGPUI_WINDOW_ORIGIN="x,y" places the window (e.g. a small
        // corner window for non-focus-stealing visual debugging).
        parse_point_env("RNGPUI_WINDOW_ORIGIN").unwrap_or_else(|| point(px(120.0), px(120.0)))
    };
    let show_window = !test_mode || test_onscreen;

    let app = gpui::Application::new().with_assets(icons::Assets);
    app.run(move |cx: &mut App| {
        // sets up gpui-component's theme + the input key bindings (backspace,
        // arrows, select-all, copy/paste, word-motion, …) used by InputState.
        gpui_component::init(cx);
        Theme::global_mut(cx).background = gpui::Hsla::transparent_black();
        // React Native multiline TextInput uses shift+enter for a newline when
        // plain enter submits. gpui-component only binds platform-secondary+enter.
        cx.bind_keys([KeyBinding::new(
            "shift-enter",
            Enter { secondary: true },
            Some("Input"),
        )]);

        // quit on ⌘Q and when the last window closes (X button).
        cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
        cx.on_action(|action: &InvokeCommand, _cx: &mut App| {
            bridge::command(&action.id);
        });
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.set_menus(vec![Menu {
            name: "react-native-gpui".into(),
            items: vec![MenuItem::action("Quit", Quit)],
        }]);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        // The view that renders the tree. Created up front so the stdin pump below
        // can update it directly.
        let content = cx.new(|_| ServiceApp {
            root: app_root,
            last_w: 0.0,
            last_h: 0.0,
            inputs: HashMap::new(),
            input_values: HashMap::new(),
            input_secure: HashMap::new(),
            suppressed_input_changes: HashMap::new(),
            webviews: HashMap::new(),
            inspector: inspector::InspectorState::from_env(),
        });

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: window_origin,
                size: size(px(win_w), px(win_h)),
            })),
            titlebar: if test_mode {
                None
            } else {
                Some(TitlebarOptions {
                    title: Some("react-native-gpui".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(14.0), px(18.0))),
                })
            },
            focus: !background,
            show: show_window,
            // test windows must still be normal windows: popup panels raise
            // above user work. the offscreen test path starts hidden, moves the
            // NSWindow, verifies it stayed offscreen, then reveals it.
            kind: gpui::WindowKind::Normal,
            is_movable: true,
            is_resizable: !test_mode,
            is_minimizable: !test_mode,
            display_id: None,
            window_background: {
                #[cfg(target_os = "macos")]
                {
                    if std::env::var("RNGPUI_OPAQUE_WINDOW").is_ok() {
                        gpui::WindowBackgroundAppearance::Opaque
                    } else {
                        gpui::WindowBackgroundAppearance::Transparent
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    gpui::WindowBackgroundAppearance::Blurred
                }
            },
            app_id: None,
            window_min_size: None,
            window_decorations: None,
            tabbing_identifier: None,
        };

        let pump = content.clone();
        let window_handle = cx
            .open_window(options, move |window, cx| {
                window.set_window_title("react-native-gpui");
                #[cfg(target_os = "macos")]
                liquid_glass::install(window);
                #[cfg(target_os = "macos")]
                if offscreen_test_window && !liquid_glass::show_offscreen_test_window(window) {
                    eprintln!("[rngpui test] window was clamped on-screen; refusing to show");
                    cx.quit();
                }
                let content_for_activation = content.clone();
                content_for_activation.update(cx, |_this, cx| {
                    cx.observe_window_activation(window, |this, window, cx| {
                        if window.is_window_active() {
                            return;
                        }
                        if this.inspector.deactivate() {
                            cx.notify();
                            window.refresh();
                        }
                    })
                    .detach();
                });
                // follow the system light/dark setting: gpui delivers an appearance
                // change whenever macOS toggles theme. push it to JS so tamagui
                // re-themes live, and emit the current value once so JS matches the
                // real window appearance from the first frame.
                bridge::appearance(appearance_scheme(window.appearance()));
                window
                    .observe_window_appearance(|window, _cx| {
                        bridge::appearance(appearance_scheme(window.appearance()));
                    })
                    .detach();
                cx.new(|cx| gpui_component::Root::new(content.clone(), window, cx))
            })
            .expect("open window");
        // bring the app to the front so keystrokes reach the focused input
        // (skipped in background mode so it doesn't pop over your work).
        if !background {
            cx.activate(true);
        }

        if let Some(position) = inspector_copy_at {
            let inspector_pump = pump.clone();
            cx.spawn(async move |cx| {
                for _ in 0..80 {
                    cx.background_executor()
                        .timer(Duration::from_millis(25))
                        .await;
                    let copied = inspector_pump
                        .update(cx, |this, cx| {
                            let root = this.root.clone();
                            this.inspector.copy_at(&root, position, cx)
                        })
                        .unwrap_or(false);
                    if copied {
                        break;
                    }
                }
            })
            .detach();
        }

        let native_layout_driver_active = Arc::new(AtomicBool::new(false));

        // Foreground pump: apply each message on the main thread. A new tree re-renders
        // (cx.notify); a webview command runs straight against the live wry view (which
        // must be driven from the main thread). Both arrive on the same ordered channel.
        cx.spawn(async move |cx| {
            while let Ok(msg) = tree_rx.recv_async().await {
                match msg {
                    Incoming::FocusInput { id } => {
                        let applied = window_handle.update(cx, |_root, window, cx| {
                            pump.update(cx, |this, cx| {
                                if let Some(state) = this.inputs.get(&id) {
                                    state.update(cx, |input, cx| input.focus(window, cx));
                                }
                            })
                        });
                        if applied.is_err() {
                            break;
                        }
                    }
                    Incoming::BlurInput => {
                        if window_handle
                            .update(cx, |_root, window, _cx| window.blur())
                            .is_err()
                        {
                            break;
                        }
                    }
                    Incoming::AppCommands(config) => {
                        if cx.update(|cx| install_app_commands(config, cx)).is_err() {
                            break;
                        }
                    }
                    msg => {
                        let mut drive_native_layout_animation = false;
                        let applied = pump.update(cx, |this, cx| match msg {
                            Incoming::Tree(t) => {
                                let next_root = fill_root(t);
                                let mut node_ids = HashSet::new();
                                collect_node_ids(&next_root, &mut node_ids);
                                bridge::retain_layout(&node_ids);
                                let mut native_layout_keys = HashSet::new();
                                collect_native_layout_keys(&next_root, &mut native_layout_keys);
                                elements::retain_native_layout_keys(&native_layout_keys);
                                let mut layout_ids = HashSet::new();
                                collect_layout_ids(&next_root, &mut layout_ids);
                                bridge::emit_cached_layout_for_new_subscribers(&layout_ids);
                                emit_definite_cached_layouts(&next_root);
                                this.root = next_root;
                                cx.notify();
                            }
                            Incoming::Eval { id, js } => {
                                if let Some(view) = this.webviews.get(&id) {
                                    let _ = view.evaluate_script(&js);
                                }
                            }
                            Incoming::Reload { id } => {
                                if let Some(view) = this.webviews.get(&id) {
                                    let _ = view.reload();
                                }
                            }
                            Incoming::ScrollTo { id, x, y } => {
                                elements::scroll_to(id, x, y);
                                cx.notify();
                            }
                            Incoming::ScrollToEnd { id } => {
                                elements::scroll_to_end(id);
                                cx.notify();
                            }
                            Incoming::NativeLayout {
                                key,
                                width,
                                height,
                                x,
                                y,
                                animate_ms,
                                clear,
                            } => {
                                if clear {
                                    elements::clear_native_layout_override(&key);
                                } else if let Some(animate_ms) = animate_ms {
                                    drive_native_layout_animation = true;
                                    elements::animate_native_layout_override(
                                        &key, width, height, x, y, animate_ms,
                                    );
                                } else {
                                    elements::set_native_layout_override(&key, width, height, x, y);
                                }
                                cx.notify();
                            }
                            Incoming::FocusInput { .. }
                            | Incoming::BlurInput
                            | Incoming::AppCommands(_) => unreachable!(),
                        });
                        if applied.is_err() {
                            break; // view dropped
                        }
                        if window_handle
                            .update(cx, |_root, window, root_cx| {
                                root_cx.notify();
                                window.refresh();
                            })
                            .is_err()
                        {
                            break;
                        }
                        if cx.update(|cx| cx.refresh_windows()).is_err() {
                            break;
                        }
                        if drive_native_layout_animation
                            && !native_layout_driver_active.swap(true, Ordering::SeqCst)
                        {
                            let pump = pump.clone();
                            let active = native_layout_driver_active.clone();
                            cx.spawn(async move |cx| {
                                let debug_native_layout =
                                    std::env::var("RNGPUI_NATIVE_LAYOUT_DEBUG").is_ok();
                                'driver: loop {
                                    let mut ticks = 0;
                                    while elements::native_layout_has_animations() {
                                        cx.background_executor()
                                            .timer(Duration::from_millis(4))
                                            .await;
                                        ticks += 1;
                                        if debug_native_layout {
                                            eprintln!("[native-layout] tick {ticks}");
                                        }
                                        if pump.update(cx, |_this, cx| cx.notify()).is_err() {
                                            break 'driver;
                                        }
                                        if window_handle
                                            .update(cx, |_root, window, root_cx| {
                                                root_cx.notify();
                                                window.refresh();
                                            })
                                            .is_err()
                                        {
                                            break 'driver;
                                        }
                                        if cx.update(|cx| cx.refresh_windows()).is_err() {
                                            break 'driver;
                                        }
                                    }
                                    if debug_native_layout {
                                        eprintln!("[native-layout] done ticks={ticks}");
                                    }
                                    active.store(false, Ordering::SeqCst);
                                    if !elements::native_layout_has_animations()
                                        || active.swap(true, Ordering::SeqCst)
                                    {
                                        break;
                                    }
                                }
                                active.store(false, Ordering::SeqCst);
                            })
                            .detach();
                        }
                    }
                }
            }
        })
        .detach();
    });
}

#[cfg(test)]
mod tests {
    use super::{Incoming, parse_incoming, position_for_byte_offset};
    use serde_json::json;

    #[test]
    fn maps_window_appearance_to_scheme() {
        use super::appearance_scheme;
        use gpui::WindowAppearance::{Dark, Light, VibrantDark, VibrantLight};
        assert_eq!(appearance_scheme(Light), "light");
        assert_eq!(appearance_scheme(VibrantLight), "light");
        assert_eq!(appearance_scheme(Dark), "dark");
        assert_eq!(appearance_scheme(VibrantDark), "dark");
    }

    #[test]
    fn parses_scroll_to_x_and_y_axes() {
        let incoming = parse_incoming(&json!({
            "$cmd": "scrollTo",
            "id": 7,
            "x": 42,
            "y": 13
        }));

        if let Some(Incoming::ScrollTo { id, x, y }) = incoming {
            assert_eq!(id, 7);
            assert_eq!(x, Some(42.0));
            assert_eq!(y, Some(13.0));
        } else {
            panic!("expected scrollTo command");
        }
    }

    #[test]
    fn parses_native_layout_command() {
        let incoming = parse_incoming(&json!({
            "$cmd": "nativeLayout",
            "key": "left-pane",
            "width": 286,
            "clear": false
        }));

        if let Some(Incoming::NativeLayout {
            key,
            width,
            height,
            x,
            y,
            animate_ms,
            clear,
        }) = incoming
        {
            assert_eq!(key, "left-pane");
            assert_eq!(width, Some(286.0));
            assert_eq!(height, None);
            assert_eq!(x, None);
            assert_eq!(y, None);
            assert_eq!(animate_ms, None);
            assert!(!clear);
        } else {
            panic!("expected nativeLayout command");
        }
    }

    #[test]
    fn parses_animated_native_layout_command() {
        let incoming = parse_incoming(&json!({
            "$cmd": "nativeLayout",
            "key": "right-pane",
            "width": 0,
            "height": 240,
            "x": 18,
            "animateMs": 180
        }));

        if let Some(Incoming::NativeLayout {
            key,
            width,
            height,
            x,
            y,
            animate_ms,
            clear,
        }) = incoming
        {
            assert_eq!(key, "right-pane");
            assert_eq!(width, Some(0.0));
            assert_eq!(height, Some(240.0));
            assert_eq!(x, Some(18.0));
            assert_eq!(y, None);
            assert_eq!(animate_ms, Some(180.0));
            assert!(!clear);
        } else {
            panic!("expected nativeLayout command");
        }
    }

    #[test]
    fn maps_multiline_utf16_cursor_positions() {
        assert_eq!(position_for_byte_offset("alpha", "alpha".len()).line, 0);
        assert_eq!(
            position_for_byte_offset("alpha", "alpha".len()).character,
            5
        );

        let text = "alpha\nbe😀ta";
        let end = position_for_byte_offset(text, text.len());
        assert_eq!(end.line, 1);
        assert_eq!(end.character, 6);
    }

    #[test]
    fn parses_native_resize_from_tree() {
        let incoming = parse_incoming(&json!({
            "globalId": 1,
            "type": "div",
            "nativeLayoutKey": "left-pane",
            "nativeListGroup": "files",
            "nativeResize": {
                "target": "right-pane",
                "edge": "left",
                "min": 240,
                "max": 460
            }
        }));

        if let Some(Incoming::Tree(root)) = incoming {
            assert_eq!(root.native_layout_key.as_deref(), Some("left-pane"));
            assert_eq!(root.native_list_group.as_deref(), Some("files"));
            let resize = root.native_resize.as_ref().expect("native resize");
            assert_eq!(resize.target, "right-pane");
            assert_eq!(resize.edge, super::NativeResizeEdge::Left);
            assert_eq!(resize.min, Some(240.0));
            assert_eq!(resize.max, Some(460.0));
        } else {
            panic!("expected tree");
        }
    }
}
