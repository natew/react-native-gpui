// Thin C ABI over JavaScriptCore for the Rust host.
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*RngHostVoidFn)(void* userdata, const char* arg);
typedef double (*RngHostNumFn)(void* userdata, const char* arg);

void* rng_jsc_create(void);
void rng_jsc_destroy(void* rt);
int rng_jsc_eval(void* rt, const uint8_t* data, size_t len, const char* url,
                 char* errbuf, size_t errcap);
int rng_jsc_measure_jit(void* rt, double* elapsed_ms, char* errbuf, size_t errcap);
void rng_jsc_install_void_fn(void* rt, const char* name, RngHostVoidFn fn, void* userdata);
void rng_jsc_install_num_fn(void* rt, const char* name, RngHostNumFn fn, void* userdata);
int rng_jsc_call1(void* rt, const char* name, const char* arg, char* errbuf, size_t errcap);
void* rng_jsc_shared_buffer_create(size_t len);
void rng_jsc_install_shared_buffer(void* rt, const char* name, void* buffer, size_t len);

#ifdef __cplusplus
}
#endif
