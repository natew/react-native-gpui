// Thin C ABI over Hermes JSI for the Rust host. All functions must be called on the
// runtime's owning (JS) thread. See rust/src/hermes.rs and plans/single-process-hermes.md.
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// A host function callable from JS. Receives the registered userdata pointer and the
// first JS argument coerced to a NUL-terminated UTF-8 string ("" if absent/non-string).
typedef void (*RngHostVoidFn)(void* userdata, const char* arg);
typedef double (*RngHostNumFn)(void* userdata, const char* arg);

// Create / destroy a Hermes runtime. Returns an opaque handle (nullptr on failure).
void* rng_hermes_create(void);
void rng_hermes_destroy(void* rt);

// Evaluate JS source OR Hermes bytecode (auto-detected by HBC magic). Returns 0 on
// success, 1 on a JS/C++ error (message written into errbuf, truncated to errcap).
int rng_hermes_eval(void* rt, const uint8_t* data, size_t len, const char* url,
                    char* errbuf, size_t errcap);

// Install a global host function `name` that trampolines to `fn(userdata, arg)`.
void rng_hermes_install_void_fn(void* rt, const char* name, RngHostVoidFn fn, void* userdata);
void rng_hermes_install_num_fn(void* rt, const char* name, RngHostNumFn fn, void* userdata);

// Call global JS function `name` with one string arg. No-op if `name` isn't a function
// (e.g. not installed yet). Returns 0 on success, 1 on a JS error (message in errbuf).
int rng_hermes_call1(void* rt, const char* name, const char* arg, char* errbuf, size_t errcap);

// Run the JS microtask queue (Promises). Call after each task batch.
void rng_hermes_drain_microtasks(void* rt);

// Allocate a process-lifetime shared byte buffer (zero-initialized, 8-byte aligned).
// Returns an opaque pointer to the region. Never freed (lives for the process lifetime);
// the same pointer is handed to rng_hermes_install_shared_buffer for one or more runtimes.
void* rng_hermes_shared_buffer_create(size_t len);

// Expose `buffer` (created above) to runtime `rt` as global `name` — a JS ArrayBuffer
// whose backing store IS that memory (no copy). Installable into multiple runtimes; each
// gets its own ArrayBuffer object over the same bytes. Cross-runtime/cross-thread
// visibility relies on aligned 8-byte loads/stores (tear-free on arm64) plus the host's
// existing cross-thread message passing for ordering — the same contract
// SharedArrayBuffer + postMessage gives the web pattern this ports.
void rng_hermes_install_shared_buffer(void* rt, const char* name, void* buffer, size_t len);

#ifdef __cplusplus
}
#endif
