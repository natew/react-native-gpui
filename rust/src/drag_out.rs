//! Drag an `<Image>` out of the app onto Finder, Desktop, Slack, or a browser.
//!
//! gpui's `on_drag` is in-window only. macOS file drops need an AppKit
//! `NSDraggingSession` with a file URL (and image bytes when we have them).
//! Test mode prepares that session and logs it, but does not call
//! `beginDraggingSessionWithItems` so a conformance run cannot steal the
//! cursor.

#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use cocoa::appkit::{NSFilenamesPboardType, NSPasteboardTypePNG};
use cocoa::base::{id, nil};
use cocoa::foundation::{
    NSArray, NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString, NSUInteger,
};
use gpui::{
    Bounds, Hitbox, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
    Window,
};
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object};
use objc::{class, msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::sync::OnceLock;

const DRAG_THRESHOLD: f32 = 8.0;

struct Pending {
    start: Point<Pixels>,
    src: String,
    bounds: Bounds<Pixels>,
    started: bool,
}

thread_local! {
    static PENDING: RefCell<Option<Pending>> = const { RefCell::new(None) };
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn trace_enabled() -> bool {
    std::env::var_os("RNGPUI_DRAG_TRACE").is_some()
        || std::env::var_os("RNGPUI_TEST_MODE").is_some()
}

fn log_trace(message: &str) {
    if trace_enabled() {
        eprintln!("[drag-out] {message}");
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
fn ns_view(window: &mut Window) -> Option<id> {
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(handle) => Some(handle.ns_view.as_ptr() as id),
        _ => None,
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
fn current_event() -> id {
    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let event: id = msg_send![app, currentEvent];
        if event != nil {
            return event;
        }
        let event: id = msg_send![
            class!(NSEvent),
            mouseEventWithType: 1u64
            location: NSPoint { x: 0.0, y: 0.0 }
            modifierFlags: 0u64
            timestamp: 0.0
            windowNumber: 0i64
            context: nil
            eventNumber: 0i64
            clickCount: 1i64
            pressure: 1.0f32
        ];
        event
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
fn file_url_type() -> id {
    unsafe { NSString::alloc(nil).init_str("public.file-url") }
}

#[allow(unsafe_op_in_unsafe_fn)]
fn ns_str(value: &str) -> id {
    unsafe { NSString::alloc(nil).init_str(value) }
}

fn extension_for(src: &str) -> &'static str {
    let path = src.split('?').next().unwrap_or(src);
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "tif" | "tiff" => "tiff",
        "heic" => "heic",
        "bmp" => "bmp",
        _ => "png",
    }
}

fn temp_path(ext: &str) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("rngpui-drag-{seq}.{}", ext.trim_start_matches('.')))
}

fn decode_data_uri(src: &str) -> Option<(Vec<u8>, &'static str)> {
    let (meta, data) = src.split_once(',')?;
    if !meta.starts_with("data:image/") {
        return None;
    }
    let ext = if meta.contains("jpeg") || meta.contains("jpg") {
        "jpg"
    } else if meta.contains("gif") {
        "gif"
    } else if meta.contains("webp") {
        "webp"
    } else {
        "png"
    };
    let bytes = if meta.contains(";base64") {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()?
    } else {
        data.as_bytes().to_vec()
    };
    Some((bytes, ext))
}

fn fetch_bytes(url: &str) -> Option<Vec<u8>> {
    let response = ureq::get(url).timeout(Duration::from_secs(5)).call().ok()?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(32 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.is_empty() {
        None
    } else {
        Some(bytes)
    }
}

struct DragFile {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
    ephemeral: bool,
}

fn resolve_file(src: &str) -> Option<DragFile> {
    if let Some((bytes, ext)) = decode_data_uri(src) {
        let path = temp_path(ext);
        fs::write(&path, &bytes).ok()?;
        return Some(DragFile {
            path,
            bytes: Some(bytes),
            ephemeral: true,
        });
    }
    if let Some(path) = src.strip_prefix("file://") {
        let decoded = url::Url::parse(src)
            .ok()
            .and_then(|url| url.to_file_path().ok());
        let path = decoded.unwrap_or_else(|| PathBuf::from(path));
        if path.is_file() {
            let bytes = fs::read(&path).ok();
            return Some(DragFile {
                path,
                bytes,
                ephemeral: false,
            });
        }
    }
    let as_path = PathBuf::from(src);
    if as_path.is_file() {
        let bytes = fs::read(&as_path).ok();
        return Some(DragFile {
            path: as_path,
            bytes,
            ephemeral: false,
        });
    }
    if src.starts_with("http://") || src.starts_with("https://") {
        let bytes = fetch_bytes(src)?;
        let path = temp_path(extension_for(src));
        fs::write(&path, &bytes).ok()?;
        return Some(DragFile {
            path,
            bytes: Some(bytes),
            ephemeral: true,
        });
    }
    None
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn ns_data(bytes: &[u8]) -> id {
    let data: id = msg_send![class!(NSData), alloc];
    msg_send![data, initWithBytes: bytes.as_ptr() length: bytes.len()]
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn file_url_string(path: &str) -> id {
    let ns_path = ns_str(path);
    let url: id = msg_send![class!(NSURL), fileURLWithPath: ns_path];
    if url == nil {
        ns_str(&format!("file://{path}"))
    } else {
        msg_send![url, absoluteString]
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn dragging_frame(view: id, bounds: Bounds<Pixels>) -> NSRect {
    let width = f64::from(bounds.size.width).max(1.0);
    let height = f64::from(bounds.size.height).max(1.0);
    let x = f64::from(bounds.origin.x);
    let y = f64::from(bounds.origin.y);
    let flipped: bool = msg_send![view, isFlipped];
    let origin_y = if flipped {
        y
    } else {
        let view_bounds: NSRect = msg_send![view, bounds];
        view_bounds.size.height - y - height
    };
    NSRect {
        origin: NSPoint { x, y: origin_y },
        size: NSSize { width, height },
    }
}

extern "C" fn drag_source_mask(
    _this: &Object,
    _: objc::runtime::Sel,
    _session: id,
    _context: i64,
) -> NSUInteger {
    1
}

fn drag_source_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut decl = ClassDecl::new("RNGPUIImageDragSource", class!(NSObject))
            .expect("RNGPUIImageDragSource");
        unsafe {
            decl.add_method(
                sel!(draggingSession:sourceOperationMaskForDraggingContext:),
                drag_source_mask
                    as extern "C" fn(&Object, objc::runtime::Sel, id, i64) -> NSUInteger,
            );
        }
        decl.register()
    })
}

fn drag_source() -> id {
    thread_local! {
        static LAST: RefCell<id> = const { RefCell::new(nil) };
    }
    unsafe {
        let source: id = msg_send![drag_source_class(), new];
        LAST.with(|last| *last.borrow_mut() = source);
        source
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn begin_session(window: &mut Window, file: &DragFile, bounds: Bounds<Pixels>) -> bool {
    let view = match ns_view(window) {
        Some(view) if view != nil => view,
        _ => {
            log_trace("abort: no NSView");
            return false;
        }
    };
    let pool = NSAutoreleasePool::new(nil);
    let path = file.path.to_string_lossy();
    let pb_item: id = msg_send![class!(NSPasteboardItem), new];
    let _: cocoa::base::BOOL = msg_send![
        pb_item,
        setString: file_url_string(&path)
        forType: file_url_type()
    ];
    let names = NSArray::arrayWithObject(nil, ns_str(&path));
    let filenames_type = unsafe { NSFilenamesPboardType };
    let _: cocoa::base::BOOL = msg_send![
        pb_item,
        setPropertyList: names
        forType: filenames_type
    ];
    let mut types = vec!["public.file-url", "NSFilenamesPboardType"];
    if let Some(bytes) = file.bytes.as_deref().filter(|bytes| is_png(bytes)) {
        let data = ns_data(bytes);
        let png_type = unsafe { NSPasteboardTypePNG };
        let _: cocoa::base::BOOL = msg_send![pb_item, setData: data forType: png_type];
        types.push("public.png");
    }
    let drag_item: id = msg_send![class!(NSDraggingItem), alloc];
    let drag_item: id = msg_send![drag_item, initWithPasteboardWriter: pb_item];
    let frame = dragging_frame(view, bounds);
    let preview: id = {
        let image: id = msg_send![class!(NSImage), alloc];
        let image: id = msg_send![image, initWithContentsOfFile: ns_str(&path)];
        if image == nil {
            nil
        } else {
            image
        }
    };
    let _: () = msg_send![drag_item, setDraggingFrame: frame contents: preview];
    let items = NSArray::arrayWithObject(nil, drag_item);
    let event = current_event();
    let test_mode = std::env::var_os("RNGPUI_TEST_MODE").is_some();
    let type_list = types.join(",");
    if test_mode {
        log_trace(&format!(
            "session=prepared path={} types={} bytes={}",
            path,
            type_list,
            file.bytes.as_ref().map(Vec::len).unwrap_or(0)
        ));
        let _: () = msg_send![pool, drain];
        return true;
    }
    let source = drag_source();
    let session: id = msg_send![
        view,
        beginDraggingSessionWithItems: items
        event: event
        source: source
    ];
    let started = session != nil;
    log_trace(&format!(
        "session={} path={} types={} bytes={}",
        if started { "started" } else { "failed" },
        path,
        type_list,
        file.bytes.as_ref().map(Vec::len).unwrap_or(0)
    ));
    let _: () = msg_send![pool, drain];
    started
}

fn start_drag(window: &mut Window, src: &str, bounds: Bounds<Pixels>) {
    log_trace(&format!("arm src={src}"));
    let Some(file) = resolve_file(src) else {
        log_trace(&format!("abort: could not resolve {src}"));
        return;
    };
    let started = unsafe { begin_session(window, &file, bounds) };
    if started {
        crate::elements::finish_pointer_gesture();
    } else if file.ephemeral {
        let _ = fs::remove_file(&file.path);
    }
}

/// Wire OS-level image drag-out on an `<Image>` hitbox inserted in prepaint.
/// Clicks (no 8px move) still bubble so a wrapping `onPress` works.
pub fn wire_image_drag_out(
    src: &str,
    bounds: Bounds<Pixels>,
    hitbox: &Hitbox,
    window: &mut Window,
) {
    if src.is_empty() {
        return;
    }
    let src = src.to_string();
    window.on_mouse_event({
        let hitbox = hitbox.clone();
        let src = src.clone();
        move |event: &MouseDownEvent, phase, window, _cx| {
            if event.button != MouseButton::Left || !phase.bubble() || !hitbox.is_hovered(window) {
                return;
            }
            PENDING.with(|pending| {
                *pending.borrow_mut() = Some(Pending {
                    start: event.position,
                    src: src.clone(),
                    bounds,
                    started: false,
                });
            });
            log_trace(&format!(
                "down src={src} at {},{}",
                f32::from(event.position.x),
                f32::from(event.position.y)
            ));
        }
    });
    window.on_mouse_event({
        move |event: &MouseMoveEvent, phase, window, _cx| {
            if !phase.bubble() || event.pressed_button != Some(MouseButton::Left) {
                return;
            }
            PENDING.with(|pending| {
                let mut pending = pending.borrow_mut();
                let Some(state) = pending.as_mut() else {
                    return;
                };
                if state.started {
                    return;
                }
                let dx = f32::from(event.position.x - state.start.x);
                let dy = f32::from(event.position.y - state.start.y);
                if dx.hypot(dy) < DRAG_THRESHOLD {
                    return;
                }
                // start once the pointer has moved 8px from the down point, even if
                // it has already left the image. Finder does the same.
                state.started = true;
                let src = state.src.clone();
                let bounds = state.bounds;
                drop(pending);
                start_drag(window, &src, bounds);
            });
        }
    });
    window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, _cx| {
        if phase.bubble() && event.button == MouseButton::Left {
            PENDING.with(|pending| {
                *pending.borrow_mut() = None;
            });
        }
    });
}
