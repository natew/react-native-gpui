use serde::Serialize;
use std::sync::Mutex;

/// A serializable event sent from Rust to JS via polling.
#[derive(Debug, Clone, Serialize)]
pub struct GpuiEvent {
    pub window_id: u64,
    pub element_id: u64,
    pub event_type: String,
    pub timestamp: u64,
    // Mouse
    pub client_x: Option<f64>,
    pub client_y: Option<f64>,
    pub offset_x: Option<f64>,
    pub offset_y: Option<f64>,
    pub button: Option<u32>,
    // Keyboard
    pub key: Option<String>,
    pub code: Option<String>,
    pub ctrl_key: Option<bool>,
    pub shift_key: Option<bool>,
    pub alt_key: Option<bool>,
    pub meta_key: Option<bool>,
    // Scroll
    pub delta_x: Option<f64>,
    pub delta_y: Option<f64>,
    pub delta_mode: Option<u32>,
    // Focus
    pub related_target: Option<u64>,
    // Input
    pub value: Option<String>,
    // Gesture
    #[serde(rename = "gestureType")]
    pub gesture_type: Option<String>,
    pub velocity_x: Option<f64>,
    pub velocity_y: Option<f64>,
    pub scale: Option<f64>,
    pub direction: Option<String>,
    pub number_of_touches: Option<u32>,
    // Phase: began, moved, ended, cancelled
    pub phase: Option<String>,
}

impl GpuiEvent {
    pub fn new(window_id: u64, event_type: &str) -> Self {
        Self {
            window_id,
            element_id: 0,
            event_type: event_type.to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            client_x: None,
            client_y: None,
            offset_x: None,
            offset_y: None,
            button: None,
            key: None,
            code: None,
            ctrl_key: None,
            shift_key: None,
            alt_key: None,
            meta_key: None,
            delta_x: None,
            delta_y: None,
            delta_mode: None,
            related_target: None,
            value: None,
            gesture_type: None,
            velocity_x: None,
            velocity_y: None,
            scale: None,
            direction: None,
            number_of_touches: None,
            phase: None,
        }
    }

    pub fn mouse(
        mut self,
        window_id: u64,
        element_id: u64,
        event_type: &str,
        x: f64,
        y: f64,
        button: u32,
    ) -> Self {
        self.window_id = window_id;
        self.element_id = element_id;
        self.event_type = event_type.to_string();
        self.client_x = Some(x);
        self.client_y = Some(y);
        self.offset_x = Some(x);
        self.offset_y = Some(y);
        self.button = Some(button);
        self
    }

    pub fn with_phase(mut self, phase: &str) -> Self {
        self.phase = Some(phase.to_string());
        self
    }
}

/// Global event queue.
pub type EventQueue = Mutex<Vec<GpuiEvent>>;
