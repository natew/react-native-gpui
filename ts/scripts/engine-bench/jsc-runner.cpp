#include "../../../rust/jsc_shim/jsc_shim.h"

#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>

static void print_line(void*, const char* value) {
  std::printf("%s\n", value);
  std::fflush(stdout);
}

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: jsc-runner bundle.js\n");
    return 2;
  }
  std::ifstream input(argv[1], std::ios::binary);
  if (!input) {
    std::fprintf(stderr, "failed to open %s\n", argv[1]);
    return 2;
  }
  std::string source((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  void* runtime = rng_jsc_create();
  if (!runtime) return 3;
  rng_jsc_install_void_fn(runtime, "print", print_line, nullptr);
  char error[1024] = {0};
  int status = rng_jsc_eval(runtime, reinterpret_cast<const uint8_t*>(source.data()),
                               source.size(), argv[1], error, sizeof error);
  if (status) std::fprintf(stderr, "%s\n", error);
  if (const char* hold = std::getenv("RNGPUI_JSC_HOLD_MS")) {
    std::this_thread::sleep_for(std::chrono::milliseconds(std::strtol(hold, nullptr, 10)));
  }
  rng_jsc_destroy(runtime);
  return status;
}
