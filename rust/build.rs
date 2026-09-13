use std::process::Command;

fn main() {
    let source_sha = std::env::var("RNGPUI_SOURCE_SHA").ok().or_else(|| {
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|sha| sha.trim().to_string())
    });
    let source_sha = source_sha.unwrap_or_else(|| "unknown".to_string());
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".to_string());
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=RNGPUI_SOURCE_SHA={source_sha}");
    println!(
        "cargo:rustc-env=RNGPUI_BUILD_ID={source_sha}:{}:{profile}:{target}",
        env!("CARGO_PKG_VERSION")
    );
    println!("cargo:rustc-env=RNGPUI_JSC_VERSION=system");
    println!("cargo:rerun-if-env-changed=RNGPUI_SOURCE_SHA");

    let head_ref = Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|reference| reference.trim().to_string())
        .unwrap_or_else(|| "HEAD".to_string());
    if let Some(git_head) = Command::new("git")
        .args(["rev-parse", "--git-path", &head_ref])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
    {
        println!("cargo:rerun-if-changed={}", git_head.trim());
    }

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .file("jsc_shim/jsc_shim.cpp")
        .compile("rng_jsc_shim");

    println!("cargo:rustc-link-lib=framework=JavaScriptCore");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    println!("cargo:rerun-if-changed=jsc_shim/jsc_shim.cpp");
    println!("cargo:rerun-if-changed=jsc_shim/jsc_shim.h");
}
