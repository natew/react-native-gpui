// Compiles the Hermes JSI C ABI shim (hermes_shim.cpp) together with jsi.cpp, and links
// the prebuilt Hermes runtime (libhermesvm.dylib). See plans/single-process-hermes.md.
//
// HERMES_ROOT overrides the Hermes checkout (default: ~/github/hermes). The runtime dylib
// is found at $HERMES_ROOT/build/lib and resolved at runtime via an embedded rpath.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                let modified = entry.metadata().ok().and_then(|meta| meta.modified().ok());
                if modified > newest {
                    newest = modified;
                }
            }
        }
    }
    newest
}

fn main() {
    let hermes = std::env::var("HERMES_ROOT").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/github/hermes")
    });
    let hermes = PathBuf::from(hermes);
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
    println!(
        "cargo:rustc-env=RNGPUI_HERMES_VERSION={}",
        std::env::var("HERMES_VERSION").unwrap_or_else(|_| {
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&hermes)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|sha| sha.trim().to_string())
                .unwrap_or_else(|| "unknown".to_string())
        })
    );
    println!("cargo:rerun-if-env-changed=RNGPUI_SOURCE_SHA");
    println!("cargo:rerun-if-env-changed=HERMES_VERSION");
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
    let api = hermes.join("API");
    let jsi = api.join("jsi");
    let include = hermes.join("include");
    let public = hermes.join("public");
    let lib = hermes.join("build/lib");

    let jsi_cpp = jsi.join("jsi/jsi.cpp");
    assert!(
        jsi_cpp.is_file(),
        "jsi.cpp not found at {} — set HERMES_ROOT to a built Hermes checkout",
        jsi_cpp.display()
    );
    let dylib = lib.join("libhermesvm.dylib");
    assert!(
        dylib.is_file(),
        "libhermesvm.dylib not found at {}. Build Hermes: ninja -C {} lib/libhermesvm.dylib",
        lib.display(),
        hermes.join("build").display()
    );

    // The shim compiles against these headers and links the dylib built from the same
    // checkout, so both must come from one Hermes source state. Cargo cannot see when
    // they diverge: a Hermes checkout can be updated or re-cloned without any file in
    // this crate changing, and this script would then compile the shim against new
    // headers while still linking a stale dylib. That mismatch is invisible until
    // runtime, where a default RuntimeConfig() segfaults inside GCConfig's copy
    // constructor before any JS runs, with no message and an empty log. A stale dylib
    // cost hours to find once; refuse to build one instead.
    let newest_header = [&api, &include, &public]
        .into_iter()
        .filter_map(|dir| newest_mtime(dir))
        .max();
    let dylib_built = dylib.metadata().ok().and_then(|meta| meta.modified().ok());
    if let (Some(header), Some(built)) = (newest_header, dylib_built) {
        assert!(
            built >= header,
            "libhermesvm.dylib at {} is older than the Hermes headers at {}, so the shim \
             would be compiled against a different ABI than it links. Rebuild the runtime \
             from its own sources: ninja -C {} lib/libhermesvm.dylib",
            dylib.display(),
            hermes.display(),
            hermes.join("build").display()
        );
    }

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .file("hermes_shim/hermes_shim.cpp")
        .file(&jsi_cpp)
        .include(&api)
        .include(&jsi)
        .include(&include)
        .include(&public)
        .compile("rng_hermes_shim");

    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-lib=dylib=hermesvm");
    // libhermesvm via the Hermes build dir; libghostty-vt + a packaged libhermesvm resolve
    // next to the binary (the self-contained layout the .app ships). stage_dylibs.sh copies
    // them into target/<profile>/ for dev runs.
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    println!("cargo:rerun-if-changed=hermes_shim/hermes_shim.cpp");
    println!("cargo:rerun-if-changed=hermes_shim/hermes_shim.h");
    // Rebuilding the runtime recompiles the shim, so the pair never drifts apart in the
    // direction the staleness check above cannot catch.
    println!("cargo:rerun-if-changed={}", dylib.display());
    println!("cargo:rerun-if-env-changed=HERMES_ROOT");
}
