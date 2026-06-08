// Standalone validation of the Hermes embedding (no Rust). Compiles hermes_shim.cpp +
// jsi.cpp, links libhermesvm. Proves: runtime create, eval, void+num host fns, JS→C and
// C→JS calls, microtask drain.
#include "hermes_shim.h"
#include <cstdio>
#include <cstring>

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
  rng_hermes_destroy(rt);
  printf("SELFTEST OK\n");
  return 0;
}
