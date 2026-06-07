// Thin C ABI over Hermes JSI. jsi.cpp is compiled alongside this (see build.rs) so the
// non-inline JSI symbols resolve here; libhermesvm provides makeHermesRuntime + the
// HermesRuntime vtable. All calls must happen on the runtime's owning thread.
#include "hermes_shim.h"

#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <cstdio>
#include <exception>
#include <memory>
#include <string>

namespace jsi = facebook::jsi;

namespace {
struct Box {
  std::unique_ptr<facebook::hermes::HermesRuntime> rt;
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

}  // extern "C"
