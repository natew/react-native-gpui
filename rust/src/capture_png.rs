// Full-opacity PNG capture of the gpui window's rendered content, gated by
// `RNGPUI_CAPTURE_PNG=/path/to/out.png`. Entirely inert without that env var.
//
// Why this exists: the parity harness opens the window on-screen-but-invisible
// (NSWindow alphaValue ~0) so macOS still composites its Metal surface (a fully
// transparent / fully offscreen window is occlusion-culled and never draws).
// External capture tools read the *screen-composited* pixels, which the window
// alphaValue scales — so the chrome comes back near-transparent, useless for a
// pixel diff.
//
// We capture in-process instead. gpui renders through a CAMetalLayer whose
// presented frames live in a private CAImageQueue: CARenderer, -renderInContext:,
// and reading -[CAMetalLayer contents] as an IOSurface all return blank, because
// CoreAnimation only composites the Metal front buffer live in the WindowServer —
// the pixels are not in any CALayer-readable surface in-process. (Verified: see
// the git history of this file / the handoff notes.)
//
// The only source of the rendered chrome at FULL opacity is the WindowServer's
// composite of the window. CGWindowListCreateImage reads that composite for our
// own window without screen-recording TCC. It scales by the window alphaValue
// (out = chrome * alpha), so the raw grab is faint. We read the window's current
// alpha and divide it back out per-pixel to recover full-opacity chrome —
// deterministic and race-free, and the window's invisible state is never touched.
// (Momentarily bumping alpha to 1.0 doesn't work: the bump never reaches the
// asynchronous render server's composite within the synchronous frame the grab
// reads.) We encode the result to a PNG with a tiny hand-rolled writer (no dep).
//
// The center timeline is a sibling WKWebView, composited as a separate window, so
// it is not part of this window's surface and captures transparent — expected and
// fine for chrome parity.

use std::path::Path;

use cocoa::base::{id, nil};
use objc::{msg_send, sel, sel_impl};

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

// CGWindowListCreateImage is obsoleted in the macOS 15 SDK headers but the runtime
// symbol still exists in CoreGraphics; call it directly. It captures our own
// window's composite without screen-recording permission.
const CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
const CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
const CG_WINDOW_IMAGE_BEST_RESOLUTION: u32 = 1 << 5;
const CG_RECT_NULL: CGRect = CGRect {
    origin: CGPoint {
        x: f64::INFINITY,
        y: f64::INFINITY,
    },
    size: CGSize {
        width: 0.0,
        height: 0.0,
    },
};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCreateImage(
        screen_bounds: CGRect,
        list_option: u32,
        window_id: u32,
        image_option: u32,
    ) -> id;
    fn CGImageGetWidth(image: id) -> usize;
    fn CGImageGetHeight(image: id) -> usize;
    fn CGImageGetDataProvider(image: id) -> id;
    fn CGImageGetBytesPerRow(image: id) -> usize;
    fn CGImageGetBitsPerPixel(image: id) -> usize;
    fn CGImageGetAlphaInfo(image: id) -> u32;
    fn CGImageGetBitmapInfo(image: id) -> u32;
    fn CGDataProviderCopyData(provider: id) -> id;
    fn CGImageRelease(image: id);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataGetLength(data: id) -> isize;
    fn CFDataGetBytePtr(data: id) -> *const u8;
    fn CFRelease(cf: id);
}

/// Capture the gpui window's rendered content into `path` at full opacity.
/// `gpui_view` is the AppKit `ns_view` (the gpui Metal-backed view). Returns true
/// on a non-blank capture. Safe to call repeatedly; it overwrites the file.
pub fn capture_layer_to_png(gpui_view: id, path: &str) -> bool {
    if gpui_view == nil {
        return false;
    }
    unsafe { capture_inner(gpui_view, path) }
}

unsafe fn capture_inner(gpui_view: id, path: &str) -> bool {
    unsafe {
        let ns_window: id = msg_send![gpui_view, window];
        if ns_window == nil {
            debug("view has no window");
            return false;
        }
        let window_number: i64 = msg_send![ns_window, windowNumber];
        if window_number <= 0 {
            debug("window has no on-screen window number yet");
            return false;
        }

        // CGWindowListCreateImage reads the WindowServer composite of our window,
        // which is scaled by the window alphaValue: out = chrome * alpha. The window
        // runs at a tiny invisible alpha (so macOS keeps compositing its Metal
        // surface instead of occlusion-culling a fully-transparent window). Rather
        // than fight the asynchronous render server to momentarily bump alpha (the
        // bump never lands in the same synchronous frame the grab reads), we read the
        // *current* alpha and divide it back out — deterministic and race-free. The
        // window's visible state is never touched, so it stays fully invisible.
        let window_alpha: f64 = msg_send![ns_window, alphaValue];
        if window_alpha <= 0.0 {
            debug(
                "window alpha is 0 (occlusion-culled, nothing composited); set RNGPUI_CAPTURE_ALPHA",
            );
            return false;
        }

        let image: id = CGWindowListCreateImage(
            CG_RECT_NULL,
            CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW,
            window_number as u32,
            CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING | CG_WINDOW_IMAGE_BEST_RESOLUTION,
        );

        if image == nil {
            debug("CGWindowListCreateImage returned nil");
            return false;
        }

        let width = CGImageGetWidth(image);
        let height = CGImageGetHeight(image);
        let bytes_per_row = CGImageGetBytesPerRow(image);
        let bits_per_pixel = CGImageGetBitsPerPixel(image);
        if width == 0 || height == 0 || bits_per_pixel != 32 {
            debug(&format!(
                "unexpected captured image: {width}x{height} bpp={bits_per_pixel}"
            ));
            CGImageRelease(image);
            return false;
        }

        let provider = CGImageGetDataProvider(image);
        let data = if provider == nil {
            nil
        } else {
            CGDataProviderCopyData(provider)
        };
        if data == nil {
            debug("could not copy image data provider bytes");
            CGImageRelease(image);
            return false;
        }

        let len = CFDataGetLength(data) as usize;
        let ptr = CFDataGetBytePtr(data);
        if ptr.is_null() || len < bytes_per_row * height {
            debug("image data too small");
            CFRelease(data);
            CGImageRelease(image);
            return false;
        }
        let src = std::slice::from_raw_parts(ptr, len);

        // CGImage byte order for a window grab is typically BGRA (little-endian 32)
        // with premultiplied alpha. Decode channels, recover chrome at full opacity.
        let alpha_info = CGImageGetAlphaInfo(image);
        let bitmap_info = CGImageGetBitmapInfo(image);
        let order_little = (bitmap_info & 0x3000) == 0x2000; // kCGBitmapByteOrder32Little
        let premultiplied = alpha_info == 1 /* premulLast */ || alpha_info == 2 /* premulFirst */;
        let alpha_first = alpha_info == 2 /* premulFirst */ || alpha_info == 4 /* first */;

        let rgba = recover_chrome_rgba(
            src,
            width,
            height,
            bytes_per_row,
            order_little,
            alpha_first,
            premultiplied,
            window_alpha,
        );

        CFRelease(data);
        CGImageRelease(image);

        // chrome pixels should now be opaque; if everything is still ~transparent the
        // window composited nothing.
        let opaque_pixels = rgba.chunks_exact(4).filter(|p| p[3] > 200).count();
        if opaque_pixels == 0 {
            debug("recovered image has no opaque pixels (blank composite)");
        }
        let ok = write_rgba_png(path, &rgba, width as u32, height as u32);
        if ok {
            debug(&format!(
                "captured window {window_number} alpha={window_alpha:.4} -> {path} \
                 ({width}x{height}, {opaque_pixels} opaque px)"
            ));
        }
        ok && opaque_pixels > 0
    }
}

/// Recover the full-opacity chrome from a captured composite premultiplied by the
/// window alphaValue. The grab is `out = chrome_premul * window_alpha`:
///   • chrome alpha  = out_a / window_alpha                (clamped to 255)
///   • chrome rgb    = out_rgb / out_a * 255               (un-premultiply; the
///     window_alpha cancels since it scales both out_rgb and out_a)
/// The transparent timeline region (out_a ≈ 0) stays transparent.
#[allow(clippy::too_many_arguments)]
fn recover_chrome_rgba(
    src: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    order_little: bool,
    alpha_first: bool,
    premultiplied: bool,
    window_alpha: f64,
) -> Vec<u8> {
    let inv_window_alpha = 1.0 / window_alpha;
    let mut out = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row = &src[y * bytes_per_row..y * bytes_per_row + width * 4];
        for px in row.chunks_exact(4) {
            let (r, g, b, a) = decode_pixel(px, order_little, alpha_first);
            if a == 0 {
                // fully transparent (timeline underlay / outside chrome)
                out.extend_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            // un-premultiply rgb by the captured pixel alpha (recovers true color).
            let (cr, cg, cb) = if premultiplied {
                let unmul = |c: u8| ((c as u16 * 255 + (a as u16 / 2)) / a as u16).min(255) as u8;
                (unmul(r), unmul(g), unmul(b))
            } else {
                (r, g, b)
            };
            // recover chrome alpha by dividing out the window alphaValue.
            let ca = ((a as f64) * inv_window_alpha).round().clamp(0.0, 255.0) as u8;
            out.extend_from_slice(&[cr, cg, cb, ca]);
        }
    }
    out
}

#[inline]
fn decode_pixel(px: &[u8], order_little: bool, alpha_first: bool) -> (u8, u8, u8, u8) {
    // px is 4 bytes in memory. For 32Little BGRA-premul-first (the common window
    // grab format) the in-memory byte order is B,G,R,A. Cover the variants.
    let (b0, b1, b2, b3) = (px[0], px[1], px[2], px[3]);
    match (order_little, alpha_first) {
        // little-endian, alpha in high byte -> memory B,G,R,A
        (true, true) => (b2, b1, b0, b3),
        // little-endian, alpha in low byte -> memory A,B,G,R
        (true, false) => (b3, b2, b1, b0),
        // big-endian, alpha first -> memory A,R,G,B
        (false, true) => (b1, b2, b3, b0),
        // big-endian, alpha last -> memory R,G,B,A
        (false, false) => (b0, b1, b2, b3),
    }
}

fn debug(message: &str) {
    if std::env::var("RNGPUI_CAPTURE_DEBUG").is_ok() || std::env::var("RNGPUI_TEST_DEBUG").is_ok() {
        eprintln!("[rngpui capture] {message}");
    }
}

// --- PNG encoding (straight RGBA, zlib "stored" blocks; no compression dep) ---

/// Encode a straight-RGBA buffer (top-to-bottom, `width*4` stride) to an RGBA PNG.
fn write_rgba_png(path: &str, rgba: &[u8], width: u32, height: u32) -> bool {
    // PNG scanlines: filter-type byte (0 = none) + the RGBA row.
    let w = width as usize;
    let mut raw = Vec::with_capacity((w * 4 + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0u8);
        raw.extend_from_slice(&rgba[y * w * 4..(y + 1) * w * 4]);
    }

    let zlib = zlib_store(&raw);

    let mut png: Vec<u8> = Vec::with_capacity(zlib.len() + 64);
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // color type RGBA
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    write_chunk(&mut png, b"IHDR", &ihdr);
    write_chunk(&mut png, b"IDAT", &zlib);
    write_chunk(&mut png, b"IEND", &[]);

    match std::fs::write(Path::new(path), &png) {
        Ok(()) => true,
        Err(err) => {
            debug(&format!("png write failed: {err}"));
            false
        }
    }
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// zlib stream: DEFLATE "stored" (uncompressed) blocks + adler32. Larger files,
/// zero dependencies.
fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 65535 * 5 + 16);
    out.push(0x78); // CMF
    out.push(0x01); // FLG
    let mut idx = 0usize;
    let n = data.len();
    while idx < n {
        let chunk = (n - idx).min(0xffff);
        let is_last = idx + chunk >= n;
        out.push(if is_last { 1 } else { 0 });
        let len = chunk as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(&data[idx..idx + chunk]);
        idx += chunk;
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}
