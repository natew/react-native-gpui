//! native AppKit scroll input for GPUI-rendered scroll regions.
//!
//! each macOS scroll container gets a transparent `NSScrollView` child over the
//! GPUI Metal view. AppKit owns wheel routing, momentum, overlay scrollers, and
//! edge clamping. Its clip-view offset is sent back through GPUI as an absolute
//! native scroll event, while RNGPUI continues to paint the content itself.

use std::collections::HashSet;

use gpui::{Bounds, Pixels, Window};

#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
#[cfg(target_os = "macos")]
use objc::declare::ClassDecl;
#[cfg(target_os = "macos")]
use objc::runtime::{BOOL, Class, NO, Object, Sel, YES};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

#[cfg(target_os = "macos")]
use crate::elements::webview::{bounds_close, set_child_frame, webview_parent};

#[derive(Clone, Copy, Debug, Default)]
pub struct DriverStats {
    pub notification_count: u64,
    pub callback_count: u64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    last_callback_x: f64,
    last_callback_y: f64,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct Driver {
    scroll_view: id,
    document_view: id,
    clip_view: id,
    gpui_view: id,
    last_bounds: (f64, f64, f64, f64),
    last_content: (f64, f64),
    horizontal: Option<bool>,
    vertical: Option<bool>,
    scrollable: Option<bool>,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct PendingOffset {
    driver_id: u64,
    gpui_view: id,
    offset_x: f64,
    offset_y: f64,
}

#[cfg(target_os = "macos")]
thread_local! {
    static DRIVERS: RefCell<HashMap<u64, Driver>> = RefCell::new(HashMap::new());
    static CLIP_TARGETS: RefCell<HashMap<usize, (u64, id)>> = RefCell::new(HashMap::new());
    static APPLYING: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
    static STATS: RefCell<HashMap<u64, DriverStats>> = RefCell::new(HashMap::new());
    static PENDING: RefCell<HashMap<u64, PendingOffset>> = RefCell::new(HashMap::new());
    static EMIT_SCHEDULED: RefCell<bool> = const { RefCell::new(false) };
    static LAST_EMIT: RefCell<Option<Instant>> = const { RefCell::new(None) };
    static OBSERVER: RefCell<Option<id>> = RefCell::new(None);
    static ACTIVE_DRIVER: RefCell<Option<u64>> = const { RefCell::new(None) };
}

#[cfg(target_os = "macos")]
const NS_SCROLL_WHEEL_EVENT: u64 = 22;
#[cfg(target_os = "macos")]
const NS_SCROLLER_STYLE_OVERLAY: u64 = 1;
#[cfg(target_os = "macos")]
const FRAME_INTERVAL: Duration = Duration::from_nanos(8_333_333);

#[cfg(target_os = "macos")]
#[repr(C)]
struct DispatchQueue {
    _address: u8,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    static mut _dispatch_main_q: DispatchQueue;
    fn dispatch_time(when: u64, delta: i64) -> u64;
    fn dispatch_after_f(
        when: u64,
        queue: *mut DispatchQueue,
        context: *mut c_void,
        work: Option<unsafe extern "C" fn(*mut c_void)>,
    );
}

#[cfg(target_os = "macos")]
extern "C" fn document_is_flipped(_: &Object, _: Sel) -> BOOL {
    YES
}

#[cfg(target_os = "macos")]
extern "C" fn scroll_hit_test(this: &Object, _: Sel, point: NSPoint) -> id {
    unsafe {
        let hit: id = msg_send![super(this, class!(NSScrollView)), hitTest: point];
        if hit == nil {
            return nil;
        }
        let mut candidate = hit;
        while candidate != nil && candidate != this as *const Object as id {
            let is_scroller: BOOL = msg_send![candidate, isKindOfClass: class!(NSScroller)];
            if is_scroller == YES {
                return hit;
            }
            candidate = msg_send![candidate, superview];
        }
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let current: id = msg_send![app, currentEvent];
        if current != nil {
            let event_type: u64 = msg_send![current, type];
            if event_type == NS_SCROLL_WHEEL_EVENT {
                let gpui_view: id = msg_send![this, superview];
                let bounds: NSRect = msg_send![gpui_view, bounds];
                let flipped: BOOL = msg_send![gpui_view, isFlipped];
                let y = if flipped == YES {
                    point.y
                } else {
                    bounds.size.height - point.y
                };
                if crate::hit_passthrough::native_underlay_at(point.x, y) {
                    return nil;
                }
                return hit;
            }
        }
        nil
    }
}

#[cfg(target_os = "macos")]
extern "C" fn scroll_wheel(this: &Object, _: Sel, event: id) {
    unsafe {
        let clip: id = msg_send![this, contentView];
        let driver_id =
            CLIP_TARGETS.with(|targets| targets.borrow().get(&(clip as usize)).map(|(id, _)| *id));
        let Some(driver_id) = driver_id else { return };
        let phase: u64 = msg_send![event, phase];
        let momentum: u64 = msg_send![event, momentumPhase];
        let phased = phase != 0 || momentum != 0;
        if phased {
            if phase == 1 || phase == 32 {
                ACTIVE_DRIVER.with(|active| *active.borrow_mut() = Some(driver_id));
            }
            let active = ACTIVE_DRIVER.with(|active| *active.borrow());
            if let Some(owner) = active.filter(|owner| *owner != driver_id) {
                if let Some(view) =
                    DRIVERS.with(|drivers| drivers.borrow().get(&owner).map(|d| d.scroll_view))
                {
                    let _: () = msg_send![view, scrollWheel: event];
                    return;
                }
            }
            if momentum == 8 || momentum == 16 {
                ACTIVE_DRIVER.with(|active| *active.borrow_mut() = None);
            }
        }
        let _: () = msg_send![super(this, class!(NSScrollView)), scrollWheel: event];
    }
}

#[cfg(target_os = "macos")]
extern "C" fn clip_bounds_changed(_: &Object, _: Sel, notification: id) {
    unsafe {
        let clip_view: id = msg_send![notification, object];
        let Some((driver_id, gpui_view)) =
            CLIP_TARGETS.with(|targets| targets.borrow().get(&(clip_view as usize)).copied())
        else {
            return;
        };
        if APPLYING.with(|applying| applying.borrow().contains(&driver_id)) {
            return;
        }
        let bounds: NSRect = msg_send![clip_view, bounds];
        STATS.with(|stats| {
            let mut stats = stats.borrow_mut();
            let entry = stats.entry(driver_id).or_default();
            entry.notification_count += 1;
            entry.offset_x = bounds.origin.x;
            entry.offset_y = bounds.origin.y;
        });
        PENDING.with(|pending| {
            pending.borrow_mut().insert(
                driver_id,
                PendingOffset {
                    driver_id,
                    gpui_view,
                    offset_x: bounds.origin.x,
                    offset_y: bounds.origin.y,
                },
            );
        });
        let should_schedule = EMIT_SCHEDULED.with(|scheduled| {
            let mut scheduled = scheduled.borrow_mut();
            if *scheduled {
                false
            } else {
                *scheduled = true;
                true
            }
        });
        if should_schedule {
            let delay = LAST_EMIT.with(|last| {
                last.borrow()
                    .map(|last| FRAME_INTERVAL.saturating_sub(last.elapsed()).as_secs_f64())
                    .unwrap_or(0.0)
            });
            let delay_ns = (delay * 1_000_000_000.0) as i64;
            let when = dispatch_time(0, delay_ns);
            dispatch_after_f(
                when,
                std::ptr::addr_of_mut!(_dispatch_main_q),
                std::ptr::null_mut(),
                Some(emit_scroll_offsets),
            );
        }
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn emit_scroll_offsets(_: *mut c_void) {
    EMIT_SCHEDULED.with(|scheduled| *scheduled.borrow_mut() = false);
    LAST_EMIT.with(|last| *last.borrow_mut() = Some(Instant::now()));
    let pending = PENDING.with(|pending| pending.borrow_mut().drain().collect::<Vec<_>>());
    for (_, pending) in pending {
        let (delta_x, delta_y, max_x, max_y, previous_x, previous_y) = STATS.with(|stats| {
            let mut stats = stats.borrow_mut();
            let entry = stats.entry(pending.driver_id).or_default();
            let previous = (entry.last_callback_x, entry.last_callback_y);
            let delta = (pending.offset_x - previous.0, pending.offset_y - previous.1);
            entry.last_callback_x = pending.offset_x;
            entry.last_callback_y = pending.offset_y;
            (
                delta.0,
                delta.1,
                entry.max_x,
                entry.max_y,
                previous.0,
                previous.1,
            )
        });
        STATS.with(|stats| {
            stats
                .borrow_mut()
                .entry(pending.driver_id)
                .or_default()
                .callback_count += 1;
        });
        unsafe {
            let _: () = msg_send![
                pending.gpui_view,
                rngpuiScrollDriverChanged: pending.driver_id
                offsetX: pending.offset_x
                offsetY: pending.offset_y
            ];
        }
    }
}

#[cfg(target_os = "macos")]
fn document_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| unsafe {
        let mut decl = ClassDecl::new("RNGPUIScrollDocumentView", class!(NSView))
            .expect("failed to declare RNGPUIScrollDocumentView");
        decl.add_method(
            sel!(isFlipped),
            document_is_flipped as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.register()
    })
}

#[cfg(target_os = "macos")]
fn scroll_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| unsafe {
        let mut decl = ClassDecl::new("RNGPUIScrollDriverView", class!(NSScrollView))
            .expect("failed to declare RNGPUIScrollDriverView");
        decl.add_method(
            sel!(hitTest:),
            scroll_hit_test as extern "C" fn(&Object, Sel, NSPoint) -> id,
        );
        decl.add_method(
            sel!(scrollWheel:),
            scroll_wheel as extern "C" fn(&Object, Sel, id),
        );
        decl.register()
    })
}

#[cfg(target_os = "macos")]
fn observer_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| unsafe {
        let mut decl = ClassDecl::new("RNGPUIScrollObserver", class!(NSObject))
            .expect("failed to declare RNGPUIScrollObserver");
        decl.add_method(
            sel!(rngpuiScrollBoundsChanged:),
            clip_bounds_changed as extern "C" fn(&Object, Sel, id),
        );
        decl.register()
    })
}

#[cfg(target_os = "macos")]
fn observer() -> id {
    OBSERVER.with(|observer| {
        let mut observer = observer.borrow_mut();
        if let Some(existing) = *observer {
            return existing;
        }
        let created: id = unsafe { msg_send![observer_class(), new] };
        *observer = Some(created);
        created
    })
}

#[cfg(target_os = "macos")]
unsafe fn notification_name() -> id {
    let name = NSString::alloc(nil).init_str("NSViewBoundsDidChangeNotification");
    let _: id = msg_send![name, autorelease];
    name
}

#[cfg(target_os = "macos")]
unsafe fn create_driver(driver_id: u64, gpui_view: id) -> Driver {
    let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0));
    let scroll_view: id = msg_send![scroll_class(), alloc];
    let scroll_view: id = msg_send![scroll_view, initWithFrame: zero];
    let _: () = msg_send![scroll_view, setDrawsBackground: NO];
    let _: () = msg_send![scroll_view, setAutohidesScrollers: YES];
    let _: () = msg_send![scroll_view, setScrollerStyle: NS_SCROLLER_STYLE_OVERLAY];
    let _: () = msg_send![scroll_view, setAutomaticallyAdjustsContentInsets: NO];

    let document_view: id = msg_send![document_class(), alloc];
    let document_view: id = msg_send![document_view, initWithFrame: zero];
    let _: () = msg_send![scroll_view, setDocumentView: document_view];
    let _: () = msg_send![document_view, release];

    let clip_view: id = msg_send![scroll_view, contentView];
    let _: () = msg_send![clip_view, setPostsBoundsChangedNotifications: YES];
    CLIP_TARGETS.with(|targets| {
        targets
            .borrow_mut()
            .insert(clip_view as usize, (driver_id, gpui_view));
    });
    let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
    let _: () = msg_send![
        center,
        addObserver: observer()
        selector: sel!(rngpuiScrollBoundsChanged:)
        name: notification_name()
        object: clip_view
    ];
    let _: () = msg_send![gpui_view, addSubview: scroll_view];

    Driver {
        scroll_view,
        document_view,
        clip_view,
        gpui_view,
        last_bounds: (f64::NAN, f64::NAN, f64::NAN, f64::NAN),
        last_content: (f64::NAN, f64::NAN),
        horizontal: None,
        vertical: None,
        scrollable: None,
    }
}

#[cfg(target_os = "macos")]
pub fn sync_driver(
    window: &mut Window,
    driver_id: u64,
    bounds: Bounds<Pixels>,
    content_width: f32,
    content_height: f32,
    offset_x: f32,
    offset_y: f32,
) {
    let Some((_, gpui_view)) = webview_parent(window) else {
        return;
    };
    let x: f64 = bounds.origin.x.into();
    let y: f64 = bounds.origin.y.into();
    let width: f64 = bounds.size.width.into();
    let height: f64 = bounds.size.height.into();
    let content_width = f64::from(content_width).max(width).max(1.0);
    let content_height = f64::from(content_height).max(height).max(1.0);
    let horizontal = content_width > width + 0.5;
    let vertical = content_height > height + 0.5;
    let scrollable = horizontal || vertical;

    DRIVERS.with(|drivers| {
        let mut drivers = drivers.borrow_mut();
        let driver = drivers
            .entry(driver_id)
            .or_insert_with(|| unsafe { create_driver(driver_id, gpui_view) });
        if driver.gpui_view != gpui_view {
            unsafe {
                let _: () = msg_send![driver.scroll_view, removeFromSuperview];
                let _: () = msg_send![gpui_view, addSubview: driver.scroll_view];
            }
            driver.gpui_view = gpui_view;
            CLIP_TARGETS.with(|targets| {
                targets
                    .borrow_mut()
                    .insert(driver.clip_view as usize, (driver_id, gpui_view));
            });
        }

        // prepaint walks an outer scroller before its nested scrollers. keep that
        // order in AppKit's child stack so the deepest painted driver receives the
        // wheel when regions overlap, regardless of creation order.
        unsafe {
            let subviews: id = msg_send![gpui_view, subviews];
            let count: usize = msg_send![subviews, count];
            let topmost: id = if count > 0 {
                msg_send![subviews, objectAtIndex: count - 1]
            } else {
                nil
            };
            if topmost != driver.scroll_view {
                let _: () = msg_send![gpui_view, addSubview: driver.scroll_view];
            }
        }

        APPLYING.with(|applying| applying.borrow_mut().insert(driver_id));
        unsafe {
            let next_bounds = (x, y, width, height);
            if !bounds_close(driver.last_bounds, next_bounds) {
                set_child_frame(gpui_view, driver.scroll_view, x, y, width, height);
                driver.last_bounds = next_bounds;
            }
            let next_content = (content_width, content_height);
            if !bounds_close(
                (driver.last_content.0, driver.last_content.1, 0.0, 0.0),
                (next_content.0, next_content.1, 0.0, 0.0),
            ) {
                let size = NSSize::new(content_width, content_height);
                let _: () = msg_send![driver.document_view, setFrameSize: size];
                driver.last_content = next_content;
            }
            if driver.horizontal != Some(horizontal) {
                let value = if horizontal { YES } else { NO };
                let _: () = msg_send![driver.scroll_view, setHasHorizontalScroller: value];
                driver.horizontal = Some(horizontal);
            }
            if driver.vertical != Some(vertical) {
                let value = if vertical { YES } else { NO };
                let _: () = msg_send![driver.scroll_view, setHasVerticalScroller: value];
                driver.vertical = Some(vertical);
            }
            let clip_bounds: NSRect = msg_send![driver.clip_view, bounds];
            let target_x = f64::from(offset_x).clamp(0.0, (content_width - width).max(0.0));
            let target_y = f64::from(offset_y).clamp(0.0, (content_height - height).max(0.0));
            if (clip_bounds.origin.x - target_x).abs() > 0.01
                || (clip_bounds.origin.y - target_y).abs() > 0.01
            {
                let target = NSPoint::new(target_x, target_y);
                let _: () = msg_send![driver.clip_view, scrollToPoint: target];
                let _: () =
                    msg_send![driver.scroll_view, reflectScrolledClipView: driver.clip_view];
            }
            if driver.scrollable != Some(scrollable) {
                let hidden = if scrollable { NO } else { YES };
                let _: () = msg_send![driver.scroll_view, setHidden: hidden];
                driver.scrollable = Some(scrollable);
            }
        }
        APPLYING.with(|applying| applying.borrow_mut().remove(&driver_id));
        STATS.with(|stats| {
            let mut stats = stats.borrow_mut();
            let entry = stats.entry(driver_id).or_default();
            entry.offset_x = f64::from(offset_x);
            entry.offset_y = f64::from(offset_y);
            entry.max_x = (content_width - width).max(0.0);
            entry.max_y = (content_height - height).max(0.0);
            entry.last_callback_x = f64::from(offset_x);
            entry.last_callback_y = f64::from(offset_y);
        });
    });
}

#[cfg(not(target_os = "macos"))]
pub fn sync_driver(
    _window: &mut Window,
    _driver_id: u64,
    _bounds: Bounds<Pixels>,
    _content_width: f32,
    _content_height: f32,
    _offset_x: f32,
    _offset_y: f32,
) {
}

#[cfg(target_os = "macos")]
pub fn scroll_by(driver_id: u64, dx: f32, dy: f32) -> bool {
    DRIVERS.with(|drivers| {
        let drivers = drivers.borrow();
        let Some(driver) = drivers
            .get(&driver_id)
            .filter(|driver| driver.scrollable == Some(true))
        else {
            return false;
        };
        unsafe {
            let bounds: NSRect = msg_send![driver.clip_view, bounds];
            let document_frame: NSRect = msg_send![driver.document_view, frame];
            let max_x = (document_frame.size.width - bounds.size.width).max(0.0);
            let max_y = (document_frame.size.height - bounds.size.height).max(0.0);
            let next_x = (bounds.origin.x + f64::from(dx)).clamp(0.0, max_x);
            let next_y = (bounds.origin.y + f64::from(dy)).clamp(0.0, max_y);
            let target = NSPoint::new(next_x, next_y);
            let _: () = msg_send![driver.clip_view, scrollToPoint: target];
            let _: () = msg_send![driver.scroll_view, reflectScrolledClipView: driver.clip_view];
        }
        true
    })
}

#[cfg(not(target_os = "macos"))]
pub fn scroll_by(_driver_id: u64, _dx: f32, _dy: f32) -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn stats(driver_id: u64, reset: bool) -> Option<DriverStats> {
    if !DRIVERS.with(|drivers| drivers.borrow().contains_key(&driver_id)) {
        return None;
    }
    STATS.with(|stats| {
        let mut stats = stats.borrow_mut();
        let result = stats.get(&driver_id).copied().unwrap_or_default();
        if reset {
            let entry = stats.entry(driver_id).or_default();
            entry.notification_count = 0;
            entry.callback_count = 0;
            entry.last_callback_x = entry.offset_x;
            entry.last_callback_y = entry.offset_y;
        }
        Some(result)
    })
}

#[cfg(not(target_os = "macos"))]
pub fn stats(_driver_id: u64, _reset: bool) -> Option<DriverStats> {
    None
}

#[cfg(target_os = "macos")]
pub fn retain_drivers(present: &HashSet<u64>) {
    DRIVERS.with(|drivers| {
        let mut drivers = drivers.borrow_mut();
        let stale = drivers
            .keys()
            .filter(|driver_id| !present.contains(driver_id))
            .copied()
            .collect::<Vec<_>>();
        for driver_id in stale {
            let Some(driver) = drivers.remove(&driver_id) else {
                continue;
            };
            unsafe {
                let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
                let _: () = msg_send![
                    center,
                    removeObserver: observer()
                    name: notification_name()
                    object: driver.clip_view
                ];
                let _: () = msg_send![driver.scroll_view, removeFromSuperview];
                let _: () = msg_send![driver.scroll_view, release];
            }
            CLIP_TARGETS.with(|targets| {
                targets.borrow_mut().remove(&(driver.clip_view as usize));
            });
            STATS.with(|stats| {
                stats.borrow_mut().remove(&driver_id);
            });
            PENDING.with(|pending| {
                pending.borrow_mut().remove(&driver_id);
            });
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn retain_drivers(_present: &HashSet<u64>) {}
