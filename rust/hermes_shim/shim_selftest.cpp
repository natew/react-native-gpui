// Standalone validation of the Hermes embedding (no Rust). Compiles hermes_shim.cpp +
// jsi.cpp, links libhermesvm. Proves: runtime create, eval, void+num host fns, JS→C and
// C→JS calls, microtask drain.
#include "hermes_shim.h"
#include <cstdio>
#include <cstring>
#include <cstdint>

static void host_log(void*, const char* s) { printf("[host_log] %s\n", s); }
static double host_now(void*, const char*) { return 42.5; }

int main() {
  void* rt = rng_hermes_create();
  if (!rt) { printf("FAIL: create\n"); return 1; }

  rng_hermes_install_void_fn(rt, "__host_log", host_log, nullptr);
  rng_hermes_install_num_fn(rt, "__host_now", host_now, nullptr);

  char err[512] = {0};
  const char* js =
      "globalThis.__rngpui_ping = function(arg){ __host_log('ping got: ' + arg); };"
      "__host_log('eval ok, now=' + __host_now());"
      "__host_log('json ' + JSON.stringify({a:1,b:[2,3]}));"
      "Promise.resolve().then(function(){ __host_log('microtask ran'); });";
  if (rng_hermes_eval(rt, (const uint8_t*)js, strlen(js), "selftest.js", err, sizeof err)) {
    printf("FAIL eval: %s\n", err);
    return 2;
  }
  if (rng_hermes_call1(rt, "__rngpui_ping", "from C", err, sizeof err)) {
    printf("FAIL call: %s\n", err);
    return 3;
  }
  rng_hermes_drain_microtasks(rt);

  // --- shared buffer across two runtimes (the reanimated SharedArrayBuffer pattern) ---
  // Layout the JS side relies on: 4-float header + Float64 slots. Size it for a few slots.
  const size_t kLen = (4 + 32) * sizeof(double);  // header floats + slots, in bytes
  void* shared = rng_hermes_shared_buffer_create(kLen);
  if (!shared) { printf("FAIL: shared_buffer_create\n"); rng_hermes_destroy(rt); return 4; }

  void* rtA = rng_hermes_create();
  void* rtB = rng_hermes_create();
  if (!rtA || !rtB) { printf("FAIL: create A/B\n"); return 5; }
  rng_hermes_install_void_fn(rtA, "__host_log", host_log, nullptr);
  rng_hermes_install_void_fn(rtB, "__host_log", host_log, nullptr);

  // Install the SAME backing region as a global ArrayBuffer in both runtimes (no copy).
  rng_hermes_install_shared_buffer(rtA, "__shared", shared, kLen);
  rng_hermes_install_shared_buffer(rtB, "__shared", shared, kLen);

  // Runtime A: verify byteLength, then write Float64 slots via a Float64Array view.
  const char* jsA =
      "if (__shared.byteLength !== " /* kLen */
      "(4 + 32) * 8) throw new Error('byteLength ' + __shared.byteLength);"
      "var a = new Float64Array(__shared);"
      "a[0] = 7.25;"
      "a[5] = 42.5;"
      "__host_log('A wrote a[0]=' + a[0] + ' a[5]=' + a[5]);";
  if (rng_hermes_eval(rtA, (const uint8_t*)jsA, strlen(jsA), "sharedA.js", err, sizeof err)) {
    printf("FAIL shared eval A: %s\n", err);
    return 6;
  }

  // Runtime B: read them back through its own ArrayBuffer over the same memory.
  const char* jsB =
      "var b = new Float64Array(__shared);"
      "if (b.length !== 36) throw new Error('len ' + b.length);"
      "if (b[0] !== 7.25) throw new Error('b[0] ' + b[0]);"
      "if (b[5] !== 42.5) throw new Error('b[5] ' + b[5]);"
      "__host_log('B read a[0]=' + b[0] + ' a[5]=' + b[5]);";
  if (rng_hermes_eval(rtB, (const uint8_t*)jsB, strlen(jsB), "sharedB.js", err, sizeof err)) {
    printf("FAIL shared eval B: %s\n", err);
    return 7;
  }

  // C-side write (simulating a Rust host write) must be visible from JS. Aligned 8-byte
  // store at slot index 6 (byte offset 48).
  double fromC = 99.5;
  std::memcpy(static_cast<uint8_t*>(shared) + 6 * sizeof(double), &fromC, sizeof(double));
  const char* jsC =
      "var c = new Float64Array(__shared);"
      "if (c[6] !== 99.5) throw new Error('c[6] ' + c[6]);"
      "__host_log('B sees C-written a[6]=' + c[6]);";
  if (rng_hermes_eval(rtB, (const uint8_t*)jsC, strlen(jsC), "sharedC.js", err, sizeof err)) {
    printf("FAIL shared eval C-visibility: %s\n", err);
    return 8;
  }

  rng_hermes_destroy(rtA);
  rng_hermes_destroy(rtB);
  rng_hermes_destroy(rt);
  printf("SELFTEST OK\n");
  return 0;
}
