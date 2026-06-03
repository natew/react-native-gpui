use std::io::{self, BufRead};
use std::sync::{Arc, Mutex};

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    actions, px, point, rgb, size, App, AppContext, Bounds, Context, Entity, IntoElement,
    KeyBinding, Menu, MenuItem, ParentElement, Render, Styled, TitlebarOptions, Window,
    WindowBounds, WindowOptions,
};
use gpui_component::input::{InputEvent, InputState};
use once_cell::sync::Lazy;

actions!(rngpui, [Quit]);

mod bridge;
mod elements;
mod icons;
mod style;

use elements::{create_element, ReactElement};
use style::{Dim, ElementStyle};

use std::sync::atomic::{AtomicU64, Ordering};
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

// Latest tree pushed from JS via stdin (after the initial one). The render loop
// drains this so the window re-renders when React re-renders.
static PENDING_ROOT: Lazy<Mutex<Option<Arc<ReactElement>>>> = Lazy::new(|| Mutex::new(None));

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

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
    let src = obj
        .get("src")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let events = obj
        .get("events")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
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

    Some(Arc::new(ReactElement {
        global_id,
        element_type: element_type.to_string(),
        text,
        src,
        events,
        children,
        style,
        cached_gpui_style: None,
    }))
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
    Arc::new(r)
}

struct ServiceApp {
    root: Arc<ReactElement>,
    last_w: f64,
    last_h: f64,
    // persistent gpui-component input state, one per <TextInput>/<TextArea> id.
    inputs: HashMap<u64, Entity<InputState>>,
    // persistent native WebView, one per <WebView> id, + its last-loaded content.
    webviews: HashMap<u64, Rc<wry::WebView>>,
    webview_content: HashMap<u64, String>,
}

/// Collect (id, placeholder, multiline) for every text-input node in the tree.
fn collect_inputs(el: &Arc<ReactElement>, out: &mut Vec<(u64, String, bool)>) {
    if el.element_type == "textinput" || el.element_type == "textarea" {
        out.push((
            el.global_id,
            el.text.clone().unwrap_or_default(),
            el.element_type == "textarea",
        ));
    }
    for c in &el.children {
        collect_inputs(c, out);
    }
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

impl Render for ServiceApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        // Apply any newer tree React pushed over stdin.
        if let Some(new_root) = PENDING_ROOT.lock().ok().and_then(|mut g| g.take()) {
            self.root = fill_root(new_root);
        }

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

        // Keep a frame scheduled so stdin-pushed trees get picked up promptly.
        window.request_animation_frame();

        // Ensure a persistent InputState entity exists for every text-input node,
        // subscribing once so edits stream back to JS as `changeText`.
        let mut specs = Vec::new();
        collect_inputs(&self.root, &mut specs);
        let present: HashSet<u64> = specs.iter().map(|(id, _, _)| *id).collect();
        self.inputs.retain(|id, _| present.contains(id));
        for (id, placeholder, multiline) in specs {
            if !self.inputs.contains_key(&id) {
                let state = cx.new(|cx| {
                    let mut s = InputState::new(window, cx).placeholder(placeholder.clone());
                    if multiline {
                        s = s.multi_line(true);
                    }
                    s
                });
                cx.subscribe(&state, move |_this, input, ev: &InputEvent, cx| match ev {
                    InputEvent::Change => bridge::change_text(id, input.read(cx).value().as_ref()),
                    InputEvent::PressEnter { .. } => bridge::event(id, "submit"),
                    InputEvent::Focus => bridge::event(id, "focus"),
                    InputEvent::Blur => bridge::event(id, "blur"),
                })
                .detach();
                self.inputs.insert(id, state);
            }
        }
        elements::input::set_entities(self.inputs.clone());

        // Same lifecycle for <WebView>: create a native child view per id, (re)load
        // its content when it changes, and let the element resize it each frame.
        let mut wv_specs = Vec::new();
        collect_webviews(&self.root, &mut wv_specs);
        let present_wv: HashSet<u64> = wv_specs.iter().map(|(id, _, _)| *id).collect();
        self.webviews.retain(|id, _| present_wv.contains(id));
        self.webview_content.retain(|id, _| present_wv.contains(id));
        for (id, content, is_html) in wv_specs {
            let view = self.webviews.entry(id).or_insert_with(|| {
                let wv = wry::WebViewBuilder::new()
                    .build_as_child(&*window)
                    .expect("failed to create webview");
                let _ = wv.set_visible(true);
                Rc::new(wv)
            });
            if self.webview_content.get(&id) != Some(&content) {
                if is_html {
                    let _ = view.load_html(&content);
                } else {
                    let _ = view.load_url(&content);
                }
                self.webview_content.insert(id, content);
            }
        }
        elements::webview::set_webviews(self.webviews.clone());

        // GC layout-dedup state for nodes that left the tree.
        let mut layout_ids = HashSet::new();
        collect_layout_ids(&self.root, &mut layout_ids);
        bridge::retain_layout(&layout_ids);

        let root = create_element(self.root.clone(), 0, None);
        gpui::div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0xe9e9ec))
            .child(root)
            .into_any_element()
    }
}

fn fallback_root() -> Arc<ReactElement> {
    Arc::new(ReactElement {
        global_id: 1,
        element_type: "div".to_string(),
        text: None,
        src: None,
        events: Vec::new(),
        children: vec![],
        style: ElementStyle {
            width: Some(Dim::Px(720.0)),
            height: Some(Dim::Px(800.0)),
            background_color: Some(0xe9e9ec),
            flex_direction: Some("column".to_string()),
            ..Default::default()
        },
        cached_gpui_style: None,
    })
}

fn main() {
    // Background thread continuously reads JSON trees from stdin (one per line).
    // The first one bootstraps the window; later ones are re-renders from React.
    let (first_tx, first_rx) = std::sync::mpsc::channel::<Arc<ReactElement>>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut first_sent = false;
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
            if let Some(root) = parse_json_tree(&v) {
                if !first_sent {
                    first_sent = true;
                    let _ = first_tx.send(root);
                } else if let Ok(mut g) = PENDING_ROOT.lock() {
                    *g = Some(root);
                }
            }
        }
    });

    let initial = first_rx.recv().unwrap_or_else(|_| fallback_root());

    // Window opens at the root's declared width/height; after that it fills.
    let win_w = initial.style.width.and_then(Dim::as_px).unwrap_or(720.0);
    let win_h = initial.style.height.and_then(Dim::as_px).unwrap_or(800.0);
    let app_root = fill_root(initial);

    bridge::ready(win_w, win_h);

    // when set, the window opens in the background without stealing focus — handy
    // for screenshotting/iterating without it popping over whatever you're doing.
    let background = std::env::var("RNGPUI_NO_ACTIVATE").is_ok();

    let app = gpui::Application::new().with_assets(icons::Assets);
    app.run(move |cx: &mut App| {
        // sets up gpui-component's theme + the input key bindings (backspace,
        // arrows, select-all, copy/paste, word-motion, …) used by InputState.
        gpui_component::init(cx);

        // quit on ⌘Q and when the last window closes (X button).
        cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
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

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(120.0), px(120.0)),
                size: size(px(win_w), px(win_h)),
            })),
            titlebar: Some(TitlebarOptions {
                title: Some("react-native-gpui".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(14.0), px(18.0))),
            }),
            focus: !background,
            show: true,
            kind: gpui::WindowKind::Normal,
            is_movable: true,
            is_resizable: true,
            is_minimizable: true,
            display_id: None,
            window_background: gpui::WindowBackgroundAppearance::default(),
            app_id: None,
            window_min_size: None,
            window_decorations: None,
            tabbing_identifier: None,
        };

        cx.open_window(options, |window, cx| {
            let content = cx.new(|_| ServiceApp {
                root: app_root,
                last_w: 0.0,
                last_h: 0.0,
                inputs: HashMap::new(),
                webviews: HashMap::new(),
                webview_content: HashMap::new(),
            });
            // gpui-component needs the window root to be a `Root` (owns the
            // focused-input / dialog / notification layers the Input uses).
            cx.new(|cx| gpui_component::Root::new(content, window, cx))
        })
        .expect("open window");
        // bring the app to the front so keystrokes reach the focused input
        // (skipped in background mode so it doesn't pop over your work).
        if !background {
            cx.activate(true);
        }
    });
}
