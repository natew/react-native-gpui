#![allow(unexpected_cfgs)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use gpui::{
    App, AppContext, Bounds, Context, Entity, InteractiveElement as _, IntoElement, KeyBinding,
    Menu, MenuItem, ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, NoAction, ParentElement, Pixels, Point, Render, Styled, TitlebarOptions, Window,
    WindowBounds, WindowOptions, actions, point, px, size,
};
use gpui_component::input::{Enter, InputEvent, InputState, Position};
use gpui_component::theme::{Theme, ThemeMode};
use once_cell::sync::Lazy;
use serde::Deserialize;

actions!(rngpui, [Quit]);

#[derive(Clone, PartialEq, Eq, Deserialize, gpui::Action)]
#[action(namespace = rngpui, no_json)]
struct InvokeCommand {
    id: String,
}

static APP_COMMAND_BINDING_SLOTS: Lazy<Mutex<HashSet<AppCommandBindingSlot>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

mod anim_overlay;
mod anim_trace;
mod audio;
#[cfg(target_os = "macos")]
mod ax;
mod bridge;
#[cfg(target_os = "macos")]
mod capture_png;
mod debug_control;
mod dock;
mod dump;
mod elements;
mod frame_clock;
mod frame_trace;
mod hermes;
mod hit_passthrough;
mod icons;
mod inspector;
#[cfg(target_os = "macos")]
mod liquid_glass;
mod selection;
mod style;

use elements::webview::WebViewContent;
use elements::{AccessibilityInfo, ReactElement, create_element};
use elements::{
    NativeResizeEdge, NativeResizeSpec, SystemShadowSpec, TerminalFrame, TerminalFrameKind,
};
use raw_window_handle::HasWindowHandle;
use style::{Dim, ElementStyle};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

// debug-control pointer state: `realdown` holds the left button until `realup`, and
// `realmove` mirrors the OS by reporting the held button on every move — so the split
// commands compose into a real drag (ev.dragging() == true mid-scrub).
static DEBUG_LEFT_HELD: AtomicBool = AtomicBool::new(false);

// startup timing: process-start instant + a one-shot first-render marker. gated on
// RNGPUI_STARTUP_TIMING so it's silent in normal runs. used to drive cold start < 200ms.
static STARTUP: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
static FIRST_RENDER_LOGGED: AtomicBool = AtomicBool::new(false);

// RNGPUI_DISABLE_RENDER_GATE=1 forces the per-frame tree lifecycle to run EVERY render
// (the pre-fix behavior), so the on-screen validator can A/B the freeze: gate-off = the
// per-frame WebView reposition + whole-tree walks that pinned the main thread, gate-on =
// the fix. Cached once; the OR below is free in normal runs.
static RENDER_GATE_DISABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
fn render_gate_disabled() -> bool {
    *RENDER_GATE_DISABLED.get_or_init(|| std::env::var_os("RNGPUI_DISABLE_RENDER_GATE").is_some())
}

fn startup_mark(label: &str) {
    if std::env::var_os("RNGPUI_STARTUP_TIMING").is_some() {
        if let Some(t0) = STARTUP.get() {
            eprintln!(
                "[startup] {label} +{:.1}ms",
                t0.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
}

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

/// Dispatch a real platform input through gpui's window event loop (the same hitbox
/// hit-test + listener path an OS click takes). Used by `realtap` (debug_control) to test
/// real clickability — unlike synth_tap, which invokes handlers straight off the tree.
/// Relies on the vendored gpui patch that makes `DispatchEventResult` `pub`.
fn dispatch_real_input(window: &mut Window, input: gpui::PlatformInput, cx: &mut App) {
    let _ = window.dispatch_event(input, cx);
}

/// The `key_char` a real keystroke would carry for a probe key. Single printable keys
/// type themselves; named keys (enter/tab/escape/…) carry no char. Enter's char is "\n"
/// so the focused element's `js_key` resolves it to "Enter" the same way an OS Return does.
fn real_key_char(key: &str) -> Option<String> {
    match key {
        "enter" | "return" => Some("\n".to_string()),
        "tab" => Some("\t".to_string()),
        k if k.chars().count() == 1 => Some(k.to_string()),
        _ => None,
    }
}

fn js_key_for_keystroke(keystroke: &gpui::Keystroke) -> String {
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

// Read the general pasteboard's string (the webviewCopyProof readback). Returns None
// when empty / no string type present.
#[cfg(target_os = "macos")]
fn read_general_pasteboard_string() -> Option<String> {
    use cocoa::base::nil;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let pb: cocoa::base::id = msg_send![class!(NSPasteboard), generalPasteboard];
        if pb == nil {
            return None;
        }
        let ns_string_class: cocoa::base::id = msg_send![class!(NSString), class];
        let s: cocoa::base::id = msg_send![pb, stringForType: pasteboard_string_type()];
        let _ = ns_string_class;
        if s == nil {
            return None;
        }
        let bytes: *const std::os::raw::c_char = msg_send![s, UTF8String];
        if bytes.is_null() {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr(bytes)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

#[cfg(target_os = "macos")]
fn pasteboard_string_type() -> cocoa::base::id {
    use objc::{class, msg_send, sel, sel_impl};
    // NSPasteboardTypeString = "public.utf8-plain-text"
    unsafe {
        let s = std::ffi::CString::new("public.utf8-plain-text").unwrap();
        msg_send![class!(NSString), stringWithUTF8String: s.as_ptr()]
    }
}

// Injected into every <WebView> before its content loads: the React Native bridge
// global, so existing RN web content (and our own pages) can post to the host with
// `window.ReactNativeWebView.postMessage(data)`. It tunnels through wry's IPC, which
// the service forwards to the node's onMessage handler.
const RN_WEBVIEW_SHIM: &str = "window.ReactNativeWebView={postMessage:function(d){\
    window.ipc.postMessage(typeof d==='string'?d:JSON.stringify(d))}};";

// The prior committed tree's globalId -> Arc index, used to resolve delta `ref` nodes
// (unchanged subtrees the reconciler didn't re-serialize). Rebuilt from the
// reconstructed tree after every commit so reused subtrees stay resolvable for future
// refs. Thread-local because `parse_json_tree` runs on the JS thread inside
// `host_apply_tree` (one runtime = one JS thread); this also isolates the index per
// test thread so parallel tests don't pollute each other.
thread_local! {
    static PRIOR_TREE_INDEX: RefCell<HashMap<u64, Arc<ReactElement>>> =
        RefCell::new(HashMap::new());
}

// Walk a reconstructed tree (including reused subtrees) into a globalId -> Arc index
// for the next commit's `ref` resolution. Mirrors `collect_node_ids` but keeps the Arc.
fn index_tree(el: &Arc<ReactElement>, out: &mut HashMap<u64, Arc<ReactElement>>) {
    out.insert(el.global_id, Arc::clone(el));
    for c in &el.children {
        index_tree(c, out);
    }
}

fn parse_json_tree(
    value: &serde_json::Value,
    prior: &HashMap<u64, Arc<ReactElement>>,
) -> Option<Arc<ReactElement>> {
    let obj = value.as_object()?;
    // delta wire fast path: a `{ globalId, ref: true }` node means "this subtree is
    // unchanged since the last commit" — reuse the prior commit's Arc wholesale
    // (structural sharing, no reparse). The reconciler only emits a ref for a node it
    // already sent in full, so `prior` is guaranteed to hold it; a miss means the JS
    // sent-set and this index drifted (shouldn't happen) — log so it's visible.
    if obj.get("ref").and_then(|v| v.as_bool()) == Some(true) {
        let id = obj.get("globalId").and_then(|v| v.as_u64())?;
        return match prior.get(&id) {
            Some(arc) => Some(Arc::clone(arc)),
            None => {
                eprintln!("[rngpui] delta ref miss for globalId {id} (no prior node)");
                None
            }
        };
    }
    let element_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("div");
    let global_id = obj
        .get("globalId")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(next_id);
    // stamp this node's authored JSX source into the inspector side-table — set at bundle
    // time by the babel source-location plugin and carried through the reconciler as
    // `source`. Kept off ReactElement so it doesn't touch the shared struct.
    if let Some(source) = obj
        .get("source")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        crate::inspector::remember_source(global_id, source);
    }
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
    let selectable = obj
        .get("selectable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let src = obj
        .get("src")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // <SystemView> native surface props: NSVisualEffectView material, NSGlassEffectView
    // variant, tint overlay color, and a native outer drop shadow.
    let system_material = obj
        .get("systemMaterial")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let system_glass_variant = obj
        .get("systemGlassVariant")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let system_tint = obj
        .get("systemTint")
        .and_then(|v| v.as_str())
        .and_then(crate::style::parse_css_color);
    let system_shadow = obj.get("systemShadow").and_then(parse_system_shadow);
    let system_edge_fade = obj
        .get("systemEdgeFade")
        .and_then(|v| v.as_f64())
        .map(|v| (v as f32).clamp(0.0, 0.5))
        .filter(|v| *v > 0.0);
    let system_top_fade_start = obj
        .get("systemTopFadeStart")
        .and_then(|v| v.as_f64())
        .map(|v| (v as f32).clamp(0.0, 1.0));
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
    let events: Vec<String> = obj
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
    let style_json = obj.get("style").filter(|v| v.is_object()).cloned();
    let style = style_json
        .as_ref()
        .map(ElementStyle::from_json)
        .unwrap_or_default();
    // opt-in renderer→JS pseudo lane: a node sets `pseudoEvents: true` (the tamagui
    // platform driver does this via the rngpui pseudo registry) to ask the host to emit a
    // coalesced `pseudo` event on each native hover/press flip. Opt-in so we don't spam an
    // event per hitbox; `div` paint only emits for nodes carrying this flag.
    let pseudo_events = obj
        .get("pseudoEvents")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let children: Vec<Arc<ReactElement>> = obj
        .get("children")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| parse_json_tree(c, prior))
                .collect()
        })
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
    // precompute the per-frame prepaint facts (event scan) once per commit — prepaint
    // runs them for every node on every draw.
    let interactive = events
        .iter()
        .any(|e: &String| crate::elements::POINTER_EVENTS.contains(&e.as_str()));
    Some(Arc::new(ReactElement {
        global_id,
        element_type: element_type.to_string(),
        text,
        number_of_lines,
        selectable,
        runs,
        src,
        system_material,
        system_glass_variant,
        system_tint,
        system_shadow,
        system_edge_fade,
        system_top_fade_start,
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
        style_json,
        cached_gpui_style,
        interactive,
        pseudo_events,
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

// Parse `<SystemView shadow={{ color, radius, offsetX, offsetY, opacity }}>` into a
// SystemShadowSpec. Sensible defaults: black, radius 0, no offset, opacity 0.25 (or
// baked into the color's alpha when no explicit `opacity` is given).
fn parse_system_shadow(value: &serde_json::Value) -> Option<SystemShadowSpec> {
    let obj = value.as_object()?;
    let color = obj
        .get("color")
        .and_then(|v| v.as_str())
        .and_then(crate::style::parse_css_color)
        .unwrap_or(gpui::Hsla {
            h: 0.0,
            s: 0.0,
            l: 0.0,
            a: 1.0,
        });
    let radius = obj.get("radius").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    let offset_x = obj.get("offsetX").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    let offset_y = obj.get("offsetY").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    // explicit `opacity` wins; otherwise fall back to the color's own alpha, then 0.25.
    let opacity = obj
        .get("opacity")
        .and_then(|v| v.as_f64())
        .map(|v| v as f32)
        .unwrap_or_else(|| if color.a < 1.0 { color.a } else { 0.25 })
        .clamp(0.0, 1.0);
    Some(SystemShadowSpec {
        color,
        radius,
        offset_x,
        offset_y,
        opacity,
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

// Compute a window origin anchored to the active display (bottom-center, center,
// …), so the launcher never has to know the screen size — gpui knows it natively.
// Driven by RNGPUI_WINDOW_ANCHOR; the gap from the screen edge is
// RNGPUI_WINDOW_MARGIN (default 72px). None when no anchor is set or no display.
fn anchored_window_origin(win_w: f32, win_h: f32, cx: &App) -> Option<Point<Pixels>> {
    let anchor = std::env::var("RNGPUI_WINDOW_ANCHOR").ok()?;
    let display = cx.primary_display()?;
    let b = display.bounds();
    let dx = f32::from(b.origin.x);
    let dy = f32::from(b.origin.y);
    let dw = f32::from(b.size.width);
    let dh = f32::from(b.size.height);
    let margin = std::env::var("RNGPUI_WINDOW_MARGIN")
        .ok()
        .and_then(|m| m.trim().parse::<f32>().ok())
        .unwrap_or(72.0);
    let (x, y) = match anchor.trim() {
        "bottom-center" => (dx + (dw - win_w) / 2.0, dy + dh - win_h - margin),
        "bottom-left" => (dx + margin, dy + dh - win_h - margin),
        "bottom-right" => (dx + dw - win_w - margin, dy + dh - win_h - margin),
        "center" => (dx + (dw - win_w) / 2.0, dy + (dh - win_h) / 2.0),
        "top-center" => (dx + (dw - win_w) / 2.0, dy + margin),
        _ => return None,
    };
    Some(point(px(x.max(dx)), px(y.max(dy))))
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

/// Offscreen harnesses (parity capture, the input pixel gate) can't change the host's
/// real system appearance, but they need the input theme to render in a known mode.
/// `RNGPUI_FORCE_APPEARANCE=dark|light` overrides the window appearance for the input
/// theme decision. None = follow the real window appearance.
fn forced_appearance() -> Option<ThemeMode> {
    match std::env::var("RNGPUI_FORCE_APPEARANCE").ok()?.as_str() {
        "dark" => Some(ThemeMode::Dark),
        "light" => Some(ThemeMode::Light),
        _ => None,
    }
}

/// Match the theme's input-relevant colors to native macOS so gpui-component's Input
/// renders like a real NSTextField/NSTextView:
///   - caret  = controlAccentColor (default system blue), NOT the text color
///   - foreground (typed text) = labelColor (white@85% dark / black@85% light), not pure white
///   - muted_foreground (placeholder) = secondaryLabelColor-ish
/// Applied every render (cheap field writes); the values only change with the mode.
fn apply_native_input_theme(cx: &mut App, mode: ThemeMode) {
    use gpui::Hsla;
    // macOS default controlAccentColor: #007AFF (light), #0A84FF (dark).
    let accent = match mode {
        ThemeMode::Dark => crate::style::u32_to_hsla(0x0a84ff),
        ThemeMode::Light => crate::style::u32_to_hsla(0x007aff),
    };
    // labelColor is white/black at 85% alpha; matches NSTextView's rendered text.
    let (base_label, base_secondary): (Hsla, Hsla) = match mode {
        ThemeMode::Dark => (
            crate::style::u32_to_hsla(0xffffff),
            crate::style::u32_to_hsla(0xffffff),
        ),
        ThemeMode::Light => (
            crate::style::u32_to_hsla(0x000000),
            crate::style::u32_to_hsla(0x000000),
        ),
    };
    let theme = Theme::global_mut(cx);
    theme.caret = accent;
    theme.foreground = base_label.opacity(0.85);
    // secondaryLabelColor ≈ 50% (placeholder); a touch dimmer than label.
    theme.muted_foreground = base_secondary.opacity(0.5);
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
    // the app-level focus anchor. tracked by the root frame div so the key-dispatch
    // path always includes the frame's "App" key context: gpui matches context-gated
    // bindings against the focused node's dispatch path, and with NO focus the path is
    // a synthetic root with an empty context stack — where predicate eval is false even
    // for pure negations like "!Input". render() re-focuses this whenever the window
    // has no focus (startup, input blur), so negation-gated app bindings always work.
    app_focus: gpui::FocusHandle,
    // true when `root` changed since the last full render. The per-frame `render` only
    // re-walks the tree for the input/webview/system/ax/layout lifecycle when this is set
    // — an overlay-only animation frame (`SetNodeStyle`) leaves `root` untouched, so it
    // skips all those whole-tree walks AND the native WebView repositioning that otherwise
    // ran on EVERY animation frame and pinned the main thread on-screen (the freeze). The
    // element tree itself still rebuilds each frame (it reads the live overlay).
    root_dirty: bool,
    dump_tree_path: Option<String>,
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
    // id of the currently-focused text input, used by the debug CLI type/key driver.
    focused_input: Option<u64>,
    // last time the RNGPUI_DUMP_TREE debug dump was written. the dump serializes the
    // whole tree (~hundreds of KB) and writes it synchronously on the main thread; the
    // SetNodeStyle animation path calls it every frame, so at 60Hz with gui-debug on it
    // became a per-frame whole-tree-walk + serialize + blocking disk write that taxed the
    // main thread (and made app-switch feel sluggish). throttle it — a debug dump a few
    // times a second is plenty for inspection.
    last_debug_dump: Option<std::time::Instant>,
    // a throttled dump has a trailing-edge flush scheduled. without it the LAST
    // update of a burst was dropped forever: a commit landing <150ms after the
    // initial tree never reached the dump file, so dump-file consumers (harness
    // gates, capture tooling) read stale state while the live tree had moved on.
    debug_dump_scheduled: bool,
}

impl ServiceApp {
    fn write_debug_dump(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.dump_tree_path.as_ref() else {
            return;
        };
        let now = std::time::Instant::now();
        if let Some(last) = self.last_debug_dump {
            let elapsed = now.duration_since(last);
            if elapsed < Duration::from_millis(150) {
                // trailing edge: re-run after the throttle window so the final
                // state of a burst always lands on disk.
                if !self.debug_dump_scheduled {
                    self.debug_dump_scheduled = true;
                    let delay = Duration::from_millis(160).saturating_sub(elapsed);
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(delay).await;
                        let _ = this.update(cx, |this, cx| {
                            this.debug_dump_scheduled = false;
                            this.write_debug_dump(cx);
                        });
                    })
                    .detach();
                }
                return;
            }
        }
        self.last_debug_dump = Some(now);
        let tree = dump::dump_tree(&self.root);
        if let Ok(json) = serde_json::to_string_pretty(&tree) {
            let _ = std::fs::write(path, json);
        }
    }
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

/// After the Copy menu item is clicked, let "Copied" show for a beat, then close the
/// menu — unless the user interacted with it again (the token check inside
/// `close_menu_after_copy` cancels stale closes).
fn schedule_inspector_menu_close(cx: &mut Context<ServiceApp>, token: u64) {
    cx.spawn(async move |this, cx| {
        cx.background_executor()
            .timer(inspector::INSPECTOR_COPY_CLOSE_DELAY)
            .await;
        let changed = this
            .update(cx, |this, cx| {
                let changed = this.inspector.close_menu_after_copy(token);
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

/// Collect (id, content, is_html, hidden) for every webview node. Prefers a `src` uri;
/// falls back to inline html carried in `text`.
fn collect_webviews(
    el: &Arc<ReactElement>,
    inherited_hidden: bool,
    out: &mut Vec<(u64, String, bool, bool)>,
) {
    let hidden = inherited_hidden || el.style.is_display_none();
    if el.element_type == "webview" {
        if let Some(uri) = el.src.clone() {
            out.push((el.global_id, uri, false, hidden));
        } else if let Some(html) = el.text.clone() {
            out.push((el.global_id, html, true, hidden));
        }
    }
    for c in &el.children {
        collect_webviews(c, hidden, out);
    }
}

/// Collect ids of every `<SystemView>` node, to tear down native views for absent ones.
fn collect_system_ids(el: &Arc<ReactElement>, out: &mut HashSet<u64>) {
    if el.element_type == "system" {
        out.insert(el.global_id);
    }
    for c in &el.children {
        collect_system_ids(c, out);
    }
}

fn collect_native_control_ids(el: &Arc<ReactElement>, out: &mut HashSet<u64>) {
    if el.element_type == "nativebutton" || el.element_type == "nativeinput" {
        out.insert(el.global_id);
    }
    for c in &el.children {
        collect_native_control_ids(c, out);
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

fn first_app_key_press_listener(el: &Arc<ReactElement>) -> Option<u64> {
    let text_owner = matches!(
        el.element_type.as_str(),
        "textinput" | "textarea" | "terminal" | "ghostty-terminal"
    );
    if !text_owner && el.listens("keyPress") {
        return Some(el.global_id);
    }
    for c in &el.children {
        if let Some(id) = first_app_key_press_listener(c) {
            return Some(id);
        }
    }
    None
}

/// Map gpui's window appearance to the JS color-scheme name the bridge speaks.
fn appearance_scheme(appearance: gpui::WindowAppearance) -> &'static str {
    match appearance {
        gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => "dark",
        gpui::WindowAppearance::Light | gpui::WindowAppearance::VibrantLight => "light",
    }
}

/// The scheme JS/tamagui themes off of. `RNGPUI_FORCE_APPEARANCE=dark|light`
/// overrides the real window appearance so offscreen captures (the `rngpui shot`
/// loop, parity, conformance) can pin light/dark without touching the host's
/// system setting — the bridge must report the *forced* value, not the window's,
/// or the app paints in the host theme regardless of the flag.
fn effective_appearance_scheme(appearance: gpui::WindowAppearance) -> &'static str {
    match forced_appearance() {
        Some(ThemeMode::Dark) => "dark",
        Some(ThemeMode::Light) => "light",
        None => appearance_scheme(appearance),
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
        // keystrokes dispatch along the FOCUSED node's path; with no focus they land on
        // a synthetic root whose context stack is empty, where context-gated key
        // bindings can never match (see app_focus). whenever nothing holds focus
        // (startup, an input blurring via window.blur()), anchor focus on the app
        // frame so its "App" key context is always on the dispatch path.
        if window.focused(cx).is_none() {
            window.focus(&self.app_focus);
        }
        // per-draw counter behind frameStats / trace — one atomic + bounded ring push.
        anim_trace::on_frame_painted();
        // reset the per-frame hit-test passthrough registry before this frame's prepaint
        // pass repopulates it (webview rects + occluder rects, for native webview events).
        hit_passthrough::begin_frame();
        // while the inspector overlay/menu is up it owns all mouse input — without this,
        // a menu painted over a webview region is unclickable (clicks fall through to
        // the page via the hitTest: passthrough).
        hit_passthrough::set_input_grab(self.inspector.wants_input_grab());
        // flush the previous frame's stage breakdown + reset accumulators for this frame.
        frame_trace::begin_render(self.root_dirty);
        if std::env::var_os("RNGPUI_STARTUP_TIMING").is_some()
            && !FIRST_RENDER_LOGGED.swap(true, Ordering::SeqCst)
        {
            if let Some(t0) = STARTUP.get() {
                eprintln!(
                    "[startup] first render +{:.1}ms",
                    t0.elapsed().as_secs_f64() * 1000.0
                );
            }
        }
        // The tree is applied (and a re-render scheduled) by the hermes JS thread's
        // foreground task in `main`, not polled here — rendering is fully on-demand: this
        // runs only on a new tree, input, scroll, or resize, so the app idles at ~0fps.
        let theme_mode = root_theme_mode(&self.root);
        if Theme::global(cx).mode != theme_mode {
            Theme::change(theme_mode, Some(window), cx);
        }
        Theme::global_mut(cx).background = gpui::Hsla::transparent_black();
        // Native-macOS input fidelity. gpui-component's shadcn default theme ships a
        // caret that is the foreground color (white in dark) and a foreground that is
        // pure-ish #fafafa — neither matches NSTextView. Override at the theme layer so
        // EVERY <TextInput>/<TextArea> inherits it (the elements read these via
        // `cx.theme().caret` / `.foreground` / `.muted_foreground`), no per-app fixes.
        //
        // Drive the INPUT mode from the real window appearance, not the root-bg heuristic
        // above: agentbus follows the system light/dark via the JS color layer and never
        // sets a bg on the synthetic root, so `root_theme_mode` is stuck on Light — which
        // would render dark-mode inputs with black text. `window.appearance()` is the
        // ground truth the app itself follows.
        let input_mode = forced_appearance().unwrap_or_else(|| match window.appearance() {
            gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => ThemeMode::Dark,
            gpui::WindowAppearance::Light | gpui::WindowAppearance::VibrantLight => {
                ThemeMode::Light
            }
        });
        apply_native_input_theme(cx, input_mode);

        // Emit a `resize` event whenever the content size changes, so the JS side
        // can update Dimensions and re-render. Bridges RN's Dimensions API.
        let vs = window.viewport_size();
        let w: f64 = vs.width.into();
        let h: f64 = vs.height.into();
        let viewport_changed = (w - self.last_w).abs() > 0.5 || (h - self.last_h).abs() > 0.5;
        if viewport_changed {
            self.last_w = w;
            self.last_h = h;
            bridge::resize(w as f32, h as f32);
        }

        // ── tree-lifecycle work (gated on `root_dirty`) ──────────────────────────────
        // All of this is a pure function of `self.root`: text-input entities, native
        // WebView creation + REPOSITIONING, <SystemView> retention, a11y tree sync,
        // layout-dedup GC. On an overlay-only animation frame (`SetNodeStyle`) `root` is
        // unchanged, so re-running it every frame is wasted work — and `set_webviews`'
        // per-frame WebView repositioning + the repeated whole-tree walks are what pinned
        // the main thread on-screen during a multi-component spring (the freeze). Skip it
        // unless the tree actually changed; the element renderers keep their last-set state.
        // A worklet-driven layout change (pane resize) moved a yoga box this frame — run
        // the lifecycle so native WebViews reposition. take() it unconditionally so the
        // flag is consumed even when root_dirty already forces the lifecycle.
        let layout_dirty = crate::anim_overlay::take_layout_dirty();

        // ── retained-layout fast path decision ───────────────────────────────────────
        // Consume the paint-only-frame flag EVERY render (so a stale `true` can never leak
        // into a later frame), then engage the retained-layout reuse only when this frame
        // is provably geometry-stable: the trigger was a paint-only `SetNodeStyle`
        // (`paint_only`), AND no new React tree (`root_dirty`), AND no animated layout key
        // moved (`layout_dirty`), AND the window didn't resize, AND no pane-resize drag /
        // native-layout animation is mid-flight, AND the inspector overlay (which adds a
        // structural child) is off. Any of those forces a full taffy solve — the safe
        // direction. When it engages, `window.prepare_layout_frame(true)` replays the prior
        // full-layout frame's geometry and skips the ~7ms flexbox solve; otherwise it
        // clears the carried-over taffy tree and runs a normal full layout (capturing a
        // fresh retained frame for the next reuse). The disable env is the A/B escape hatch.
        let paint_only = crate::anim_overlay::take_paint_only_frame();
        let retained_layout_disabled = std::env::var_os("RNGPUI_DISABLE_RETAINED_LAYOUT").is_some();
        // test escape hatch: force the reuse path on EVERY geometry-stable idle frame
        // (ignoring the paint-only trigger), so conformance can drive the retained path on
        // every repaint and assert pixel/bounds parity. Never set in production.
        let force_reuse = std::env::var_os("RNGPUI_FORCE_RETAINED_LAYOUT").is_some();
        let want_reuse = (paint_only || force_reuse)
            && !self.root_dirty
            && !layout_dirty
            && !viewport_changed
            && !elements::native_resize_active()
            && !elements::native_layout_has_animations()
            // Veto only while the inspector is ACTIVELY inspecting (overlay/menu shown) —
            // that adds a structural overlay child. An enabled-but-idle inspector (the
            // common case behind `~/.agentbus/gui-debug`) renders no overlay, so the tree
            // is structurally stable and reuse is sound.
            && !self.inspector.wants_input_grab()
            && !render_gate_disabled()
            && !retained_layout_disabled;
        let reusing = window.prepare_layout_frame(want_reuse);
        if std::env::var_os("RNGPUI_RETAINED_TRACE").is_some() {
            eprintln!(
                "[retained] paint_only={paint_only} want_reuse={want_reuse} reusing={reusing} \
                 | root_dirty={} layout_dirty={layout_dirty} viewport_changed={viewport_changed} \
                 native_resize={} native_anim={} inspector={}",
                self.root_dirty,
                elements::native_resize_active(),
                elements::native_layout_has_animations(),
                self.inspector.enabled(),
            );
        }

        if std::env::var_os("RNGPUI_RENDER_TRACE").is_some() {
            eprintln!(
                "[render] root_dirty={} layout_dirty={} (lifecycle {})",
                self.root_dirty,
                layout_dirty,
                if self.root_dirty || render_gate_disabled() || layout_dirty {
                    "RUN"
                } else {
                    "SKIP"
                }
            );
        }
        if self.root_dirty || render_gate_disabled() || layout_dirty {
            let lifecycle_t0 = std::time::Instant::now();
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
                            InputEvent::Focus => {
                                this.focused_input = Some(id);
                                bridge::event(id, "focus");
                            }
                            InputEvent::Blur => {
                                if this.focused_input == Some(id) {
                                    this.focused_input = None;
                                }
                                bridge::event(id, "blur");
                            }
                        },
                    )
                    .detach();
                    // re-render this view when the input's contents/cursor change. An edit
                    // can resize the text box (and moves the caret), so veto the retained-
                    // layout fast path for the resulting frame even if it coalesces with a
                    // paint-only overlay write — force a full taffy solve.
                    cx.observe(&state, |_this, _input, cx| {
                        crate::anim_overlay::clear_paint_only_frame();
                        cx.notify();
                    })
                    .detach();
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
            collect_webviews(&self.root, false, &mut wv_specs);
            let present_wv: HashSet<u64> = wv_specs.iter().map(|(id, _, _, _)| *id).collect();
            self.webviews.retain(|id, _| present_wv.contains(id));
            let mut webview_content = HashMap::new();
            for (id, content, is_html, hidden) in wv_specs {
                webview_content.insert(
                    id,
                    WebViewContent {
                        body: content,
                        is_html,
                    },
                );
                let view = self.webviews.entry(id).or_insert_with(|| {
                    let event_dbg = std::env::var("RNGPUI_WEBVIEW_EVENT_DEBUG").is_ok();
                    let message_dbg = std::env::var("RNGPUI_WEBVIEW_MESSAGE_DEBUG").is_ok();
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
                            if message_dbg {
                                eprintln!("[webview {id}] message: {body}");
                            }
                            if inspector_enabled && inspector::handle_webview_ipc(id, body) {
                                return;
                            }
                            bridge::webview_message(id, body);
                        })
                        // page finished loading -> fire the node's onLoad. Under DEBUG this is
                        // also the quickest way to distinguish load from compositing issues.
                        .with_on_page_load_handler(move |event, _url| match event {
                            wry::PageLoadEvent::Started => {
                                if event_dbg {
                                    eprintln!("[webview {id}] page-load started");
                                }
                            }
                            wry::PageLoadEvent::Finished => {
                                if event_dbg {
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
                    let _ = wv.set_visible(!hidden);
                    Rc::new(wv)
                });
                if hidden {
                    #[cfg(target_os = "macos")]
                    elements::webview::hide_webview_host(id);
                    let _ = view.set_visible(false);
                } else {
                    let _ = view.set_visible(true);
                }
            }
            elements::webview::set_webviews(self.webviews.clone(), webview_content);

            // Parallel lifecycle for <SystemView>: tear down the native surface/tint/shadow
            // views for any id that left the tree (card closed/removed). The views themselves
            // are created lazily in the element's prepaint, so retaining present ids is all
            // we do here.
            let mut system_ids = HashSet::new();
            collect_system_ids(&self.root, &mut system_ids);
            elements::system::retain_system_views(&system_ids);

            // Parallel lifecycle for native AppKit controls (<NativeButton>/<NativeTextInput>):
            // GC the NSButton/NSTextField views for any id that left the tree. The views are
            // created lazily in the element's prepaint, so retaining present ids is all we do.
            let mut native_control_ids = HashSet::new();
            collect_native_control_ids(&self.root, &mut native_control_ids);
            elements::native_control::retain_native_controls(&native_control_ids);

            if self.inspector.enabled() {
                inspector::refresh_snapshot_cache(&self.root);
            }

            // GC layout-dedup and pointer state for nodes that left the tree.
            let mut node_ids = HashSet::new();
            collect_node_ids(&self.root, &mut node_ids);
            bridge::retain_layout(&node_ids);
            elements::retain_pointer_state(&node_ids);
            let mut native_layout_keys = HashSet::new();
            collect_native_layout_keys(&self.root, &mut native_layout_keys);
            elements::retain_native_layout_keys(&native_layout_keys);

            let mut layout_ids = HashSet::new();
            collect_layout_ids(&self.root, &mut layout_ids);
            bridge::emit_cached_layout_for_new_subscribers(&layout_ids);

            #[cfg(target_os = "macos")]
            ax::sync_tree(window, &self.root);
            self.write_debug_dump(cx);
            if std::env::var_os("RNGPUI_RENDER_TRACE").is_some() {
                eprintln!(
                    "[render] lifecycle took {:.2}ms",
                    lifecycle_t0.elapsed().as_secs_f64() * 1000.0
                );
            }
            self.root_dirty = false;
        } // end tree-lifecycle (root_dirty) gate

        let create_t0 = std::time::Instant::now();
        let root = create_element(self.root.clone(), 0);
        frame_trace::add_create(create_t0.elapsed());
        let mut frame = gpui::div()
            .size_full()
            .flex()
            .flex_col()
            // the root frame must contribute a key context: gpui's predicate eval
            // returns false on an EMPTY context stack even for pure negations
            // (`contexts.last() else return false`), so app key bindings gated on
            // e.g. "!Input && !Terminal" could never fire unless an Input/Terminal
            // was focused — which then fails the negation anyway. with "App" always
            // on the stack, negation-gated bindings work at rest and focused
            // Input/Terminal contexts still suppress them. track_focus puts this
            // node on the key-dispatch path whenever app_focus is focused (see the
            // no-focus guard at the top of render).
            .key_context("App")
            .track_focus(&self.app_focus)
            .on_action(|action: &InvokeCommand, _window, _cx| {
                bridge::command(&action.id);
            })
            // Cmd+C with no Input focused: the chord misses the keymap, AppKit walks
            // the responder chain, and gpui's app delegate (`copy:` → handle_menu_item)
            // re-dispatches the menu's Copy action down the focus path — which ends
            // here on the App-context root. Copy the native <Text selectable> drag
            // selection if one exists. A focused Input handles Copy deeper (unchanged)
            // and a first-responder WKWebView handles `copy:` before the delegate
            // (webview page copy unchanged).
            .on_action(|_: &gpui_component::input::Copy, _window, cx| {
                if let Some(text) = crate::selection::selected_text() {
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                }
            })
            .on_mouse_up(MouseButton::Left, |_event: &MouseUpEvent, _window, _cx| {
                elements::finish_pointer_gesture();
            })
            .on_mouse_up_out(MouseButton::Left, |_event: &MouseUpEvent, _window, _cx| {
                elements::finish_pointer_gesture();
            })
            // self-heal a wedged pointer capture: a fresh press always begins a new
            // gesture, so any ACTIVE_MOUSE_TARGET still set here is stale — its mouse-up
            // never reached gpui (swallowed by a native menu's nested event loop, lost
            // across a heavy session-switch re-render, or eaten while the webview host
            // re-orders under the cursor). without this the stale capture makes
            // `target_receives_captured_pointer_event` reject every *other* element
            // forever — the per-element down-handler only re-captures when the slot is
            // free (`active.is_none()`), so one missed up wedges all clicks + hovers
            // permanently while the divider (separate ACTIVE_NATIVE_RESIZE path) and
            // native webview scroll keep working. capture phase runs before the bubble
            // down-handlers that set the fresh capture, so this clears then they re-arm.
            .capture_any_mouse_down(|_event: &MouseDownEvent, _window, _cx| {
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
                    let size = window.viewport_size();
                    let viewport = (size.width.into(), size.height.into());
                    let (handled, copy_close_token) =
                        this.inspector.handle_mouse_down(&root, event, viewport, cx);
                    if let Some(token) = copy_close_token {
                        schedule_inspector_menu_close(cx, token);
                    }
                    if handled {
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
        selectable: false,
        runs: Vec::new(),
        src: None,
        system_material: None,
        system_glass_variant: None,
        system_tint: None,
        system_shadow: None,
        system_edge_fade: None,
        system_top_fade_start: None,
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
        style_json: None,
        cached_gpui_style: None,
        interactive: false,
        pseudo_events: false,
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

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AppCommandBindingSlot {
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

/// A message from the JS side or the debug CLI: either a new element tree to render,
/// a host command targeting a live native element, or a debug request.
pub(crate) enum Incoming {
    Quit,
    Tree(Arc<ReactElement>),
    /// reanimated per-frame style overrides, coalesced to one host crossing per rAF
    /// tick. Applied to the `anim_overlay` map + `cx.notify()` WITHOUT rebuilding
    /// `root` — the off-thread-reanimated fast path.
    SetNodeStyle {
        ops: Vec<(u64, serde_json::Map<String, serde_json::Value>)>,
    },
    Eval {
        id: u64,
        js: String,
    },
    Reload {
        id: u64,
    },
    Inspector {
        enabled: bool,
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
    PickPaths {
        id: u64,
        files: bool,
        directories: bool,
        multiple: bool,
        prompt: String,
    },
    FocusInput {
        id: u64,
    },
    BlurInput,
    AppCommands(AppCommandConfig),
    /// set (or clear, with an empty label) the macOS dock tile badge.
    DockBadge {
        label: String,
    },
    /// request user attention (dock bounce). critical = keep bouncing.
    RequestAttention {
        critical: bool,
    },
    DebugDump {
        reply: flume::Sender<serde_json::Value>,
    },
    DebugTap {
        x: f32,
        y: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    /// dispatch a REAL gpui pointer event (MouseDown+MouseUp) through the window's actual
    /// hitbox hit-test — the SAME path an OS click takes — and report whether a handler
    /// fired. Unlike DebugTap (which reads the serialized tree and invokes handlers
    /// directly), this exercises gpui's real event loop, so it catches a frozen/occluded
    /// hitbox that `tap` is structurally blind to.
    DebugRealTap {
        x: f32,
        y: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    /// dispatch a real MouseMove then MouseDown — the move establishes hover first
    /// (press-down assertions depend on it), the down is held without a MouseUp.
    /// debug-only harnesses use this when they need to observe transient pressed
    /// state before MouseUp is coalesced.
    DebugRealDown {
        x: f32,
        y: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugRealUp {
        x: f32,
        y: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugRealMove {
        x: f32,
        y: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugRealDrag {
        x: f32,
        y: f32,
        x2: f32,
        y2: f32,
        steps: u32,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugRealDragPath {
        path: Vec<(f32, f32)>,
        reply: flume::Sender<serde_json::Value>,
    },
    /// resize the real gpui window to (w, h) content px. test mode sets
    /// is_resizable=false (blocking AX resize), so this command is the only way to
    /// drive a window resize offscreen for perf measurement.
    DebugResize {
        w: f32,
        h: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugDragAt {
        phase: String,
        x: f32,
        y: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugScrollAt {
        x: f32,
        y: f32,
        dx: f32,
        dy: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    /// proof-of-native-scroll: run the REAL AppKit `hitTest:` at (x,y) and report the
    /// resolved view class, then synthesize a real scroll-wheel `NSEvent` and deliver it
    /// natively to that view via `scrollWheel:` — NO rngpui JS delta-forwarding. If the
    /// hitTest passthrough is working, the resolved view is the WKWebView (or its scroll
    /// view), not `GPUIView`, and the page's scroller moves from a true native event.
    DebugNativeScrollAt {
        x: f32,
        y: f32,
        dy: f32,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugTypeText {
        text: String,
        reply: flume::Sender<serde_json::Value>,
    },
    DebugKeyPress {
        key: String,
        reply: flume::Sender<serde_json::Value>,
    },
    /// dispatch a REAL gpui KeyDown through the window's actual key dispatch — the same
    /// path an OS keystroke takes (keymap bindings resolved FIRST, then the focused
    /// element's on_key_down). Unlike DebugKeyPress (which pokes a focused TextInput's
    /// model directly), this exercises the real dispatch, so it catches a global keybinding
    /// that swallows a key before it reaches the focused element (e.g. a bare `enter`
    /// binding eating the terminal's submit). Reports how many host events fired.
    DebugRealKey {
        key: String,
        reply: flume::Sender<serde_json::Value>,
    },
    /// dispatch a gpui action by registered name down the focused dispatch path
    /// (the app-delegate menu fallthrough route) and report the pasteboard after.
    DebugDispatchAction {
        name: String,
        reply: flume::Sender<serde_json::Value>,
    },
    /// proof the standard Edit menu carries a nil-target `copy:` item AND that `copy:`
    /// on the WKWebView at (x,y) copies the page selection to the pasteboard. Selects
    /// all page text first (JS), runs the copy, reads NSPasteboard back.
    DebugWebviewCopyProof {
        x: f32,
        y: f32,
        reply: flume::Sender<serde_json::Value>,
    },
}

/// Parse one JS-host payload into an `Incoming`. A `$cmd` object is a native host
/// command; anything else is parsed as an element tree.
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
            "inspector" => Some(Incoming::Inspector {
                enabled: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true),
            }),
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
            "dockBadge" => Some(Incoming::DockBadge {
                label: v
                    .get("label")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
            }),
            "requestAttention" => Some(Incoming::RequestAttention {
                critical: v.get("critical").and_then(|x| x.as_bool()).unwrap_or(false),
            }),
            _ => None,
        };
    }
    // a tree (full or delta) arrives here once per React commit. resolve any `ref` nodes
    // against the prior commit's index, then rebuild the index from the reconstructed
    // tree (incl. reused subtrees) for the next commit's refs. the source side-table is
    // pruned by `retain_sources(present)` in the Incoming::Tree handler — NOT cleared here,
    // or ref'd nodes would lose their source (they never re-enter parse_json_tree).
    let root = PRIOR_TREE_INDEX.with(|idx| parse_json_tree(v, &idx.borrow()))?;
    let mut next_index = HashMap::new();
    index_tree(&root, &mut next_index);
    PRIOR_TREE_INDEX.with(|idx| *idx.borrow_mut() = next_index);
    Some(Incoming::Tree(root))
}

fn install_app_commands(config: AppCommandConfig, cx: &mut App) {
    let bindings = {
        let mut previous_slots = APP_COMMAND_BINDING_SLOTS
            .lock()
            .expect("app command binding slots mutex poisoned");
        app_command_key_bindings(&mut previous_slots, config.bindings)
    };
    cx.bind_keys(bindings);

    let mut menus = vec![Menu {
        name: "react-native-gpui".into(),
        items: vec![MenuItem::action("Quit", Quit)],
    }];
    menus.extend(standard_edit_menus());
    menus.extend(config.menus.into_iter().map(build_app_menu));
    cx.set_menus(menus);
}

// The standard macOS Edit menu (+ Select All). Without it the app has no
// Cmd+C/Cmd+V/Cmd+X/Cmd+A key equivalents, so when a WKWebView underlay
// (timeline) is the active surface those chords never reach it — copy out of the
// page silently does nothing. Backing each item with gpui-component's own Input
// Copy/Cut/Paste/SelectAll actions is deliberate: those actions already have
// `cmd-c`/`cmd-v`/`cmd-x`/`cmd-a` bindings scoped to the `Input` key context
// (gpui_component::init), so the menu derives its key equivalents from them AND
// they only fire gpui-side when a TextInput is actually focused. The `os_action`
// gives each item the OS selector (`copy:`/`paste:`/`cut:`/`selectAll:`) with a
// nil target, so when no gpui Input is focused the chord falls through GPUIView's
// `performKeyEquivalent:` (no keymap match → returns NO) and AppKit routes the
// selector down the responder chain to the first responder — the focused
// WKWebView — which copies the page selection natively. Composer TextInput copy
// stays unchanged: when it's focused the context-scoped keymap binding wins.
fn standard_edit_menus() -> Vec<Menu> {
    use gpui::OsAction;
    use gpui_component::input::{Copy, Cut, Paste, SelectAll};
    vec![Menu {
        name: "Edit".into(),
        items: vec![
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::separator(),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ],
    }]
}

fn app_command_key_bindings(
    previous_slots: &mut HashSet<AppCommandBindingSlot>,
    bindings: Vec<AppCommandBinding>,
) -> Vec<KeyBinding> {
    let next_slots = app_command_binding_slots(&bindings);
    let mut out = Vec::new();

    for slot in previous_slots.difference(&next_slots) {
        out.push(KeyBinding::new(
            &slot.key,
            NoAction {},
            slot.context.as_deref(),
        ));
    }

    *previous_slots = next_slots;

    for binding in bindings {
        if !valid_app_command_binding(&binding) {
            continue;
        }
        let AppCommandBinding { id, key, context } = binding;
        out.push(KeyBinding::new(
            &key,
            InvokeCommand { id },
            context.as_deref(),
        ));
    }

    out
}

fn app_command_binding_slots(bindings: &[AppCommandBinding]) -> HashSet<AppCommandBindingSlot> {
    bindings
        .iter()
        .filter(|binding| valid_app_command_binding(binding))
        .map(|binding| AppCommandBindingSlot {
            key: binding.key.clone(),
            context: binding.context.clone(),
        })
        .collect()
}

fn valid_app_command_binding(binding: &AppCommandBinding) -> bool {
    !binding.id.is_empty() && !binding.key.is_empty()
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

/// Read the app bundle named by RNGPUI_BUNDLE — Hermes bytecode (`app.hbc`) or JS source.
/// Hermes auto-detects HBC vs. source by magic, so either works.
fn load_bundle() -> Vec<u8> {
    let path = match std::env::var("RNGPUI_BUNDLE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("[hermes] RNGPUI_BUNDLE not set — point it at app.hbc or app.js");
            std::process::exit(1);
        }
    };
    match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[hermes] cannot read bundle {path}: {e}");
            std::process::exit(1);
        }
    }
}

/// Read the reanimated worklet/UI runtime bundle: RNGPUI_UI_BUNDLE, or
/// `ui-runtime.js` next to this executable. It is app-INDEPENDENT library code
/// (upstream reanimated core + the worklet bridge, built by the rngpui ts
/// `build:bundle` as dist/ui-runtime.js and staged beside the binary by
/// build-native), so it versions with the binary, not with the app bundle. Not
/// optional — off-thread reanimated is the one animation path
/// (plans/off-thread-reanimated.md).
fn load_ui_bundle() -> Vec<u8> {
    let path = match std::env::var("RNGPUI_UI_BUNDLE") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("ui-runtime.js")))
            .unwrap_or_else(|| std::path::PathBuf::from("ui-runtime.js")),
    };
    match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!(
                "[hermes-ui] cannot read ui-runtime bundle {}: {e} — set RNGPUI_UI_BUNDLE or stage ui-runtime.js next to the binary (rngpui ts: `bun scripts/build-ui-runtime.mjs`)",
                path.display()
            );
            std::process::exit(1);
        }
    }
}

#[cfg(target_os = "macos")]
fn pick_paths_native(
    files: bool,
    directories: bool,
    multiple: bool,
    prompt: &str,
) -> Result<Vec<String>, String> {
    use cocoa::base::{NO, YES, id, nil};
    use cocoa::foundation::{NSInteger, NSString, NSUInteger};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    unsafe {
        let panel: id = msg_send![class!(NSOpenPanel), openPanel];
        let _: () = msg_send![panel, setCanChooseFiles: if files { YES } else { NO }];
        let _: () = msg_send![panel, setCanChooseDirectories: if directories { YES } else { NO }];
        let _: () = msg_send![panel, setAllowsMultipleSelection: if multiple { YES } else { NO }];
        let message = NSString::alloc(nil).init_str(prompt);
        let _: () = msg_send![panel, setMessage: message];

        let result: NSInteger = msg_send![panel, runModal];
        if result != 1 {
            return Ok(Vec::new());
        }

        let urls: id = msg_send![panel, URLs];
        let count: NSUInteger = msg_send![urls, count];
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let url: id = msg_send![urls, objectAtIndex: index];
            let path: id = msg_send![url, path];
            let cstr: *const std::os::raw::c_char = msg_send![path, UTF8String];
            if !cstr.is_null()
                && let Ok(path) = CStr::from_ptr(cstr).to_str()
            {
                paths.push(path.to_string());
            }
        }
        Ok(paths)
    }
}

#[cfg(not(target_os = "macos"))]
fn pick_paths_native(
    _files: bool,
    _directories: bool,
    _multiple: bool,
    _prompt: &str,
) -> Result<Vec<String>, String> {
    Err("native file picker is only available on macos".to_string())
}

/// Offscreen harnesses (conformance, cli --launch, example runners — anything
/// setting RNGPUI_TEST_MODE) spawn this service as a child and are supposed to
/// reap it, but runners die in unreapable ways (timeouts, SIGPIPE when their
/// stdout is piped to `head`, SIGKILL) and the service lingered as an orphan —
/// the user found a pile of hanging rngpui-service processes. Root fix in ONE
/// place: under test mode, poll the parent pid and exit when it changes
/// (orphaned processes reparent to launchd). The real app (`agentbus gui`)
/// never sets RNGPUI_TEST_MODE, so its lifecycle is untouched.
fn spawn_parent_exit_watchdog() {
    // Reap-on-orphan is the DEFAULT, not opt-in: any process that spawns this
    // service as a normal child (a CLI shot, a conformance gate, a one-off tool —
    // whether or not it remembered to set RNGPUI_TEST_MODE) gets the service
    // cleaned up when it dies. Previously this was gated on RNGPUI_TEST_MODE, so
    // every tool path that forgot the flag leaked an orphaned service (the
    // "hanging rngpui-service" reports). Two exemptions keep long-lived launches
    // alive:
    //   - the real `agentbus gui` app is launched via LaunchServices with parent
    //     launchd, so the `parent <= 1` check below already exempts it (the
    //     USER_OWNED_DO_NOT_KILL label is an extra belt in case it's ever a child);
    //   - `rngpui ... --keep` / `rngpui dev` sessions are CONTRACTUALLY long-lived
    //     (driven later via --session, reaped by `rngpui close`).
    if std::env::var_os("RNGPUI_KEEP_ALIVE").is_some() {
        return;
    }
    if std::env::var("RNGPUI_OWNER_LABEL")
        .map(|v| v == "USER_OWNED_DO_NOT_KILL")
        .unwrap_or(false)
    {
        return;
    }
    let parent = std::os::unix::process::parent_id();
    if parent <= 1 {
        return; // launched detached (LaunchServices / already orphaned); nothing to watch
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if std::os::unix::process::parent_id() != parent {
                eprintln!("[rngpui] launcher (pid {parent}) exited — reaping orphaned service");
                std::process::exit(0);
            }
        }
    });
}

// Redirect this process's stdout+stderr (append) to RNGPUI_LOG_PATH. When the app is
// launched directly as the bundle's CFBundleExecutable (no shell wrapper), LaunchServices
// gives it no stdout terminal, so the wrapper's `exec rngpui-service >> log 2>&1` is gone —
// the service redirects its own fds instead. A wrapper that exec's into this binary splits
// the LaunchServices identity (declared executable vs running image) and stalls Cmd+Tab
// activation ~2s; running the real binary as CFBundleExecutable is the fix (see open-gpui.mjs).
fn redirect_stdio_to_log() {
    let Ok(path) = std::env::var("RNGPUI_LOG_PATH") else {
        return;
    };
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    use std::os::unix::io::AsRawFd;
    let fd = file.as_raw_fd();
    unsafe {
        libc::dup2(fd, libc::STDOUT_FILENO);
        libc::dup2(fd, libc::STDERR_FILENO);
    }
    // stdout/stderr now alias this fd; keep it open for the process lifetime.
    std::mem::forget(file);
}

fn main() {
    // launched as CFBundleExecutable, LaunchServices gives cwd `/`; RNGPUI_CWD restores the
    // working dir the wrapper used to `cd` into (the gui root, for the Cmd+R reload build).
    if let Ok(dir) = std::env::var("RNGPUI_CWD") {
        let _ = std::env::set_current_dir(&dir);
    }
    redirect_stdio_to_log();
    let _ = STARTUP.set(std::time::Instant::now());
    spawn_parent_exit_watchdog();
    if let Ok(path) = std::env::var("RNGPUI_SERVICE_PID_FILE") {
        if let Err(error) = std::fs::write(&path, std::process::id().to_string()) {
            eprintln!("[rngpui] failed to write service pid file {path}: {error}");
        }
    }
    // `kill -USR2 <pid>` = live reload (same path as Cmd+R); see hermes.rs.
    hermes::install_reload_signal_handler();
    // The JS runs in an embedded Hermes runtime on a dedicated thread (hermes.rs). The
    // bundle's reconciler hands every committed tree to __rngpui_applyTree, which parses it
    // and sends an Incoming on this channel: the first tree bootstraps the window size, the
    // rest are applied by a foreground task that calls cx.notify() — no polling.
    let (tree_tx, tree_rx) = flume::unbounded::<Incoming>();
    if let Ok(path) = std::env::var("RNGPUI_CONTROL_SOCKET") {
        debug_control::start(path, tree_tx.clone());
    }

    // start the JS engine; its first synchronous React commit sends the first tree below.
    // native events + fetch/ws results flow back to the JS thread via hermes::post.
    let bundle = load_bundle();
    startup_mark("bundle loaded");
    // the reanimated worklet/UI runtime boots first (its call queue must exist
    // before the React bundle's eval can dispatch worklets to it), then both
    // runtimes overlap each other and the GPUI platform init below. JsCalls
    // queued while a bundle is still evaluating drain once its run_loop starts,
    // so the startup interleaving is loss-free in both directions.
    hermes::start_ui(load_ui_bundle(), tree_tx.clone());
    hermes::start(bundle, tree_tx);
    // NOTE: we deliberately do NOT block for the first tree here. The GPUI platform init
    // below (Application::new + app.run + gpui_component::init) is tree-independent and is
    // the dominant cold-start cost (~85ms), so we let it overlap the JS eval (~60ms). The
    // first tree is awaited inside app.run, right before the window opens — by then it's
    // already available, so there's no added latency and no window-size flash.

    // test mode keeps conformance windows backgrounded and off the main screen.
    let test_mode = std::env::var("RNGPUI_TEST_MODE").is_ok();
    let test_onscreen = std::env::var("RNGPUI_TEST_ONSCREEN").is_ok();
    let background = test_mode || std::env::var("RNGPUI_NO_ACTIVATE").is_ok();
    let inspector_copy_at = parse_point_env("RNGPUI_INSPECTOR_COPY_AT");
    // Pixel-capture mode: macOS never composites a fully-offscreen window's Metal
    // surface (so a screenshot of the offscreen test window is blank). This mode
    // instead keeps the window ON-screen — where WindowServer does composite it —
    // but invisible: alpha ~0, click-through, non-activating, opened hidden so there
    // is no flash. A screenshot tool reads the full-opacity backing surface. Used
    // by gui/native-shell/scripts/check-web-parity.ts.
    let capture_onscreen = std::env::var("RNGPUI_CAPTURE_ONSCREEN").is_ok();
    let offscreen_test_window =
        test_mode && !test_onscreen && !capture_onscreen && inspector_copy_at.is_none();
    let window_origin = if offscreen_test_window {
        point(px(-10000.0), px(-10000.0))
    } else {
        // debug override: RNGPUI_WINDOW_ORIGIN="x,y" places the window (e.g. a small
        // corner window for non-focus-stealing visual debugging).
        parse_point_env("RNGPUI_WINDOW_ORIGIN").unwrap_or_else(|| point(px(120.0), px(120.0)))
    };
    // capture mode opens hidden too (no flash); liquid_glass reveals it invisibly.
    let show_window = (!test_mode || test_onscreen) && !capture_onscreen;

    let app = gpui::Application::new().with_assets(icons::Assets);
    startup_mark("Application::new");
    app.run(move |cx: &mut App| {
        startup_mark("app.run entered");
        // env-gated main-runloop gap detector (RNGPUI_ACTIVATION_TRACE=1): a 100ms
        // foreground timer that logs whenever the main loop went unserviced for
        // >300ms — catches stalls no specific-path probe instruments (cmd+tab
        // visual-switch investigation; temporary diagnostics).
        if std::env::var_os("RNGPUI_ACTIVATION_TRACE").is_some() {
            cx.spawn(async move |cx| {
                let mut last = std::time::Instant::now();
                loop {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(100))
                        .await;
                    let gap = last.elapsed();
                    if gap > std::time::Duration::from_millis(300) {
                        eprintln!(
                            "[act-trace {}] MAIN RUNLOOP GAP {}ms",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0),
                            gap.as_millis()
                        );
                    }
                    last = std::time::Instant::now();
                }
            })
            .detach();
        }
        // sets up gpui-component's theme + the input key bindings (backspace,
        // arrows, select-all, copy/paste, word-motion, …) used by InputState.
        gpui_component::init(cx);
        startup_mark("gpui_component::init done");
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
        let mut initial_menus = vec![Menu {
            name: "react-native-gpui".into(),
            items: vec![MenuItem::action("Quit", Quit)],
        }];
        initial_menus.extend(standard_edit_menus());
        cx.set_menus(initial_menus);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        // await the first tree HERE (after the tree-independent GPUI init above, which
        // overlapped the JS eval). it bootstraps the window size + initial content.
        startup_mark("awaiting first tree");
        let initial = loop {
            match tree_rx.recv() {
                Ok(Incoming::Tree(t)) => break t,
                Ok(Incoming::Quit) => {
                    cx.quit();
                    return;
                }
                Ok(_) => continue,
                Err(_) => break fallback_root(),
            }
        };
        startup_mark("first tree received");
        // window opens at the root's declared width/height (RNGPUI_WINDOW_SIZE overrides);
        // after that it fills.
        let win_w = initial.style.width.and_then(Dim::as_px).unwrap_or(720.0);
        let win_h = initial.style.height.and_then(Dim::as_px).unwrap_or(800.0);
        let (win_w, win_h) = parse_point_env("RNGPUI_WINDOW_SIZE")
            .map(|p| (f32::from(p.x), f32::from(p.y)))
            .unwrap_or((win_w, win_h));
        // anchor to the active display (bottom-center, center, …) when requested;
        // gpui knows the real screen, so the launcher never computes coordinates.
        let window_origin = if offscreen_test_window {
            window_origin
        } else {
            anchored_window_origin(win_w, win_h, cx).unwrap_or(window_origin)
        };
        let app_root = fill_root(initial);
        bridge::ready(win_w, win_h);

        // The view that renders the tree. Created up front so the applier task below
        // can update it directly.
        let content = cx.new(|cx| ServiceApp {
            app_focus: cx.focus_handle(),
            root: app_root,
            root_dirty: true,
            dump_tree_path: std::env::var("RNGPUI_DUMP_TREE").ok(),
            last_w: 0.0,
            last_h: 0.0,
            inputs: HashMap::new(),
            input_values: HashMap::new(),
            input_secure: HashMap::new(),
            suppressed_input_changes: HashMap::new(),
            webviews: HashMap::new(),
            inspector: inspector::InspectorState::from_env(),
            focused_input: None,
            last_debug_dump: None,
            debug_dump_scheduled: false,
        });

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: window_origin,
                size: size(px(win_w), px(win_h)),
            })),
            // borderless/HUD mode (RNGPUI_BORDERLESS) drops the titlebar + traffic
            // lights entirely, for a floating spotlight-style window.
            titlebar: if test_mode || std::env::var("RNGPUI_BORDERLESS").is_ok() {
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
        startup_mark("pre open_window");
        let window_handle = cx
            .open_window(options, move |window, cx| {
                window.set_window_title("react-native-gpui");
                startup_mark("open_window cb: pre glass");
                #[cfg(target_os = "macos")]
                liquid_glass::install(window);
                startup_mark("open_window cb: post glass");
                #[cfg(target_os = "macos")]
                if offscreen_test_window && !liquid_glass::show_offscreen_test_window(window) {
                    // macOS constrained the window back on-screen (happens on some
                    // display arrangements — `setFrame:display:` clamps a fully
                    // offscreen origin). rather than refuse + quit — which blocks every
                    // composite-dependent test (webview paint, dynamic color, animation
                    // frame-diff) — fall back to the invisible on-screen path used for
                    // pixel capture: alpha ~0, non-key, click-through. imperceptible and
                    // non-focus-stealing, but it composites so the test can run.
                    eprintln!("[rngpui test] offscreen position clamped; showing invisible (alpha~0) instead");
                    liquid_glass::show_onscreen_capture_window(window);
                }
                #[cfg(target_os = "macos")]
                if capture_onscreen {
                    liquid_glass::show_onscreen_capture_window(window);
                }
                #[cfg(target_os = "macos")]
                if background && show_window {
                    liquid_glass::show_nonactivating_window(window);
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
                let content_for_keys = content.clone();
                cx.intercept_keystrokes(move |event, _window, cx| {
                    let key = js_key_for_keystroke(&event.keystroke);
                    let shift = event.keystroke.modifiers.shift;
                    let control = event.keystroke.modifiers.control;
                    let alt = event.keystroke.modifiers.alt;
                    let platform = event.keystroke.modifiers.platform;
                    let _ = content_for_keys.update(cx, |this, _cx| {
                        if let Some(id) = first_app_key_press_listener(&this.root) {
                            bridge::key_press(id, &key, shift, control, alt, platform);
                        }
                    });
                })
                .detach();
                // follow the system light/dark setting: gpui delivers an appearance
                // change whenever macOS toggles theme. push it to JS so tamagui
                // re-themes live, and emit the current value once so JS matches the
                // real window appearance from the first frame.
                bridge::appearance(effective_appearance_scheme(window.appearance()));
                window
                    .observe_window_appearance(|window, _cx| {
                        bridge::appearance(effective_appearance_scheme(window.appearance()));
                    })
                    .detach();
                cx.new(|cx| gpui_component::Root::new(content.clone(), window, cx))
            })
            .expect("open window");
        startup_mark("window opened (GPUI/Metal init)");
        // bring the app to the front so keystrokes reach the focused input
        // (skipped in background mode so it doesn't pop over your work).
        if !background {
            cx.activate(true);
        }

        #[cfg(target_os = "macos")]
        if background && show_window {
            let order_window_handle = window_handle;
            cx.spawn(async move |cx| {
                for _ in 0..8 {
                    cx.background_executor()
                        .timer(Duration::from_millis(50))
                        .await;
                    if order_window_handle
                        .update(cx, |_root, window, _cx| {
                            liquid_glass::show_nonactivating_window(window);
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
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

        // Full-opacity PNG capture for the web<->desktop parity harness. Inert
        // unless RNGPUI_CAPTURE_PNG is set. The window is on-screen-but-invisible
        // (NSWindow alphaValue ~0.02) so its Metal surface keeps compositing;
        // capture_png reads the WindowServer composite via CGWindowListCreateImage
        // and divides the window alpha back out to recover full-opacity chrome (the
        // gpui CAMetalLayer's presented frames can't be read in-process — see
        // capture_png.rs). Runs on a repeating main-thread timer (the AppKit /
        // CG window calls require the main thread), overwriting the file each time,
        // so whenever the harness grabs it the latest frame is present. The harness
        // waits ~3s after the window appears.
        #[cfg(target_os = "macos")]
        if let Ok(capture_path) = std::env::var("RNGPUI_CAPTURE_PNG") {
            cx.spawn(async move |cx| {
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(250))
                        .await;
                    let still_open = window_handle
                        .update(cx, |_root, window, _cx| {
                            if let Some(view_ptr) = liquid_glass::gpui_ns_view_ptr(window) {
                                capture_png::capture_layer_to_png(
                                    view_ptr as *mut objc::runtime::Object,
                                    &capture_path,
                                );
                            }
                        })
                        .is_ok();
                    if !still_open {
                        break;
                    }
                }
            })
            .detach();
        }

        let native_layout_driver_active = Arc::new(AtomicBool::new(false));

        // Effects driver: animated procedural backgrounds (Background::Smoke) need the
        // window repainting every frame while one is on screen. A paint-chained
        // request_animation_frame is fragile (one dropped next-frame callback kills the
        // chain for good), so this mirrors the native-layout driver instead: tick ~120Hz
        // while a smoke quad painted recently, idle on a cheap poll otherwise.
        {
            let pump = pump.clone();
            let window_handle = window_handle;
            cx.spawn(async move |cx| {
                loop {
                    if elements::smoke_recently_painted() {
                        cx.background_executor()
                            .timer(Duration::from_millis(8))
                            .await;
                        if pump.update(cx, |_this, cx| cx.notify()).is_err() {
                            break;
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
                    } else {
                        cx.background_executor()
                            .timer(Duration::from_millis(120))
                            .await;
                        if pump.update(cx, |_this, _cx| ()).is_err() {
                            break;
                        }
                    }
                }
            })
            .detach();
        }

        // Foreground pump: apply each message on the main thread. A new tree re-renders
        // (cx.notify); a webview command runs straight against the live wry view (which
        // must be driven from the main thread). Both arrive on the same ordered channel.
        cx.spawn(async move |cx| {
            while let Ok(msg) = tree_rx.recv_async().await {
                match msg {
                    Incoming::Quit => {
                        let _ = cx.update(|cx| cx.quit());
                        break;
                    }
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
                    Incoming::DebugRealTap { x, y, reply } => {
                        // dispatch a REAL pointer event through gpui's hitbox hit-test (the
                        // same path an OS click takes). draw a fresh frame first so hitboxes
                        // are current, snapshot the host-event counter, dispatch
                        // MouseDown+MouseUp, then report the hit element + whether a JS
                        // handler actually fired (delta in emitted events).
                        let result = window_handle.update(cx, |_root, window, cx| {
                            // dispatch against the last rendered frame's hitboxes. We do NOT
                            // call window.draw() here — drawing re-enters the Root update and
                            // panics ("already being updated"); the dispatched MouseMove below
                            // re-runs hit-testing against the current rendered_frame, and the
                            // pump already refreshed the window for any pending animation
                            // frame before this command was processed.
                            let position = gpui::point(px(x), px(y));
                            let before = crate::bridge::events_emitted_count();
                            // dispatch through gpui's REAL event loop + hitbox hit-test. The
                            // return (`DispatchEventResult`) is a private gpui type, so each
                            // call is funneled through `dispatch_real_input` (a free fn that
                            // erases the return to `()`), then dropped — never named here.
                            // a MouseMove first so gpui updates its hover/hit-test set to the
                            // tap point, then a real down+up through the actual event loop.
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseMove(MouseMoveEvent {
                                    position,
                                    pressed_button: None,
                                    modifiers: gpui::Modifiers::default(),
                                }),
                                cx,
                            );
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseDown(MouseDownEvent {
                                    button: MouseButton::Left,
                                    position,
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                    first_mouse: false,
                                }),
                                cx,
                            );
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseUp(MouseUpEvent {
                                    button: MouseButton::Left,
                                    position,
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                }),
                                cx,
                            );
                            crate::bridge::events_emitted_count().saturating_sub(before)
                        });
                        match result {
                            Ok(emitted) => {
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "realtap",
                                    "x": x,
                                    "y": y,
                                    // a real handler firing emits >=1 host event (press /
                                    // mouseUp / click). 0 = the click reached no handler =
                                    // the freeze / dead hitbox we're hunting.
                                    "handlerFired": emitted > 0,
                                    "eventsEmitted": emitted,
                                }));
                            }
                            Err(_) => break,
                        }
                    }
                    Incoming::DebugRealDown { x, y, reply } => {
                        DEBUG_LEFT_HELD.store(true, Ordering::Relaxed);
                        let result = window_handle.update(cx, |_root, window, cx| {
                            let position = gpui::point(px(x), px(y));
                            let before = crate::bridge::events_emitted_count();
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseMove(MouseMoveEvent {
                                    position,
                                    pressed_button: None,
                                    modifiers: gpui::Modifiers::default(),
                                }),
                                cx,
                            );
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseDown(MouseDownEvent {
                                    button: MouseButton::Left,
                                    position,
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                    first_mouse: false,
                                }),
                                cx,
                            );
                            crate::bridge::events_emitted_count().saturating_sub(before)
                        });
                        match result {
                            Ok(emitted) => {
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "realdown",
                                    "x": x,
                                    "y": y,
                                    "eventsEmitted": emitted,
                                }));
                            }
                            Err(_) => break,
                        }
                    }
                    Incoming::DebugRealUp { x, y, reply } => {
                        DEBUG_LEFT_HELD.store(false, Ordering::Relaxed);
                        let result = window_handle.update(cx, |_root, window, cx| {
                            let position = gpui::point(px(x), px(y));
                            let before = crate::bridge::events_emitted_count();
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseUp(MouseUpEvent {
                                    button: MouseButton::Left,
                                    position,
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                }),
                                cx,
                            );
                            crate::bridge::events_emitted_count().saturating_sub(before)
                        });
                        match result {
                            Ok(emitted) => {
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "realup",
                                    "x": x,
                                    "y": y,
                                    "eventsEmitted": emitted,
                                }));
                            }
                            Err(_) => break,
                        }
                    }
                    Incoming::DebugRealMove { x, y, reply } => {
                        // dispatch a REAL mouse MOVE through gpui's hitbox hit-test, the same
                        // path an OS hover takes. Tests use this to drive native hover and
                        // pseudoEvents plumbing without activating a window. Like the OS, the
                        // move reports the held button (set by `realdown`), so moves between
                        // realdown/realup are dragging moves — a holdable mid-scrub probe.
                        // Snapshot the host->JS event counter so callers can distinguish a pure
                        // hover from a node that intentionally emitted coalesced pseudo events.
                        let pressed_button = if DEBUG_LEFT_HELD.load(Ordering::Relaxed) {
                            Some(MouseButton::Left)
                        } else {
                            None
                        };
                        let result = window_handle.update(cx, |_root, window, cx| {
                            let position = gpui::point(px(x), px(y));
                            let before = crate::bridge::events_emitted_count();
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseMove(MouseMoveEvent {
                                    position,
                                    pressed_button,
                                    modifiers: gpui::Modifiers::default(),
                                }),
                                cx,
                            );
                            window.refresh();
                            crate::bridge::events_emitted_count().saturating_sub(before)
                        });
                        match result {
                            Ok(emitted) => {
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "realmove",
                                    "x": x,
                                    "y": y,
                                    "eventsEmitted": emitted,
                                }));
                            }
                            Err(_) => break,
                        }
                    }
                    Incoming::DebugRealDrag {
                        x,
                        y,
                        x2,
                        y2,
                        steps,
                        reply,
                    } => {
                        // a real press-drag through gpui's event loop: down at the
                        // start, `steps` interpolated moves with the button HELD
                        // (pressed_button=Left ⇒ ev.dragging()), then up. This is the
                        // live cross-row scrub path; counts host events emitted so a
                        // gate can assert each swept row activated (grant per row).
                        let result = window_handle.update(cx, |_root, window, cx| {
                            let before = crate::bridge::events_emitted_count();
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseMove(MouseMoveEvent {
                                    position: gpui::point(px(x), px(y)),
                                    pressed_button: None,
                                    modifiers: gpui::Modifiers::default(),
                                }),
                                cx,
                            );
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseDown(MouseDownEvent {
                                    button: MouseButton::Left,
                                    position: gpui::point(px(x), px(y)),
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                    first_mouse: false,
                                }),
                                cx,
                            );
                            let n = steps.max(1);
                            for i in 1..=n {
                                let t = i as f32 / n as f32;
                                dispatch_real_input(
                                    window,
                                    gpui::PlatformInput::MouseMove(MouseMoveEvent {
                                        position: gpui::point(px(x + (x2 - x) * t), px(y + (y2 - y) * t)),
                                        pressed_button: Some(MouseButton::Left),
                                        modifiers: gpui::Modifiers::default(),
                                    }),
                                    cx,
                                );
                            }
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseUp(MouseUpEvent {
                                    button: MouseButton::Left,
                                    position: gpui::point(px(x2), px(y2)),
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                }),
                                cx,
                            );
                            window.refresh();
                            crate::bridge::events_emitted_count().saturating_sub(before)
                        });
                        match result {
                            Ok(emitted) => {
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "realdrag",
                                    "eventsEmitted": emitted,
                                }));
                            }
                            Err(_) => break,
                        }
                    }
                    Incoming::DebugRealDragPath { path, reply } => {
                        // a real press-drag along a waypoint path through gpui's loop:
                        // down at point[0], held moves through each subsequent point,
                        // up at the last. lets a probe reverse direction mid-drag.
                        let result = window_handle.update(cx, |_root, window, cx| {
                            let before = crate::bridge::events_emitted_count();
                            let (sx, sy) = path[0];
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseMove(MouseMoveEvent {
                                    position: gpui::point(px(sx), px(sy)),
                                    pressed_button: None,
                                    modifiers: gpui::Modifiers::default(),
                                }),
                                cx,
                            );
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseDown(MouseDownEvent {
                                    button: MouseButton::Left,
                                    position: gpui::point(px(sx), px(sy)),
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                    first_mouse: false,
                                }),
                                cx,
                            );
                            for &(px_, py_) in &path[1..] {
                                dispatch_real_input(
                                    window,
                                    gpui::PlatformInput::MouseMove(MouseMoveEvent {
                                        position: gpui::point(px(px_), px(py_)),
                                        pressed_button: Some(MouseButton::Left),
                                        modifiers: gpui::Modifiers::default(),
                                    }),
                                    cx,
                                );
                            }
                            let (ex, ey) = *path.last().unwrap();
                            dispatch_real_input(
                                window,
                                gpui::PlatformInput::MouseUp(MouseUpEvent {
                                    button: MouseButton::Left,
                                    position: gpui::point(px(ex), px(ey)),
                                    modifiers: gpui::Modifiers::default(),
                                    click_count: 1,
                                }),
                                cx,
                            );
                            window.refresh();
                            crate::bridge::events_emitted_count().saturating_sub(before)
                        });
                        match result {
                            Ok(emitted) => {
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "realdragpath",
                                    "eventsEmitted": emitted,
                                }));
                            }
                            Err(_) => break,
                        }
                    }
                    Incoming::DebugResize { w, h, reply } => {
                        let applied = window_handle.update(cx, |_root, window, cx| {
                            window.resize(size(px(w), px(h)));
                            cx.notify();
                        });
                        match applied {
                            Ok(()) => {
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "resize",
                                    "w": w,
                                    "h": h,
                                }));
                            }
                            Err(_) => break,
                        }
                    }
                    Incoming::PickPaths {
                        id,
                        files,
                        directories,
                        multiple,
                        prompt,
                    } => {
                        let result = pick_paths_native(files, directories, multiple, &prompt);
                        let payload = match result {
                            Ok(paths) => serde_json::json!({
                                "id": id,
                                "ok": true,
                                "paths": paths,
                            }),
                            Err(error) => serde_json::json!({
                                "id": id,
                                "ok": false,
                                "error": error,
                            }),
                        };
                        hermes::post("__rngpui_filePickerDone", payload.to_string());
                    }
                    Incoming::DebugTypeText { text, reply } => {
                        let mut focused_id = None;
                        let applied = window_handle.update(cx, |_root, window, cx| {
                            pump.update(cx, |this, cx| {
                                if let Some(id) = this.focused_input
                                    && let Some(state) = this.inputs.get(&id)
                                {
                                    focused_id = Some(id);
                                    state.update(cx, |input, cx| {
                                        input.insert(text.clone(), window, cx);
                                        // mirror real typing: keep the caret solid for the
                                        // pause window after a keystroke.
                                        input.pause_blink(cx);
                                    });
                                }
                                cx.notify();
                            })
                        });
                        let _ = reply.send(serde_json::json!({
                            "ok": applied.is_ok() && focused_id.is_some(),
                            "type": "type",
                            "focusedId": focused_id,
                        }));
                        if applied.is_err() {
                            break;
                        }
                    }
                    Incoming::DebugKeyPress { key, reply } => {
                        let mut focused_id = None;
                        let applied = window_handle.update(cx, |_root, window, cx| {
                            pump.update(cx, |this, cx| {
                                if let Some(id) = this.focused_input
                                    && let Some(state) = this.inputs.get(&id)
                                {
                                    focused_id = Some(id);
                                    let key_lower = key.to_ascii_lowercase();
                                    state.update(cx, |input, cx| match key_lower.as_str() {
                                        "enter" | "return" => {
                                            // mirror a REAL enter keystroke: the component
                                            // inserts the newline then emits PressEnter, and
                                            // the app-side subscription runs the submit path
                                            // (stripping the just-inserted newline). Without
                                            // the emit, `rngpui do key enter` never fires
                                            // onSubmitEditing.
                                            input.insert("\n", window, cx);
                                            cx.emit(InputEvent::PressEnter { secondary: false });
                                        }
                                        "backspace" => {
                                            let cursor = input.cursor();
                                            if cursor > 0 {
                                                let value = input.value().to_string();
                                                let mut next = value;
                                                next.truncate(cursor.saturating_sub(1));
                                                input.set_value(next, window, cx);
                                            }
                                        }
                                        "space" => input.insert(" ", window, cx),
                                        k if k.chars().count() == 1 => {
                                            input.insert(key.clone(), window, cx)
                                        }
                                        _ => {}
                                    });
                                }
                                cx.notify();
                            })
                        });
                        let _ = reply.send(serde_json::json!({
                            "ok": applied.is_ok() && focused_id.is_some(),
                            "type": "key",
                            "focusedId": focused_id,
                        }));
                        if applied.is_err() {
                            break;
                        }
                    }
                    Incoming::DebugRealKey { key, reply } => {
                        let reply_after_dispatch = reply.clone();
                        let key_after_dispatch = key.clone();
                        let scheduled = window_handle.update(cx, |_root, window, cx| {
                            // KeyDown can synchronously emit JS events whose handlers update
                            // React. Run it after the current root update unwinds so the debug
                            // probe exercises the real dispatch path without re-entering Root.
                            window.defer(cx, move |window, cx| {
                                let before = crate::bridge::events_emitted_count();
                                let keystroke = gpui::Keystroke {
                                    modifiers: gpui::Modifiers::default(),
                                    key: key_after_dispatch.clone(),
                                    key_char: real_key_char(&key_after_dispatch),
                                };
                                dispatch_real_input(
                                    window,
                                    gpui::PlatformInput::KeyDown(gpui::KeyDownEvent {
                                        keystroke,
                                        is_held: false,
                                    }),
                                    cx,
                                );
                                let contexts: Vec<String> = window
                                    .context_stack()
                                    .iter()
                                    .map(|c| format!("{c:?}"))
                                    .collect();
                                let emitted =
                                    crate::bridge::events_emitted_count().saturating_sub(before);
                                let _ = reply_after_dispatch.send(serde_json::json!({
                                    "ok": true,
                                    "type": "realKey",
                                    "key": key_after_dispatch,
                                    // a key reaching a focused element that forwards it
                                    // emits >=1 host event; 0 = the key was swallowed
                                    // (e.g. by a global binding) before any element saw it.
                                    "handlerFired": emitted > 0,
                                    "eventsEmitted": emitted,
                                    // the key-dispatch context stack (root → focused node)
                                    // the keystroke was matched against — empty means
                                    // context-gated bindings can never fire.
                                    "contextStack": contexts,
                                }));
                            });
                        });
                        if scheduled.is_err() {
                            let _ = reply.send(serde_json::json!({
                                "ok": false,
                                "type": "realKey",
                                "key": key,
                                "error": "window update failed",
                            }));
                            break;
                        }
                    }
                    Incoming::DebugDispatchAction { name, reply } => {
                        let dispatched = window_handle.update(cx, |_root, window, cx| {
                            match cx.build_action(&name, None) {
                                Ok(action) => {
                                    window.dispatch_action(action, cx);
                                    true
                                }
                                Err(_) => false,
                            }
                        });
                        // dispatch_action defers through the effect queue; the update()
                        // above flushed effects on drop, so the handler (and any
                        // clipboard write) has run by now.
                        let _ = reply.send(serde_json::json!({
                            "ok": matches!(dispatched, Ok(true)),
                            "type": "dispatchAction",
                            "name": name,
                            "pasteboard": read_general_pasteboard_string(),
                        }));
                        if dispatched.is_err() {
                            break;
                        }
                    }
                    Incoming::DebugNativeScrollAt { x, y, dy, reply } => {
                        // proof the hitTest passthrough routes a REAL scroll-wheel NSEvent
                        // natively to the WKWebView — no rngpui JS delta-forwarding. resolve
                        // the webview id at the point (so we can read scrollY back), then run
                        // the real AppKit hitTest + native scrollWheel: dispatch.
                        let webview_id = pump
                            .read_with(cx, |this, _| {
                                inspector::webview_at(&this.root, x, y)
                            })
                            .ok()
                            .flatten();
                        #[cfg(target_os = "macos")]
                        let (hit_class, dispatched) = window_handle
                            .update(cx, |_root, window, _cx| {
                                elements::webview::native_scroll_proof(
                                    window,
                                    x as f64,
                                    y as f64,
                                    dy as f64,
                                )
                            })
                            .unwrap_or_else(|_| ("<update-failed>".into(), false));
                        #[cfg(not(target_os = "macos"))]
                        let (hit_class, dispatched) = ("<non-macos>".to_string(), false);
                        // ask the page for its current scrollY so the caller can confirm a
                        // NON-zero scroll resulted from the native event alone. read-only —
                        // it posts the value back through the same onMessage bridge the
                        // fixture already listens on.
                        if let Some(id) = webview_id {
                            let _ = pump.update(cx, |this, _| {
                                if let Some(view) = this.webviews.get(&id) {
                                    let _ = view.evaluate_script(
                                        "window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'nativeScrollProbe',scrollY:window.scrollY}));",
                                    );
                                }
                            });
                        }
                        let _ = reply.send(serde_json::json!({
                            "ok": dispatched,
                            "type": "nativeScrollAt",
                            "hitClass": hit_class,
                            "dispatched": dispatched,
                            "webviewId": webview_id,
                            // a webview region passes through hitTest (returns nil on
                            // GPUIView), so AppKit resolves a WebKit view — never GPUIView.
                            "passthrough": hit_class != "GPUIView",
                        }));
                    }
                    Incoming::DebugWebviewCopyProof { x, y, reply } => {
                        // resolve the webview at the point, select all its page text,
                        // run the menu's `copy:` route against the WKWebView, then read
                        // the pasteboard back — proof a webview Cmd+C copies the page.
                        // The waits are async timers, NOT thread::sleep: the selection
                        // and the pasteboard write both happen in WebKit's processes and
                        // land via the main runloop — blocking it would starve exactly
                        // the callbacks this proof is waiting on.
                        let webview_id = pump
                            .read_with(cx, |this, _| inspector::webview_at(&this.root, x, y))
                            .ok()
                            .flatten();
                        #[cfg(target_os = "macos")]
                        {
                            let pump = pump.clone();
                            cx.spawn(async move |cx| {
                                let Some(id) = webview_id else {
                                    let _ = reply.send(serde_json::json!({
                                        "ok": false,
                                        "type": "webviewCopyProof",
                                        "error": "no webview at point",
                                    }));
                                    return;
                                };
                                // clear the pasteboard, then select the page text.
                                let selected = pump.update(cx, |this, _| {
                                    let Some(view) = this.webviews.get(&id) else {
                                        return false;
                                    };
                                    unsafe {
                                        use objc::{class, msg_send, sel, sel_impl};
                                        let pb: cocoa::base::id =
                                            msg_send![class!(NSPasteboard), generalPasteboard];
                                        let _: i64 = msg_send![pb, clearContents];
                                    }
                                    view.evaluate_script(
                                        "(()=>{const s=window.getSelection();s.removeAllRanges();const r=document.createRange();r.selectNodeContents(document.body);s.addRange(r);})();",
                                    )
                                    .is_ok()
                                });
                                if !matches!(selected, Ok(true)) {
                                    let _ = reply.send(serde_json::json!({
                                        "ok": false,
                                        "type": "webviewCopyProof",
                                        "error": "webview id not live",
                                    }));
                                    return;
                                }
                                // let the selection apply across XPC (runloop keeps spinning).
                                cx.background_executor()
                                    .timer(std::time::Duration::from_millis(400))
                                    .await;
                                let menu_facts = pump.update(cx, |this, _| {
                                    this.webviews
                                        .get(&id)
                                        .map(|view| elements::webview::webview_copy_proof(view))
                                });
                                let Ok(Some((menu_found, key_equiv, has_cmd, target_nil, responds))) =
                                    menu_facts
                                else {
                                    let _ = reply.send(serde_json::json!({
                                        "ok": false,
                                        "type": "webviewCopyProof",
                                        "error": "webview went away before copy",
                                    }));
                                    return;
                                };
                                // let WebKit land the async pasteboard write.
                                cx.background_executor()
                                    .timer(std::time::Duration::from_millis(400))
                                    .await;
                                let pasteboard = read_general_pasteboard_string();
                                let copied =
                                    pasteboard.as_deref().is_some_and(|s| !s.trim().is_empty());
                                let _ = reply.send(serde_json::json!({
                                    "ok": menu_found && target_nil && has_cmd && responds && copied,
                                    "type": "webviewCopyProof",
                                    "webviewId": id,
                                    // menu route facts:
                                    "menuCopyItemFound": menu_found,
                                    "copyKeyEquivalent": key_equiv,
                                    "copyHasCommandModifier": has_cmd,
                                    "copyTargetIsNil": target_nil,
                                    "webviewRespondsToCopy": responds,
                                    // actual result:
                                    "pasteboardCopied": copied,
                                    "pasteboardSample": pasteboard
                                        .as_deref()
                                        .map(|s| s.chars().take(80).collect::<String>()),
                                }));
                            })
                            .detach();
                        }
                        #[cfg(not(target_os = "macos"))]
                        let _ = reply.send(serde_json::json!({
                            "ok": false,
                            "type": "webviewCopyProof",
                            "error": "non-macos",
                        }));
                    }
                    Incoming::AppCommands(config) => {
                        if cx.update(|cx| install_app_commands(config, cx)).is_err() {
                            break;
                        }
                    }
                    Incoming::DockBadge { label } => {
                        dock::set_badge(&label);
                    }
                    Incoming::RequestAttention { critical } => {
                        dock::request_attention(critical);
                    }
                    msg => {
                        let mut drive_native_layout_animation = false;
                        let applied = pump.update(cx, |this, cx| match msg {
                            Incoming::Tree(t) => {
                                let next_root = fill_root(t);
                                let mut node_ids = HashSet::new();
                                collect_node_ids(&next_root, &mut node_ids);
                                bridge::retain_layout(&node_ids);
                                crate::anim_overlay::retain(&node_ids);
                                crate::inspector::retain_sources(&node_ids);
                                elements::retain_pointer_state(&node_ids);
                                let mut native_layout_keys = HashSet::new();
                                collect_native_layout_keys(&next_root, &mut native_layout_keys);
                                elements::retain_native_layout_keys(&native_layout_keys);
                                let mut layout_ids = HashSet::new();
                                collect_layout_ids(&next_root, &mut layout_ids);
                                bridge::emit_cached_layout_for_new_subscribers(&layout_ids);
                                emit_definite_cached_layouts(&next_root);
                                this.root = next_root;
                                this.root_dirty = true;
                                this.write_debug_dump(cx);
                                cx.notify();
                            }
                            Incoming::SetNodeStyle { ops } => {
                                // off-thread reanimated fast path: write the per-frame
                                // overrides into the overlay and re-render WITHOUT
                                // touching `root`. No React re-commit, no tree reparse.
                                if crate::anim_overlay::apply_ops(ops) {
                                    this.write_debug_dump(cx);
                                    cx.notify();
                                }
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
                            Incoming::Inspector { enabled } => {
                                if this.inspector.set_enabled(enabled) {
                                    cx.notify();
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
                            Incoming::DebugDump { reply } => {
                                let tree = dump::dump_tree(&this.root);
                                let dock = dock::snapshot();
                                let _ = reply.send(serde_json::json!({
                                    "ok": true,
                                    "type": "dump",
                                    "tree": tree,
                                    "dockBadge": dock.badge,
                                    "dockAttentionInformational": dock.attention_informational,
                                    "dockAttentionCritical": dock.attention_critical,
                                }));
                            }
                            Incoming::DebugTap { x, y, reply } => {
                                let target = inspector::tap_target_at(&this.root, x, y);
                                if let Some(target) = target {
                                    // a native AppKit control (NSButton) takes the real
                                    // target/action route via performClick:; only fall back
                                    // to a gpui synth-tap for ordinary gpui nodes.
                                    if !elements::native_control::perform_native_click(target.id) {
                                        elements::synth_tap(
                                            target.id,
                                            &target.events,
                                            target.bounds,
                                            x,
                                            y,
                                        );
                                    }
                                    if target.focusable_input {
                                        this.focused_input = Some(target.id);
                                    }
                                    cx.notify();
                                    let _ = reply.send(serde_json::json!({
                                        "ok": true,
                                        "type": "tap",
                                        "targetId": target.id,
                                        "focusedInput": target.focusable_input,
                                    }));
                                } else {
                                    let _ = reply.send(serde_json::json!({
                                        "ok": false,
                                        "type": "tap",
                                        "error": "no tappable node at point",
                                    }));
                                }
                            }
                            Incoming::DebugDragAt { phase, x, y, reply } => {
                                let target = inspector::tap_target_at(&this.root, x, y);
                                match phase.as_str() {
                                    "start" => {
                                        if let Some(target) = target {
                                            elements::synth_drag_start(
                                                target.id,
                                                &target.events,
                                                target.native_list_group.as_deref(),
                                                target.bounds,
                                                x,
                                                y,
                                            );
                                            cx.notify();
                                            let _ = reply.send(serde_json::json!({
                                                "ok": true,
                                                "type": "dragAt",
                                                "phase": phase,
                                                "targetId": target.id,
                                            }));
                                        } else {
                                            let _ = reply.send(serde_json::json!({
                                                "ok": false,
                                                "type": "dragAt",
                                                "phase": phase,
                                                "error": "no draggable node at point",
                                            }));
                                        }
                                    }
                                    "move" => {
                                        if let Some(target) = target {
                                            let activated = elements::synth_drag_move(
                                                target.id,
                                                &target.events,
                                                target.native_list_group.as_deref(),
                                                target.bounds,
                                                x,
                                                y,
                                            );
                                            cx.notify();
                                            let _ = reply.send(serde_json::json!({
                                                "ok": true,
                                                "type": "dragAt",
                                                "phase": phase,
                                                "targetId": target.id,
                                                "activated": activated,
                                            }));
                                        } else {
                                            let _ = reply.send(serde_json::json!({
                                                "ok": false,
                                                "type": "dragAt",
                                                "phase": phase,
                                                "error": "no draggable node at point",
                                            }));
                                        }
                                    }
                                    "end" => {
                                        elements::synth_drag_end();
                                        cx.notify();
                                        let _ = reply.send(serde_json::json!({
                                            "ok": true,
                                            "type": "dragAt",
                                            "phase": phase,
                                            "targetId": target.map(|target| target.id),
                                        }));
                                    }
                                    _ => {
                                        let _ = reply.send(serde_json::json!({
                                            "ok": false,
                                            "type": "dragAt",
                                            "phase": phase,
                                            "error": "phase must be start, move, or end",
                                        }));
                                    }
                                }
                            }
                            Incoming::DebugScrollAt {
                                x,
                                y,
                                dx,
                                dy,
                                reply,
                            } => {
                                let target = inspector::scroll_container_at(&this.root, x, y);
                                if let Some(id) = target {
                                    elements::scroll_by(id, dx, dy);
                                    if let Some((width, height, content_width, content_height)) =
                                        inspector::scroll_container_metrics(&this.root, id)
                                    {
                                        let (scroll_x, scroll_y) = elements::scroll_position(id);
                                        crate::bridge::scroll_event(
                                            id,
                                            scroll_x,
                                            scroll_y,
                                            width,
                                            height,
                                            content_width,
                                            content_height,
                                        );
                                    }
                                    cx.notify();
                                    let _ = reply.send(serde_json::json!({
                                        "ok": true,
                                        "type": "scrollAt",
                                        "targetId": id,
                                    }));
                                } else if let Some(id) = inspector::webview_at(&this.root, x, y) {
                                    let ok = this
                                        .webviews
                                        .get(&id)
                                        .and_then(|view| {
                                            elements::webview::webview_scroll_script(dx, dy)
                                                .map(|script| view.evaluate_script(&script).is_ok())
                                        })
                                        .unwrap_or(false);
                                    let _ = reply.send(serde_json::json!({
                                        "ok": ok,
                                        "type": "scrollAt",
                                        "targetId": id,
                                    }));
                                } else {
                                    let _ = reply.send(serde_json::json!({
                                        "ok": false,
                                        "type": "scrollAt",
                                        "error": "no scroll container at point",
                                    }));
                                }
                            }
                            Incoming::FocusInput { .. }
                            | Incoming::BlurInput
                            | Incoming::PickPaths { .. }
                            | Incoming::Quit
                            | Incoming::DebugTypeText { .. }
                            | Incoming::DebugKeyPress { .. }
                            | Incoming::DebugRealKey { .. }
                            | Incoming::DebugDispatchAction { .. }
                            | Incoming::DebugRealTap { .. }
                            | Incoming::DebugRealDown { .. }
                            | Incoming::DebugRealUp { .. }
                            | Incoming::DebugRealMove { .. }
                            | Incoming::DebugRealDrag { .. }
                            | Incoming::DebugRealDragPath { .. }
                            | Incoming::DebugResize { .. }
                            | Incoming::DebugNativeScrollAt { .. }
                            | Incoming::DebugWebviewCopyProof { .. }
                            | Incoming::AppCommands(_)
                            | Incoming::DockBadge { .. }
                            | Incoming::RequestAttention { .. } => unreachable!(),
                        });
                        if applied.is_err() {
                            break; // view dropped
                        }
                        // One targeted repaint of OUR window per applied message. The
                        // previous `cx.refresh_windows()` on top of this refreshed EVERY
                        // window in the process on every SetNodeStyle — a per-spring-frame
                        // all-windows redraw that taxed the main thread (a frame-drop
                        // contributor on the loaded on-screen window). This is a
                        // single-window app; the targeted refresh is sufficient.
                        if window_handle
                            .update(cx, |_root, window, root_cx| {
                                root_cx.notify();
                                window.refresh();
                            })
                            .is_err()
                        {
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
    use super::{
        AppCommandBinding, AppCommandBindingSlot, Incoming, app_command_key_bindings,
        parse_incoming, position_for_byte_offset,
    };
    use gpui::{KeyContext, Keymap, Keystroke};
    use serde_json::json;
    use std::collections::HashSet;
    use std::sync::Arc;

    fn tree_of(incoming: Option<Incoming>) -> Arc<super::ReactElement> {
        match incoming {
            Some(Incoming::Tree(t)) => t,
            _ => panic!("expected Incoming::Tree"),
        }
    }

    // The delta wire: a full commit seeds the index, then a delta with a `ref` node
    // reuses the prior Arc for the unchanged subtree (structural sharing) and must
    // reconstruct a tree byte-identical to a full apply of the same end state.
    #[test]
    fn delta_ref_reconstructs_full_tree_with_structural_sharing() {
        let full_a = json!({
            "globalId": 0, "type": "div", "children": [
                { "globalId": 1, "type": "div", "style": { "backgroundColor": "#111111" } },
                { "globalId": 2, "type": "div", "children": [
                    { "globalId": 3, "type": "text", "text": "hello" }
                ]}
            ]
        });
        // node 1's style changed; node 2's subtree is unchanged -> emitted as a ref.
        let delta = json!({
            "globalId": 0, "type": "div", "children": [
                { "globalId": 1, "type": "div", "style": { "backgroundColor": "#222222" } },
                { "globalId": 2, "ref": true }
            ]
        });
        // the equivalent full tree for the post-delta state.
        let full_b = json!({
            "globalId": 0, "type": "div", "children": [
                { "globalId": 1, "type": "div", "style": { "backgroundColor": "#222222" } },
                { "globalId": 2, "type": "div", "children": [
                    { "globalId": 3, "type": "text", "text": "hello" }
                ]}
            ]
        });

        let root_a = tree_of(parse_incoming(&full_a));
        let root_b_delta = tree_of(parse_incoming(&delta));

        // the ref'd subtree (node 2) must be the SAME Arc as in tree A — reused, not reparsed.
        assert!(
            Arc::ptr_eq(&root_a.children[1], &root_b_delta.children[1]),
            "ref'd subtree should reuse the prior commit's Arc"
        );
        // node 1 changed, so it must be a fresh Arc (not shared with A).
        assert!(
            !Arc::ptr_eq(&root_a.children[0], &root_b_delta.children[0]),
            "changed node should be reparsed, not shared"
        );

        // and the delta-reconstructed tree must be structurally identical to a full apply of B.
        let root_b_full = tree_of(parse_incoming(&full_b));
        assert_eq!(
            crate::dump::dump_tree(&root_b_delta),
            crate::dump::dump_tree(&root_b_full),
            "delta reconstruction must match a full apply"
        );
    }

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
    fn parses_dock_badge_command() {
        match parse_incoming(&json!({ "$cmd": "dockBadge", "label": "3" })) {
            Some(Incoming::DockBadge { label }) => assert_eq!(label, "3"),
            _ => panic!("expected dockBadge command"),
        }
        // missing label clears (empty string).
        match parse_incoming(&json!({ "$cmd": "dockBadge" })) {
            Some(Incoming::DockBadge { label }) => assert_eq!(label, ""),
            _ => panic!("expected dockBadge command"),
        }
    }

    #[test]
    fn parses_request_attention_command() {
        match parse_incoming(&json!({ "$cmd": "requestAttention", "critical": true })) {
            Some(Incoming::RequestAttention { critical }) => assert!(critical),
            _ => panic!("expected requestAttention command"),
        }
        // default is non-critical (informational).
        match parse_incoming(&json!({ "$cmd": "requestAttention" })) {
            Some(Incoming::RequestAttention { critical }) => assert!(!critical),
            _ => panic!("expected requestAttention command"),
        }
    }

    #[test]
    fn dock_state_records_badge_and_attention_in_test_mode() {
        // in TEST_MODE set_badge/request_attention skip the real AppKit call and
        // only record the value — assert the recorded snapshot tracks the inputs.
        // SAFETY: tests in this module run single-threaded for this env var.
        unsafe { std::env::set_var("RNGPUI_TEST_MODE", "1") };

        super::dock::set_badge("4");
        assert_eq!(super::dock::snapshot().badge.as_deref(), Some("4"));

        super::dock::set_badge("");
        assert_eq!(super::dock::snapshot().badge, None);

        let before = super::dock::snapshot();
        super::dock::request_attention(false);
        super::dock::request_attention(true);
        let after = super::dock::snapshot();
        assert_eq!(
            after.attention_informational,
            before.attention_informational + 1
        );
        assert_eq!(after.attention_critical, before.attention_critical + 1);
    }

    #[test]
    fn app_commands_mask_removed_key_bindings() {
        let mut previous = HashSet::<AppCommandBindingSlot>::new();
        let mut keymap = Keymap::default();
        let down = Keystroke::parse("down").expect("down keystroke");
        let context = [KeyContext::parse("pane").expect("pane context")];

        keymap.add_bindings(app_command_key_bindings(
            &mut previous,
            vec![app_command_binding("focus.down", "down", Some("!Input"))],
        ));
        assert_eq!(
            keymap.bindings_for_input(&[down.clone()], &context).0.len(),
            1
        );

        keymap.add_bindings(app_command_key_bindings(&mut previous, vec![]));
        assert!(
            keymap
                .bindings_for_input(&[down.clone()], &context)
                .0
                .is_empty()
        );

        keymap.add_bindings(app_command_key_bindings(
            &mut previous,
            vec![app_command_binding("focus.down", "down", Some("!Input"))],
        ));
        assert_eq!(keymap.bindings_for_input(&[down], &context).0.len(), 1);
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

    fn app_command_binding(id: &str, key: &str, context: Option<&str>) -> AppCommandBinding {
        AppCommandBinding {
            id: id.to_string(),
            key: key.to_string(),
            context: context.map(str::to_string),
        }
    }
}
