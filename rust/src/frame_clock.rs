//! Vsync frame clock: drives JS `requestAnimationFrame` off the display's real
//! CVDisplayLink instead of a free-running 16ms timer.
//!
//! Before this, `raf.ts` shimmed rAF as `setTimeout(16)` riding the JS thread's
//! timer loop — a ~60Hz free-running clock beating against the display-linked
//! render thread: capped below ProMotion rates, jittered, and up to a frame of
//! added latency on every animation tick. Now JS arms the clock with
//! `__rngpui_requestFrame` whenever rAF callbacks are pending, and the display
//! link posts ONE `__rngpui_fireFrame` call into the owning runtime's JsCall
//! queue per display refresh while armed. At most one fire is in flight per
//! runtime by construction: the clock only fires when armed, and JS only re-arms
//! after the previous fire ran its callbacks.
//!
//! Multiple runtimes share the one process-wide link (the React runtime today,
//! the reanimated worklet/UI runtime as a second consumer): each registers a
//! sink once at thread start and requests ticks independently via its bit in
//! `PENDING`. The link auto-stops after a few idle ticks (nothing armed) and
//! restarts on the next request, so an idle app holds zero display-link wakeups.
//!
//! Headless fallback: if CoreVideo can't create a link for the main display
//! (ssh session, no display), the same clock runs off a 120Hz timer thread —
//! consumers see the identical interface either way.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Runtime ids (bits in `PENDING`).
pub const REACT: u8 = 0;
pub const UI: u8 = 1;

/// Consecutive idle display ticks before the link stops itself.
const IDLE_TICKS_BEFORE_STOP: u32 = 3;

type FireSink = Arc<dyn Fn() + Send + Sync>;

static SINKS: OnceLock<Mutex<HashMap<u8, FireSink>>> = OnceLock::new();
/// Bitmask of runtime ids that want the next display tick.
static PENDING: AtomicU32 = AtomicU32::new(0);
static IDLE_TICKS: AtomicU32 = AtomicU32::new(0);
static CLOCK: Mutex<Option<Clock>> = Mutex::new(None);

fn sinks() -> &'static Mutex<HashMap<u8, FireSink>> {
    SINKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register the fire-sink for a runtime (call once from that runtime's thread
/// startup). The sink must be cheap + thread-safe: it runs on the display-link
/// thread and should only post into the runtime's call queue.
pub fn register(runtime: u8, fire: FireSink) {
    sinks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(runtime, fire);
}

/// Arm the clock: the given runtime gets one `fire` on the next display tick.
pub fn request(runtime: u8) {
    PENDING.fetch_or(1 << runtime, Ordering::AcqRel);
    ensure_running();
}

/// One display tick: fire every armed runtime's sink, or stop the link after a
/// few consecutive idle ticks. Runs on the CVDisplayLink (or fallback timer)
/// thread.
fn tick() {
    let pending = PENDING.swap(0, Ordering::AcqRel);
    if pending == 0 {
        if IDLE_TICKS.fetch_add(1, Ordering::AcqRel) + 1 >= IDLE_TICKS_BEFORE_STOP {
            stop();
        }
        return;
    }
    IDLE_TICKS.store(0, Ordering::Release);
    // Snapshot the armed sinks, then RELEASE the lock before invoking them. A sink must
    // never run while we hold SINKS: a panicking sink would poison the mutex and abort
    // every later register/tick/request, and a sink that re-entered `register` would
    // deadlock. Arc-clone the few armed sinks out, drop the guard, then fire.
    let to_fire: Vec<FireSink> = {
        let sinks = sinks().lock().unwrap_or_else(|e| e.into_inner());
        sinks
            .iter()
            .filter(|(runtime, _)| pending & (1 << **runtime) != 0)
            .map(|(_, fire)| Arc::clone(fire))
            .collect()
    };
    for fire in to_fire {
        fire();
    }
}

fn ensure_running() {
    let mut guard = CLOCK.lock().unwrap();
    let clock = guard.get_or_insert_with(Clock::new);
    clock.start();
}

fn stop() {
    if let Some(clock) = CLOCK.lock().unwrap().as_mut() {
        clock.stop();
    }
}

// ── CoreVideo CVDisplayLink FFI ──────────────────────────────────────────────
// CVDisplayLink is deprecated in macOS 15 in favor of per-NSView CADisplayLink,
// but it's display-scoped (fires regardless of window visibility — exactly what
// offscreen test windows need) and it's what the vendored gpui's own window
// pacing uses. The link is created once and never released (process lifetime).

#[allow(non_camel_case_types)]
type CVDisplayLinkRef = *mut c_void;

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVDisplayLinkCreateWithCGDisplay(display_id: u32, link_out: *mut CVDisplayLinkRef) -> i32;
    fn CVDisplayLinkSetOutputCallback(
        link: CVDisplayLinkRef,
        callback: extern "C" fn(
            CVDisplayLinkRef,
            *const c_void,
            *const c_void,
            u64,
            *mut u64,
            *mut c_void,
        ) -> i32,
        user_info: *mut c_void,
    ) -> i32;
    fn CVDisplayLinkStart(link: CVDisplayLinkRef) -> i32;
    fn CVDisplayLinkStop(link: CVDisplayLinkRef) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGMainDisplayID() -> u32;
}

extern "C" fn display_link_callback(
    _link: CVDisplayLinkRef,
    _now: *const c_void,
    _output_time: *const c_void,
    _flags_in: u64,
    _flags_out: *mut u64,
    _user_info: *mut c_void,
) -> i32 {
    tick();
    0
}

enum Clock {
    DisplayLink {
        link: SendPtr,
        running: bool,
    },
    /// No display available (headless): a 120Hz timer thread drives `tick()`.
    Timer {
        running: &'static std::sync::atomic::AtomicBool,
    },
}

struct SendPtr(CVDisplayLinkRef);
// CVDisplayLinkStart/Stop are documented thread-safe; the pointer is only used
// for those two calls under the CLOCK mutex.
unsafe impl Send for SendPtr {}

impl Clock {
    fn new() -> Clock {
        unsafe {
            let mut link: CVDisplayLinkRef = std::ptr::null_mut();
            let created = CVDisplayLinkCreateWithCGDisplay(CGMainDisplayID(), &mut link);
            if created == 0 && !link.is_null() {
                CVDisplayLinkSetOutputCallback(link, display_link_callback, std::ptr::null_mut());
                return Clock::DisplayLink {
                    link: SendPtr(link),
                    running: false,
                };
            }
            eprintln!(
                "[frame_clock] CVDisplayLink unavailable (CVReturn {created}); using 120Hz timer"
            );
            let running: &'static std::sync::atomic::AtomicBool =
                Box::leak(Box::new(std::sync::atomic::AtomicBool::new(false)));
            Clock::Timer { running }
        }
    }

    fn start(&mut self) {
        match self {
            Clock::DisplayLink { link, running } => {
                if !*running {
                    unsafe { CVDisplayLinkStart(link.0) };
                    *running = true;
                }
            }
            Clock::Timer { running } => {
                let running: &'static std::sync::atomic::AtomicBool = running;
                if !running.swap(true, Ordering::AcqRel) {
                    std::thread::Builder::new()
                        .name("frame-clock-timer".into())
                        .spawn(move || {
                            while running.load(Ordering::Acquire) {
                                tick();
                                std::thread::sleep(Duration::from_micros(8333));
                            }
                        })
                        .expect("spawn frame-clock timer thread");
                }
            }
        }
    }

    fn stop(&mut self) {
        match self {
            Clock::DisplayLink { link, running } => {
                if *running {
                    unsafe { CVDisplayLinkStop(link.0) };
                    *running = false;
                }
            }
            Clock::Timer { running } => {
                running.store(false, Ordering::Release);
            }
        }
    }
}
