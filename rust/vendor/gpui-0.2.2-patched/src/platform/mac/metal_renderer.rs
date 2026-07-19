use super::metal_atlas::MetalAtlas;
use crate::{
    AtlasTextureId, BackdropBlur, Background, Bounds, ContentMask, DevicePixels, MonochromeSprite,
    PaintSurface, Path, Point, PolychromeSprite, PrimitiveBatch, Quad, ScaledPixels, Scene,
    SceneDamage, SceneSnapshot, Shadow, Size, Surface, Underline, point, size,
};
use anyhow::Result;
use block::ConcreteBlock;
use cocoa::{
    base::{NO, YES},
    foundation::{NSSize, NSUInteger},
    quartzcore::AutoresizingMask,
};

use core_foundation::base::TCFType;
use core_video::{
    metal_texture::CVMetalTextureGetTexture, metal_texture_cache::CVMetalTextureCache,
    pixel_buffer::kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
};
use foreign_types::{ForeignType, ForeignTypeRef};
use metal::{
    CAMetalLayer, CommandQueue, MTLPixelFormat, MTLOrigin, MTLResourceOptions, MTLScissorRect,
    MTLSize, NSRange, RenderPassColorAttachmentDescriptorRef,
};
use objc::{self, msg_send, sel, sel_impl};
use parking_lot::Mutex;

use std::{cell::Cell, ffi::c_void, mem, ptr, sync::Arc};

// Exported to metal
pub(crate) type PointF = crate::Point<f32>;

#[derive(Clone, Copy, Debug)]
struct ScrollBlitPlan {
    viewport: MTLScissorRect,
    delta_x: i64,
    delta_y: i64,
    damage: MTLScissorRect,
    repairs: [Option<MTLScissorRect>; 4],
}

#[derive(Clone, Copy, Debug)]
enum RetainedPlan {
    Full(&'static str),
    Damage(MTLScissorRect),
    Reuse,
    ScrollBlit(ScrollBlitPlan),
}

fn scissor_for_bounds(
    bounds: Bounds<ScaledPixels>,
    viewport_size: Size<DevicePixels>,
) -> Option<MTLScissorRect> {
    let viewport_w = i32::from(viewport_size.width).max(0);
    let viewport_h = i32::from(viewport_size.height).max(0);
    let x0 = (bounds.origin.x.0.floor() as i32).clamp(0, viewport_w);
    let y0 = (bounds.origin.y.0.floor() as i32).clamp(0, viewport_h);
    let x1 = ((bounds.origin.x.0 + bounds.size.width.0).ceil() as i32).clamp(0, viewport_w);
    let y1 = ((bounds.origin.y.0 + bounds.size.height.0).ceil() as i32).clamp(0, viewport_h);
    (x1 > x0 && y1 > y0).then_some(MTLScissorRect {
        x: x0 as u64,
        y: y0 as u64,
        width: (x1 - x0) as u64,
        height: (y1 - y0) as u64,
    })
}

fn scissor_area(rect: MTLScissorRect) -> u64 {
    rect.width.saturating_mul(rect.height)
}

// rngpui debug: RNGPUI_SPRITE_TRACE="x0,y0,x1,y1" (device px) dumps, per frame,
// every monochrome sprite intersecting that band (order/texture/tile/bounds) plus
// the frame's full batch sequence — the instrument for glyph-tail-drop diagnosis.
fn sprite_trace_band() -> Option<(f32, f32, f32, f32)> {
    use std::sync::OnceLock;
    static BAND: OnceLock<Option<(f32, f32, f32, f32)>> = OnceLock::new();
    *BAND.get_or_init(|| {
        let v = std::env::var("RNGPUI_SPRITE_TRACE").ok()?;
        let mut it = v.split(',').map(|s| s.trim().parse::<f32>().ok());
        Some((it.next()??, it.next()??, it.next()??, it.next()??))
    })
}

fn trace_scene_sprites(scene: &Scene, band: (f32, f32, f32, f32)) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static FRAME: AtomicU64 = AtomicU64::new(0);
    let frame = FRAME.fetch_add(1, Ordering::Relaxed);
    let (bx0, by0, bx1, by1) = band;
    let hit = |b: &Bounds<ScaledPixels>| {
        b.origin.x.0 < bx1
            && b.origin.x.0 + b.size.width.0 > bx0
            && b.origin.y.0 < by1
            && b.origin.y.0 + b.size.height.0 > by0
    };
    let mut any = false;
    for s in &scene.monochrome_sprites {
        if !hit(&s.bounds) {
            continue;
        }
        any = true;
        let m = &s.content_mask.bounds;
        let t = &s.tile;
        eprintln!(
            "[spritetrace] f={frame} ord={} tex={:?}/{} tile={} tb=({},{} {}x{}) b=({:.1},{:.1} {:.1}x{:.1}) mask=({:.1},{:.1} {:.1}x{:.1}) a={:.2}",
            s.order,
            t.texture_id.kind,
            t.texture_id.index,
            t.tile_id.0,
            t.bounds.origin.x.0,
            t.bounds.origin.y.0,
            t.bounds.size.width.0,
            t.bounds.size.height.0,
            s.bounds.origin.x.0,
            s.bounds.origin.y.0,
            s.bounds.size.width.0,
            s.bounds.size.height.0,
            m.origin.x.0,
            m.origin.y.0,
            m.size.width.0,
            m.size.height.0,
            s.color.a,
        );
    }
    if any {
        let mut seq = String::new();
        for batch in scene.batches() {
            use std::fmt::Write as _;
            match batch {
                PrimitiveBatch::Shadows(s) => write!(seq, " sh{}", s.len()),
                PrimitiveBatch::Quads(q) => write!(seq, " q{}", q.len()),
                PrimitiveBatch::Paths(p) => write!(seq, " p{}", p.len()),
                PrimitiveBatch::Underlines(u) => write!(seq, " u{}", u.len()),
                PrimitiveBatch::MonochromeSprites { texture_id, sprites } => {
                    let in_band = sprites.iter().filter(|s| hit(&s.bounds)).count();
                    if in_band > 0 {
                        write!(
                            seq,
                            " M{}(t{} ord={}..{} band={})",
                            sprites.len(),
                            texture_id.index,
                            sprites.first().map(|s| s.order).unwrap_or(0),
                            sprites.last().map(|s| s.order).unwrap_or(0),
                            in_band
                        )
                    } else {
                        write!(seq, " m{}(t{})", sprites.len(), texture_id.index)
                    }
                }
                PrimitiveBatch::PolychromeSprites { texture_id, sprites } => {
                    write!(seq, " po{}(t{})", sprites.len(), texture_id.index)
                }
                PrimitiveBatch::Surfaces(s) => write!(seq, " su{}", s.len()),
                PrimitiveBatch::BackdropBlurs(b) => write!(seq, " bb{}", b.len()),
            }
            .ok();
        }
        eprintln!("[spritetrace] f={frame} batches:{seq}");
    }
}

#[cfg(not(feature = "runtime_shaders"))]
const SHADERS_METALLIB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/shaders.metallib"));
#[cfg(feature = "runtime_shaders")]
const SHADERS_SOURCE_FILE: &str = include_str!(concat!(env!("OUT_DIR"), "/stitched_shaders.metal"));
// Use 4x MSAA, all devices support it.
// https://developer.apple.com/documentation/metal/mtldevice/1433355-supportstexturesamplecount
const PATH_SAMPLE_COUNT: u32 = 4;

pub type Context = Arc<Mutex<InstanceBufferPool>>;
pub type Renderer = MetalRenderer;

pub unsafe fn new_renderer(
    context: self::Context,
    _native_window: *mut c_void,
    _native_view: *mut c_void,
    _bounds: crate::Size<f32>,
    _transparent: bool,
) -> Renderer {
    MetalRenderer::new(context)
}

pub(crate) struct InstanceBufferPool {
    buffer_size: usize,
    buffers: Vec<metal::Buffer>,
}

impl Default for InstanceBufferPool {
    fn default() -> Self {
        Self {
            buffer_size: 2 * 1024 * 1024,
            buffers: Vec::new(),
        }
    }
}

pub(crate) struct InstanceBuffer {
    metal_buffer: metal::Buffer,
    size: usize,
}

impl InstanceBufferPool {
    pub(crate) fn reset(&mut self, buffer_size: usize) {
        self.buffer_size = buffer_size;
        self.buffers.clear();
    }

    pub(crate) fn acquire(&mut self, device: &metal::Device) -> InstanceBuffer {
        let buffer = self.buffers.pop().unwrap_or_else(|| {
            device.new_buffer(
                self.buffer_size as u64,
                MTLResourceOptions::StorageModeManaged,
            )
        });
        InstanceBuffer {
            metal_buffer: buffer,
            size: self.buffer_size,
        }
    }

    pub(crate) fn release(&mut self, buffer: InstanceBuffer) {
        if buffer.size == self.buffer_size {
            self.buffers.push(buffer.metal_buffer)
        }
    }
}

pub(crate) struct MetalRenderer {
    device: metal::Device,
    layer: metal::MetalLayer,
    presents_with_transaction: bool,
    command_queue: CommandQueue,
    paths_rasterization_pipeline_state: metal::RenderPipelineState,
    path_sprites_pipeline_state: metal::RenderPipelineState,
    shadows_pipeline_state: metal::RenderPipelineState,
    quads_pipeline_state: metal::RenderPipelineState,
    clear_quads_pipeline_state: metal::RenderPipelineState,
    underlines_pipeline_state: metal::RenderPipelineState,
    monochrome_sprites_pipeline_state: metal::RenderPipelineState,
    polychrome_sprites_pipeline_state: metal::RenderPipelineState,
    surfaces_pipeline_state: metal::RenderPipelineState,
    // the two backdrop-blur passes: a horizontal gaussian into scratch (blending off),
    // then a vertical gaussian + tint composite back onto the drawable (blending on).
    backdrop_blur_h_pipeline_state: metal::RenderPipelineState,
    backdrop_blur_composite_pipeline_state: metal::RenderPipelineState,
    unit_vertices: metal::Buffer,
    #[allow(clippy::arc_with_non_send_sync)]
    instance_buffer_pool: Arc<Mutex<InstanceBufferPool>>,
    sprite_atlas: Arc<MetalAtlas>,
    core_video_texture_cache: core_video::metal_texture_cache::CVMetalTextureCache,
    path_intermediate_texture: Option<metal::Texture>,
    path_intermediate_msaa_texture: Option<metal::Texture>,
    // full-viewport sampleable scratch target for the backdrop-blur horizontal pass.
    scratch_texture: Option<metal::Texture>,
    retained_texture: Option<metal::Texture>,
    scroll_scratch_texture: Option<metal::Texture>,
    retained_valid: bool,
    previous_scene: Option<SceneSnapshot>,
    path_sample_count: u32,
}

#[repr(C)]
pub struct PathRasterizationVertex {
    pub xy_position: Point<ScaledPixels>,
    pub st_position: Point<f32>,
    pub color: Background,
    pub bounds: Bounds<ScaledPixels>,
}

impl MetalRenderer {
    pub fn new(instance_buffer_pool: Arc<Mutex<InstanceBufferPool>>) -> Self {
        // Prefer low‐power integrated GPUs on Intel Mac. On Apple
        // Silicon, there is only ever one GPU, so this is equivalent to
        // `metal::Device::system_default()`.
        let mut devices = metal::Device::all();
        devices.sort_by_key(|device| (device.is_removable(), device.is_low_power()));
        let Some(device) = devices.pop() else {
            log::error!("unable to access a compatible graphics device");
            std::process::exit(1);
        };

        let layer = metal::MetalLayer::new();
        layer.set_device(&device);
        layer.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
        layer.set_opaque(false);
        layer.set_maximum_drawable_count(3);
        // the backdrop-blur passes sample the drawable as a shader input, so the drawable
        // must be readable — framebuffer_only would make it write-only and the sample fail.
        layer.set_framebuffer_only(false);
        unsafe {
            let _: () = msg_send![&*layer, setAllowsNextDrawableTimeout: NO];
            let _: () = msg_send![&*layer, setNeedsDisplayOnBoundsChange: YES];
            let _: () = msg_send![
                &*layer,
                setAutoresizingMask: AutoresizingMask::WIDTH_SIZABLE
                    | AutoresizingMask::HEIGHT_SIZABLE
            ];
        }
        #[cfg(feature = "runtime_shaders")]
        let library = device
            .new_library_with_source(&SHADERS_SOURCE_FILE, &metal::CompileOptions::new())
            .expect("error building metal library");
        #[cfg(not(feature = "runtime_shaders"))]
        let library = device
            .new_library_with_data(SHADERS_METALLIB)
            .expect("error building metal library");

        fn to_float2_bits(point: PointF) -> u64 {
            let mut output = point.y.to_bits() as u64;
            output <<= 32;
            output |= point.x.to_bits() as u64;
            output
        }

        let unit_vertices = [
            to_float2_bits(point(0., 0.)),
            to_float2_bits(point(1., 0.)),
            to_float2_bits(point(0., 1.)),
            to_float2_bits(point(0., 1.)),
            to_float2_bits(point(1., 0.)),
            to_float2_bits(point(1., 1.)),
        ];
        let unit_vertices = device.new_buffer_with_data(
            unit_vertices.as_ptr() as *const c_void,
            mem::size_of_val(&unit_vertices) as u64,
            MTLResourceOptions::StorageModeManaged,
        );

        let paths_rasterization_pipeline_state = build_path_rasterization_pipeline_state(
            &device,
            &library,
            "paths_rasterization",
            "path_rasterization_vertex",
            "path_rasterization_fragment",
            MTLPixelFormat::BGRA8Unorm,
            PATH_SAMPLE_COUNT,
        );
        let path_sprites_pipeline_state = build_path_sprite_pipeline_state(
            &device,
            &library,
            "path_sprites",
            "path_sprite_vertex",
            "path_sprite_fragment",
            MTLPixelFormat::BGRA8Unorm,
        );
        let shadows_pipeline_state = build_pipeline_state(
            &device,
            &library,
            "shadows",
            "shadow_vertex",
            "shadow_fragment",
            MTLPixelFormat::BGRA8Unorm,
        );
        let quads_pipeline_state = build_pipeline_state(
            &device,
            &library,
            "quads",
            "quad_vertex",
            "quad_fragment",
            MTLPixelFormat::BGRA8Unorm,
        );
        let clear_quads_pipeline_state = build_pipeline_state_with_blending(
            &device,
            &library,
            "clear_quads",
            "quad_vertex",
            "quad_fragment",
            MTLPixelFormat::BGRA8Unorm,
            false,
        );
        let underlines_pipeline_state = build_pipeline_state(
            &device,
            &library,
            "underlines",
            "underline_vertex",
            "underline_fragment",
            MTLPixelFormat::BGRA8Unorm,
        );
        let monochrome_sprites_pipeline_state = build_pipeline_state(
            &device,
            &library,
            "monochrome_sprites",
            "monochrome_sprite_vertex",
            "monochrome_sprite_fragment",
            MTLPixelFormat::BGRA8Unorm,
        );
        let polychrome_sprites_pipeline_state = build_pipeline_state(
            &device,
            &library,
            "polychrome_sprites",
            "polychrome_sprite_vertex",
            "polychrome_sprite_fragment",
            MTLPixelFormat::BGRA8Unorm,
        );
        let surfaces_pipeline_state = build_pipeline_state(
            &device,
            &library,
            "surfaces",
            "surface_vertex",
            "surface_fragment",
            MTLPixelFormat::BGRA8Unorm,
        );
        // horizontal gaussian into scratch: opaque write (blending off), so the scratch
        // holds the raw horizontally-blurred backdrop the composite pass reads back.
        let backdrop_blur_h_pipeline_state = build_backdrop_blur_pipeline_state(
            &device,
            &library,
            "backdrop_blur_h",
            "backdrop_blur_h_vertex",
            "backdrop_blur_h_fragment",
            MTLPixelFormat::BGRA8Unorm,
            false,
        );
        // vertical gaussian + tint composite back onto the drawable (blending on) so the
        // rounded-rect AA edge composites over the untouched content behind it.
        let backdrop_blur_composite_pipeline_state = build_backdrop_blur_pipeline_state(
            &device,
            &library,
            "backdrop_blur_composite",
            "backdrop_blur_composite_vertex",
            "backdrop_blur_composite_fragment",
            MTLPixelFormat::BGRA8Unorm,
            true,
        );

        let command_queue = device.new_command_queue();
        let sprite_atlas = Arc::new(MetalAtlas::new(device.clone()));
        let core_video_texture_cache =
            CVMetalTextureCache::new(None, device.clone(), None).unwrap();

        Self {
            device,
            layer,
            presents_with_transaction: false,
            command_queue,
            paths_rasterization_pipeline_state,
            path_sprites_pipeline_state,
            shadows_pipeline_state,
            quads_pipeline_state,
            clear_quads_pipeline_state,
            underlines_pipeline_state,
            monochrome_sprites_pipeline_state,
            polychrome_sprites_pipeline_state,
            surfaces_pipeline_state,
            backdrop_blur_h_pipeline_state,
            backdrop_blur_composite_pipeline_state,
            unit_vertices,
            instance_buffer_pool,
            sprite_atlas,
            core_video_texture_cache,
            path_intermediate_texture: None,
            path_intermediate_msaa_texture: None,
            scratch_texture: None,
            retained_texture: None,
            scroll_scratch_texture: None,
            retained_valid: false,
            previous_scene: None,
            path_sample_count: PATH_SAMPLE_COUNT,
        }
    }

    pub fn layer(&self) -> &metal::MetalLayerRef {
        &self.layer
    }

    pub fn layer_ptr(&self) -> *mut CAMetalLayer {
        self.layer.as_ptr()
    }

    pub fn sprite_atlas(&self) -> &Arc<MetalAtlas> {
        &self.sprite_atlas
    }

    pub fn set_presents_with_transaction(&mut self, presents_with_transaction: bool) {
        self.presents_with_transaction = presents_with_transaction;
        self.layer
            .set_presents_with_transaction(presents_with_transaction);
    }

    pub fn update_drawable_size(&mut self, size: Size<DevicePixels>) {
        let size = NSSize {
            width: size.width.0 as f64,
            height: size.height.0 as f64,
        };
        unsafe {
            let _: () = msg_send![
                self.layer(),
                setDrawableSize: size
            ];
        }
        let device_pixels_size = Size {
            width: DevicePixels(size.width as i32),
            height: DevicePixels(size.height as i32),
        };
        self.update_path_intermediate_textures(device_pixels_size);
    }

    fn update_path_intermediate_textures(&mut self, size: Size<DevicePixels>) {
        // We are uncertain when this happens, but sometimes size can be 0 here. Most likely before
        // the layout pass on window creation. Zero-sized texture creation causes SIGABRT.
        // https://github.com/zed-industries/zed/issues/36229
        if size.width.0 <= 0 || size.height.0 <= 0 {
            self.path_intermediate_texture = None;
            self.path_intermediate_msaa_texture = None;
            self.scratch_texture = None;
            self.retained_texture = None;
            self.scroll_scratch_texture = None;
            self.retained_valid = false;
            self.previous_scene = None;
            return;
        }

        let texture_descriptor = metal::TextureDescriptor::new();
        texture_descriptor.set_width(size.width.0 as u64);
        texture_descriptor.set_height(size.height.0 as u64);
        texture_descriptor.set_pixel_format(metal::MTLPixelFormat::BGRA8Unorm);
        texture_descriptor
            .set_usage(metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead);
        self.path_intermediate_texture = Some(self.device.new_texture(&texture_descriptor));
        // full-viewport scratch for the backdrop-blur horizontal pass — same format/usage
        // as the path intermediate (render target + shader read).
        self.scratch_texture = Some(self.device.new_texture(&texture_descriptor));
        self.retained_texture = Some(self.device.new_texture(&texture_descriptor));
        self.scroll_scratch_texture = Some(self.device.new_texture(&texture_descriptor));
        self.retained_valid = false;
        self.previous_scene = None;

        if self.path_sample_count > 1 {
            let mut msaa_descriptor = texture_descriptor;
            msaa_descriptor.set_texture_type(metal::MTLTextureType::D2Multisample);
            msaa_descriptor.set_storage_mode(metal::MTLStorageMode::Private);
            msaa_descriptor.set_sample_count(self.path_sample_count as _);
            self.path_intermediate_msaa_texture = Some(self.device.new_texture(&msaa_descriptor));
        } else {
            self.path_intermediate_msaa_texture = None;
        }
    }

    pub fn update_transparency(&self, _transparent: bool) {
        // todo(mac)?
    }

    pub fn destroy(&self) {
        // nothing to do
    }

    fn retained_plan(&self, scene: &Scene, viewport_size: Size<DevicePixels>) -> RetainedPlan {
        if !self.retained_valid || self.previous_scene.is_none() {
            return RetainedPlan::Full("cold");
        }
        let previous = self.previous_scene.as_ref().unwrap();

        if scene.content_epoch == previous.content_epoch {
            match self.scroll_blit_plan(scene, previous, viewport_size) {
                Ok(Some(plan)) => return RetainedPlan::ScrollBlit(plan),
                Ok(None) => {}
                Err(reason) => {
                    if std::env::var_os("RNGPUI_COMPOSITOR_TRACE").is_some() {
                        eprintln!("[compositor] blitBlocked={reason}");
                    }
                }
            }
        }

        match scene.damage_since(previous) {
            SceneDamage::None => RetainedPlan::Reuse,
            SceneDamage::Bounds(bounds) => {
                let Some(scissor) = scissor_for_bounds(bounds, viewport_size) else {
                    return RetainedPlan::Reuse;
                };
                let full_area = u64::from(i32::from(viewport_size.width).max(0) as u32)
                    .saturating_mul(u64::from(
                        i32::from(viewport_size.height).max(0) as u32,
                    ));
                if full_area == 0 || scissor_area(scissor).saturating_mul(5) >= full_area * 4 {
                    RetainedPlan::Full("damage-threshold")
                } else {
                    RetainedPlan::Damage(scissor)
                }
            }
            SceneDamage::Full(_) => RetainedPlan::Full("structure"),
        }
    }

    fn scroll_blit_plan(
        &self,
        scene: &Scene,
        previous: &SceneSnapshot,
        viewport_size: Size<DevicePixels>,
    ) -> std::result::Result<Option<ScrollBlitPlan>, &'static str> {
        if scene.scroll_regions.len() != previous.scroll_regions.len() {
            return Err("scroll-region-structure");
        }
        let mut changed = None;
        for region in &scene.scroll_regions {
            let Some(prior) = previous.scroll_regions.iter().find(|prior| prior.id == region.id)
            else {
                return Err("scroll-region-identity");
            };
            if region.bounds != prior.bounds {
                return Err("scroll-region-resized");
            }
            if region.offset != prior.offset {
                if changed.is_some() {
                    return Err("multiple-scroll-regions");
                }
                changed = Some((region, prior));
            }
        }
        let Some((region, prior)) = changed else {
            return Ok(None);
        };
        if region.operation_end <= region.operation_start {
            return Err("empty-scroll-layer");
        }
        if scene.scroll_blit_is_volatile(region.bounds) {
            return Err("volatile-scroll-content");
        }
        let Some(viewport) = scissor_for_bounds(region.bounds, viewport_size) else {
            return Err("empty-scroll-viewport");
        };

        let dx = region.offset.x.0 - prior.offset.x.0;
        let dy = region.offset.y.0 - prior.offset.y.0;
        let rounded_x = dx.round();
        let rounded_y = dy.round();
        if (dx - rounded_x).abs() > 0.01 || (dy - rounded_y).abs() > 0.01 {
            return Err("fractional-device-delta");
        }
        let delta_x = rounded_x as i64;
        let delta_y = rounded_y as i64;
        if delta_x != 0 && delta_y != 0 {
            return Err("diagonal-delta");
        }
        if delta_x == 0 && delta_y == 0 {
            return Ok(None);
        }
        if delta_x.unsigned_abs() >= viewport.width || delta_y.unsigned_abs() >= viewport.height {
            return Err("delta-exceeds-viewport");
        }

        let damage = if delta_y > 0 {
            let amount = delta_y as u64;
            MTLScissorRect {
                x: viewport.x,
                y: viewport.y + viewport.height - amount,
                width: viewport.width,
                height: amount,
            }
        } else if delta_y < 0 {
            MTLScissorRect {
                x: viewport.x,
                y: viewport.y,
                width: viewport.width,
                height: delta_y.unsigned_abs(),
            }
        } else if delta_x > 0 {
            let amount = delta_x as u64;
            MTLScissorRect {
                x: viewport.x + viewport.width - amount,
                y: viewport.y,
                width: amount,
                height: viewport.height,
            }
        } else {
            MTLScissorRect {
                x: viewport.x,
                y: viewport.y,
                width: delta_x.unsigned_abs(),
                height: viewport.height,
            }
        };
        let mut repairs = [None; 4];
        let repair_bounds = scene.scroll_blit_fixed_content_repairs(
            region,
            point(ScaledPixels(rounded_x), ScaledPixels(rounded_y)),
        );
        if repair_bounds.len() > repairs.len() {
            return Err("too-many-fixed-repairs");
        }
        let mut repair_area = 0_u64;
        for (slot, bounds) in repairs.iter_mut().zip(repair_bounds) {
            *slot = scissor_for_bounds(bounds, viewport_size);
            if let Some(scissor) = *slot {
                repair_area = repair_area.saturating_add(scissor_area(scissor));
            }
        }
        if repair_area.saturating_mul(5) >= scissor_area(viewport).saturating_mul(4) {
            return Err("fixed-repair-too-large");
        }
        Ok(Some(ScrollBlitPlan {
            viewport,
            delta_x,
            delta_y,
            damage,
            repairs,
        }))
    }

    fn encode_scroll_blit(
        &self,
        command_buffer: &metal::CommandBufferRef,
        retained_texture: &metal::TextureRef,
        plan: ScrollBlitPlan,
    ) -> Result<()> {
        let scratch = self
            .scroll_scratch_texture
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("scroll scratch texture unavailable"))?;
        let viewport = plan.viewport;
        let copy_size = MTLSize {
            width: viewport.width,
            height: viewport.height,
            depth: 1,
        };

        // Metal does not define overlapping copies within one texture. Snapshot the
        // scroll layer first, then copy its still-valid portion back at the new offset.
        let snapshot = command_buffer.new_blit_command_encoder();
        snapshot.copy_from_texture(
            retained_texture,
            0,
            0,
            MTLOrigin {
                x: viewport.x,
                y: viewport.y,
                z: 0,
            },
            copy_size,
            scratch,
            0,
            0,
            MTLOrigin {
                x: viewport.x,
                y: viewport.y,
                z: 0,
            },
        );
        snapshot.end_encoding();

        let abs_x = plan.delta_x.unsigned_abs();
        let abs_y = plan.delta_y.unsigned_abs();
        let mut source = MTLOrigin {
            x: viewport.x,
            y: viewport.y,
            z: 0,
        };
        let mut destination = source;
        let size = MTLSize {
            width: viewport.width - abs_x,
            height: viewport.height - abs_y,
            depth: 1,
        };

        // Scroll offsets grow toward the content end while painted children move in
        // the opposite direction. A positive y offset therefore copies lower source
        // pixels upward and exposes a strip at the bottom.
        if plan.delta_x > 0 {
            source.x += abs_x;
        } else if plan.delta_x < 0 {
            destination.x += abs_x;
        }
        if plan.delta_y > 0 {
            source.y += abs_y;
        } else if plan.delta_y < 0 {
            destination.y += abs_y;
        }

        let shift = command_buffer.new_blit_command_encoder();
        shift.copy_from_texture(
            scratch,
            0,
            0,
            source,
            size,
            retained_texture,
            0,
            0,
            destination,
        );
        shift.end_encoding();
        Ok(())
    }

    pub fn draw(&mut self, scene: &Scene) {
        let layer = self.layer.clone();
        let viewport_size = layer.drawable_size();
        let viewport_size: Size<DevicePixels> = size(
            (viewport_size.width.ceil() as i32).into(),
            (viewport_size.height.ceil() as i32).into(),
        );
        let _nd_t0 = std::time::Instant::now();
        let drawable = if let Some(drawable) = layer.next_drawable() {
            if std::env::var_os("RNGPUI_ACTIVATION_TRACE").is_some() {
                let us = _nd_t0.elapsed().as_micros();
                if us > 1000 {
                    eprintln!(
                        "[act-trace {}] metal next_drawable took {}us",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0),
                        us
                    );
                }
            }
            drawable
        } else {
            log::error!(
                "failed to retrieve next drawable, drawable size: {:?}",
                viewport_size
            );
            return;
        };

        let mut retained_plan = self.retained_plan(scene, viewport_size);
        loop {
            let mut instance_buffer = self.instance_buffer_pool.lock().acquire(&self.device);

            let command_buffer = self.draw_primitives(
                scene,
                &mut instance_buffer,
                drawable,
                viewport_size,
                retained_plan,
            );

            match command_buffer {
                Ok(command_buffer) => {
                    let instance_buffer_pool = self.instance_buffer_pool.clone();
                    let instance_buffer = Cell::new(Some(instance_buffer));
                    let block = ConcreteBlock::new(move |_| {
                        if let Some(instance_buffer) = instance_buffer.take() {
                            instance_buffer_pool.lock().release(instance_buffer);
                        }
                    });
                    let block = block.copy();
                    command_buffer.add_completed_handler(&block);

                    if crate::presentation_trace::is_active() {
                        let content_id = crate::presentation_trace::content_id();
                        let presented = ConcreteBlock::new(move |drawable: &metal::DrawableRef| {
                            crate::presentation_trace::record(
                                drawable.drawable_id() as u64,
                                drawable.presented_time(),
                                content_id,
                            );
                        });
                        let presented = presented.copy();
                        drawable.add_presented_handler(&presented);
                    }

                    if self.presents_with_transaction {
                        let _ws_t0 = std::time::Instant::now();
                        command_buffer.commit();
                        command_buffer.wait_until_scheduled();
                        if std::env::var_os("RNGPUI_ACTIVATION_TRACE").is_some() {
                            let us = _ws_t0.elapsed().as_micros();
                            if us > 1000 {
                                eprintln!(
                                    "[act-trace {}] metal wait_until_scheduled took {}us",
                                    std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_millis())
                                        .unwrap_or(0),
                                    us
                                );
                            }
                        }
                        drawable.present();
                    } else {
                        command_buffer.present_drawable(drawable);
                        command_buffer.commit();
                    }
                    self.retained_valid = true;
                    self.previous_scene = Some(scene.snapshot());
                    if std::env::var_os("RNGPUI_COMPOSITOR_TRACE").is_some() {
                        match retained_plan {
                            RetainedPlan::Full(reason) => {
                                eprintln!("[compositor] mode=record-full reason={reason}")
                            }
                            RetainedPlan::Damage(rect) => eprintln!(
                                "[compositor] mode=record-damage damage={},{},{}x{}",
                                rect.x, rect.y, rect.width, rect.height
                            ),
                            RetainedPlan::Reuse => {
                                eprintln!("[compositor] mode=replay damage=none")
                            }
                            RetainedPlan::ScrollBlit(plan) => {
                                let repair_count = plan.repairs.iter().flatten().count();
                                eprintln!(
                                    "[compositor] mode=scroll-blit delta={},{} damage={},{},{}x{} repairs={}",
                                    plan.delta_x,
                                    plan.delta_y,
                                    plan.damage.x,
                                    plan.damage.y,
                                    plan.damage.width,
                                    plan.damage.height,
                                    repair_count,
                                )
                            }
                        }
                    }
                    return;
                }
                Err(err) => {
                    log::error!(
                        "failed to render: {}. retrying with larger instance buffer size",
                        err
                    );
                    let mut instance_buffer_pool = self.instance_buffer_pool.lock();
                    let buffer_size = instance_buffer_pool.buffer_size;
                    if buffer_size >= 256 * 1024 * 1024 {
                        log::error!("instance buffer size grew too large: {}", buffer_size);
                        break;
                    }
                    instance_buffer_pool.reset(buffer_size * 2);
                    self.retained_valid = false;
                    retained_plan = RetainedPlan::Full("instance-buffer-retry");
                    log::info!(
                        "increased instance buffer size to {}",
                        instance_buffer_pool.buffer_size
                    );
                }
            }
        }
    }

    fn draw_primitives(
        &mut self,
        scene: &Scene,
        instance_buffer: &mut InstanceBuffer,
        drawable: &metal::MetalDrawableRef,
        viewport_size: Size<DevicePixels>,
        retained_plan: RetainedPlan,
    ) -> Result<metal::CommandBuffer> {
        let command_queue = self.command_queue.clone();
        let command_buffer = command_queue.new_command_buffer();
        let alpha = if self.layer.is_opaque() { 1. } else { 0. };
        let mut instance_offset = 0;
        let retained_texture = self
            .retained_texture
            .clone()
            .ok_or_else(|| anyhow::anyhow!("retained texture unavailable"))?;

        if let Some(band) = sprite_trace_band() {
            trace_scene_sprites(scene, band);
        }

        if let RetainedPlan::ScrollBlit(plan) = retained_plan {
            self.encode_scroll_blit(command_buffer, &retained_texture, plan)?;
        }

        let damage_scissors = match retained_plan {
            RetainedPlan::Full(_) => vec![None],
            RetainedPlan::Damage(scissor) => vec![Some(scissor)],
            RetainedPlan::Reuse => Vec::new(),
            RetainedPlan::ScrollBlit(plan) => {
                let mut scissors = vec![Some(plan.damage)];
                scissors.extend(plan.repairs.into_iter().flatten().map(Some));
                scissors
            }
        };

        for damage_scissor in damage_scissors {
            let mut command_encoder = new_command_encoder(
                command_buffer,
                &retained_texture,
                viewport_size,
                damage_scissor,
                |color_attachment| match (retained_plan, damage_scissor) {
                    (RetainedPlan::Full(_), None) => {
                        color_attachment.set_load_action(metal::MTLLoadAction::Clear);
                        color_attachment
                            .set_clear_color(metal::MTLClearColor::new(0., 0., 0., alpha));
                    }
                    _ => color_attachment.set_load_action(metal::MTLLoadAction::Load),
                },
            );

            if let Some(scissor) = damage_scissor {
                let clear_bounds = Bounds::new(
                    point(
                        ScaledPixels(scissor.x as f32),
                        ScaledPixels(scissor.y as f32),
                    ),
                    size(
                        ScaledPixels(scissor.width as f32),
                        ScaledPixels(scissor.height as f32),
                    ),
                );
                let clear_quad = Quad {
                    bounds: clear_bounds,
                    content_mask: ContentMask {
                        bounds: clear_bounds,
                    },
                    ..Quad::default()
                };
                if !self.draw_quads_with_pipeline(
                    std::slice::from_ref(&clear_quad),
                    &self.clear_quads_pipeline_state,
                    instance_buffer,
                    &mut instance_offset,
                    viewport_size,
                    command_encoder,
                ) {
                    command_encoder.end_encoding();
                    anyhow::bail!("scene too large while clearing damage");
                }
            }

            for batch in scene.batches() {
                let ok = match batch {
                    PrimitiveBatch::Shadows(shadows) => self.draw_shadows(
                        shadows,
                        instance_buffer,
                        &mut instance_offset,
                        viewport_size,
                        command_encoder,
                    ),
                    PrimitiveBatch::Quads(quads) => self.draw_quads(
                        quads,
                        instance_buffer,
                        &mut instance_offset,
                        viewport_size,
                        command_encoder,
                    ),
                    PrimitiveBatch::Paths(paths) => {
                        command_encoder.end_encoding();

                        let did_draw = self.draw_paths_to_intermediate(
                            paths,
                            instance_buffer,
                            &mut instance_offset,
                            viewport_size,
                            command_buffer,
                        );

                        command_encoder = new_command_encoder(
                            command_buffer,
                            &retained_texture,
                            viewport_size,
                            damage_scissor,
                            |color_attachment| {
                                color_attachment.set_load_action(metal::MTLLoadAction::Load);
                            },
                        );

                        if did_draw {
                            self.draw_paths_from_intermediate(
                                paths,
                                instance_buffer,
                                &mut instance_offset,
                                viewport_size,
                                command_encoder,
                            )
                        } else {
                            false
                        }
                    }
                    PrimitiveBatch::Underlines(underlines) => self.draw_underlines(
                        underlines,
                        instance_buffer,
                        &mut instance_offset,
                        viewport_size,
                        command_encoder,
                    ),
                    PrimitiveBatch::MonochromeSprites {
                        texture_id,
                        sprites,
                    } => self.draw_monochrome_sprites(
                        texture_id,
                        sprites,
                        instance_buffer,
                        &mut instance_offset,
                        viewport_size,
                        command_encoder,
                    ),
                    PrimitiveBatch::PolychromeSprites {
                        texture_id,
                        sprites,
                    } => self.draw_polychrome_sprites(
                        texture_id,
                        sprites,
                        instance_buffer,
                        &mut instance_offset,
                        viewport_size,
                        command_encoder,
                    ),
                    PrimitiveBatch::Surfaces(surfaces) => self.draw_surfaces(
                        surfaces,
                        instance_buffer,
                        &mut instance_offset,
                        viewport_size,
                        command_encoder,
                    ),
                    PrimitiveBatch::BackdropBlurs(blurs) => {
                        command_encoder.end_encoding();

                        let did_draw = self.draw_backdrop_blurs(
                            blurs,
                            instance_buffer,
                            &mut instance_offset,
                            viewport_size,
                            &retained_texture,
                            command_buffer,
                        );

                        command_encoder = new_command_encoder(
                            command_buffer,
                            &retained_texture,
                            viewport_size,
                            damage_scissor,
                            |color_attachment| {
                                color_attachment.set_load_action(metal::MTLLoadAction::Load);
                            },
                        );

                        did_draw
                    }
                };
                if !ok {
                    command_encoder.end_encoding();
                    anyhow::bail!(
                        "scene too large: {} paths, {} shadows, {} quads, {} underlines, {} mono, {} poly, {} surfaces, {} backdrop_blurs",
                        scene.paths.len(),
                        scene.shadows.len(),
                        scene.quads.len(),
                        scene.underlines.len(),
                        scene.monochrome_sprites.len(),
                        scene.polychrome_sprites.len(),
                        scene.surfaces.len(),
                        scene.backdrop_blurs.len(),
                    );
                }
            }

            command_encoder.end_encoding();
        }

        let blit = command_buffer.new_blit_command_encoder();
        blit.copy_from_texture(
            &retained_texture,
            0,
            0,
            MTLOrigin { x: 0, y: 0, z: 0 },
            MTLSize {
                width: i32::from(viewport_size.width).max(0) as u64,
                height: i32::from(viewport_size.height).max(0) as u64,
                depth: 1,
            },
            drawable.texture(),
            0,
            0,
            MTLOrigin { x: 0, y: 0, z: 0 },
        );
        blit.end_encoding();

        if instance_offset > 0 {
            instance_buffer.metal_buffer.did_modify_range(NSRange {
                location: 0,
                length: instance_offset as NSUInteger,
            });
        }
        Ok(command_buffer.to_owned())
    }

    fn draw_paths_to_intermediate(
        &self,
        paths: &[Path<ScaledPixels>],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_buffer: &metal::CommandBufferRef,
    ) -> bool {
        if paths.is_empty() {
            return true;
        }
        let Some(intermediate_texture) = &self.path_intermediate_texture else {
            return false;
        };

        let render_pass_descriptor = metal::RenderPassDescriptor::new();
        let color_attachment = render_pass_descriptor
            .color_attachments()
            .object_at(0)
            .unwrap();
        color_attachment.set_load_action(metal::MTLLoadAction::Clear);
        color_attachment.set_clear_color(metal::MTLClearColor::new(0., 0., 0., 0.));

        if let Some(msaa_texture) = &self.path_intermediate_msaa_texture {
            color_attachment.set_texture(Some(msaa_texture));
            color_attachment.set_resolve_texture(Some(intermediate_texture));
            color_attachment.set_store_action(metal::MTLStoreAction::MultisampleResolve);
        } else {
            color_attachment.set_texture(Some(intermediate_texture));
            color_attachment.set_store_action(metal::MTLStoreAction::Store);
        }

        let command_encoder = command_buffer.new_render_command_encoder(render_pass_descriptor);
        command_encoder.set_render_pipeline_state(&self.paths_rasterization_pipeline_state);

        align_offset(instance_offset);
        let mut vertices = Vec::new();
        for path in paths {
            vertices.extend(path.vertices.iter().map(|v| PathRasterizationVertex {
                xy_position: v.xy_position,
                st_position: v.st_position,
                color: path.color,
                bounds: path.bounds.intersect(&path.content_mask.bounds),
            }));
        }
        let vertices_bytes_len = mem::size_of_val(vertices.as_slice());
        let next_offset = *instance_offset + vertices_bytes_len;
        if next_offset > instance_buffer.size {
            command_encoder.end_encoding();
            return false;
        }
        command_encoder.set_vertex_buffer(
            PathRasterizationInputIndex::Vertices as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_vertex_bytes(
            PathRasterizationInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );
        command_encoder.set_fragment_buffer(
            PathRasterizationInputIndex::Vertices as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        let buffer_contents =
            unsafe { (instance_buffer.metal_buffer.contents() as *mut u8).add(*instance_offset) };
        unsafe {
            ptr::copy_nonoverlapping(
                vertices.as_ptr() as *const u8,
                buffer_contents,
                vertices_bytes_len,
            );
        }
        command_encoder.draw_primitives(
            metal::MTLPrimitiveType::Triangle,
            0,
            vertices.len() as u64,
        );
        *instance_offset = next_offset;

        command_encoder.end_encoding();
        true
    }

    fn draw_shadows(
        &self,
        shadows: &[Shadow],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        if shadows.is_empty() {
            return true;
        }
        align_offset(instance_offset);

        command_encoder.set_render_pipeline_state(&self.shadows_pipeline_state);
        command_encoder.set_vertex_buffer(
            ShadowInputIndex::Vertices as u64,
            Some(&self.unit_vertices),
            0,
        );
        command_encoder.set_vertex_buffer(
            ShadowInputIndex::Shadows as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_fragment_buffer(
            ShadowInputIndex::Shadows as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );

        command_encoder.set_vertex_bytes(
            ShadowInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );

        let shadow_bytes_len = mem::size_of_val(shadows);
        let buffer_contents =
            unsafe { (instance_buffer.metal_buffer.contents() as *mut u8).add(*instance_offset) };

        let next_offset = *instance_offset + shadow_bytes_len;
        if next_offset > instance_buffer.size {
            return false;
        }

        unsafe {
            ptr::copy_nonoverlapping(
                shadows.as_ptr() as *const u8,
                buffer_contents,
                shadow_bytes_len,
            );
        }

        command_encoder.draw_primitives_instanced(
            metal::MTLPrimitiveType::Triangle,
            0,
            6,
            shadows.len() as u64,
        );
        *instance_offset = next_offset;
        true
    }

    fn draw_quads(
        &self,
        quads: &[Quad],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        self.draw_quads_with_pipeline(
            quads,
            &self.quads_pipeline_state,
            instance_buffer,
            instance_offset,
            viewport_size,
            command_encoder,
        )
    }

    fn draw_quads_with_pipeline(
        &self,
        quads: &[Quad],
        pipeline: &metal::RenderPipelineStateRef,
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        if quads.is_empty() {
            return true;
        }
        align_offset(instance_offset);

        command_encoder.set_render_pipeline_state(pipeline);
        command_encoder.set_vertex_buffer(
            QuadInputIndex::Vertices as u64,
            Some(&self.unit_vertices),
            0,
        );
        command_encoder.set_vertex_buffer(
            QuadInputIndex::Quads as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_fragment_buffer(
            QuadInputIndex::Quads as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );

        command_encoder.set_vertex_bytes(
            QuadInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );

        let quad_bytes_len = mem::size_of_val(quads);
        let buffer_contents =
            unsafe { (instance_buffer.metal_buffer.contents() as *mut u8).add(*instance_offset) };

        let next_offset = *instance_offset + quad_bytes_len;
        if next_offset > instance_buffer.size {
            return false;
        }

        unsafe {
            ptr::copy_nonoverlapping(quads.as_ptr() as *const u8, buffer_contents, quad_bytes_len);
        }

        command_encoder.draw_primitives_instanced(
            metal::MTLPrimitiveType::Triangle,
            0,
            6,
            quads.len() as u64,
        );
        *instance_offset = next_offset;
        true
    }

    fn draw_paths_from_intermediate(
        &self,
        paths: &[Path<ScaledPixels>],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        let Some(first_path) = paths.first() else {
            return true;
        };

        let Some(ref intermediate_texture) = self.path_intermediate_texture else {
            return false;
        };

        command_encoder.set_render_pipeline_state(&self.path_sprites_pipeline_state);
        command_encoder.set_vertex_buffer(
            SpriteInputIndex::Vertices as u64,
            Some(&self.unit_vertices),
            0,
        );
        command_encoder.set_vertex_bytes(
            SpriteInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );

        command_encoder.set_fragment_texture(
            SpriteInputIndex::AtlasTexture as u64,
            Some(intermediate_texture),
        );

        // When copying paths from the intermediate texture to the drawable,
        // each pixel must only be copied once, in case of transparent paths.
        //
        // If all paths have the same draw order, then their bounds are all
        // disjoint, so we can copy each path's bounds individually. If this
        // batch combines different draw orders, we perform a single copy
        // for a minimal spanning rect.
        let sprites;
        if paths.last().unwrap().order == first_path.order {
            sprites = paths
                .iter()
                .map(|path| PathSprite {
                    bounds: path.clipped_bounds(),
                })
                .collect();
        } else {
            let mut bounds = first_path.clipped_bounds();
            for path in paths.iter().skip(1) {
                bounds = bounds.union(&path.clipped_bounds());
            }
            sprites = vec![PathSprite { bounds }];
        }

        align_offset(instance_offset);
        let sprite_bytes_len = mem::size_of_val(sprites.as_slice());
        let next_offset = *instance_offset + sprite_bytes_len;
        if next_offset > instance_buffer.size {
            return false;
        }

        command_encoder.set_vertex_buffer(
            SpriteInputIndex::Sprites as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );

        let buffer_contents =
            unsafe { (instance_buffer.metal_buffer.contents() as *mut u8).add(*instance_offset) };
        unsafe {
            ptr::copy_nonoverlapping(
                sprites.as_ptr() as *const u8,
                buffer_contents,
                sprite_bytes_len,
            );
        }

        command_encoder.draw_primitives_instanced(
            metal::MTLPrimitiveType::Triangle,
            0,
            6,
            sprites.len() as u64,
        );
        *instance_offset = next_offset;

        true
    }

    fn draw_underlines(
        &self,
        underlines: &[Underline],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        if underlines.is_empty() {
            return true;
        }
        align_offset(instance_offset);

        command_encoder.set_render_pipeline_state(&self.underlines_pipeline_state);
        command_encoder.set_vertex_buffer(
            UnderlineInputIndex::Vertices as u64,
            Some(&self.unit_vertices),
            0,
        );
        command_encoder.set_vertex_buffer(
            UnderlineInputIndex::Underlines as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_fragment_buffer(
            UnderlineInputIndex::Underlines as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );

        command_encoder.set_vertex_bytes(
            UnderlineInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );

        let underline_bytes_len = mem::size_of_val(underlines);
        let buffer_contents =
            unsafe { (instance_buffer.metal_buffer.contents() as *mut u8).add(*instance_offset) };

        let next_offset = *instance_offset + underline_bytes_len;
        if next_offset > instance_buffer.size {
            return false;
        }

        unsafe {
            ptr::copy_nonoverlapping(
                underlines.as_ptr() as *const u8,
                buffer_contents,
                underline_bytes_len,
            );
        }

        command_encoder.draw_primitives_instanced(
            metal::MTLPrimitiveType::Triangle,
            0,
            6,
            underlines.len() as u64,
        );
        *instance_offset = next_offset;
        true
    }

    fn draw_monochrome_sprites(
        &self,
        texture_id: AtlasTextureId,
        sprites: &[MonochromeSprite],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        if sprites.is_empty() {
            return true;
        }
        align_offset(instance_offset);

        let sprite_bytes_len = mem::size_of_val(sprites);
        let buffer_contents =
            unsafe { (instance_buffer.metal_buffer.contents() as *mut u8).add(*instance_offset) };

        let next_offset = *instance_offset + sprite_bytes_len;
        if next_offset > instance_buffer.size {
            return false;
        }

        let texture = self.sprite_atlas.metal_texture(texture_id);
        let texture_size = size(
            DevicePixels(texture.width() as i32),
            DevicePixels(texture.height() as i32),
        );
        command_encoder.set_render_pipeline_state(&self.monochrome_sprites_pipeline_state);
        command_encoder.set_vertex_buffer(
            SpriteInputIndex::Vertices as u64,
            Some(&self.unit_vertices),
            0,
        );
        command_encoder.set_vertex_buffer(
            SpriteInputIndex::Sprites as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_vertex_bytes(
            SpriteInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );
        command_encoder.set_vertex_bytes(
            SpriteInputIndex::AtlasTextureSize as u64,
            mem::size_of_val(&texture_size) as u64,
            &texture_size as *const Size<DevicePixels> as *const _,
        );
        command_encoder.set_fragment_buffer(
            SpriteInputIndex::Sprites as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_fragment_texture(SpriteInputIndex::AtlasTexture as u64, Some(&texture));

        unsafe {
            ptr::copy_nonoverlapping(
                sprites.as_ptr() as *const u8,
                buffer_contents,
                sprite_bytes_len,
            );
        }

        command_encoder.draw_primitives_instanced(
            metal::MTLPrimitiveType::Triangle,
            0,
            6,
            sprites.len() as u64,
        );
        *instance_offset = next_offset;
        true
    }

    fn draw_polychrome_sprites(
        &self,
        texture_id: AtlasTextureId,
        sprites: &[PolychromeSprite],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        if sprites.is_empty() {
            return true;
        }
        align_offset(instance_offset);

        let texture = self.sprite_atlas.metal_texture(texture_id);
        let texture_size = size(
            DevicePixels(texture.width() as i32),
            DevicePixels(texture.height() as i32),
        );
        command_encoder.set_render_pipeline_state(&self.polychrome_sprites_pipeline_state);
        command_encoder.set_vertex_buffer(
            SpriteInputIndex::Vertices as u64,
            Some(&self.unit_vertices),
            0,
        );
        command_encoder.set_vertex_buffer(
            SpriteInputIndex::Sprites as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_vertex_bytes(
            SpriteInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );
        command_encoder.set_vertex_bytes(
            SpriteInputIndex::AtlasTextureSize as u64,
            mem::size_of_val(&texture_size) as u64,
            &texture_size as *const Size<DevicePixels> as *const _,
        );
        command_encoder.set_fragment_buffer(
            SpriteInputIndex::Sprites as u64,
            Some(&instance_buffer.metal_buffer),
            *instance_offset as u64,
        );
        command_encoder.set_fragment_texture(SpriteInputIndex::AtlasTexture as u64, Some(&texture));

        let sprite_bytes_len = mem::size_of_val(sprites);
        let buffer_contents =
            unsafe { (instance_buffer.metal_buffer.contents() as *mut u8).add(*instance_offset) };

        let next_offset = *instance_offset + sprite_bytes_len;
        if next_offset > instance_buffer.size {
            return false;
        }

        unsafe {
            ptr::copy_nonoverlapping(
                sprites.as_ptr() as *const u8,
                buffer_contents,
                sprite_bytes_len,
            );
        }

        command_encoder.draw_primitives_instanced(
            metal::MTLPrimitiveType::Triangle,
            0,
            6,
            sprites.len() as u64,
        );
        *instance_offset = next_offset;
        true
    }

    fn draw_surfaces(
        &mut self,
        surfaces: &[PaintSurface],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        command_encoder: &metal::RenderCommandEncoderRef,
    ) -> bool {
        command_encoder.set_render_pipeline_state(&self.surfaces_pipeline_state);
        command_encoder.set_vertex_buffer(
            SurfaceInputIndex::Vertices as u64,
            Some(&self.unit_vertices),
            0,
        );
        command_encoder.set_vertex_bytes(
            SurfaceInputIndex::ViewportSize as u64,
            mem::size_of_val(&viewport_size) as u64,
            &viewport_size as *const Size<DevicePixels> as *const _,
        );

        for surface in surfaces {
            let texture_size = size(
                DevicePixels::from(surface.image_buffer.get_width() as i32),
                DevicePixels::from(surface.image_buffer.get_height() as i32),
            );

            assert_eq!(
                surface.image_buffer.get_pixel_format(),
                kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            );

            let y_texture = self
                .core_video_texture_cache
                .create_texture_from_image(
                    surface.image_buffer.as_concrete_TypeRef(),
                    None,
                    MTLPixelFormat::R8Unorm,
                    surface.image_buffer.get_width_of_plane(0),
                    surface.image_buffer.get_height_of_plane(0),
                    0,
                )
                .unwrap();
            let cb_cr_texture = self
                .core_video_texture_cache
                .create_texture_from_image(
                    surface.image_buffer.as_concrete_TypeRef(),
                    None,
                    MTLPixelFormat::RG8Unorm,
                    surface.image_buffer.get_width_of_plane(1),
                    surface.image_buffer.get_height_of_plane(1),
                    1,
                )
                .unwrap();

            align_offset(instance_offset);
            let next_offset = *instance_offset + mem::size_of::<Surface>();
            if next_offset > instance_buffer.size {
                return false;
            }

            command_encoder.set_vertex_buffer(
                SurfaceInputIndex::Surfaces as u64,
                Some(&instance_buffer.metal_buffer),
                *instance_offset as u64,
            );
            command_encoder.set_vertex_bytes(
                SurfaceInputIndex::TextureSize as u64,
                mem::size_of_val(&texture_size) as u64,
                &texture_size as *const Size<DevicePixels> as *const _,
            );
            // let y_texture = y_texture.get_texture().unwrap().
            command_encoder.set_fragment_texture(SurfaceInputIndex::YTexture as u64, unsafe {
                let texture = CVMetalTextureGetTexture(y_texture.as_concrete_TypeRef());
                Some(metal::TextureRef::from_ptr(texture as *mut _))
            });
            command_encoder.set_fragment_texture(SurfaceInputIndex::CbCrTexture as u64, unsafe {
                let texture = CVMetalTextureGetTexture(cb_cr_texture.as_concrete_TypeRef());
                Some(metal::TextureRef::from_ptr(texture as *mut _))
            });

            unsafe {
                let buffer_contents = (instance_buffer.metal_buffer.contents() as *mut u8)
                    .add(*instance_offset)
                    as *mut SurfaceBounds;
                ptr::write(
                    buffer_contents,
                    SurfaceBounds {
                        bounds: surface.bounds,
                        content_mask: surface.content_mask.clone(),
                    },
                );
            }

            command_encoder.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 6);
            *instance_offset = next_offset;
        }
        true
    }

    fn draw_backdrop_blurs(
        &self,
        blurs: &[BackdropBlur],
        instance_buffer: &mut InstanceBuffer,
        instance_offset: &mut usize,
        viewport_size: Size<DevicePixels>,
        target_texture: &metal::TextureRef,
        command_buffer: &metal::CommandBufferRef,
    ) -> bool {
        if blurs.is_empty() {
            return true;
        }
        let Some(scratch_texture) = &self.scratch_texture else {
            return false;
        };

        let viewport_w = i32::from(viewport_size.width);
        let viewport_h = i32::from(viewport_size.height);

        for blur in blurs {
            // upload this blur as a one-element instance buffer the two passes both index.
            align_offset(instance_offset);
            let blur_bytes_len = mem::size_of::<BackdropBlur>();
            let next_offset = *instance_offset + blur_bytes_len;
            if next_offset > instance_buffer.size {
                return false;
            }
            let blur_offset = *instance_offset;
            unsafe {
                let buffer_contents =
                    (instance_buffer.metal_buffer.contents() as *mut u8).add(blur_offset);
                ptr::copy_nonoverlapping(
                    blur as *const BackdropBlur as *const u8,
                    buffer_contents,
                    blur_bytes_len,
                );
            }
            *instance_offset = next_offset;

            // blur rect intersected with its content mask, in device px.
            let clip = blur.bounds.intersect(&blur.content_mask.bounds);
            if clip.size.width.0 <= 0.0 || clip.size.height.0 <= 0.0 {
                continue;
            }
            let margin = (3.0 * blur.blur_radius.0).ceil() as i32;
            let x0 = (clip.origin.x.0.floor() as i32).clamp(0, viewport_w);
            let x1 = ((clip.origin.x.0 + clip.size.width.0).ceil() as i32).clamp(0, viewport_w);
            let y0 = (clip.origin.y.0.floor() as i32).clamp(0, viewport_h);
            let y1 = ((clip.origin.y.0 + clip.size.height.0).ceil() as i32).clamp(0, viewport_h);
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            // h pass writes a vertically-expanded band so the v pass has valid neighbors.
            let hy0 = (y0 - margin).clamp(0, viewport_h);
            let hy1 = (y1 + margin).clamp(0, viewport_h);

            // --- horizontal pass: drawable -> scratch (blending off) ---
            {
                let render_pass_descriptor = metal::RenderPassDescriptor::new();
                let color_attachment = render_pass_descriptor
                    .color_attachments()
                    .object_at(0)
                    .unwrap();
                color_attachment.set_texture(Some(scratch_texture));
                color_attachment.set_load_action(metal::MTLLoadAction::Load);
                color_attachment.set_store_action(metal::MTLStoreAction::Store);
                let encoder =
                    command_buffer.new_render_command_encoder(render_pass_descriptor);
                encoder.set_viewport(metal::MTLViewport {
                    originX: 0.0,
                    originY: 0.0,
                    width: viewport_w as f64,
                    height: viewport_h as f64,
                    znear: 0.0,
                    zfar: 1.0,
                });
                encoder.set_scissor_rect(metal::MTLScissorRect {
                    x: x0 as u64,
                    y: hy0 as u64,
                    width: (x1 - x0) as u64,
                    height: (hy1 - hy0) as u64,
                });
                encoder.set_render_pipeline_state(&self.backdrop_blur_h_pipeline_state);
                encoder.set_vertex_buffer(
                    BackdropBlurInputIndex::Vertices as u64,
                    Some(&self.unit_vertices),
                    0,
                );
                encoder.set_vertex_buffer(
                    BackdropBlurInputIndex::Blurs as u64,
                    Some(&instance_buffer.metal_buffer),
                    blur_offset as u64,
                );
                encoder.set_vertex_bytes(
                    BackdropBlurInputIndex::ViewportSize as u64,
                    mem::size_of_val(&viewport_size) as u64,
                    &viewport_size as *const Size<DevicePixels> as *const _,
                );
                encoder.set_fragment_buffer(
                    BackdropBlurInputIndex::Blurs as u64,
                    Some(&instance_buffer.metal_buffer),
                    blur_offset as u64,
                );
                encoder.set_fragment_bytes(
                    BackdropBlurInputIndex::ViewportSize as u64,
                    mem::size_of_val(&viewport_size) as u64,
                    &viewport_size as *const Size<DevicePixels> as *const _,
                );
                encoder.set_fragment_texture(
                    BackdropBlurInputIndex::InputTexture as u64,
                    Some(target_texture),
                );
                encoder.draw_primitives_instanced(metal::MTLPrimitiveType::Triangle, 0, 6, 1);
                encoder.end_encoding();
            }

            // --- composite pass: scratch -> drawable (blending on) ---
            {
                let render_pass_descriptor = metal::RenderPassDescriptor::new();
                let color_attachment = render_pass_descriptor
                    .color_attachments()
                    .object_at(0)
                    .unwrap();
                color_attachment.set_texture(Some(target_texture));
                color_attachment.set_load_action(metal::MTLLoadAction::Load);
                color_attachment.set_store_action(metal::MTLStoreAction::Store);
                let encoder =
                    command_buffer.new_render_command_encoder(render_pass_descriptor);
                encoder.set_viewport(metal::MTLViewport {
                    originX: 0.0,
                    originY: 0.0,
                    width: viewport_w as f64,
                    height: viewport_h as f64,
                    znear: 0.0,
                    zfar: 1.0,
                });
                encoder.set_scissor_rect(metal::MTLScissorRect {
                    x: x0 as u64,
                    y: y0 as u64,
                    width: (x1 - x0) as u64,
                    height: (y1 - y0) as u64,
                });
                encoder
                    .set_render_pipeline_state(&self.backdrop_blur_composite_pipeline_state);
                encoder.set_vertex_buffer(
                    BackdropBlurInputIndex::Vertices as u64,
                    Some(&self.unit_vertices),
                    0,
                );
                encoder.set_vertex_buffer(
                    BackdropBlurInputIndex::Blurs as u64,
                    Some(&instance_buffer.metal_buffer),
                    blur_offset as u64,
                );
                encoder.set_vertex_bytes(
                    BackdropBlurInputIndex::ViewportSize as u64,
                    mem::size_of_val(&viewport_size) as u64,
                    &viewport_size as *const Size<DevicePixels> as *const _,
                );
                encoder.set_fragment_buffer(
                    BackdropBlurInputIndex::Blurs as u64,
                    Some(&instance_buffer.metal_buffer),
                    blur_offset as u64,
                );
                encoder.set_fragment_bytes(
                    BackdropBlurInputIndex::ViewportSize as u64,
                    mem::size_of_val(&viewport_size) as u64,
                    &viewport_size as *const Size<DevicePixels> as *const _,
                );
                encoder.set_fragment_texture(
                    BackdropBlurInputIndex::InputTexture as u64,
                    Some(scratch_texture),
                );
                encoder.draw_primitives_instanced(metal::MTLPrimitiveType::Triangle, 0, 6, 1);
                encoder.end_encoding();
            }
        }
        true
    }
}

fn new_command_encoder<'a>(
    command_buffer: &'a metal::CommandBufferRef,
    target_texture: &'a metal::TextureRef,
    viewport_size: Size<DevicePixels>,
    scissor: Option<MTLScissorRect>,
    configure_color_attachment: impl Fn(&RenderPassColorAttachmentDescriptorRef),
) -> &'a metal::RenderCommandEncoderRef {
    let render_pass_descriptor = metal::RenderPassDescriptor::new();
    let color_attachment = render_pass_descriptor
        .color_attachments()
        .object_at(0)
        .unwrap();
    color_attachment.set_texture(Some(target_texture));
    color_attachment.set_store_action(metal::MTLStoreAction::Store);
    configure_color_attachment(color_attachment);

    let command_encoder = command_buffer.new_render_command_encoder(render_pass_descriptor);
    command_encoder.set_viewport(metal::MTLViewport {
        originX: 0.0,
        originY: 0.0,
        width: i32::from(viewport_size.width) as f64,
        height: i32::from(viewport_size.height) as f64,
        znear: 0.0,
        zfar: 1.0,
    });
    if let Some(scissor) = scissor {
        command_encoder.set_scissor_rect(scissor);
    }
    command_encoder
}

fn build_pipeline_state(
    device: &metal::DeviceRef,
    library: &metal::LibraryRef,
    label: &str,
    vertex_fn_name: &str,
    fragment_fn_name: &str,
    pixel_format: metal::MTLPixelFormat,
) -> metal::RenderPipelineState {
    build_pipeline_state_with_blending(
        device,
        library,
        label,
        vertex_fn_name,
        fragment_fn_name,
        pixel_format,
        true,
    )
}

fn build_pipeline_state_with_blending(
    device: &metal::DeviceRef,
    library: &metal::LibraryRef,
    label: &str,
    vertex_fn_name: &str,
    fragment_fn_name: &str,
    pixel_format: metal::MTLPixelFormat,
    blending: bool,
) -> metal::RenderPipelineState {
    let vertex_fn = library
        .get_function(vertex_fn_name, None)
        .expect("error locating vertex function");
    let fragment_fn = library
        .get_function(fragment_fn_name, None)
        .expect("error locating fragment function");

    let descriptor = metal::RenderPipelineDescriptor::new();
    descriptor.set_label(label);
    descriptor.set_vertex_function(Some(vertex_fn.as_ref()));
    descriptor.set_fragment_function(Some(fragment_fn.as_ref()));
    let color_attachment = descriptor.color_attachments().object_at(0).unwrap();
    color_attachment.set_pixel_format(pixel_format);
    color_attachment.set_blending_enabled(blending);
    color_attachment.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
    color_attachment.set_alpha_blend_operation(metal::MTLBlendOperation::Add);
    color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::SourceAlpha);
    color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
    color_attachment.set_destination_alpha_blend_factor(metal::MTLBlendFactor::One);

    device
        .new_render_pipeline_state(&descriptor)
        .expect("could not create render pipeline state")
}

fn build_path_sprite_pipeline_state(
    device: &metal::DeviceRef,
    library: &metal::LibraryRef,
    label: &str,
    vertex_fn_name: &str,
    fragment_fn_name: &str,
    pixel_format: metal::MTLPixelFormat,
) -> metal::RenderPipelineState {
    let vertex_fn = library
        .get_function(vertex_fn_name, None)
        .expect("error locating vertex function");
    let fragment_fn = library
        .get_function(fragment_fn_name, None)
        .expect("error locating fragment function");

    let descriptor = metal::RenderPipelineDescriptor::new();
    descriptor.set_label(label);
    descriptor.set_vertex_function(Some(vertex_fn.as_ref()));
    descriptor.set_fragment_function(Some(fragment_fn.as_ref()));
    let color_attachment = descriptor.color_attachments().object_at(0).unwrap();
    color_attachment.set_pixel_format(pixel_format);
    color_attachment.set_blending_enabled(true);
    color_attachment.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
    color_attachment.set_alpha_blend_operation(metal::MTLBlendOperation::Add);
    color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
    color_attachment.set_destination_alpha_blend_factor(metal::MTLBlendFactor::One);

    device
        .new_render_pipeline_state(&descriptor)
        .expect("could not create render pipeline state")
}

fn build_path_rasterization_pipeline_state(
    device: &metal::DeviceRef,
    library: &metal::LibraryRef,
    label: &str,
    vertex_fn_name: &str,
    fragment_fn_name: &str,
    pixel_format: metal::MTLPixelFormat,
    path_sample_count: u32,
) -> metal::RenderPipelineState {
    let vertex_fn = library
        .get_function(vertex_fn_name, None)
        .expect("error locating vertex function");
    let fragment_fn = library
        .get_function(fragment_fn_name, None)
        .expect("error locating fragment function");

    let descriptor = metal::RenderPipelineDescriptor::new();
    descriptor.set_label(label);
    descriptor.set_vertex_function(Some(vertex_fn.as_ref()));
    descriptor.set_fragment_function(Some(fragment_fn.as_ref()));
    if path_sample_count > 1 {
        descriptor.set_raster_sample_count(path_sample_count as _);
        descriptor.set_alpha_to_coverage_enabled(false);
    }
    let color_attachment = descriptor.color_attachments().object_at(0).unwrap();
    color_attachment.set_pixel_format(pixel_format);
    color_attachment.set_blending_enabled(true);
    color_attachment.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
    color_attachment.set_alpha_blend_operation(metal::MTLBlendOperation::Add);
    color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
    color_attachment.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
    color_attachment.set_destination_alpha_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);

    device
        .new_render_pipeline_state(&descriptor)
        .expect("could not create render pipeline state")
}

fn build_backdrop_blur_pipeline_state(
    device: &metal::DeviceRef,
    library: &metal::LibraryRef,
    label: &str,
    vertex_fn_name: &str,
    fragment_fn_name: &str,
    pixel_format: metal::MTLPixelFormat,
    blending: bool,
) -> metal::RenderPipelineState {
    let vertex_fn = library
        .get_function(vertex_fn_name, None)
        .expect("error locating vertex function");
    let fragment_fn = library
        .get_function(fragment_fn_name, None)
        .expect("error locating fragment function");

    let descriptor = metal::RenderPipelineDescriptor::new();
    descriptor.set_label(label);
    descriptor.set_vertex_function(Some(vertex_fn.as_ref()));
    descriptor.set_fragment_function(Some(fragment_fn.as_ref()));
    let color_attachment = descriptor.color_attachments().object_at(0).unwrap();
    color_attachment.set_pixel_format(pixel_format);
    // h pass writes opaque scratch (blending off); composite pass blends its AA edge over
    // the untouched drawable with standard premultiplied src-over.
    color_attachment.set_blending_enabled(blending);
    if blending {
        color_attachment.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
        color_attachment.set_alpha_blend_operation(metal::MTLBlendOperation::Add);
        color_attachment.set_source_rgb_blend_factor(metal::MTLBlendFactor::SourceAlpha);
        color_attachment.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
        color_attachment
            .set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
        color_attachment.set_destination_alpha_blend_factor(metal::MTLBlendFactor::One);
    }

    device
        .new_render_pipeline_state(&descriptor)
        .expect("could not create render pipeline state")
}

// Align to multiples of 256 make Metal happy.
fn align_offset(offset: &mut usize) {
    *offset = (*offset).div_ceil(256) * 256;
}

#[repr(C)]
enum ShadowInputIndex {
    Vertices = 0,
    Shadows = 1,
    ViewportSize = 2,
}

#[repr(C)]
enum QuadInputIndex {
    Vertices = 0,
    Quads = 1,
    ViewportSize = 2,
}

#[repr(C)]
enum UnderlineInputIndex {
    Vertices = 0,
    Underlines = 1,
    ViewportSize = 2,
}

#[repr(C)]
enum SpriteInputIndex {
    Vertices = 0,
    Sprites = 1,
    ViewportSize = 2,
    AtlasTextureSize = 3,
    AtlasTexture = 4,
}

#[repr(C)]
enum SurfaceInputIndex {
    Vertices = 0,
    Surfaces = 1,
    ViewportSize = 2,
    TextureSize = 3,
    YTexture = 4,
    CbCrTexture = 5,
}

#[repr(C)]
enum PathRasterizationInputIndex {
    Vertices = 0,
    ViewportSize = 1,
}

#[repr(C)]
enum BackdropBlurInputIndex {
    Vertices = 0,
    Blurs = 1,
    ViewportSize = 2,
    InputTexture = 3,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct PathSprite {
    pub bounds: Bounds<ScaledPixels>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct SurfaceBounds {
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
}
