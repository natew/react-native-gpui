use std::io::Read as _;
use std::sync::OnceLock;

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

pub const GPUI_UPSTREAM_REVISION: &str = "d9ad6aff67e47de43abb270d22de75dd950f1b48";
pub const GPUI_COMPATIBILITY_BASE: &str = "69e2130295c2649963eb639fc70b4f2ee8ea1624";
pub const SOURCE_SHA: &str = env!("RNGPUI_SOURCE_SHA");
pub const BUILD_IDENTITY: &str = env!("RNGPUI_BUILD_ID");

static BINARY_SHA: OnceLock<String> = OnceLock::new();

fn binary_sha() -> &'static str {
    BINARY_SHA.get_or_init(|| {
        let Ok(path) = std::env::current_exe() else {
            return "unavailable".to_string();
        };
        let Ok(mut file) = std::fs::File::open(path) else {
            return "unavailable".to_string();
        };
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            match file.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => digest.update(&buffer[..read]),
                Err(_) => return "unavailable".to_string(),
            }
        }
        format!("{:x}", digest.finalize())
    })
}

pub fn provenance() -> Value {
    let bundle_url = std::env::var("RNGPUI_BUNDLE").unwrap_or_default();
    let development = std::env::var("NODE_ENV")
        .map(|value| value != "production")
        .unwrap_or_else(|_| std::env::var_os("RNGPUI_TEST_MODE").is_some());
    json!({
        "renderer": "react-native-gpui",
        "rendererVersion": env!("CARGO_PKG_VERSION"),
        "gpuiRevision": GPUI_UPSTREAM_REVISION,
        "gpuiCompatibilityBase": GPUI_COMPATIBILITY_BASE,
        "gpuiCompatibilityMode": "0.2.2-api-compatible-backports",
        "serviceVersion": env!("CARGO_PKG_VERSION"),
        "hermesVersion": env!("RNGPUI_HERMES_VERSION"),
        "bundleUrl": bundle_url,
        "development": development,
        "sourceSha": SOURCE_SHA,
        "binarySha": binary_sha(),
        "buildIdentity": BUILD_IDENTITY,
        "refreshCapability": {
            "fastRefresh": true,
            "hotEval": true,
            "execReload": false,
        },
    })
}
