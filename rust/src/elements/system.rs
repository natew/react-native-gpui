//! `<SystemView>` — a native macOS surface parked directly BELOW gpui's Metal layer,
//! clipped to the element's rounded rect.
//!
//! It composites three things, each optional and independently driven by props:
//!   - **backdrop blur** (`material`): an `NSVisualEffectView` (or `NSGlassEffectView`
//!     clear variant on macOS 26+) with `blendingMode = BehindWindow`, so the
//!     compositor blurs the desktop/windows behind the (transparent) app window within
//!     just this rect — transparent window regions stay crisp while the card frosts.
//!     When `material` is omitted, NO effect view is created; the surface is a plain
//!     transparent layer that can still carry a tint and/or shadow.
//!   - **tint** (`tint`): a thin tinted overlay so foreground text stays legible.
//!   - **shadow** (`shadow`): a TRUE outer drop shadow drawn on a SEPARATE layer-backed
//!     decor view BELOW the surface, `masksToBounds = NO` so it spills past the frame.
//!     gpui's own box-shadow renders behind/under the element, so on a glass surface it
//!     bleeds through; this native shadow spills outward like a real card shadow. The
//!     corner-clip (needs `masksToBounds = YES`) and the shadow (needs `masksToBounds =
//!     NO`) therefore live on two different views — exactly the webview's two-layer split.
//!
//! Same gpui native-underlay overlay pattern `webview.rs` uses (the small AppKit
//! helpers — `webview_parent` / `set_child_frame` / `configure_transparent_view` /
//! `bounds_close` / `hsla_to_srgb` — are shared from there). The element paints nothing
//! visible; it only resizes its native views to the node's layout bounds every prepaint.

use std::sync::Arc;

use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior, IntoElement,
    LayoutId, Pixels, Window,
};

use crate::elements::{ReactElement, report_layout};

#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::collections::{HashMap, HashSet};

#[cfg(target_os = "macos")]
use crate::elements::webview::{
    bounds_close, configure_transparent_view, hsla_to_srgb, set_child_frame, webview_parent,
};
#[cfg(target_os = "macos")]
use crate::style::ElementStyle;

#[cfg(target_os = "macos")]
use cocoa::appkit::{
    NSViewHeightSizable, NSViewWidthSizable, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState,
};
#[cfg(target_os = "macos")]
use cocoa::base::{NO, YES, id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSPoint, NSRect, NSSize};
#[cfg(target_os = "macos")]
use objc::runtime::{Class, Object, Sel};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

#[cfg(target_os = "macos")]
#[allow(non_snake_case)]
unsafe extern "C" {
    // CoreGraphics: a rounded-rect CGPath for the shadow layer's `shadowPath`, so the
    // drop shadow is a crisp rounded-card silhouette independent of view content.
    fn CGPathCreateWithRoundedRect(
        rect: NSRect,
        corner_width: f64,
        corner_height: f64,
        transform: *const std::ffi::c_void,
    ) -> id;
    fn CGPathRelease(path: id);
}

// order a subview below a given sibling, or — with `relativeTo: nil` — at the very
// bottom of the parent's z-stack (NSWindowBelow).
#[cfg(target_os = "macos")]
const NS_WINDOW_BELOW: i64 = -1;

#[cfg(target_os = "macos")]
const CA_LAYER_MIN_X_MIN_Y_CORNER: u64 = 1 << 0;
#[cfg(target_os = "macos")]
const CA_LAYER_MAX_X_MIN_Y_CORNER: u64 = 1 << 1;
#[cfg(target_os = "macos")]
const CA_LAYER_MIN_X_MAX_Y_CORNER: u64 = 1 << 2;
#[cfg(target_os = "macos")]
const CA_LAYER_MAX_X_MAX_Y_CORNER: u64 = 1 << 3;

// Per-id native views + the geometry/style we last applied, so we can skip the
// per-frame setFrame churn (same discipline as the webview host — re-setting a
// layer-backed view's frame each frame kicks an implicit CoreAnimation pass and
// flickers). `SYSTEM_VIEWS` is the surface (effect view when a material is set, else a
// plain transparent NSView). `SYSTEM_SHADOW_VIEWS` is the decor view one level below it.
#[cfg(target_os = "macos")]
thread_local! {
    static SYSTEM_VIEWS: RefCell<HashMap<u64, id>> = RefCell::new(HashMap::new());
    static SYSTEM_TINT_VIEWS: RefCell<HashMap<u64, id>> = RefCell::new(HashMap::new());
    static SYSTEM_SHADOW_VIEWS: RefCell<HashMap<u64, id>> = RefCell::new(HashMap::new());
    static SYSTEM_LAST_BOUNDS: RefCell<HashMap<u64, (f64, f64, f64, f64)>> = RefCell::new(HashMap::new());
    static SYSTEM_LAST_STYLE: RefCell<HashMap<u64, SystemViewStyle>> = RefCell::new(HashMap::new());
    // last alphaValue we set on the surface + shadow views, so an RN opacity animation
    // (Animated, useNativeDriver:false) drives setAlphaValue: without per-frame churn.
    static SYSTEM_LAST_ALPHA: RefCell<HashMap<u64, f64>> = RefCell::new(HashMap::new());
    // last (width, height, shadow) the shadow decor was applied at, so a resize only
    // re-traces the size-dependent shadowPath and skips re-setting color/opacity/etc.
    static SYSTEM_LAST_SHADOW_APPLIED: RefCell<HashMap<u64, (f64, f64, SystemShadow)>> = RefCell::new(HashMap::new());
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct SystemViewStyle {
    // the resolved native surface kind: a glass view (macOS 26+), an NSVisualEffectView
    // material, or a plain transparent layer (tint/shadow only). See SystemSurface.
    surface: SystemSurface,
    corner_clip: SystemCornerClip,
    tint: Option<(f32, f32, f32, f32)>,
    shadow: Option<SystemShadow>,
    edge_fade: Option<f32>,
    top_fade_start: Option<f32>,
}

// The native surface kind to back this SystemView with, resolved from the `material` +
// `glassVariant` props. `Plain` → a transparent NSView (no blur), so a tint-only or
// shadow-only SystemView still has a layer to clip + host the tint.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SystemSurface {
    Plain,
    // NSVisualEffectView with this semantic material.
    Effect(NSVisualEffectMaterial),
    // NSGlassEffectView (macOS 26+) with this i64 variant; if the class is missing at
    // runtime we fall back to the `Effect` material carried alongside.
    Glass {
        variant: i64,
        fallback: NSVisualEffectMaterial,
    },
}

#[cfg(target_os = "macos")]
impl SystemSurface {
    // a stable discriminant identifying the AppKit class + key config, so we know when
    // a surface must be rebuilt (different class can't be reconfigured in place) vs.
    // merely re-tuned. Glass and Effect of the same value are distinct classes.
    fn kind_key(self) -> (u8, i64) {
        match self {
            SystemSurface::Plain => (0, 0),
            SystemSurface::Effect(m) => (1, m as i64),
            SystemSurface::Glass { variant, .. } => (2, variant),
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct SystemCornerClip {
    radius: f32,
    masked_corners: u64,
}

// One CALayer drop shadow derived from the `shadow` prop: an opaque srgb color + a
// separate opacity (the way CALayer wants them), a blur radius, a screen-space offset,
// and the rounded corner radius its `shadowPath` traces so the silhouette matches the
// card.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct SystemShadow {
    color: (f32, f32, f32),
    opacity: f32,
    radius: f32,
    offset_x: f32,
    offset_y: f32,
    corner_radius: f32,
}

// The default NSVisualEffectView material used when a `glassVariant` is requested but
// NSGlassEffectView isn't available (pre-macOS-26), or as the implicit material.
#[cfg(target_os = "macos")]
const DEFAULT_EFFECT_MATERIAL: NSVisualEffectMaterial = NSVisualEffectMaterial::HudWindow;

// Map a `material` prop string onto an NSVisualEffectView semantic material. Matches
// the names ~/chat's liquid-glass plugin / AppKit expose. Unknown non-empty names fall
// back to the HUD material rather than silently dropping the blur. `#[allow(deprecated)]`
// isn't needed — we only reference the non-deprecated semantic materials.
#[cfg(target_os = "macos")]
fn ns_visual_effect_material(name: &str) -> NSVisualEffectMaterial {
    match name {
        "titlebar" => NSVisualEffectMaterial::Titlebar,
        "selection" => NSVisualEffectMaterial::Selection,
        "menu" => NSVisualEffectMaterial::Menu,
        "popover" => NSVisualEffectMaterial::Popover,
        "sidebar" => NSVisualEffectMaterial::Sidebar,
        "headerView" => NSVisualEffectMaterial::HeaderView,
        "sheet" => NSVisualEffectMaterial::Sheet,
        "windowBackground" => NSVisualEffectMaterial::WindowBackground,
        "hudWindow" => NSVisualEffectMaterial::HudWindow,
        "fullScreenUI" => NSVisualEffectMaterial::FullScreenUI,
        "toolTip" => NSVisualEffectMaterial::Tooltip,
        "contentBackground" => NSVisualEffectMaterial::ContentBackground,
        "underWindowBackground" => NSVisualEffectMaterial::UnderWindowBackground,
        "underPageBackground" => NSVisualEffectMaterial::UnderPageBackground,
        _ => DEFAULT_EFFECT_MATERIAL,
    }
}

// Map a `glassVariant` prop string onto the NSGlassEffectView private i64 `variant`,
// matching ~/chat's `GlassMaterialVariant` (0..=23). Unknown names → regular (0).
#[cfg(target_os = "macos")]
fn glass_variant_value(name: &str) -> i64 {
    match name {
        "regular" => 0,
        "clear" => 1,
        "dock" => 2,
        "appIcons" => 3,
        "widgets" => 4,
        "text" => 5,
        "avplayer" => 6,
        "facetime" => 7,
        "controlCenter" => 8,
        "notificationCenter" => 9,
        "monogram" => 10,
        "bubbles" => 11,
        "identity" => 12,
        "focusBorder" => 13,
        "focusPlatter" => 14,
        "keyboard" => 15,
        "sidebar" => 16,
        "abuttedSidebar" => 17,
        "inspector" => 18,
        "control" => 19,
        "loupe" => 20,
        "slider" => 21,
        "camera" => 22,
        "cartouchePopover" => 23,
        _ => 0,
    }
}

// Resolve the native surface kind from the `material` + `glassVariant` props. A
// glassVariant takes precedence (it's the macOS-26 liquid-glass path) and carries the
// NSVisualEffectView material as its pre-26 fallback. Neither prop → a plain
// transparent surface (tint/shadow only).
#[cfg(target_os = "macos")]
fn resolve_surface(material: Option<&str>, glass_variant: Option<&str>) -> SystemSurface {
    let fallback = material
        .map(ns_visual_effect_material)
        .unwrap_or(DEFAULT_EFFECT_MATERIAL);
    if let Some(variant) = glass_variant {
        return SystemSurface::Glass {
            variant: glass_variant_value(variant),
            fallback,
        };
    }
    match material {
        Some(name) => SystemSurface::Effect(ns_visual_effect_material(name)),
        None => SystemSurface::Plain,
    }
}

/// Drop every native view whose node id left the tree (card closed/removed), so the
/// surface + tint + shadow views are torn down with it. Called from service.rs's apply
/// pass beside the webview retain. No-op on non-macos (no native views to GC).
#[cfg(target_os = "macos")]
pub fn retain_system_views(present: &HashSet<u64>) {
    SYSTEM_LAST_BOUNDS.with(|b| b.borrow_mut().retain(|id, _| present.contains(id)));
    SYSTEM_LAST_STYLE.with(|s| s.borrow_mut().retain(|id, _| present.contains(id)));
    SYSTEM_LAST_ALPHA.with(|a| a.borrow_mut().retain(|id, _| present.contains(id)));
    SYSTEM_LAST_SHADOW_APPLIED.with(|s| s.borrow_mut().retain(|id, _| present.contains(id)));
    let drop_absent = |map: &RefCell<HashMap<u64, id>>| {
        map.borrow_mut().retain(|id, view| {
            if present.contains(id) {
                return true;
            }
            unsafe {
                let _: () = msg_send![*view, removeFromSuperview];
                let _: () = msg_send![*view, release];
            }
            false
        });
    };
    SYSTEM_TINT_VIEWS.with(drop_absent);
    SYSTEM_SHADOW_VIEWS.with(drop_absent);
    SYSTEM_VIEWS.with(drop_absent);
}

#[cfg(not(target_os = "macos"))]
pub fn retain_system_views(_present: &std::collections::HashSet<u64>) {}

#[cfg(target_os = "macos")]
fn system_corner_clip(style: &ElementStyle) -> SystemCornerClip {
    let shorthand = style.border_radius;
    let top_left = style.border_top_left_radius.or(shorthand).unwrap_or(0.0);
    let top_right = style.border_top_right_radius.or(shorthand).unwrap_or(0.0);
    let bottom_left = style.border_bottom_left_radius.or(shorthand).unwrap_or(0.0);
    let bottom_right = style
        .border_bottom_right_radius
        .or(shorthand)
        .unwrap_or(0.0);
    let mut masked_corners = 0;
    if bottom_left > 0.0 {
        masked_corners |= CA_LAYER_MIN_X_MIN_Y_CORNER;
    }
    if bottom_right > 0.0 {
        masked_corners |= CA_LAYER_MAX_X_MIN_Y_CORNER;
    }
    if top_left > 0.0 {
        masked_corners |= CA_LAYER_MIN_X_MAX_Y_CORNER;
    }
    if top_right > 0.0 {
        masked_corners |= CA_LAYER_MAX_X_MAX_Y_CORNER;
    }
    SystemCornerClip {
        radius: top_left.max(top_right).max(bottom_left).max(bottom_right),
        masked_corners,
    }
}

// Resolve the drop shadow from the element's parsed `shadow` prop, folding in the
// element's corner radius so the `shadowPath` silhouette matches the card. A fully
// transparent shadow (opacity 0) resolves to None (no decoration).
#[cfg(target_os = "macos")]
fn system_shadow_style(element: &ReactElement, clip: SystemCornerClip) -> Option<SystemShadow> {
    let spec = element.system_shadow?;
    if spec.opacity <= 0.0 {
        return None;
    }
    let (r, g, b, _a) = hsla_to_srgb(spec.color);
    Some(SystemShadow {
        color: (r as f32, g as f32, b as f32),
        opacity: spec.opacity.clamp(0.0, 1.0),
        radius: spec.radius.max(0.0),
        offset_x: spec.offset_x,
        // CALayer shadowOffset is in the (non-flipped, +y UP) decor-view layer geometry,
        // so a CSS-style "shadow below the box" (+y down) is a NEGATIVE height. Matches
        // the webview decor shadow.
        offset_y: -spec.offset_y,
        corner_radius: clip.radius.max(0.0),
    })
}

#[cfg(target_os = "macos")]
fn system_view_style(element: &ReactElement) -> SystemViewStyle {
    let corner_clip = system_corner_clip(&element.style);
    SystemViewStyle {
        surface: resolve_surface(
            element.system_material.as_deref(),
            element.system_glass_variant.as_deref(),
        ),
        corner_clip,
        tint: element.system_tint.map(|c| {
            let (r, g, b, a) = hsla_to_srgb(c);
            (r as f32, g as f32, b as f32, a as f32)
        }),
        shadow: system_shadow_style(element, corner_clip),
        edge_fade: element
            .system_edge_fade
            .map(|v| v.clamp(0.0, 0.5))
            .filter(|v| *v > 0.0),
        top_fade_start: element.system_top_fade_start.map(|v| v.clamp(0.0, 1.0)),
    }
}

// Create a maskable host view for a SystemView. The AppKit blur/glass view is a child,
// not the host itself: NSGlassEffectView/NSVisualEffectView are compositor-backed, and
// their own layer masks do not reliably fade the material. A plain transparent NSView
// host gives us one normal layer for corner clipping, alpha masks, and tint overlays.
#[cfg(target_os = "macos")]
unsafe fn create_surface_view(surface: SystemSurface) -> id {
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));

    let host: id = msg_send![class!(NSView), alloc];
    let host: id = msg_send![host, initWithFrame: frame];
    unsafe {
        configure_transparent_view(host);
    }
    let _: () = msg_send![host, setAutoresizesSubviews: YES];

    match surface {
        SystemSurface::Plain => {}
        SystemSurface::Glass { variant, fallback } => {
            let child = if let Some(class) = Class::get("NSGlassEffectView") {
                let glass: id = msg_send![class, alloc];
                let glass: id = msg_send![glass, initWithFrame: frame];
                let _: () = msg_send![glass, setWantsLayer: YES];
                unsafe {
                    set_i64_property(glass, "variant", variant);
                }
                glass
            } else {
                unsafe { create_effect_view(fallback) }
            };
            if child != nil {
                unsafe {
                    configure_surface_child(host, child);
                }
            }
        }
        SystemSurface::Effect(material) => {
            let child = unsafe { create_effect_view(material) };
            if child != nil {
                unsafe {
                    configure_surface_child(host, child);
                }
            }
        }
    }

    host
}

// A configured NSVisualEffectView: BehindWindow blurs the desktop/windows behind the
// app window (not in-app content), Active keeps the blur live even when the window
// isn't key.
#[cfg(target_os = "macos")]
unsafe fn create_effect_view(material: NSVisualEffectMaterial) -> id {
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    let visual: id = msg_send![class!(NSVisualEffectView), alloc];
    let visual: id = msg_send![visual, initWithFrame: frame];
    let _: () = msg_send![visual, setWantsLayer: YES];
    let _: () = msg_send![visual, setBlendingMode: NSVisualEffectBlendingMode::BehindWindow];
    let _: () = msg_send![visual, setMaterial: material];
    let _: () = msg_send![visual, setState: NSVisualEffectState::Active];
    visual
}

#[cfg(target_os = "macos")]
unsafe fn configure_surface_child(host: id, child: id) {
    if host == nil || child == nil {
        return;
    }
    let _: () = msg_send![child, setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable];
    let bounds: NSRect = msg_send![host, bounds];
    let _: () = msg_send![child, setFrame: bounds];
    let _: () = msg_send![host, addSubview: child];
    let _: () = msg_send![child, release];
}

#[cfg(target_os = "macos")]
unsafe fn sync_surface_children_frame(host: id) {
    if host == nil {
        return;
    }
    let bounds: NSRect = msg_send![host, bounds];
    let subviews: id = msg_send![host, subviews];
    let count: usize = msg_send![subviews, count];
    for index in 0..count {
        let child: id = msg_send![subviews, objectAtIndex: index];
        if child != nil {
            let _: () = msg_send![child, setFrame: bounds];
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn apply_visual_effect_mask_image(host: id, style: &SystemViewStyle) {
    if host == nil {
        return;
    }
    let bounds: NSRect = msg_send![host, bounds];
    let needs_mask = style.corner_clip.radius > 0.0
        || style.edge_fade.is_some()
        || style.top_fade_start.is_some();
    let mask = if needs_mask {
        unsafe {
            create_visual_effect_mask_image(
                bounds.size.width,
                bounds.size.height,
                style.corner_clip.radius,
                style.edge_fade,
                style.top_fade_start,
            )
        }
    } else {
        nil
    };

    let selector = Sel::register("setMaskImage:");
    let subviews: id = msg_send![host, subviews];
    let count: usize = msg_send![subviews, count];
    let mut applied = 0usize;
    for index in 0..count {
        let child: id = msg_send![subviews, objectAtIndex: index];
        if child == nil {
            continue;
        }
        let responds: bool = msg_send![child, respondsToSelector: selector];
        if responds {
            let _: () = msg_send![child, setMaskImage: mask];
            applied += 1;
        }
    }

    if std::env::var_os("RNGPUI_GLASS_DEBUG").is_some() {
        let cls = if count > 0 {
            let first: id = msg_send![subviews, objectAtIndex: 0usize];
            if first != nil {
                let ns: id = msg_send![first, className];
                let utf8: *const std::os::raw::c_char = if ns != nil {
                    msg_send![ns, UTF8String]
                } else {
                    std::ptr::null()
                };
                if utf8.is_null() {
                    "<none>".to_string()
                } else {
                    std::ffi::CStr::from_ptr(utf8)
                        .to_string_lossy()
                        .into_owned()
                }
            } else {
                "<nil>".to_string()
            }
        } else {
            "<empty>".to_string()
        };
        eprintln!(
            "[glassdbg] mask host={:.0}x{:.0} needs_mask={} top={:?} edge={:?} radius={:.1} subviews={} child0={} maskApplied={}",
            bounds.size.width,
            bounds.size.height,
            needs_mask,
            style.top_fade_start,
            style.edge_fade,
            style.corner_clip.radius,
            count,
            cls,
            applied
        );
    }

    if mask != nil {
        let _: () = msg_send![mask, release];
    }
}

#[cfg(target_os = "macos")]
unsafe fn create_visual_effect_mask_image(
    width: f64,
    height: f64,
    radius: f32,
    edge_fade: Option<f32>,
    top_fade_start: Option<f32>,
) -> id {
    let width = width.max(1.0).ceil() as usize;
    let height = height.max(1.0).ceil() as usize;
    let bytes_per_row = width * 4;
    let color_space: id =
        msg_send![class!(NSString), stringWithUTF8String: c"NSDeviceRGBColorSpace".as_ptr()];
    let planes: *mut *mut u8 = std::ptr::null_mut();
    let rep: id = msg_send![class!(NSBitmapImageRep), alloc];
    let rep: id = msg_send![
        rep,
        initWithBitmapDataPlanes: planes
        pixelsWide: width
        pixelsHigh: height
        bitsPerSample: 8usize
        samplesPerPixel: 4usize
        hasAlpha: YES
        isPlanar: NO
        colorSpaceName: color_space
        bytesPerRow: bytes_per_row
        bitsPerPixel: 32usize
    ];
    if rep == nil {
        return nil;
    }

    let data: *mut u8 = msg_send![rep, bitmapData];
    if data.is_null() {
        let _: () = msg_send![rep, release];
        return nil;
    }

    let width_f = width as f64;
    let height_f = height as f64;
    let radius = f64::from(radius).clamp(0.0, width_f.min(height_f) * 0.5);
    let edge = edge_fade.map(|v| f64::from(v.clamp(0.0, 0.5)));
    let top = top_fade_start.map(|v| f64::from(v.clamp(0.0, 1.0)));

    for row in 0..height {
        let y_top = if height <= 1 {
            1.0
        } else {
            row as f64 / (height - 1) as f64
        };
        let top_alpha = top
            .map(|start| smoothstep(0.0, start, y_top))
            .unwrap_or(1.0);
        for col in 0..width {
            let x_norm = if width <= 1 {
                0.5
            } else {
                col as f64 / (width - 1) as f64
            };
            let edge_alpha = edge
                .map(|fade| {
                    smoothstep(0.0, fade, x_norm) * (1.0 - smoothstep(1.0 - fade, 1.0, x_norm))
                })
                .unwrap_or(1.0);
            let corner_alpha = rounded_rect_alpha(
                col as f64 + 0.5,
                row as f64 + 0.5,
                width_f,
                height_f,
                radius,
            );
            let alpha = (top_alpha * edge_alpha * corner_alpha * 255.0)
                .round()
                .clamp(0.0, 255.0) as u8;
            let offset = row * bytes_per_row + col * 4;
            unsafe {
                *data.add(offset) = 255;
                *data.add(offset + 1) = 255;
                *data.add(offset + 2) = 255;
                *data.add(offset + 3) = alpha;
            }
        }
    }

    let image: id = msg_send![class!(NSImage), alloc];
    let image: id = msg_send![image, initWithSize: NSSize::new(width_f, height_f)];
    if image == nil {
        let _: () = msg_send![rep, release];
        return nil;
    }
    let _: () = msg_send![image, addRepresentation: rep];
    let _: () = msg_send![rep, release];
    image
}

#[cfg(target_os = "macos")]
fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
    if (edge1 - edge0).abs() <= f64::EPSILON {
        return if x >= edge1 { 1.0 } else { 0.0 };
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[cfg(target_os = "macos")]
fn rounded_rect_alpha(x: f64, y: f64, width: f64, height: f64, radius: f64) -> f64 {
    if radius <= 0.0 {
        return 1.0;
    }
    let cx = if x < radius {
        radius
    } else if x > width - radius {
        width - radius
    } else {
        x
    };
    let cy = if y < radius {
        radius
    } else if y > height - radius {
        height - radius
    } else {
        y
    };
    let dx = x - cx;
    let dy = y - cy;
    let dist = (dx * dx + dy * dy).sqrt();
    (radius + 0.75 - dist).clamp(0.0, 1.0)
}

// Send a private/public `set<Key>:`-style i64 setter if the view responds (used for
// NSGlassEffectView.variant, which is API-private). Mirrors liquid_glass.rs.
#[cfg(target_os = "macos")]
unsafe fn set_i64_property(view: id, key: &str, value: i64) {
    let private_sel = Sel::register(&format!("set_{}:", key));
    if unsafe { send_i64_if_supported(view, private_sel, value) } {
        return;
    }
    let public_sel = Sel::register(&format!(
        "set{}{}:",
        key.chars().next().unwrap().to_uppercase(),
        &key[1..]
    ));
    let _ = unsafe { send_i64_if_supported(view, public_sel, value) };
}

#[cfg(target_os = "macos")]
unsafe fn send_i64_if_supported(view: *mut Object, selector: Sel, value: i64) -> bool {
    let responds: bool = msg_send![view, respondsToSelector: selector];
    if !responds {
        return false;
    }
    let _: () = unsafe { objc::__send_message(&*view, selector, (value,)).unwrap_or(()) };
    true
}

// The per-id shadow decor view (created lazily): layer-backed, clear, `masksToBounds=NO`
// so its CALayer drop shadow can spill past its frame. Sits one level below the surface
// view; the surface (and any opaque content above it) covers the decor's interior, so
// only the outward shadow spill is ever visible.
#[cfg(target_os = "macos")]
fn ensure_shadow_view(id: u64) -> id {
    SYSTEM_SHADOW_VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        *views.entry(id).or_insert_with(|| unsafe {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
            let view: id = msg_send![class!(NSView), alloc];
            let view: id = msg_send![view, initWithFrame: frame];
            let _: () = msg_send![view, setWantsLayer: YES];
            let layer: id = msg_send![view, layer];
            if layer != nil {
                let clear: id = msg_send![class!(NSColor), clearColor];
                let clear_cg: id = msg_send![clear, CGColor];
                let _: () = msg_send![layer, setMasksToBounds: NO];
                let _: () = msg_send![layer, setBackgroundColor: clear_cg];
            }
            view
        })
    })
}

// Lazily create the surface view for an id and park it in the native z-stack so its
// outer drop shadow can never be occluded. The stack is split into three bands, bottom
// → top: ALL shadow decor views, then ALL surface views, then gpui's Metal view on top.
//
// Why bands and not "surface directly above its own shadow": with the per-card
// "surface above its own shadow" ordering, a second card's shadow gets pushed to the
// absolute bottom (below the first card's surface), so the first card's opaque glass
// surface sits ABOVE the second card's shadow and CLIPS its spill at the shared edge —
// the reported "shadow clipped at the card edges" bug. Keeping every surface in a single
// band directly BELOW gpui's Metal view (and above ALL shadows) means no surface ever
// covers another card's shadow spill, while the surface still covers its OWN shadow's
// interior (same frame). gpui's Metal view is re-asserted on top so a surface ordered
// `NS_WINDOW_BELOW relativeTo: gpui_view` lands just under it. Mirrors webview.rs's
// bottom→top re-stack (backing, decor, host, gpui_view).
//
// Re-creates the surface when the surface KIND changes (plain NSView ⇄
// NSVisualEffectView ⇄ NSGlassEffectView, or a different glass variant — different
// classes/instances can't be reconfigured in place). Returns the current surface id.
#[cfg(target_os = "macos")]
fn ensure_surface_view(id: u64, parent_view: id, gpui_view: id, surface: SystemSurface) -> id {
    // the decor view exists first so the surface can be ordered directly above it.
    let shadow = ensure_shadow_view(id);

    SYSTEM_VIEWS.with(|views| {
        let mut views = views.borrow_mut();

        // a plain NSView, an NSVisualEffectView and an NSGlassEffectView are different
        // classes; a glass view's variant is set at most reliably at creation. Rebuild
        // whenever the surface kind-key (class + variant/material) changes.
        let prev_key =
            SYSTEM_LAST_STYLE.with(|s| s.borrow().get(&id).map(|st| st.surface.kind_key()));
        let needs_rebuild = matches!(prev_key, Some(prev) if prev != surface.kind_key());
        if needs_rebuild {
            if let Some(old) = views.remove(&id) {
                unsafe {
                    let _: () = msg_send![old, removeFromSuperview];
                    let _: () = msg_send![old, release];
                }
            }
            SYSTEM_TINT_VIEWS.with(|tints| {
                if let Some(tint) = tints.borrow_mut().remove(&id) {
                    unsafe {
                        let _: () = msg_send![tint, removeFromSuperview];
                        let _: () = msg_send![tint, release];
                    }
                }
            });
        }

        let view = *views
            .entry(id)
            .or_insert_with(|| unsafe { create_surface_view(surface) });

        unsafe {
            // keep every shadow decor at the very bottom of the parent z-stack (the
            // shadows band), below all surfaces and gpui's Metal view.
            let shadow_parent: id = msg_send![shadow, superview];
            if shadow_parent != parent_view {
                if shadow_parent != nil {
                    let _: () = msg_send![shadow, removeFromSuperview];
                }
                let _: () = msg_send![
                    parent_view,
                    addSubview: shadow
                    positioned: NS_WINDOW_BELOW
                    relativeTo: nil
                ];
            }
            // park the surface in the band directly BELOW gpui's Metal view — i.e. above
            // ALL shadow decors, so no card's surface can occlude another card's shadow
            // spill, while still covering its own shadow's interior (same frame). Ordering
            // relative to gpui_view (not to its own shadow) is what keeps every surface in
            // one band above every shadow regardless of card count / tree order.
            let surface_parent: id = msg_send![view, superview];
            if surface_parent != parent_view {
                if surface_parent != nil {
                    let _: () = msg_send![view, removeFromSuperview];
                }
                let _: () = msg_send![
                    parent_view,
                    addSubview: view
                    positioned: NS_WINDOW_BELOW
                    relativeTo: gpui_view
                ];
            }
            // re-assert gpui's Metal view on top so surfaces ordered below it stay below
            // it (and above every shadow). `addSubview:` re-adds an existing subview at
            // the top; gate it on the Metal view not already being topmost to avoid the
            // per-frame reparent churn that tears the whole UI out and flickers.
            if gpui_view != nil {
                let subviews: id = msg_send![parent_view, subviews];
                let count: usize = msg_send![subviews, count];
                let topmost: id = if count > 0 {
                    msg_send![subviews, objectAtIndex: count - 1]
                } else {
                    nil
                };
                if topmost != gpui_view {
                    let _: () = msg_send![parent_view, addSubview: gpui_view];
                }
            }
        }

        view
    })
}

// the optional tinted overlay subview, sized to fill the surface view. Created lazily
// only when a `tint` prop is present.
#[cfg(target_os = "macos")]
fn ensure_tint_view(id: u64, surface_view: id) -> id {
    SYSTEM_TINT_VIEWS.with(|tints| {
        let mut tints = tints.borrow_mut();
        let view = *tints.entry(id).or_insert_with(|| unsafe {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
            let view: id = msg_send![class!(NSView), alloc];
            let view: id = msg_send![view, initWithFrame: frame];
            configure_transparent_view(view);
            view
        });
        unsafe {
            let current_parent: id = msg_send![view, superview];
            if current_parent != surface_view {
                if current_parent != nil {
                    let _: () = msg_send![view, removeFromSuperview];
                }
                let _: () = msg_send![surface_view, addSubview: view];
            }
            let _: () =
                msg_send![view, setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable];
        }
        view
    })
}

#[cfg(target_os = "macos")]
unsafe fn apply_layer_corner_clip(layer: id, clip: SystemCornerClip) {
    if layer == nil {
        return;
    }
    if clip.radius > 0.0 && clip.masked_corners != 0 {
        let _: () = msg_send![layer, setMasksToBounds: YES];
        let _: () = msg_send![layer, setCornerRadius: clip.radius as f64];
        let _: () = msg_send![layer, setMaskedCorners: clip.masked_corners];
    } else {
        let _: () = msg_send![layer, setMasksToBounds: NO];
        let _: () = msg_send![layer, setCornerRadius: 0.0f64];
        let _: () = msg_send![layer, setMaskedCorners: 0u64];
    }
}

// Apply corner clip + optional tint to the surface view. The tint overlay is
// created/hidden as the prop comes and goes, and rounded to match.
#[cfg(target_os = "macos")]
unsafe fn apply_surface_style(id: u64, view: id, style: &SystemViewStyle) {
    let clip = style.corner_clip;
    let _: () = msg_send![view, setWantsLayer: YES];
    unsafe {
        sync_surface_children_frame(view);
    }
    let layer: id = msg_send![view, layer];
    unsafe {
        apply_layer_corner_clip(layer, clip);
        apply_visual_effect_mask_image(view, style);
    }

    match style.tint {
        Some((r, g, b, a)) if a > 0.0 => {
            let tint = ensure_tint_view(id, view);
            let tint_layer: id = msg_send![tint, layer];
            if tint_layer != nil {
                let ns_color: id = msg_send![
                    class!(NSColor),
                    colorWithSRGBRed: r as f64
                    green: g as f64
                    blue: b as f64
                    alpha: a as f64
                ];
                let cg_color: id = msg_send![ns_color, CGColor];
                let _: () = msg_send![tint_layer, setBackgroundColor: cg_color];
                unsafe {
                    apply_layer_corner_clip(tint_layer, clip);
                }
            }
            let _: () = msg_send![tint, setHidden: NO];
        }
        _ => {
            SYSTEM_TINT_VIEWS.with(|tints| {
                if let Some(tint) = tints.borrow().get(&id).copied() {
                    let _: () = msg_send![tint, setHidden: YES];
                }
            });
        }
    }
}

// Drive the shadow decor view from the resolved shadow. Like the webview decor, split
// the work: only re-set the style (color/opacity/radius/offset — each allocates an
// NSColor/CGColor) when it changed, and only re-trace the size-dependent rounded-rect
// `shadowPath` when the size or corner changed. No shadow → hide the decor.
#[cfg(target_os = "macos")]
unsafe fn apply_shadow_decor(id: u64, width: f64, height: f64, shadow: Option<SystemShadow>) {
    let view = ensure_shadow_view(id);
    let layer: id = msg_send![view, layer];
    if layer == nil {
        return;
    }

    let Some(shadow) = shadow else {
        let _: () = msg_send![layer, setShadowOpacity: 0.0f32];
        let _: () = msg_send![layer, setShadowPath: nil];
        let _: () = msg_send![view, setHidden: YES];
        SYSTEM_LAST_SHADOW_APPLIED.with(|m| m.borrow_mut().remove(&id));
        return;
    };

    let (style_same, size_same) = SYSTEM_LAST_SHADOW_APPLIED.with(|m| match m.borrow().get(&id) {
        Some((lw, lh, last)) => (
            *last == shadow,
            (lw - width).round() == 0.0 && (lh - height).round() == 0.0,
        ),
        None => (false, false),
    });
    if style_same && size_same {
        return; // nothing visual changed — skip the shadow re-rasterization entirely.
    }

    if !style_same {
        let ns_color: id = msg_send![
            class!(NSColor),
            colorWithSRGBRed: shadow.color.0 as f64
            green: shadow.color.1 as f64
            blue: shadow.color.2 as f64
            alpha: 1.0f64
        ];
        let cg_color: id = msg_send![ns_color, CGColor];
        let _: () = msg_send![layer, setShadowColor: cg_color];
        let _: () = msg_send![layer, setShadowOpacity: shadow.opacity];
        let _: () = msg_send![layer, setShadowRadius: shadow.radius as f64];
        let offset = NSSize::new(shadow.offset_x as f64, shadow.offset_y as f64);
        let _: () = msg_send![layer, setShadowOffset: offset];
    }

    // the rounded-rect shadowPath depends only on size + corner; re-tracing it forces CA
    // to re-rasterize the blur, so gate it on a real size/corner change (corner lives in
    // `shadow`, so a corner change shows up as !style_same).
    if !size_same || !style_same {
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
        let r = shadow.corner_radius.max(0.0) as f64;
        let path: id = unsafe { CGPathCreateWithRoundedRect(rect, r, r, std::ptr::null()) };
        let _: () = msg_send![layer, setShadowPath: path];
        if path != nil {
            unsafe {
                CGPathRelease(path);
            }
        }
    }
    let _: () = msg_send![view, setHidden: NO];
    SYSTEM_LAST_SHADOW_APPLIED.with(|m| m.borrow_mut().insert(id, (width, height, shadow)));
}

// Park the surface + shadow views over the node's layout bounds. Mirrors
// position_webview_host: only touch native geometry/style when something actually
// changed, inside a CATransaction with implicit actions disabled to land the resize in
// one flicker-free step.
#[cfg(target_os = "macos")]
fn position_system_view(window: &mut Window, element: &ReactElement, bounds: Bounds<Pixels>) {
    let Some((parent_view, gpui_view)) = webview_parent(window) else {
        return;
    };

    let id = element.global_id;
    let style = system_view_style(element);
    let view = ensure_surface_view(id, parent_view, gpui_view, style.surface);
    let shadow_view = ensure_shadow_view(id);

    let x = f64::from(bounds.origin.x);
    let y = f64::from(bounds.origin.y);
    let width = f64::from(bounds.size.width);
    let height = f64::from(bounds.size.height);
    let new_bounds = (x, y, width, height);

    let bounds_changed = SYSTEM_LAST_BOUNDS.with(|b| match b.borrow().get(&id) {
        Some(prev) => !bounds_close(*prev, new_bounds),
        None => true,
    });
    let style_changed = SYSTEM_LAST_STYLE.with(|s| match s.borrow().get(&id) {
        Some(prev) => prev != &style,
        None => true,
    });

    unsafe {
        if bounds_changed || style_changed {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: YES];

            if bounds_changed {
                set_child_frame(parent_view, view, x, y, width, height);
                // the shadow decor shares the surface's exact frame so its rounded-rect
                // shadowPath lines up; it sits one level below.
                set_child_frame(parent_view, shadow_view, x, y, width, height);
                SYSTEM_LAST_BOUNDS.with(|b| {
                    b.borrow_mut().insert(id, new_bounds);
                });
            }

            apply_surface_style(id, view, &style);
            apply_shadow_decor(id, width, height, style.shadow);

            let _: () = msg_send![class!(CATransaction), commit];

            SYSTEM_LAST_STYLE.with(|s| {
                s.borrow_mut().insert(id, style);
            });
        }

        // opacity sync: mirror the node's computed opacity onto the native views so an
        // RN Animated opacity (useNativeDriver:false) fades the surface + shadow like a
        // normal view. Change-detected so we don't set alpha every frame. Transform
        // animation is out of scope — the native view tracks layout bounds, not the
        // Metal transform stack.
        let alpha = f64::from(element.style.opacity.unwrap_or(1.0)).clamp(0.0, 1.0);
        let alpha_changed = SYSTEM_LAST_ALPHA.with(|a| match a.borrow().get(&id) {
            Some(prev) => (prev - alpha).abs() > 0.001,
            None => alpha < 1.0, // a fresh view defaults to alpha 1.0; only touch it if lower.
        });
        if alpha_changed {
            let _: () = msg_send![view, setAlphaValue: alpha];
            let _: () = msg_send![shadow_view, setAlphaValue: alpha];
            SYSTEM_LAST_ALPHA.with(|a| {
                a.borrow_mut().insert(id, alpha);
            });
        }

        // cheap + idempotent: keep asserting visibility every frame.
        let _: () = msg_send![view, setHidden: NO];
    }
}

#[cfg(target_os = "macos")]
fn hide_system_view(id: u64) {
    SYSTEM_VIEWS.with(|views| {
        if let Some(view) = views.borrow().get(&id).copied() {
            unsafe {
                let _: () = msg_send![view, setHidden: YES];
            }
        }
    });
    SYSTEM_SHADOW_VIEWS.with(|views| {
        if let Some(view) = views.borrow().get(&id).copied() {
            unsafe {
                let _: () = msg_send![view, setHidden: YES];
            }
        }
    });
}

/// `<SystemView>` → a native macOS surface (optional backdrop blur + tint + outer drop
/// shadow) parked below gpui's Metal layer, resized to its flex-layout bounds every
/// frame. The gpui element paints nothing visible; transparent window pixels in its
/// rect read as the configured native surface.
pub struct ReactSystemElement {
    element: Arc<ReactElement>,
}

impl ReactSystemElement {
    pub fn new(element: Arc<ReactElement>) -> Self {
        Self { element }
    }
}

impl IntoElement for ReactSystemElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for ReactSystemElement {
    type RequestLayoutState = ();
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Integer(self.element.global_id))
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        // honor the node's flex style (flex:1, width/height, position:absolute, …) so a
        // SystemView can absolutely-fill a card background the way RN expects.
        let style = self.element.build_gpui_style(None);
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        if self.element.style.is_display_none() {
            #[cfg(target_os = "macos")]
            hide_system_view(self.element.global_id);
            let _ = window;
            return None;
        }

        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);
        report_layout(&self.element, bounds);
        crate::inspector::refresh_layout_snapshot(
            self.element.global_id,
            bounds.origin.x.into(),
            bounds.origin.y.into(),
            bounds.size.width.into(),
            bounds.size.height.into(),
        );

        // reserve the rect for gpui hit-testing / occlusion, like the webview host.
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);

        #[cfg(target_os = "macos")]
        position_system_view(window, &self.element, bounds);

        Some(hitbox)
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _: &mut (),
        _hitbox: &mut Self::PrepaintState,
        _window: &mut Window,
        _: &mut App,
    ) {
        // nothing to paint: the native views (below the Metal layer) are the entire
        // visual. painting an opaque fill here would cover the frosted glass.
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use gpui::Hsla;

    #[test]
    fn resolve_surface_picks_kind_from_props() {
        // neither prop → a plain (no-blur) surface.
        assert_eq!(resolve_surface(None, None), SystemSurface::Plain);
        // a material name → an NSVisualEffectView with that semantic material.
        assert_eq!(
            resolve_surface(Some("sidebar"), None),
            SystemSurface::Effect(NSVisualEffectMaterial::Sidebar)
        );
        // unknown material name falls back to the HUD material rather than dropping blur.
        assert_eq!(
            resolve_surface(Some("bogus"), None),
            SystemSurface::Effect(DEFAULT_EFFECT_MATERIAL)
        );
        // a glassVariant → a glass surface; the material rides along as the pre-26 fallback.
        assert_eq!(
            resolve_surface(Some("underWindowBackground"), Some("clear")),
            SystemSurface::Glass {
                variant: 1,
                fallback: NSVisualEffectMaterial::UnderWindowBackground,
            }
        );
        // glassVariant without a material uses the default effect material as fallback.
        assert_eq!(
            resolve_surface(None, Some("inspector")),
            SystemSurface::Glass {
                variant: 18,
                fallback: DEFAULT_EFFECT_MATERIAL,
            }
        );
    }

    #[test]
    fn ns_visual_effect_material_covers_full_set() {
        // a representative slice of the full AppKit semantic material set.
        assert_eq!(
            ns_visual_effect_material("titlebar") as i64,
            NSVisualEffectMaterial::Titlebar as i64
        );
        assert_eq!(
            ns_visual_effect_material("toolTip") as i64,
            NSVisualEffectMaterial::Tooltip as i64
        );
        assert_eq!(
            ns_visual_effect_material("underPageBackground") as i64,
            NSVisualEffectMaterial::UnderPageBackground as i64
        );
        assert_eq!(
            ns_visual_effect_material("hudWindow") as i64,
            NSVisualEffectMaterial::HudWindow as i64
        );
    }

    #[test]
    fn glass_variant_values_match_chat_plugin() {
        // a representative slice of GlassMaterialVariant (0..=23) from ~/chat's plugin.
        assert_eq!(glass_variant_value("regular"), 0);
        assert_eq!(glass_variant_value("clear"), 1);
        assert_eq!(glass_variant_value("controlCenter"), 8);
        assert_eq!(glass_variant_value("sidebar"), 16);
        assert_eq!(glass_variant_value("cartouchePopover"), 23);
        // unknown → regular (0).
        assert_eq!(glass_variant_value("bogus"), 0);
    }

    #[test]
    fn surface_kind_key_distinguishes_classes_and_variants() {
        // plain, effect, and glass are distinct classes…
        assert_ne!(
            SystemSurface::Plain.kind_key(),
            SystemSurface::Effect(NSVisualEffectMaterial::HudWindow).kind_key()
        );
        // …and two glass variants are distinct (forces a rebuild between them).
        let g1 = SystemSurface::Glass {
            variant: 1,
            fallback: NSVisualEffectMaterial::HudWindow,
        };
        let g2 = SystemSurface::Glass {
            variant: 2,
            fallback: NSVisualEffectMaterial::HudWindow,
        };
        assert_ne!(g1.kind_key(), g2.kind_key());
    }

    #[test]
    fn corner_clip_derives_radius_and_masked_corners_from_shorthand() {
        let mut style = ElementStyle::default();
        style.border_radius = Some(16.0);
        let clip = system_corner_clip(&style);
        assert_eq!(clip.radius, 16.0);
        let all = CA_LAYER_MIN_X_MIN_Y_CORNER
            | CA_LAYER_MAX_X_MIN_Y_CORNER
            | CA_LAYER_MIN_X_MAX_Y_CORNER
            | CA_LAYER_MAX_X_MAX_Y_CORNER;
        assert_eq!(clip.masked_corners, all);
    }

    #[test]
    fn corner_clip_is_empty_without_radius() {
        let clip = system_corner_clip(&ElementStyle::default());
        assert_eq!(clip.radius, 0.0);
        assert_eq!(clip.masked_corners, 0);
    }

    #[test]
    fn corner_clip_honors_per_corner_radii() {
        let mut style = ElementStyle::default();
        style.border_top_left_radius = Some(8.0);
        let clip = system_corner_clip(&style);
        assert_eq!(clip.radius, 8.0);
        assert_eq!(clip.masked_corners, CA_LAYER_MIN_X_MAX_Y_CORNER);
    }

    #[test]
    fn shadow_style_flips_offset_y_and_carries_corner() {
        let clip = SystemCornerClip {
            radius: 12.0,
            masked_corners: 0,
        };
        let spec = crate::elements::SystemShadowSpec {
            color: Hsla {
                h: 0.0,
                s: 0.0,
                l: 0.0,
                a: 1.0,
            },
            radius: 20.0,
            offset_x: 0.0,
            offset_y: 8.0,
            opacity: 0.5,
        };
        let element = test_element(Some(spec));
        let shadow = system_shadow_style(&element, clip).expect("opacity > 0 yields a shadow");
        // CSS "+y down" maps to a NEGATIVE CALayer offset height.
        assert_eq!(shadow.offset_y, -8.0);
        assert_eq!(shadow.offset_x, 0.0);
        assert_eq!(shadow.radius, 20.0);
        assert_eq!(shadow.opacity, 0.5);
        assert_eq!(shadow.corner_radius, 12.0);
    }

    #[test]
    fn shadow_style_is_none_when_fully_transparent() {
        let clip = SystemCornerClip {
            radius: 0.0,
            masked_corners: 0,
        };
        let spec = crate::elements::SystemShadowSpec {
            color: Hsla {
                h: 0.0,
                s: 0.0,
                l: 0.0,
                a: 1.0,
            },
            radius: 10.0,
            offset_x: 0.0,
            offset_y: 4.0,
            opacity: 0.0,
        };
        let element = test_element(Some(spec));
        assert!(system_shadow_style(&element, clip).is_none());
    }

    fn test_element(shadow: Option<crate::elements::SystemShadowSpec>) -> ReactElement {
        ReactElement {
            global_id: 1,
            element_type: "system".to_string(),
            text: None,
            number_of_lines: None,
            selectable: false,
            runs: Vec::new(),
            src: None,
            system_material: None,
            system_glass_variant: None,
            system_tint: None,
            system_shadow: shadow,
            system_edge_fade: None,
            system_top_fade_start: None,
            backdrop_blur_radius: None,
            backdrop_tint: None,
            value: None,
            secure_text_entry: false,
            editable: true,
            events: Vec::new(),
            native_layout_key: None,
            native_resize: None,
            native_list_group: None,
            terminal_session_id: None,
            terminal_frames: Vec::new(),
            accessibility: crate::elements::AccessibilityInfo::default(),
            children: Vec::new(),
            style: ElementStyle::default(),
            style_json: None,
            cached_gpui_style: None,
            interactive: false,
            pseudo_events: false,
        }
    }
}
