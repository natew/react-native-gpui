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

#ifdef __cplusplus
}
#endif
