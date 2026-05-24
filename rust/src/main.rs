use std::sync::Arc;
use std::time::Instant;

use gpui::{
    actions,
    px, size, App, AppContext, Bounds, Context, Menu, MenuItem, ParentElement, Render, Window,
    WindowBounds, WindowOptions, InteractiveElement as _, MouseButton,
};

actions!([Quit]);

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

fn make_text(text: &str, style: ElementStyle) -> Arc<ReactElement> {
    Arc::new(ReactElement {
        global_id: next_id(),
        element_type: "text".to_string(),
        text: Some(text.to_string()),
        children: Vec::new(),
        style,
        event_handlers: None,
        cached_gpui_style: None,
    })
}

fn make_div(style: ElementStyle, children: Vec<Arc<ReactElement>>) -> Arc<ReactElement> {
    Arc::new(ReactElement {
        global_id: next_id(),
        element_type: "div".to_string(),
        text: None,
        children,
        style,
        event_handlers: None,
        cached_gpui_style: None,
    })
}

fn make_box(color: u32, size: f32, label: &str) -> Arc<ReactElement> {
    make_div(
        ElementStyle {
            width: Some(size),
            height: Some(size),
            background_color: Some(color),
            justify_content: Some("center".to_string()),
            align_items: Some("center".to_string()),
            border_radius: Some(4.0),
            ..Default::default()
        },
        vec![make_text(
            label,
            ElementStyle {
                color: Some(0xffffff),
                font_size: Some(11.0),
                ..Default::default()
            },
        )],
    )
}

struct DemoApp {
    tapped_color: u32,
    long_press_active: bool,
    // Drag
    drag_x: f64,
    drag_y: f64,
    dragging: bool,
    drag_origin_x: f64,
    drag_origin_y: f64,
    drag_start_x: f64,
    drag_start_y: f64,
    // Scroll physics
    scroll_y: f64,
    max_scroll: f64,
    scroll_velocity: f64,
    scroll_animating: bool,
    scroll_last_time: Option<Instant>,
    // Event log
    last_gesture: String,
}

impl DemoApp {
    fn render_tree(&self) -> Arc<ReactElement> {
        let tap_bg = if self.tapped_color != 0 {
            self.tapped_color
        } else {
            0x4ed93b
        };
        let lp_bg = if self.long_press_active {
            0x2ecc71
        } else {
            0x9b59b6
        };

        // Scroll: negative margin_top pushes content upward
        let scroll_offset = -self.scroll_y;

        make_div(
            ElementStyle {
                flex_direction: Some("column".to_string()),
                width: Some(700.0),
                background_color: Some(0x1e1e2e),
                overflow: Some("hidden".to_string()),
                gap: Some(10.0),
                padding: Some(16.0),
                margin_top: Some(scroll_offset as f32),
                ..Default::default()
            },
            vec![
                // Header
                make_text(
                    "React Native GPUI",
                    ElementStyle { color: Some(0x00d9ff), font_size: Some(28.0), ..Default::default() },
                ),
                make_text(
                    "Kitchen Sink :: resizable | scrollable | cmd+q to quit",
                    ElementStyle { color: Some(0x888888), font_size: Some(13.0), ..Default::default() },
                ),
                // Event status
                make_div(
                    ElementStyle {
                        width: Some(668.0),
                        height: Some(36.0),
                        background_color: Some(0x16213e),
                        border_radius: Some(6.0),
                        padding: Some(8.0),
                        justify_content: Some("center".to_string()),
                        ..Default::default()
                    },
                    vec![make_text(
                        &format!("Event: {}", self.last_gesture),
                        ElementStyle { color: Some(0x00d9ff), font_size: Some(13.0), ..Default::default() },
                    )],
                ),
                // Gesture row
                make_text(
                    "Gestures — Tap · Long Press · Drag",
                    ElementStyle { color: Some(0xcccccc), font_size: Some(15.0), ..Default::default() },
                ),
                make_div(
                    ElementStyle {
                        flex_direction: Some("row".to_string()),
                        gap: Some(12.0),
                        flex_wrap: Some("wrap".to_string()),
                        ..Default::default()
                    },
                    vec![
                        make_div(
                            ElementStyle { width: Some(100.0), height: Some(60.0),
                                background_color: Some(tap_bg), border_radius: Some(8.0),
                                justify_content: Some("center".to_string()),
                                align_items: Some("center".to_string()), ..Default::default() },
                            vec![make_text("Tap", ElementStyle { color: Some(0xffffff),
                                font_size: Some(15.0), ..Default::default() })],
                        ),
                        make_div(
                            ElementStyle { width: Some(100.0), height: Some(60.0),
                                background_color: Some(lp_bg), border_radius: Some(8.0),
                                justify_content: Some("center".to_string()),
                                align_items: Some("center".to_string()), ..Default::default() },
                            vec![make_text("Long Press", ElementStyle { color: Some(0xffffff),
                                font_size: Some(15.0), ..Default::default() })],
                        ),
                        make_div(
                            ElementStyle { width: Some(100.0), height: Some(60.0),
                                background_color: Some(0x2c3e50), border_radius: Some(8.0),
                                justify_content: Some("center".to_string()),
                                align_items: Some("center".to_string()),
                                margin_left: Some(self.drag_x as f32),
                                margin_top: Some(self.drag_y as f32),
                                ..Default::default() },
                            vec![make_text("Drag (click & hold)", ElementStyle { color: Some(0xecf0f1),
                                font_size: Some(15.0), ..Default::default() })],
                        ),
                    ],
                ),
                // Flexbox row
                make_text(
                    "Flexbox",
                    ElementStyle { color: Some(0xcccccc), font_size: Some(15.0), ..Default::default() },
                ),
                make_div(
                    ElementStyle {
                        flex_direction: Some("row".to_string()),
                        gap: Some(8.0),
                        padding: Some(8.0),
                        background_color: Some(0x1a1a2e),
                        border_radius: Some(8.0),
                        ..Default::default()
                    },
                    vec![
                        make_box(0xe74c3c, 50.0, "R"),
                        make_box(0x2ecc71, 50.0, "G"),
                        make_box(0x3498db, 50.0, "B"),
                        make_box(0xf39c12, 50.0, "Y"),
                        make_box(0x9b59b6, 50.0, "P"),
                    ],
                ),
                // Borders
                make_text(
                    "Borders & Radius",
                    ElementStyle { color: Some(0xcccccc), font_size: Some(15.0), ..Default::default() },
                ),
                make_div(
                    ElementStyle { flex_direction: Some("row".to_string()), gap: Some(12.0), ..Default::default() },
                    vec![
                        make_div(ElementStyle { width: Some(50.0), height: Some(50.0),
                            background_color: Some(0x34495e), border_radius: Some(8.0), ..Default::default() }, vec![]),
                        make_div(ElementStyle { width: Some(50.0), height: Some(50.0),
                            background_color: Some(0xe67e22), border_radius: Some(25.0), ..Default::default() }, vec![]),
                        make_div(ElementStyle { width: Some(50.0), height: Some(50.0),
                            background_color: Some(0x1abc9c), border_width: Some(3.0),
                            border_color: Some(0xffffff), border_radius: Some(4.0), ..Default::default() }, vec![]),
                    ],
                ),
                // Swatches
                make_text(
                    "Color Swatches",
                    ElementStyle { color: Some(0xcccccc), font_size: Some(15.0), ..Default::default() },
                ),
                make_div(
                    ElementStyle {
                        flex_direction: Some("row".to_string()), gap: Some(6.0), padding: Some(8.0),
                        background_color: Some(0x0f3460), border_radius: Some(8.0), ..Default::default()
                    },
                    [(0xe74c3c,"1"),(0x2ecc71,"2"),(0x3498db,"3"),(0xf39c12,"4"),(0x9b59b6,"5"),
                     (0x1abc9c,"6"),(0xe67e22,"7"),(0x00d9ff,"8")]
                        .iter().map(|(c,l)| make_box(*c, 40.0, l)).collect(),
                ),
                // Text samples
                make_text(
                    "Text Sizes",
                    ElementStyle { color: Some(0xcccccc), font_size: Some(15.0), ..Default::default() },
                ),
                make_text("Small (12px)", ElementStyle { color: Some(0xaaaaaa), font_size: Some(12.0), ..Default::default() }),
                make_text("Large Gold (24px)", ElementStyle { color: Some(0xf1c40f), font_size: Some(24.0), ..Default::default() }),
                make_text("Cyan", ElementStyle { color: Some(0x00d9ff), font_size: Some(18.0), ..Default::default() }),
                make_text("Natural scroll ✓", ElementStyle { color: Some(0x666666), font_size: Some(12.0), ..Default::default() }),
                // Footer
                make_div(
                    ElementStyle { padding: Some(8.0), ..Default::default() },
                    vec![make_text(
                        "~ react-native-gpui v0.1 ~",
                        ElementStyle { color: Some(0x555555), font_size: Some(11.0),
                            text_align: Some("center".to_string()), ..Default::default() },
                    )],
                ),
            ],
        )
    }
}

impl Render for DemoApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        // Scroll physics: momentum + rubber-band overscroll bounce
        if self.scroll_animating {
            let now = Instant::now();
            let dt = self.scroll_last_time.map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(0.0).min(0.05);
            self.scroll_last_time = Some(now);

            if dt > 0.0 {
                let in_bounds = self.scroll_y >= 0.0 && self.scroll_y <= self.max_scroll;

                if in_bounds {
                    // Kinetic friction while in bounds
                    self.scroll_y += self.scroll_velocity * dt;
                    self.scroll_velocity *= 0.92_f64.powf(dt * 60.0);
                    if self.scroll_velocity.abs() < 1.0 {
                        self.scroll_velocity = 0.0;
                        self.scroll_y = self.scroll_y.max(0.0).min(self.max_scroll);
                        self.scroll_animating = false;
                    }
                }

                // Clamp after momentum
                if self.scroll_y < 0.0 || self.scroll_y > self.max_scroll {
                    // Overscroll spring: restore toward boundary with damping
                    let target = if self.scroll_y < 0.0 { 0.0 } else { self.max_scroll };
                    let diff = target - self.scroll_y;
                    self.scroll_velocity += diff * 12.0 * dt;    // spring stiffness
                    self.scroll_velocity *= 0.85_f64.powf(dt * 60.0); // damping
                    self.scroll_y += self.scroll_velocity * dt;

                    // Settle when close enough
                    if (self.scroll_y - target).abs() < 0.5 && self.scroll_velocity.abs() < 1.0 {
                        self.scroll_y = target;
                        self.scroll_velocity = 0.0;
                        self.scroll_animating = false;
                    }
                }
            }
        }
        if self.scroll_animating {
            cx.notify();
        }
        
        let tree = self.render_tree();
        let root = create_element(tree, 0, None);
        gpui::div()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, event: &gpui::MouseDownEvent, _window, cx| {
                let x: f64 = event.position.x.into();
                let y: f64 = event.position.y.into();
                this.last_gesture = format!("down ({:.0},{:.0})", x, y);
                this.tapped_color = 0x2ecc71;
                this.dragging = true;
                this.drag_origin_x = x;
                this.drag_origin_y = y;
                this.drag_start_x = this.drag_x;
                this.drag_start_y = this.drag_y;
                cx.notify();
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, event: &gpui::MouseUpEvent, _window, cx| {
                this.last_gesture = format!("tap ({:.0},{:.0})", Into::<f64>::into(event.position.x), Into::<f64>::into(event.position.y));
                this.tapped_color = 0x4ed93b;
                this.dragging = false;
                this.drag_x = 0.0;
                this.drag_y = 0.0;
                cx.notify();
            }))
            .on_mouse_move(cx.listener(|this, event: &gpui::MouseMoveEvent, _window, cx| {
                if !this.dragging { return; }
                let x: f64 = event.position.x.into();
                let y: f64 = event.position.y.into();
                this.drag_x = this.drag_start_x + (x - this.drag_origin_x) * 0.5;
                this.drag_y = this.drag_start_y + (y - this.drag_origin_y) * 0.5;
                this.last_gesture = format!("drag ({:.0},{:.0})", x, y);
                cx.notify();
            }))
            .on_scroll_wheel(cx.listener(|this, event: &gpui::ScrollWheelEvent, _window, cx| {
                let (dx, dy_pixels): (f64, f64) = match &event.delta {
                    gpui::ScrollDelta::Lines(p) => (p.x as f64, p.y as f64 * 30.0),
                    gpui::ScrollDelta::Pixels(p) => {
                        let px: f64 = p.x.into();
                        let py: f64 = p.y.into();
                        (px, py)
                    }
                };
                // Natural scroll: fingers down (dy_pixels < 0) → content goes up
                // Track velocity for momentum (exponential moving average, 0.4 blend)
                this.scroll_velocity = this.scroll_velocity * 0.6 + (-dy_pixels) * 0.4 * 60.0;
                this.scroll_y = (this.scroll_y - dy_pixels).max(0.0).min(this.max_scroll);
                this.scroll_animating = true;
                this.scroll_last_time = Some(Instant::now());
                this.last_gesture = format!("scroll {:.0},{:.0}", dy_pixels, dx);
                cx.notify();
            }))
            .child(root)
    }
}

fn quit(_: &Quit, cx: &mut App) {
    cx.quit();
}

fn main() {
    let app = gpui::Application::new();
    app.run(move |cx: &mut App| {
        // Focus the app and show the menu bar (required for cmd+Q and initial focus)
        cx.activate(true);
        cx.on_action(quit);
        cx.set_menus(vec![Menu {
            name: "react-native-gpui".into(),
            items: vec![MenuItem::action("Quit", Quit)],
        }]);

        let max_scroll = 400.0;
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(720.0), px(1050.0)),
                cx,
            ))),
            titlebar: Some(gpui::TitlebarOptions::default()),
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
        cx.open_window(options, |window, cx| {
            // Activate the window and give it keyboard focus
            cx.activate(false);
            window.focus(&cx.focus_handle());
            cx.new(|_| DemoApp {
                tapped_color: 0,
                long_press_active: false,
                drag_x: 0.0,
                drag_y: 0.0,
                dragging: false,
                drag_origin_x: 0.0,
                drag_origin_y: 0.0,
                drag_start_x: 0.0,
                drag_start_y: 0.0,
                scroll_y: 0.0,
                max_scroll,
                scroll_velocity: 0.0,
                scroll_animating: false,
                scroll_last_time: None,
                last_gesture: "ready — click, drag, scroll, cmd+q, resize".to_string(),
            })
        })
        .expect("open window");
    });
}
