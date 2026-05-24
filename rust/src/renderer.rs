use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gpui::{App, AppContext, Bounds, Context, Entity, Render, Window, WindowOptions, px, size};
use once_cell::sync::Lazy;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::elements::{ReactElement, create_element};
use crate::gestures::GestureState;
use crate::style::ElementStyle;

/// Commands from FFI thread to GPUI thread.
pub enum RenderCommand {
    CreateWindow {
        width: f64,
        height: f64,
        response: oneshot::Sender<u64>,
    },
    BatchUpdateElements {
        window_id: u64,
        elements_json: String,
    },
    AppendChild {
        window_id: u64,
        parent_id: u64,
        child_id: u64,
    },
    RemoveChild {
        window_id: u64,
        parent_id: u64,
        child_id: u64,
    },
    TriggerRender {
        window_id: u64,
    },
    GetInputValue {
        window_id: u64,
        element_id: u64,
        response: oneshot::Sender<Option<String>>,
    },
}

static PENDING: Lazy<Mutex<Vec<RenderCommand>>> = Lazy::new(|| Mutex::new(Vec::new()));
static INITIALIZED: AtomicBool = AtomicBool::new(false);
static WINDOWS: Lazy<Mutex<HashMap<u64, Entity<WindowState>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

pub fn send_command(cmd: RenderCommand) {
    PENDING.lock().expect("lock").push(cmd);
}

pub fn is_ready() -> bool {
    INITIALIZED.load(Ordering::SeqCst)
}

/// Process all pending commands. Called from GPUI's event loop.
pub fn process_pending(cx: &mut App) {
    let commands = {
        let mut queue = PENDING.lock().expect("lock");
        if queue.is_empty() {
            return;
        }
        std::mem::take(&mut *queue)
    };

    for cmd in commands {
        process_one(cmd, cx);
    }
}

fn process_one(cmd: RenderCommand, cx: &mut App) {
    match cmd {
        RenderCommand::CreateWindow {
            width,
            height,
            response,
        } => {
            let window_id = NEXT_WINDOW_ID.fetch_add(1, Ordering::SeqCst);
            let state = cx.new(|_| WindowState::new(window_id));
            let options = WindowOptions {
                window_bounds: Some(gpui::WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(width as f32), px(height as f32)),
                    cx,
                ))),
                ..Default::default()
            };
            let window_state = state.clone();
            match cx.open_window(options, move |window, cx| {
                cx.activate(false);
                window.focus(&cx.focus_handle());
                window_state.clone()
            }) {
                Ok(_) => {
                    if let Ok(mut map) = WINDOWS.lock() {
                        map.insert(window_id, state);
                    }
                    let _ = response.send(window_id);
                }
                Err(e) => {
                    log::error!("create window failed: {}", e);
                    let _ = response.send(0);
                }
            }
        }
        RenderCommand::BatchUpdateElements {
            window_id,
            elements_json,
        } => {
            if let Ok(map) = WINDOWS.lock() {
                if let Some(state) = map.get(&window_id) {
                    if let Ok(elements) = serde_json::from_str::<Vec<Value>>(&elements_json) {
                        state.update(cx, |s, cx| {
                            s.process_batch(&elements);
                            cx.notify();
                        });
                    }
                }
            }
        }
        RenderCommand::AppendChild {
            window_id,
            parent_id,
            child_id,
        } => {
            if let Ok(map) = WINDOWS.lock() {
                if let Some(state) = map.get(&window_id) {
                    state.update(cx, |s, cx| {
                        s.append_child(parent_id, child_id);
                        cx.notify();
                    });
                }
            }
        }
        RenderCommand::RemoveChild {
            window_id,
            parent_id,
            child_id,
        } => {
            if let Ok(map) = WINDOWS.lock() {
                if let Some(state) = map.get(&window_id) {
                    state.update(cx, |s, cx| {
                        s.remove_child(parent_id, child_id);
                        cx.notify();
                    });
                }
            }
        }
        RenderCommand::TriggerRender { window_id } => {
            if let Ok(map) = WINDOWS.lock() {
                if let Some(state) = map.get(&window_id) {
                    state.update(cx, |_s, cx| cx.notify());
                }
            }
        }
        RenderCommand::GetInputValue {
            window_id,
            element_id,
            response,
        } => {
            let value = WINDOWS.lock().ok().and_then(|map| {
                map.get(&window_id)
                    .map(|state| state.read_with(cx, |s, _| s.get_input_value(element_id)))
                    .and_then(|x| x)
            });
            let _ = response.send(value);
        }
    }
}

/// Start GPUI on a background thread. The demo binary provides the main thread.
pub fn start_gpui_thread() {
    INITIALIZED.store(true, Ordering::SeqCst);
    // The actual GPUI init is done in the demo binary via rngpui_run
    // This just marks the library as ready
    log::info!("react-native-gpui library initialized");
}

/// Wait for a window to be created (called from the GPUI main thread).
pub fn create_window_blocking(cx: &mut App, width: f64, height: f64) -> u64 {
    let window_id = NEXT_WINDOW_ID.fetch_add(1, Ordering::SeqCst);
    let state = cx.new(|_| WindowState::new(window_id));
    let options = WindowOptions {
        window_bounds: Some(gpui::WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(width as f32), px(height as f32)),
            cx,
        ))),
        ..Default::default()
    };
    let window_state = state.clone();
    match cx.open_window(options, move |window, cx| {
        cx.activate(false);
        window.focus(&cx.focus_handle());
        window_state.clone()
    }) {
        Ok(_) => {
            if let Ok(mut map) = WINDOWS.lock() {
                map.insert(window_id, state);
            }
            window_id
        }
        Err(e) => {
            log::error!("create window failed: {}", e);
            0
        }
    }
}

/// Manages element tree and rendering for one window.
pub struct WindowState {
    elements: HashMap<u64, Arc<ReactElement>>,
    children_map: HashMap<u64, Vec<u64>>,
    root_element_id: Option<u64>,
    gesture_state: GestureState,
}

impl WindowState {
    pub fn new(_window_id: u64) -> Self {
        Self {
            elements: HashMap::new(),
            children_map: HashMap::new(),
            root_element_id: None,
            gesture_state: GestureState::new(),
        }
    }

    pub fn get_input_value(&self, element_id: u64) -> Option<String> {
        self.elements.get(&element_id).and_then(|e| e.text.clone())
    }

    pub fn process_batch(&mut self, updates: &[Value]) {
        for update in updates {
            if let Some(obj) = update.as_object() {
                if let Some(id) = obj.get("globalId").and_then(|v| v.as_u64()) {
                    let element_type = obj
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("div")
                        .to_string();
                    let style = obj
                        .get("style")
                        .map(ElementStyle::from_json)
                        .unwrap_or_default();
                    let text = obj
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let is_root = obj.get("isRoot").and_then(|v| v.as_bool()).unwrap_or(false);

                    if is_root {
                        self.root_element_id = Some(id);
                    }

                    self.elements.insert(
                        id,
                        Arc::new(ReactElement {
                            global_id: id,
                            element_type,
                            text,
                            children: Vec::new(),
                            style,
                            event_handlers: None,
                            cached_gpui_style: None,
                        }),
                    );
                }
            }
        }
        self.rebuild_tree();
    }

    pub fn append_child(&mut self, parent_id: u64, child_id: u64) {
        self.children_map
            .entry(parent_id)
            .or_default()
            .push(child_id);
        self.rebuild_tree();
    }

    pub fn remove_child(&mut self, parent_id: u64, child_id: u64) {
        if let Some(children) = self.children_map.get_mut(&parent_id) {
            children.retain(|c| *c != child_id);
        }
        self.rebuild_tree();
    }

    fn rebuild_tree(&mut self) {
        if let Some(root_id) = self.root_element_id {
            self.populate_children(root_id);
        }
    }

    fn populate_children(&mut self, parent_id: u64) {
        let child_ids = self
            .children_map
            .get(&parent_id)
            .cloned()
            .unwrap_or_default();
        let children: Vec<Arc<ReactElement>> = child_ids
            .iter()
            .filter_map(|id| self.elements.get(id).cloned())
            .collect();
        if let Some(parent) = self.elements.get_mut(&parent_id) {
            Arc::make_mut(parent).children = children;
        }
        for id in &child_ids {
            self.populate_children(*id);
        }
    }

    pub fn build_root(&self) -> Option<Arc<ReactElement>> {
        self.root_element_id
            .and_then(|id| self.elements.get(&id).cloned())
    }
}

impl Render for WindowState {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl gpui::IntoElement {
        use gpui::{div, prelude::*};
        match self.build_root() {
            Some(root) => {
                let elem = create_element(root, self.window_id(), None);
                div()
                    .id("rn-root")
                    .size_full()
                    .child(elem)
                    .into_any_element()
            }
            None => div()
                .id("rn-root")
                .size_full()
                .child(div().child("React Native GPUI"))
                .into_any_element(),
        }
    }
}

impl WindowState {
    fn window_id(&self) -> u64 {
        // Stored ID would be a field; for now hardcoded for the single-window case
        1
    }
}
