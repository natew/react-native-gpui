mod elements;
mod events;
mod gestures;
mod renderer;
mod style;

use std::ffi::{CStr, CString, c_char};

use tokio::sync::oneshot;

use crate::renderer::{RenderCommand, start_gpui_thread};

/// Check if GPUI is ready.
#[unsafe(no_mangle)]
pub extern "C" fn rngpui_is_ready() -> bool {
    crate::renderer::is_ready()
}

/// Initialize GPUI.
#[unsafe(no_mangle)]
pub extern "C" fn rngpui_init() -> bool {
    start_gpui_thread();
    true
}

/// Create a new window. Returns window ID.
#[unsafe(no_mangle)]
pub extern "C" fn rngpui_create_window(width: f64, height: f64) -> u64 {
    let (tx, rx) = oneshot::channel();
    crate::renderer::send_command(RenderCommand::CreateWindow {
        width,
        height,
        response: tx,
    });
    match rx.blocking_recv() {
        Ok(id) => id,
        Err(_) => 0,
    }
}

/// Batch update elements. Takes a JSON string.
#[unsafe(no_mangle)]
pub extern "C" fn rngpui_update_elements(window_id: u64, elements_json: *const c_char) -> bool {
    let json_str = unsafe {
        if elements_json.is_null() {
            return false;
        }
        match CStr::from_ptr(elements_json).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return false,
        }
    };
    crate::renderer::send_command(RenderCommand::BatchUpdateElements {
        window_id,
        elements_json: json_str,
    });
    true
}

/// Trigger a render frame.
#[unsafe(no_mangle)]
pub extern "C" fn rngpui_trigger_render(window_id: u64) {
    crate::renderer::send_command(RenderCommand::TriggerRender { window_id });
}

/// Free a string returned by GPUI.
#[unsafe(no_mangle)]
pub extern "C" fn rngpui_free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            let _ = CString::from_raw(s);
        }
    }
}

// ── C++ shim FFI ────────────────────────────────────────────────────
// These are called by the C++ GpuiMountingDelegate when RN's Fabric
// renderer produces mount instructions.

/// Must match cpp/gpui_platform.h GpuiMutation
#[repr(C)]
pub struct GpuiMutation {
    pub type_: u8,
    pub parent_tag: i64,
    pub child_tag: i64,
    pub index: i32,
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
    pub component_name: [c_char; 64],
    pub surface_id: u64,
}

/// Called by the C++ shim with a batch of mount mutations.
#[unsafe(no_mangle)]
pub extern "C" fn gpui_mount_batch(
    surface_id: u64,
    mutations: *const GpuiMutation,
    count: usize,
) {
    if mutations.is_null() || count == 0 {
        return;
    }
    let slice = unsafe { std::slice::from_raw_parts(mutations, count) };
    log::info!("gpui_mount_batch: surface={} count={}", surface_id, count);
    for (i, m) in slice.iter().enumerate() {
        let name = unsafe {
            std::ffi::CStr::from_ptr(m.component_name.as_ptr())
                .to_string_lossy()
        };
        log::info!(
            "  [{}] type={} parent={} child={} index={} name={} rect=({},{},{},{})",
            i, m.type_, m.parent_tag, m.child_tag, m.index,
            name, m.left, m.top, m.width, m.height
        );
    }
}

/// Create a render surface (window) with the given dimensions.
#[unsafe(no_mangle)]
pub extern "C" fn gpui_create_surface(surface_id: u64, width: f32, height: f32) {
    log::info!("gpui_create_surface: id={} {}x{}", surface_id, width, height);
    let (tx, rx) = oneshot::channel();
    crate::renderer::send_command(RenderCommand::CreateWindow {
        width: width as f64,
        height: height as f64,
        response: tx,
    });
    let _ = rx.blocking_recv();
}

/// Check if the GPUI runtime is initialized.
#[unsafe(no_mangle)]
pub extern "C" fn gpui_is_initialized() -> bool {
    crate::renderer::is_ready()
}
