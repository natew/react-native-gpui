// macOS dock affordances: badge label on the app's dock tile and the
// "needs attention" bounce. Driven from JS via the `$cmd` host-command channel
// (Dock.setBadge / Dock.requestAttention in apis.ts). No-ops off macOS.
//
// Test mode: an offscreen RNGPUI_TEST_MODE / RNGPUI_NO_ACTIVATE service still
// owns its own NSApp dock tile. Badging the real tile from a headless test is
// noise (and racy with the user's window), so under RNGPUI_TEST_MODE we skip
// the real AppKit call and instead record the value for assertion. The recorded
// state is exposed two ways: in the DebugDump control-socket reply
// (`dockBadge` / `dockAttention*`) and, when RNGPUI_DOCK_STATE is set, mirrored
// to that file like RNGPUI_DUMP_TREE — so conformance gates can read it without
// the control socket.

use std::sync::Mutex;

use once_cell::sync::Lazy;

/// Last dock state we were asked to apply. `badge == None` means "no badge".
#[derive(Clone, Default)]
pub struct DockState {
    pub badge: Option<String>,
    /// number of requestAttention calls, by request type.
    pub attention_informational: u32,
    pub attention_critical: u32,
}

static STATE: Lazy<Mutex<DockState>> = Lazy::new(|| Mutex::new(DockState::default()));

fn test_mode() -> bool {
    std::env::var("RNGPUI_TEST_MODE").is_ok()
}

/// Set (or, with an empty string, clear) the dock tile badge label.
pub fn set_badge(label: &str) {
    {
        let mut state = STATE.lock().expect("dock state mutex poisoned");
        state.badge = if label.is_empty() {
            None
        } else {
            Some(label.to_string())
        };
    }
    write_state_file();
    if test_mode() {
        return;
    }
    #[cfg(target_os = "macos")]
    apply_badge_native(label);
}

/// Request the user's attention (dock bounce). `critical` keeps bouncing until
/// the app is activated; otherwise it bounces once. macOS only fires this when
/// the app is not the active app.
pub fn request_attention(critical: bool) {
    {
        let mut state = STATE.lock().expect("dock state mutex poisoned");
        if critical {
            state.attention_critical += 1;
        } else {
            state.attention_informational += 1;
        }
    }
    write_state_file();
    if test_mode() {
        return;
    }
    #[cfg(target_os = "macos")]
    apply_attention_native(critical);
}

/// Snapshot of the recorded dock state, for the DebugDump reply.
pub fn snapshot() -> DockState {
    STATE.lock().expect("dock state mutex poisoned").clone()
}

fn write_state_file() {
    let Ok(path) = std::env::var("RNGPUI_DOCK_STATE") else {
        return;
    };
    let state = snapshot();
    let json = serde_json::json!({
        "badge": state.badge,
        "attentionInformational": state.attention_informational,
        "attentionCritical": state.attention_critical,
    });
    if let Ok(text) = serde_json::to_string_pretty(&json) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(target_os = "macos")]
fn apply_badge_native(label: &str) {
    use cocoa::appkit::NSApp;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let app = NSApp();
        if app == nil {
            return;
        }
        let dock_tile: id = msg_send![app, dockTile];
        if dock_tile == nil {
            return;
        }
        // empty string clears the badge (NSDockTile treats "" as no badge).
        let ns_label: id = NSString::alloc(nil).init_str(label);
        let _: () = msg_send![dock_tile, setBadgeLabel: ns_label];
    }
}

#[cfg(target_os = "macos")]
fn apply_attention_native(critical: bool) {
    use cocoa::appkit::{NSApp, NSRequestUserAttentionType};
    use cocoa::base::nil;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let app = NSApp();
        if app == nil {
            return;
        }
        let request_type = if critical {
            NSRequestUserAttentionType::NSCriticalRequest
        } else {
            NSRequestUserAttentionType::NSInformationalRequest
        };
        // AppKit no-ops this when the app is already active, so we don't gate it.
        let _: () = msg_send![app, requestUserAttention: request_type];
    }
}
