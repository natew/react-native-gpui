//! Drag an opt-in `<Image>` out of the app onto Finder, Desktop, Slack, or a browser.
//!
//! gpui's `on_drag` is in-window only. macOS file drops for content that is not
//! already a local file use AppKit `NSFilePromiseProvider`: the drag starts
//! immediately, and the file is written on a background queue when dropped.
//! Test mode prepares that session and logs it, but does not call
//! `beginDraggingSessionWithItems` so a conformance run cannot steal the
//! cursor.

#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CStr;
use std::fs;
use std::io::Read;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use block::Block;
use cocoa::base::{id, nil};
use cocoa::foundation::{
    NSArray, NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString, NSUInteger,
};
use gpui::{
    Bounds, Hitbox, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
    Window,
};
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

const DRAG_THRESHOLD: f32 = 8.0;
const NS_DRAG_OPERATION_COPY: NSUInteger = 1;

struct Pending {
    start: Point<Pixels>,
    src: String,
    file_name: Option<String>,
    bounds: Bounds<Pixels>,
    started: bool,
}

struct PromiseOp {
    src: String,
    filename: String,
    uti: &'static str,
    bytes: Option<Vec<u8>>,
}

struct LiveDrag {
    provider: id,
    delegate: id,
    source: id,
    op_id: u64,
}

thread_local! {
    static PENDING: RefCell<Option<Pending>> = const { RefCell::new(None) };
    static LIVE: RefCell<Option<LiveDrag>> = const { RefCell::new(None) };
}

static NEXT_OP: AtomicU64 = AtomicU64::new(1);
static OPS: LazyLock<Mutex<HashMap<u64, PromiseOp>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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
        msg_send![
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
        ]
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
fn ns_str(value: &str) -> id {
    unsafe { NSString::alloc(nil).init_str(value) }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn ns_string_to_rust(value: id) -> String {
    if value == nil {
        return String::new();
    }
    let ptr: *const c_char = msg_send![value, UTF8String];
    if ptr.is_null() {
        String::new()
    } else {
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn ns_data(bytes: &[u8]) -> id {
    let data: id = msg_send![class!(NSData), alloc];
    msg_send![data, initWithBytes: bytes.as_ptr() length: bytes.len()]
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

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn call_error_block(completion: id, err: id) {
    if completion == nil {
        return;
    }
    (*(completion as *const Block<(id,), ()>)).call((err,));
}

fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(("png", "public.png"))
    } else if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        Some(("jpg", "public.jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("gif", "com.compuserve.gif"))
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(("webp", "org.webmproject.webp"))
    } else if bytes.starts_with(&[0x49, 0x49, 0x2A, 0x00])
        || bytes.starts_with(&[0x4D, 0x4D, 0x00, 0x2A])
    {
        Some(("tiff", "public.tiff"))
    } else if bytes.starts_with(b"BM") {
        Some(("bmp", "com.microsoft.bmp"))
    } else {
        None
    }
}

fn uti_from_content_type(content_type: &str) -> Option<(&'static str, &'static str)> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Some(("jpg", "public.jpeg")),
        "image/png" => Some(("png", "public.png")),
        "image/gif" => Some(("gif", "com.compuserve.gif")),
        "image/webp" => Some(("webp", "org.webmproject.webp")),
        "image/tiff" => Some(("tiff", "public.tiff")),
        "image/bmp" | "image/x-ms-bmp" => Some(("bmp", "com.microsoft.bmp")),
        "image/heic" => Some(("heic", "public.heic")),
        _ => None,
    }
}

fn ext_from_filename(name: &str) -> Option<(&'static str, &'static str)> {
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some(("jpg", "public.jpeg")),
        "png" => Some(("png", "public.png")),
        "gif" => Some(("gif", "com.compuserve.gif")),
        "webp" => Some(("webp", "org.webmproject.webp")),
        "tif" | "tiff" => Some(("tiff", "public.tiff")),
        "heic" => Some(("heic", "public.heic")),
        "bmp" => Some(("bmp", "com.microsoft.bmp")),
        _ => None,
    }
}

fn sanitize_filename(name: &str) -> String {
    let base = Path::new(name.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .replace(['/', '\\', '\0'], "");
    let cleaned = base.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "image".into()
    } else {
        cleaned.to_string()
    }
}

fn with_ext(name: &str, ext: &str) -> String {
    let path = Path::new(name);
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(existing) if existing.eq_ignore_ascii_case(ext) => name.to_string(),
        Some(_) => {
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("image");
            format!("{stem}.{ext}")
        }
        None => format!("{name}.{ext}"),
    }
}

fn decode_data_uri(src: &str) -> Option<(Vec<u8>, &'static str, &'static str)> {
    let (meta, data) = src.split_once(',')?;
    if !meta.starts_with("data:image/") {
        return None;
    }
    let from_meta = uti_from_content_type(meta.trim_start_matches("data:"));
    let bytes = if meta.contains(";base64") {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()?
    } else {
        data.as_bytes().to_vec()
    };
    let sniffed = sniff_image(&bytes);
    let (ext, uti) = sniffed.or(from_meta).unwrap_or(("png", "public.png"));
    Some((bytes, ext, uti))
}

fn local_path(src: &str) -> Option<PathBuf> {
    if let Some(rest) = src.strip_prefix("file://") {
        let decoded = url::Url::parse(src)
            .ok()
            .and_then(|url| url.to_file_path().ok());
        return decoded.or_else(|| Some(PathBuf::from(rest)));
    }
    let as_path = PathBuf::from(src);
    if as_path.is_absolute() {
        Some(as_path)
    } else {
        None
    }
}

fn fetch_bytes(url: &str) -> Option<Vec<u8>> {
    let response = ureq::get(url)
        .timeout(Duration::from_secs(15))
        .call()
        .ok()?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(32 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.is_empty() { None } else { Some(bytes) }
}

fn write_promised_file(op: &PromiseOp, dest: &Path) -> Result<(), String> {
    if let Some(bytes) = op.bytes.as_deref() {
        fs::write(dest, bytes).map_err(|err| err.to_string())?;
        return Ok(());
    }
    if let Some((bytes, _, _)) = decode_data_uri(&op.src) {
        fs::write(dest, bytes).map_err(|err| err.to_string())?;
        return Ok(());
    }
    if let Some(path) = local_path(&op.src) {
        if path.is_file() {
            fs::copy(&path, dest).map_err(|err| err.to_string())?;
            return Ok(());
        }
    }
    if op.src.starts_with("http://") || op.src.starts_with("https://") {
        let bytes = fetch_bytes(&op.src).ok_or_else(|| format!("failed to fetch {}", op.src))?;
        fs::write(dest, bytes).map_err(|err| err.to_string())?;
        return Ok(());
    }
    Err(format!("no file for {}", op.src))
}

fn promise_queue() -> id {
    static QUEUE: OnceLock<usize> = OnceLock::new();
    let ptr = *QUEUE.get_or_init(|| unsafe {
        let queue: id = msg_send![class!(NSOperationQueue), new];
        let _: () = msg_send![queue, setName: ns_str("rngpui.file-promise")];
        let _: () = msg_send![queue, setMaxConcurrentOperationCount: 1i64];
        queue as usize
    });
    ptr as id
}

extern "C" fn drag_source_mask(_this: &Object, _: Sel, _session: id, _context: i64) -> NSUInteger {
    NS_DRAG_OPERATION_COPY
}

extern "C" fn drag_ended(
    this: &Object,
    _: Sel,
    _session: id,
    _point: NSPoint,
    operation: NSUInteger,
) {
    LIVE.with(|live| {
        if let Some(old) = live.borrow_mut().take() {
            if operation == 0 {
                OPS.lock().unwrap().remove(&old.op_id);
            }
            unsafe {
                let _: () = msg_send![old.provider, release];
                let _: () = msg_send![old.delegate, release];
                if old.source != this as *const Object as id {
                    let _: () = msg_send![old.source, release];
                }
                let _: () = msg_send![this, release];
            }
        }
    });
}

fn drag_source_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut decl = ClassDecl::new("RNGPUIImageDragSource", class!(NSObject))
            .expect("RNGPUIImageDragSource");
        unsafe {
            decl.add_method(
                sel!(draggingSession:sourceOperationMaskForDraggingContext:),
                drag_source_mask as extern "C" fn(&Object, Sel, id, i64) -> NSUInteger,
            );
            decl.add_method(
                sel!(draggingSession:endedAtPoint:operation:),
                drag_ended as extern "C" fn(&Object, Sel, id, NSPoint, NSUInteger),
            );
        }
        decl.register()
    })
}

extern "C" fn promise_file_name(this: &Object, _: Sel, _provider: id, _file_type: id) -> id {
    let id = unsafe { *this.get_ivar::<u64>("opId") };
    let name = OPS
        .lock()
        .unwrap()
        .get(&id)
        .map(|op| op.filename.clone())
        .unwrap_or_else(|| "image.png".into());
    unsafe {
        let s = ns_str(&name);
        msg_send![s, autorelease]
    }
}

extern "C" fn promise_queue_for(_this: &Object, _: Sel, _provider: id) -> id {
    promise_queue()
}

extern "C" fn write_promise(this: &Object, _: Sel, _provider: id, url: id, completion: id) {
    let id = unsafe { *this.get_ivar::<u64>("opId") };
    let dest = unsafe {
        let path: id = msg_send![url, path];
        PathBuf::from(ns_string_to_rust(path))
    };
    let op = OPS.lock().unwrap().remove(&id);
    let result = match op.as_ref() {
        Some(op) => write_promised_file(op, &dest),
        None => Err("drag already finished".into()),
    };
    unsafe {
        if let Err(err) = result {
            log_trace(&format!("promise write failed: {err}"));
            let info: id = msg_send![class!(NSError), errorWithDomain: ns_str("rngpui") code: 1i64 userInfo: nil];
            call_error_block(completion, info);
        } else {
            log_trace(&format!("promise wrote {}", dest.display()));
            call_error_block(completion, nil);
        }
    }
}

fn promise_delegate_class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut decl = ClassDecl::new("RNGPUIFilePromiseDelegate", class!(NSObject))
            .expect("RNGPUIFilePromiseDelegate");
        unsafe {
            decl.add_ivar::<u64>("opId");
            decl.add_method(
                sel!(filePromiseProvider:fileNameForType:),
                promise_file_name as extern "C" fn(&Object, Sel, id, id) -> id,
            );
            decl.add_method(
                sel!(operationQueueForFilePromiseProvider:),
                promise_queue_for as extern "C" fn(&Object, Sel, id) -> id,
            );
            decl.add_method(
                sel!(filePromiseProvider:writePromiseToURL:completionHandler:),
                write_promise as extern "C" fn(&Object, Sel, id, id, id),
            );
        }
        decl.register()
    })
}

fn prepare_op(src: &str, file_name: Option<&str>) -> PromiseOp {
    let (bytes, ext, uti) = if let Some((bytes, ext, uti)) = decode_data_uri(src) {
        (Some(bytes), ext, uti)
    } else if let Some((ext, uti)) = file_name.and_then(ext_from_filename) {
        (None, ext, uti)
    } else {
        (None, "png", "public.png")
    };
    PromiseOp {
        src: src.to_string(),
        filename: with_ext(&sanitize_filename(file_name.unwrap_or("image")), ext),
        uti,
        bytes,
    }
}

fn fetch_label(src: &str, has_bytes: bool) -> &'static str {
    if has_bytes {
        "none"
    } else if src.starts_with("http://") || src.starts_with("https://") {
        "deferred"
    } else {
        "none"
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn begin_session(window: &mut Window, op: PromiseOp, bounds: Bounds<Pixels>) -> bool {
    let view = match ns_view(window) {
        Some(view) if view != nil => view,
        _ => {
            log_trace("abort: no NSView");
            return false;
        }
    };
    let pool = NSAutoreleasePool::new(nil);
    let fetch = fetch_label(&op.src, op.bytes.is_some());
    let byte_len = op.bytes.as_ref().map(Vec::len).unwrap_or(0);
    let type_list = format!("NSFilePromise,{}", op.uti);
    log_trace(&format!(
        "session=prepared filename={} uti={} types={} bytes={} fetch={}",
        op.filename, op.uti, type_list, byte_len, fetch
    ));
    let test_mode = std::env::var_os("RNGPUI_TEST_MODE").is_some();
    if test_mode {
        let _: () = msg_send![pool, drain];
        return true;
    }

    let op_id = NEXT_OP.fetch_add(1, Ordering::Relaxed);
    let filename = op.filename.clone();
    let uti = op.uti;
    let preview_bytes = op.bytes.clone();
    OPS.lock().unwrap().insert(op_id, op);

    let delegate: id = msg_send![promise_delegate_class(), new];
    (&mut *delegate).set_ivar("opId", op_id);
    let provider: id = msg_send![class!(NSFilePromiseProvider), alloc];
    let provider: id = msg_send![
        provider,
        initWithFileType: ns_str(uti)
        delegate: delegate
    ];
    if provider == nil {
        OPS.lock().unwrap().remove(&op_id);
        let _: () = msg_send![delegate, release];
        let _: () = msg_send![pool, drain];
        log_trace("abort: NSFilePromiseProvider failed");
        return false;
    }

    let drag_item: id = msg_send![class!(NSDraggingItem), alloc];
    let drag_item: id = msg_send![drag_item, initWithPasteboardWriter: provider];
    let preview = if let Some(bytes) = preview_bytes.as_deref() {
        let data = ns_data(bytes);
        let image: id = msg_send![class!(NSImage), alloc];
        let image: id = msg_send![image, initWithData: data];
        let _: () = msg_send![data, release];
        image
    } else {
        nil
    };
    let frame = dragging_frame(view, bounds);
    let _: () = msg_send![drag_item, setDraggingFrame: frame contents: preview];
    if preview != nil {
        let _: () = msg_send![preview, release];
    }
    let items = NSArray::arrayWithObject(nil, drag_item);
    let _: () = msg_send![drag_item, release];
    let source: id = msg_send![drag_source_class(), new];
    let event = current_event();
    let session: id = msg_send![
        view,
        beginDraggingSessionWithItems: items
        event: event
        source: source
    ];
    let started = session != nil;
    log_trace(&format!(
        "session={} filename={} types={} bytes={} fetch={}",
        if started { "started" } else { "failed" },
        filename,
        type_list,
        byte_len,
        fetch
    ));
    if started {
        LIVE.with(|live| {
            if let Some(old) = live.borrow_mut().replace(LiveDrag {
                provider,
                delegate,
                source,
                op_id,
            }) {
                OPS.lock().unwrap().remove(&old.op_id);
                let _: () = msg_send![old.provider, release];
                let _: () = msg_send![old.delegate, release];
                let _: () = msg_send![old.source, release];
            }
        });
    } else {
        OPS.lock().unwrap().remove(&op_id);
        let _: () = msg_send![provider, release];
        let _: () = msg_send![delegate, release];
        let _: () = msg_send![source, release];
    }
    let _: () = msg_send![pool, drain];
    started
}

fn start_drag(window: &mut Window, src: &str, file_name: Option<&str>, bounds: Bounds<Pixels>) {
    log_trace(&format!(
        "arm src={src} filename={}",
        file_name.unwrap_or("")
    ));
    let op = prepare_op(src, file_name);
    let started = unsafe { begin_session(window, op, bounds) };
    if started {
        crate::elements::finish_pointer_gesture();
    }
}

/// Wire OS-level image drag-out on an opt-in `<Image>` hitbox inserted in prepaint.
/// Clicks (no 8px move) still bubble so a wrapping `onPress` works.
pub fn wire_image_drag_out(
    src: &str,
    file_name: Option<&str>,
    bounds: Bounds<Pixels>,
    hitbox: &Hitbox,
    window: &mut Window,
) {
    if src.is_empty() {
        return;
    }
    let src = src.to_string();
    let file_name = file_name.map(str::to_string);
    window.on_mouse_event({
        let hitbox = hitbox.clone();
        let src = src.clone();
        let file_name = file_name.clone();
        move |event: &MouseDownEvent, phase, window, _cx| {
            if event.button != MouseButton::Left || !phase.bubble() || !hitbox.is_hovered(window) {
                return;
            }
            PENDING.with(|pending| {
                *pending.borrow_mut() = Some(Pending {
                    start: event.position,
                    src: src.clone(),
                    file_name: file_name.clone(),
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
                state.started = true;
                let src = state.src.clone();
                let file_name = state.file_name.clone();
                let bounds = state.bounds;
                drop(pending);
                start_drag(window, &src, file_name.as_deref(), bounds);
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

#[cfg(test)]
mod tests {
    use super::*;
    use block::ConcreteBlock;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    const JPEG: &[u8] = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00rngpui-promise-jpeg\xFF\xD9";

    fn serve_jpeg() -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                JPEG.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(JPEG);
        });
        (format!("http://{addr}/view"), handle)
    }

    #[test]
    fn file_promise_delegate_writes_http_jpeg() {
        let (src, server) = serve_jpeg();
        let dest =
            std::env::temp_dir().join(format!("rngpui-promise-test-{}.jpg", std::process::id()));
        let _ = fs::remove_file(&dest);

        let op_id = NEXT_OP.fetch_add(1, Ordering::Relaxed);
        OPS.lock().unwrap().insert(
            op_id,
            PromiseOp {
                src,
                filename: "vacation.jpg".into(),
                uti: "public.jpeg",
                bytes: None,
            },
        );

        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let delegate: id = msg_send![promise_delegate_class(), new];
            (&mut *delegate).set_ivar("opId", op_id);

            let name: id = msg_send![
                delegate,
                filePromiseProvider: nil
                fileNameForType: ns_str("public.jpeg")
            ];
            assert_eq!(ns_string_to_rust(name), "vacation.jpg");

            let ns_path = ns_str(&dest.to_string_lossy());
            let file_url: id = msg_send![class!(NSURL), fileURLWithPath: ns_path];
            let done = Arc::new(Mutex::new(None::<usize>));
            let done_c = done.clone();
            let handler = ConcreteBlock::new(move |err: id| {
                *done_c.lock().unwrap() = Some(err as usize);
            })
            .copy();

            let _: () = msg_send![
                delegate,
                filePromiseProvider: nil
                writePromiseToURL: file_url
                completionHandler: &*handler
            ];

            let err = done.lock().unwrap().expect("completion block did not run");
            assert_eq!(err, 0, "completion should be called with nil");
            let _: () = msg_send![delegate, release];
            let _: () = msg_send![pool, drain];
        }

        let written = fs::read(&dest).expect("promised file");
        assert_eq!(written.as_slice(), JPEG);
        let _ = fs::remove_file(&dest);
        let _ = server.join();
    }
}
