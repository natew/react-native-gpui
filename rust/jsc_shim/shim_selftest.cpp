#include "jsc_shim.h"

#include <cstdio>
#include <cstdint>
#include <cstring>

struct Probe {
  bool microtask_ran = false;
  int userdata_hits = 0;
};

static void host_log(void*, const char* value) { std::printf("[host_log] %s\n", value); }
static void mark_microtask(void* userdata, const char*) {
  static_cast<Probe*>(userdata)->microtask_ran = true;
}
static double host_now(void* userdata, const char* value) {
  auto* probe = static_cast<Probe*>(userdata);
  if (std::strcmp(value, "userdata") == 0) probe->userdata_hits += 1;
  return 42.5;
}

int main() {
  Probe probe;
  void* runtime = rng_jsc_create();
  if (!runtime) { std::printf("FAIL: create\n"); return 1; }
  rng_jsc_install_void_fn(runtime, "__host_log", host_log, nullptr);
  rng_jsc_install_void_fn(runtime, "__mark_microtask", mark_microtask, &probe);
  rng_jsc_install_num_fn(runtime, "__host_now", host_now, &probe);

  char error[512] = {0};
  const char* script =
      "globalThis.__rngpui_ping = function(arg){ __host_log('ping got: ' + arg); };"
      "if (__host_now('userdata') !== 42.5) throw new Error('num host result');"
      "Promise.resolve().then(function(){ __mark_microtask('ran'); });";
  if (rng_jsc_eval(runtime, reinterpret_cast<const uint8_t*>(script), std::strlen(script),
                   "selftest.js", error, sizeof error)) {
    std::printf("FAIL eval: %s\n", error); return 2;
  }
  if (!probe.microtask_ran) {
    std::printf("FAIL: promise microtask did not run before eval returned\n"); return 3;
  }
  if (probe.userdata_hits != 1) {
    std::printf("FAIL: host function userdata hits=%d\n", probe.userdata_hits); return 4;
  }
  if (rng_jsc_call1(runtime, "__rngpui_ping", "from C", error, sizeof error)) {
    std::printf("FAIL call: %s\n", error); return 5;
  }
  const size_t length = (4 + 32) * sizeof(double);
  void* shared = rng_jsc_shared_buffer_create(length);
  void* runtime_a = rng_jsc_create();
  void* runtime_b = rng_jsc_create();
  if (!shared || !runtime_a || !runtime_b) {
    std::printf("FAIL: shared setup\n"); return 6;
  }
  rng_jsc_install_shared_buffer(runtime_a, "__shared", shared, length);
  rng_jsc_install_shared_buffer(runtime_b, "__shared", shared, length);
  const char* write =
      "if (__shared.byteLength !== 288) throw new Error('byteLength ' + __shared.byteLength);"
      "var a = new Float64Array(__shared); a[0] = 7.25; a[5] = 42.5;";
  if (rng_jsc_eval(runtime_a, reinterpret_cast<const uint8_t*>(write), std::strlen(write),
                   "shared-a.js", error, sizeof error)) {
    std::printf("FAIL shared write: %s\n", error); return 7;
  }
  const char* read =
      "var b = new Float64Array(__shared);"
      "if (b.length !== 36 || b[0] !== 7.25 || b[5] !== 42.5) throw new Error('shared read');";
  if (rng_jsc_eval(runtime_b, reinterpret_cast<const uint8_t*>(read), std::strlen(read),
                   "shared-b.js", error, sizeof error)) {
    std::printf("FAIL shared read: %s\n", error); return 8;
  }
  double from_c = 99.5;
  std::memcpy(static_cast<uint8_t*>(shared) + 6 * sizeof(double), &from_c, sizeof(double));
  const char* read_c =
      "var c = new Float64Array(__shared); if (c[6] !== 99.5) throw new Error('C visibility');";
  if (rng_jsc_eval(runtime_b, reinterpret_cast<const uint8_t*>(read_c), std::strlen(read_c),
                   "shared-c.js", error, sizeof error)) {
    std::printf("FAIL shared C visibility: %s\n", error); return 9;
  }

  rng_jsc_destroy(runtime_a);
  rng_jsc_destroy(runtime_b);
  rng_jsc_destroy(runtime);
  std::printf("SELFTEST OK microtasks=automatic userdata=ok shared=ok\n");
  return 0;
}
