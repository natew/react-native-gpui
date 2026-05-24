use std::io::{self, BufRead, Write};
use std::sync::Arc;

use gpui::{
    px, size, App, AppContext, Bounds, Context, IntoElement, ParentElement, Render, Window,
    WindowBounds, WindowOptions,
};

mod elements;
mod events;
mod gestures;
mod renderer;
mod style;

use elements::{create_element, ReactElement};
use style::ElementStyle;

use std::sync::atomic::{AtomicU64, Ordering};
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

fn parse_json_tree(value: &serde_json::Value) -> Option<Arc<ReactElement>> {
    let obj = value.as_object()?;
    let element_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("div");
    let global_id = obj
        .get("globalId")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| next_id());
    let text = obj.get("text").and_then(|v| v.as_str()).map(|s| s.to_string());
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
        children,
        style,
        event_handlers: None,
        cached_gpui_style: None,
    }))
}

struct ServiceApp {
    root: Arc<ReactElement>,
}

impl Render for ServiceApp {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let root = create_element(self.root.clone(), 0, None);
        gpui::div()
            .child(root)
            .into_any_element()
    }
}

fn main() {
    // Read JSON tree from first stdin line
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();

    let initial_json: serde_json::Value = match lines.next() {
        Some(Ok(line)) => serde_json::from_str(&line).unwrap_or(serde_json::json!({
            "type": "div",
            "style": {
                "width": 700, "height": 500,
                "backgroundColor": "#1e1e2e",
                "flexDirection": "column",
                "padding": 16
            },
            "children": [{
                "type": "text",
                "text": "React Native GPUI (from TS)",
                "style": { "color": "#00d9ff", "fontSize": 28 }
            }]
        })),
        _ => serde_json::json!({}),
    };

    let root = parse_json_tree(&initial_json).unwrap_or_else(|| {
        Arc::new(ReactElement {
            global_id: 1,
            element_type: "div".to_string(),
            text: None,
            children: vec![],
            style: ElementStyle {
                width: Some(700.0),
                height: Some(500.0),
                background_color: Some(0x1e1e2e),
                flex_direction: Some("column".to_string()),
                padding: Some(16.0),
                ..Default::default()
            },
            event_handlers: None,
            cached_gpui_style: None,
        })
    });

    // Write ready signal to stdout
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(
        out,
        r#"{{"type":"ready","width":720,"height":800}}"#
    );
    let _ = out.flush();

    let app = gpui::Application::new();
    app.run(move |cx: &mut App| {
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(720.0), px(800.0)),
                cx,
            ))),
            titlebar: None,
            focus: true,
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

        let tree = root.clone();
        cx.open_window(options, |_window, cx| {
            cx.new(|_| ServiceApp { root: tree })
        })
        .expect("open window");
    });
}
