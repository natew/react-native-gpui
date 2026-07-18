//! Native hit-test passthrough for WebView underlays.
//!
//! WebViews composite *behind* gpui's Metal layer (`GPUIView`), so by default the
//! `GPUIView` sitting on top swallows every AppKit mouse event and the native
//! WKWebView never sees a click, drag, or wheel. That kills native text selection,
//! native scrollbar dragging, and native momentum scroll.
//!
//! We restore all of it by overriding `GPUIView`'s `hitTest:` to return `nil` for any
//! point whose *top-most painted element is a webview* — AppKit then falls through to
//! the WKWebView host sibling painted below `GPUIView`, and the page handles the event
//! natively. Where a gpui surface (the composer, command palette, menus) is painted
//! *over* the webview, that surface is the top-most element at the point, so `hitTest:`
//! returns the gpui view and gpui keeps handling it. Net: native webview interaction
//! *and* translucent gpui overlays floating over the live page.
//!
//! Each frame records two rect sets with paint order: webview rects (`record_webview`)
//! and occluder rects — anything with a visible background or pointer listeners
//! (`record_occluder`). `should_passthrough` picks the top-most (highest paint order)
//! rect under the point; passthrough happens only when that winner is a webview.

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::os::raw::c_char;
    use std::sync::Once;
    use std::sync::atomic::{AtomicBool, Ordering};

    use cocoa::base::{YES, id, nil};
    use cocoa::foundation::{NSPoint, NSRect};
    use objc::runtime::{BOOL, Class, Imp, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};

    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        order: u32,
        is_webview: bool,
    }

    impl Rect {
        fn contains(&self, x: f64, y: f64) -> bool {
            x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
        }
    }

    thread_local! {
        static FRAME: RefCell<Vec<Rect>> = RefCell::new(Vec::new());
        static ORDER: RefCell<u32> = RefCell::new(0);
    }

    /// While set, `hitTest:` never declines in favor of a webview — gpui owns every
    /// mouse event. The inspector turns this on while its hover overlay or popup menu
    /// is up, so option+click and menu clicks land in gpui even over a webview region
    /// (the overlay paints above the page but is invisible to AppKit hit-testing).
    static INPUT_GRAB: AtomicBool = AtomicBool::new(false);

    pub fn set_input_grab(grab: bool) {
        INPUT_GRAB.store(grab, Ordering::Relaxed);
    }

    /// Clear the per-frame rect registry and (once) install the `hitTest:` override.
    /// Called at the top of the service render pass.
    pub fn begin_frame() {
        install();
        FRAME.with(|f| f.borrow_mut().clear());
        ORDER.with(|o| *o.borrow_mut() = 0);
    }

    fn next_order() -> u32 {
        ORDER.with(|o| {
            let mut o = o.borrow_mut();
            *o += 1;
            *o
        })
    }

    fn record(x: f64, y: f64, w: f64, h: f64, is_webview: bool) {
        if !(w > 0.0 && h > 0.0) {
            return;
        }
        let order = next_order();
        FRAME.with(|f| {
            f.borrow_mut().push(Rect {
                x,
                y,
                w,
                h,
                order,
                is_webview,
            });
        });
    }

    pub fn record_webview(x: f64, y: f64, w: f64, h: f64) {
        record(x, y, w, h, true);
    }

    /// A native AppKit control (`NSButton`/`NSTextField`) underlay. Same passthrough
    /// semantics as a webview rect: the control sits below the Metal layer, so the real
    /// click/keystroke must fall through to it (unless a gpui surface paints on top).
    pub fn record_native_control(x: f64, y: f64, w: f64, h: f64) {
        record(x, y, w, h, true);
    }

    pub fn record_occluder(x: f64, y: f64, w: f64, h: f64) {
        record(x, y, w, h, false);
    }

    fn should_passthrough(x: f64, y: f64) -> bool {
        FRAME.with(|f| {
            let mut best_order: i64 = -1;
            let mut best_is_webview = false;
            for r in f.borrow().iter() {
                if r.contains(x, y) && (r.order as i64) > best_order {
                    best_order = r.order as i64;
                    best_is_webview = r.is_webview;
                }
            }
            best_is_webview
        })
    }

    pub fn native_underlay_at(x: f64, y: f64) -> bool {
        should_passthrough(x, y)
    }

    extern "C" fn hit_test(this: &Object, _sel: Sel, point: NSPoint) -> id {
        unsafe {
            // `point` arrives in the receiver's *superview* coordinate system.
            let frame: NSRect = msg_send![this, frame];
            let inside = point.x >= frame.origin.x
                && point.x <= frame.origin.x + frame.size.width
                && point.y >= frame.origin.y
                && point.y <= frame.origin.y + frame.size.height;
            if !inside {
                return nil;
            }
            let hidden: BOOL = msg_send![this, isHidden];
            if hidden == YES {
                return nil;
            }

            // inspector overlay/menu is up: gpui owns all input, no webview passthrough.
            if INPUT_GRAB.load(Ordering::Relaxed) {
                return this as *const Object as id;
            }

            // native scroll drivers are real GPUIView children. let NSView run the
            // ordinary child hit test first: the transparent driver returns a hit only
            // for wheel events and its overlay scrollers, while clicks elsewhere still
            // resolve to GPUIView below.
            let native_hit: id = msg_send![super(this, class!(NSView)), hitTest: point];
            if native_hit != nil && native_hit != this as *const Object as id {
                return native_hit;
            }

            let superview: id = msg_send![this, superview];
            let local: NSPoint = if superview != nil {
                msg_send![this, convertPoint: point fromView: superview]
            } else {
                point
            };
            let bounds: NSRect = msg_send![this, bounds];
            let flipped: BOOL = msg_send![this, isFlipped];
            let gx = local.x;
            // gpui layout is top-left origin; AppKit views are bottom-left unless flipped.
            let gy = if flipped == YES {
                local.y
            } else {
                bounds.size.height - local.y
            };

            if should_passthrough(gx, gy) {
                // decline so AppKit routes the event to the WKWebView host sibling below.
                return nil;
            }

            // an in-bounds non-passthrough point resolves to the Metal view itself.
            this as *const Object as id
        }
    }

    /// Add `hitTest:` to the `GPUIView` class. gpui doesn't define it, so this overrides
    /// the inherited `NSView` implementation. Idempotent.
    fn install() {
        static INSTALL: Once = Once::new();
        INSTALL.call_once(|| unsafe {
            let Some(class) = Class::get("GPUIView") else {
                return;
            };
            let imp: Imp =
                std::mem::transmute(hit_test as extern "C" fn(&Object, Sel, NSPoint) -> id);
            // type encoding: returns id (@), self (@), _cmd (:), NSPoint arg ({CGPoint=dd}).
            let types = b"@@:{CGPoint=dd}\0";
            objc::runtime::class_addMethod(
                class as *const Class as *mut Class,
                sel!(hitTest:),
                imp,
                types.as_ptr() as *const c_char,
            );
        });
    }
}

#[cfg(target_os = "macos")]
pub use imp::{
    begin_frame, native_underlay_at, record_native_control, record_occluder, record_webview,
    set_input_grab,
};

#[cfg(not(target_os = "macos"))]
pub fn begin_frame() {}
#[cfg(not(target_os = "macos"))]
pub fn record_webview(_x: f64, _y: f64, _w: f64, _h: f64) {}
#[cfg(not(target_os = "macos"))]
pub fn record_native_control(_x: f64, _y: f64, _w: f64, _h: f64) {}
#[cfg(not(target_os = "macos"))]
pub fn record_occluder(_x: f64, _y: f64, _w: f64, _h: f64) {}
#[cfg(not(target_os = "macos"))]
pub fn set_input_grab(_grab: bool) {}
#[cfg(not(target_os = "macos"))]
pub fn native_underlay_at(_x: f64, _y: f64) -> bool {
    false
}
