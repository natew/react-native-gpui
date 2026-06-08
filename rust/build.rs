// Compiles the Hermes JSI C ABI shim (hermes_shim.cpp) together with jsi.cpp, and links
// the prebuilt Hermes runtime (libhermesvm.dylib). See plans/single-process-hermes.md.
//
// HERMES_ROOT overrides the Hermes checkout (default: ~/github/hermes). The runtime dylib
// is found at $HERMES_ROOT/build/lib and resolved at runtime via an embedded rpath.
use std::path::PathBuf;

fn main() {
    let hermes = std::env::var("HERMES_ROOT").unwrap_or_else(|_| "/Users/n8/github/hermes".into());
    let hermes = PathBuf::from(hermes);
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
    assert!(
        lib.join("libhermesvm.dylib").is_file(),
        "libhermesvm.dylib not found at {} — build Hermes: cmake --build build --target hermesc libhermes",
        lib.display()
    );

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
    println!("cargo:rerun-if-env-changed=HERMES_ROOT");
}
