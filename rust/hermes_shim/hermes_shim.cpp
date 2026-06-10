// Thin C ABI over Hermes JSI. jsi.cpp is compiled alongside this (see build.rs) so the
// non-inline JSI symbols resolve here; libhermesvm provides makeHermesRuntime + the
// HermesRuntime vtable. All calls must happen on the runtime's owning thread.
#include "hermes_shim.h"

#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <string>

namespace jsi = facebook::jsi;

namespace {
struct Box {
  std::unique_ptr<facebook::hermes::HermesRuntime> rt;
};

// A jsi::MutableBuffer that points at an externally-owned, process-lifetime region. It is
// intentionally non-owning: the destructor frees nothing, so the same raw pointer can back
// ArrayBuffers in any number of runtimes (and the Rust/C side keeps writing to it). The
// region is allocated by rng_hermes_shared_buffer_create and never freed.
class SharedMutableBuffer : public jsi::MutableBuffer {
 public:
  SharedMutableBuffer(uint8_t* data, size_t len) : data_(data), len_(len) {}
  size_t size() const override { return len_; }
  uint8_t* data() override { return data_; }

 private:
  uint8_t* data_;
  size_t len_;
};

void set_err(char* errbuf, size_t cap, const char* msg) {
  if (errbuf && cap) std::snprintf(errbuf, cap, "%s", msg ? msg : "error");
}

std::string arg_string(jsi::Runtime& rt, const jsi::Value* args, size_t count) {
  if (count >= 1 && args[0].isString()) return args[0].getString(rt).utf8(rt);
  return std::string();
}
}  // namespace

extern "C" {

void* rng_hermes_create(void) {
  try {
    auto* box = new Box();
    box->rt = facebook::hermes::makeHermesRuntime(::hermes::vm::RuntimeConfig());
    return box;
  } catch (...) {
    return nullptr;
  }
}

void rng_hermes_destroy(void* h) { delete static_cast<Box*>(h); }

int rng_hermes_eval(void* h, const uint8_t* data, size_t len, const char* url, char* errbuf,
                    size_t errcap) {
  auto* box = static_cast<Box*>(h);
  try {
    auto buf = std::make_shared<jsi::StringBuffer>(
        std::string(reinterpret_cast<const char*>(data), len));
    box->rt->evaluateJavaScript(buf, url ? url : "bundle");
    return 0;
  } catch (const jsi::JSError& e) {
    set_err(errbuf, errcap, e.getMessage().c_str());
    return 1;
  } catch (const std::exception& e) {
    set_err(errbuf, errcap, e.what());
    return 1;
  } catch (...) {
    set_err(errbuf, errcap, "unknown C++ exception in eval");
    return 1;
  }
}

void rng_hermes_install_void_fn(void* h, const char* name, RngHostVoidFn fn, void* userdata) {
  auto* box = static_cast<Box*>(h);
  auto& rt = *box->rt;
  std::string nm(name);
  auto f = jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forUtf8(rt, nm), 1,
      [fn, userdata](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                     size_t count) -> jsi::Value {
        std::string a = arg_string(rt, args, count);
        fn(userdata, a.c_str());
        return jsi::Value::undefined();
      });
  rt.global().setProperty(rt, nm.c_str(), f);
}

void rng_hermes_install_num_fn(void* h, const char* name, RngHostNumFn fn, void* userdata) {
  auto* box = static_cast<Box*>(h);
  auto& rt = *box->rt;
  std::string nm(name);
  auto f = jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forUtf8(rt, nm), 1,
      [fn, userdata](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                     size_t count) -> jsi::Value {
        std::string a = arg_string(rt, args, count);
        return jsi::Value(fn(userdata, a.c_str()));
      });
  rt.global().setProperty(rt, nm.c_str(), f);
}

int rng_hermes_call1(void* h, const char* name, const char* arg, char* errbuf, size_t errcap) {
  auto* box = static_cast<Box*>(h);
  auto& rt = *box->rt;
  try {
    auto v = rt.global().getProperty(rt, name);
    if (!v.isObject()) return 0;
    auto obj = v.getObject(rt);
    if (!obj.isFunction(rt)) return 0;  // not installed yet — ignore
    obj.getFunction(rt).call(rt, jsi::String::createFromUtf8(rt, std::string(arg ? arg : "")));
    return 0;
  } catch (const jsi::JSError& e) {
    set_err(errbuf, errcap, e.getMessage().c_str());
    return 1;
  } catch (const std::exception& e) {
    set_err(errbuf, errcap, e.what());
    return 1;
  } catch (...) {
    set_err(errbuf, errcap, "unknown C++ exception in call");
    return 1;
  }
}

void rng_hermes_drain_microtasks(void* h) {
  auto* box = static_cast<Box*>(h);
  try {
    box->rt->drainMicrotasks();
  } catch (...) {
  }
}

void* rng_hermes_shared_buffer_create(size_t len) {
  // 8-byte aligned so JS Float64 slots are aligned (tear-free aligned loads/stores on
  // arm64). Zero-initialized. Never freed — process-lifetime per the contract above.
  void* p = nullptr;
  if (posix_memalign(&p, 8, len ? len : 8) != 0 || !p) return nullptr;
  std::memset(p, 0, len ? len : 8);
  return p;
}

void rng_hermes_install_shared_buffer(void* h, const char* name, void* buffer, size_t len) {
  auto* box = static_cast<Box*>(h);
  auto& rt = *box->rt;
  // Non-owning MutableBuffer over the shared region; Hermes' createArrayBuffer takes a
  // shared_ptr<MutableBuffer> and uses its data() pointer directly (no copy), giving a real
  // JS ArrayBuffer whose backing store IS this memory.
  auto mb = std::make_shared<SharedMutableBuffer>(static_cast<uint8_t*>(buffer), len);
  jsi::ArrayBuffer ab(rt, std::move(mb));
  rt.global().setProperty(rt, std::string(name).c_str(), ab);
}

}  // extern "C"
