//! Debug-only tracing of Metal drawables that reached the display.
//!
//! CPU draw completion does not prove that WindowServer presented a frame. The
//! macOS renderer attaches an `MTLDrawable` presented handler while this trace
//! is armed and records the drawable's Core Animation presentation timestamp.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const MAX_SAMPLES: usize = 10_000;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static CONTENT_ID: AtomicU64 = AtomicU64::new(0);
static SAMPLES: Mutex<Vec<PresentedFrame>> = Mutex::new(Vec::new());

/// One drawable confirmed as presented by Core Animation.
#[derive(Clone, Copy, Debug)]
pub struct PresentedFrame {
    /// Monotonic identifier assigned by the drawable's `CAMetalLayer`.
    pub drawable_id: u64,
    /// Core Animation host time in seconds when the drawable was displayed.
    pub presented_time: f64,
    /// Application paint generation contained in this drawable.
    pub content_id: u64,
}

/// Clear prior samples and begin tracing presented drawables.
pub fn start() {
    ACTIVE.store(false, Ordering::Release);
    SAMPLES.lock().unwrap_or_else(|error| error.into_inner()).clear();
    ACTIVE.store(true, Ordering::Release);
}

/// Whether the renderer should attach a presented handler to this drawable.
#[inline]
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Acquire)
}

/// Mark the application paint generation used by subsequent drawables.
pub fn mark_content(content_id: u64) {
    CONTENT_ID.store(content_id, Ordering::Release);
}

/// Return the latest application paint generation.
pub fn content_id() -> u64 {
    CONTENT_ID.load(Ordering::Acquire)
}

/// Record a drawable from its Metal presented handler.
pub fn record(drawable_id: u64, presented_time: f64, content_id: u64) {
    if !is_active() || !presented_time.is_finite() || presented_time <= 0.0 {
        return;
    }
    let mut samples = SAMPLES.lock().unwrap_or_else(|error| error.into_inner());
    if is_active() && samples.len() < MAX_SAMPLES {
        samples.push(PresentedFrame {
            drawable_id,
            presented_time,
            content_id,
        });
    }
}

/// Stop tracing and return the confirmed presentation samples.
pub fn stop() -> Vec<PresentedFrame> {
    ACTIVE.store(false, Ordering::Release);
    std::mem::take(&mut *SAMPLES.lock().unwrap_or_else(|error| error.into_inner()))
}
