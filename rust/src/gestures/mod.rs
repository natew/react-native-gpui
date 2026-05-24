use std::collections::HashMap;
use std::time::Instant;

use crate::events::GpuiEvent;

/// Velocity tracked point for gesture recognition.
#[derive(Clone, Debug)]
struct Sample {
    x: f64,
    y: f64,
    time: Instant,
}

/// Tracks pointer movement for pan/swipe velocity calculation.
pub struct GestureTracker {
    samples: Vec<Sample>,
    start_x: f64,
    start_y: f64,
    start_time: Instant,
    last_x: f64,
    last_y: f64,
    is_active: bool,
    long_press_timer_start: Option<Instant>,
}

impl GestureTracker {
    pub fn new() -> Self {
        Self {
            samples: Vec::with_capacity(20),
            start_x: 0.0,
            start_y: 0.0,
            start_time: Instant::now(),
            last_x: 0.0,
            last_y: 0.0,
            is_active: false,
            long_press_timer_start: None,
        }
    }

    pub fn begin(&mut self, x: f64, y: f64) {
        let now = Instant::now();
        self.start_x = x;
        self.start_y = y;
        self.last_x = x;
        self.last_y = y;
        self.start_time = now;
        self.samples.clear();
        self.samples.push(Sample { x, y, time: now });
        self.is_active = true;
        self.long_press_timer_start = Some(now);
    }

    pub fn move_to(&mut self, x: f64, y: f64) {
        self.last_x = x;
        self.last_y = y;
        let now = Instant::now();
        self.samples.push(Sample { x, y, time: now });
        // Keep last 20 samples (~200ms at 100fps)
        while self.samples.len() > 20 {
            self.samples.remove(0);
        }
    }

    pub fn end(&mut self) {
        self.is_active = false;
        self.long_press_timer_start = None;
    }

    pub fn cancel(&mut self) {
        self.is_active = false;
        self.long_press_timer_start = None;
        self.samples.clear();
    }

    /// Calculate velocity from recent samples (pixels per second).
    pub fn velocity(&self) -> (f64, f64) {
        let len = self.samples.len();
        if len < 2 {
            return (0.0, 0.0);
        }

        let recent: &[Sample] = if len > 5 {
            &self.samples[len - 5..]
        } else {
            &self.samples
        };

        let first = &recent[0];
        let last = &recent[recent.len() - 1];
        let dt = last.time.duration_since(first.time).as_secs_f64();
        if dt < 0.001 {
            return (0.0, 0.0);
        }

        let dx = last.x - first.x;
        let dy = last.y - first.y;
        (dx / dt, dy / dt)
    }

    pub fn total_delta(&self) -> (f64, f64) {
        (self.last_x - self.start_x, self.last_y - self.start_y)
    }

    pub fn distance_from_start(&self) -> f64 {
        let (dx, dy) = self.total_delta();
        (dx * dx + dy * dy).sqrt()
    }

    pub fn elapsed(&self) -> f64 {
        self.start_time.elapsed().as_secs_f64()
    }

    pub fn long_press_elapsed(&self) -> Option<f64> {
        self.long_press_timer_start
            .map(|t| t.elapsed().as_secs_f64())
    }
}

/// Detect a swipe based on velocity and direction.
pub fn detect_swipe(vx: f64, vy: f64, threshold: f64) -> Option<String> {
    let speed = (vx * vx + vy * vy).sqrt();
    if speed < threshold {
        return None;
    }
    if vx.abs() > vy.abs() {
        if vx > 0.0 {
            Some("right".to_string())
        } else {
            Some("left".to_string())
        }
    } else {
        if vy > 0.0 {
            Some("down".to_string())
        } else {
            Some("up".to_string())
        }
    }
}

/// Per-window gesture state.
pub struct GestureState {
    trackers: HashMap<u64, GestureTracker>, // element_id -> tracker
    active_element: Option<u64>,
    click_count: u32,
    last_click_time: Instant,
}

impl GestureState {
    pub fn new() -> Self {
        Self {
            trackers: HashMap::new(),
            active_element: None,
            click_count: 0,
            last_click_time: Instant::now(),
        }
    }

    pub fn handle_mouse_down(
        &mut self,
        window_id: u64,
        element_id: u64,
        x: f64,
        y: f64,
        events: &mut Vec<GpuiEvent>,
    ) {
        let tracker = self
            .trackers
            .entry(element_id)
            .or_insert_with(GestureTracker::new);
        tracker.begin(x, y);
        self.active_element = Some(element_id);

        // Check double-tap
        let now = Instant::now();
        let dt = now.duration_since(self.last_click_time).as_secs_f64();
        self.last_click_time = now;
        if dt < 0.3 {
            self.click_count += 1;
        } else {
            self.click_count = 1;
        }

        events.push(
            GpuiEvent::new(window_id, "onTouchStart")
                .mouse(window_id, element_id, "onTouchStart", x, y, 0)
                .with_phase("began"),
        );
    }

    pub fn handle_mouse_move(
        &mut self,
        window_id: u64,
        element_id: u64,
        x: f64,
        y: f64,
        events: &mut Vec<GpuiEvent>,
    ) {
        if let Some(tracker) = self.trackers.get_mut(&element_id) {
            if tracker.is_active {
                tracker.move_to(x, y);
                let (dx, dy) = tracker.total_delta();
                let (vx, vy) = tracker.velocity();
                let _elapsed = tracker.elapsed();

                let mut evt = GpuiEvent::new(window_id, "onTouchMove")
                    .mouse(window_id, element_id, "onTouchMove", x, y, 0)
                    .with_phase("moved");
                evt.velocity_x = Some(vx);
                evt.velocity_y = Some(vy);
                evt.delta_x = Some(dx);
                evt.delta_y = Some(dy);
                events.push(evt);
            }
        }
    }

    pub fn handle_mouse_up(
        &mut self,
        window_id: u64,
        element_id: u64,
        x: f64,
        y: f64,
        events: &mut Vec<GpuiEvent>,
    ) {
        let is_long_press = self
            .trackers
            .get(&element_id)
            .map(|t| t.elapsed() > 0.5 && t.distance_from_start() < 10.0)
            .unwrap_or(false);

        let (vx, vy) = self
            .trackers
            .get(&element_id)
            .map(|t| t.velocity())
            .unwrap_or((0.0, 0.0));
        let dist = self
            .trackers
            .get(&element_id)
            .map(|t| t.distance_from_start())
            .unwrap_or(0.0);

        // Touch end
        events.push(
            GpuiEvent::new(window_id, "onTouchEnd")
                .mouse(window_id, element_id, "onTouchEnd", x, y, 0)
                .with_phase("ended"),
        );

        // Tap detection
        if dist < 10.0 {
            if is_long_press {
                let mut evt = GpuiEvent::new(window_id, "onLongPress").mouse(
                    window_id,
                    element_id,
                    "onLongPress",
                    x,
                    y,
                    0,
                );
                evt.phase = Some("ended".to_string());
                events.push(evt);
            } else {
                let mut evt = GpuiEvent::new(window_id, "onPress")
                    .mouse(window_id, element_id, "onPress", x, y, 0);
                evt.phase = Some("ended".to_string());
                events.push(evt);

                // Double tap
                if self.click_count >= 2 {
                    let mut evt = GpuiEvent::new(window_id, "onDoubleTap").mouse(
                        window_id,
                        element_id,
                        "onDoubleTap",
                        x,
                        y,
                        0,
                    );
                    evt.phase = Some("ended".to_string());
                    events.push(evt);
                    self.click_count = 0;
                }
            }
        }

        // Swipe detection
        if let Some(dir) = detect_swipe(vx, vy, 500.0) {
            let mut evt = GpuiEvent::new(window_id, "onSwipe")
                .mouse(window_id, element_id, "onSwipe", x, y, 0);
            evt.direction = Some(dir);
            evt.velocity_x = Some(vx);
            evt.velocity_y = Some(vy);
            evt.phase = Some("ended".to_string());
            events.push(evt);
        }

        // Pan end event if there was movement
        if dist > 5.0 {
            let mut evt = GpuiEvent::new(window_id, "onPanEnd")
                .mouse(window_id, element_id, "onPanEnd", x, y, 0);
            evt.velocity_x = Some(vx);
            evt.velocity_y = Some(vy);
            evt.phase = Some("ended".to_string());
            events.push(evt);
        }

        // Cleanup
        if let Some(tracker) = self.trackers.get_mut(&element_id) {
            tracker.end();
        }
        self.active_element = None;
    }

    pub fn handle_pinch(
        &mut self,
        window_id: u64,
        element_id: u64,
        scale: f64,
        phase: &str,
        events: &mut Vec<GpuiEvent>,
    ) {
        let mut evt = GpuiEvent::new(window_id, "onPinch");
        evt.element_id = element_id;
        evt.scale = Some(scale);
        evt.phase = Some(phase.to_string());
        evt.number_of_touches = Some(2);
        events.push(evt);
    }

    pub fn handle_hover_start(
        &mut self,
        window_id: u64,
        element_id: u64,
        x: f64,
        y: f64,
        events: &mut Vec<GpuiEvent>,
    ) {
        events.push(GpuiEvent::new(window_id, "onMouseEnter").mouse(
            window_id,
            element_id,
            "onMouseEnter",
            x,
            y,
            0,
        ));
    }

    pub fn handle_hover_end(
        &mut self,
        window_id: u64,
        element_id: u64,
        x: f64,
        y: f64,
        events: &mut Vec<GpuiEvent>,
    ) {
        events.push(GpuiEvent::new(window_id, "onMouseLeave").mouse(
            window_id,
            element_id,
            "onMouseLeave",
            x,
            y,
            0,
        ));
    }
}
