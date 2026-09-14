#include "jsc_shim.h"

#include <cstdio>
#include <cstdint>
#include <cstring>

struct Probe {
  bool microtask_ran = false;
  int userdata_hits = 0;
  int none_dead = 0;
  int all_dead = 0;
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
static void mark_none_dead(void* userdata, const char*) {
  static_cast<Probe*>(userdata)->none_dead += 1;
}
static void mark_all_dead(void* userdata, const char*) {
  static_cast<Probe*>(userdata)->all_dead += 1;
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

  // Collection must actually collect. WeakRef.deref() is what makes that observable: an
  // unreachable target reads undefined only once its heap was really collected, which a
  // "the call returned" assertion cannot see. The control is the reading taken before the
  // collection, which must still be all-alive, so a counter that moves by itself cannot
  // pass. FinalizationRegistry is not usable as this observable: measured on macOS 25.5 its
  // callbacks never ran, not even for targets a natural collection had freed.
  rng_jsc_install_void_fn(runtime, "__mark_none_dead", mark_none_dead, &probe);
  rng_jsc_install_void_fn(runtime, "__mark_all_dead", mark_all_dead, &probe);
  const char* unreachable =
      "globalThis.__refs = [];"
      "for (var i = 0; i < 500; i++) {"
      "  __refs.push(new WeakRef({ index: i, payload: new Array(64).fill(i) }));"
      "}"
      "globalThis.__check = function(){"
      "  var dead = 0;"
      "  for (var i = 0; i < __refs.length; i++) {"
      "    if (__refs[i].deref() === undefined) dead += 1;"
      "  }"
      "  if (dead === 0) __mark_none_dead('control');"
      "  if (dead === __refs.length) __mark_all_dead('collected');"
      "};";
  if (rng_jsc_eval(runtime, reinterpret_cast<const uint8_t*>(unreachable),
                   std::strlen(unreachable), "unreachable.js", error, sizeof error)) {
    std::printf("FAIL unreachable setup: %s\n", error); return 10;
  }
  const char* check = "__check()";
  if (rng_jsc_eval(runtime, reinterpret_cast<const uint8_t*>(check), std::strlen(check),
                   "check-before.js", error, sizeof error)) {
    std::printf("FAIL check before: %s\n", error); return 11;
  }
  if (probe.none_dead != 1 || probe.all_dead != 0) {
    std::printf("FAIL: 500 unreachable targets were already dead before any collection "
                "(none_dead=%d all_dead=%d)\n",
                probe.none_dead, probe.all_dead);
    return 12;
  }
  if (rng_jsc_collect_garbage(runtime) != 0) {
    std::printf("FAIL: no synchronous collector on this platform\n"); return 13;
  }
  if (rng_jsc_eval(runtime, reinterpret_cast<const uint8_t*>(check), std::strlen(check),
                   "check-after.js", error, sizeof error)) {
    std::printf("FAIL check after: %s\n", error); return 14;
  }
  if (probe.all_dead != 1) {
    std::printf("FAIL: collection left unreachable WeakRef targets alive "
                "(none_dead=%d all_dead=%d)\n",
                probe.none_dead, probe.all_dead);
    return 15;
  }

  rng_jsc_destroy(runtime);
  std::printf("SELFTEST OK microtasks=automatic userdata=ok shared=ok gc=collects\n");
  return 0;
}
