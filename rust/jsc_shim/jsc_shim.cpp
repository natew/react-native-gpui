#include "jsc_shim.h"

#include <JavaScriptCore/JavaScriptCore.h>

#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {
struct Box {
  JSGlobalContextRef context;
};

struct HostFunction {
  RngHostVoidFn void_fn;
  RngHostNumFn num_fn;
  void* userdata;
};

void set_err(char* errbuf, size_t cap, const char* msg) {
  if (errbuf && cap) std::snprintf(errbuf, cap, "%s", msg ? msg : "error");
}

std::string js_string(JSStringRef value) {
  if (!value) return {};
  std::vector<char> bytes(JSStringGetMaximumUTF8CStringSize(value));
  size_t written = JSStringGetUTF8CString(value, bytes.data(), bytes.size());
  return written > 0 ? std::string(bytes.data(), written - 1) : std::string();
}

std::string value_string(JSContextRef context, JSValueRef value) {
  if (!value) return "JavaScriptCore error";
  JSValueRef ignored = nullptr;
  JSStringRef text = JSValueToStringCopy(context, value, &ignored);
  std::string result = js_string(text);
  if (text) JSStringRelease(text);
  return result.empty() ? "JavaScriptCore error" : result;
}

std::string arg_string(JSContextRef context, size_t count, const JSValueRef arguments[]) {
  if (count == 0 || !JSValueIsString(context, arguments[0])) return {};
  JSValueRef exception = nullptr;
  JSStringRef text = JSValueToStringCopy(context, arguments[0], &exception);
  if (exception || !text) return {};
  std::string result = js_string(text);
  JSStringRelease(text);
  return result;
}

JSValueRef call_host(JSContextRef context, JSObjectRef function, JSObjectRef,
                     size_t count, const JSValueRef arguments[], JSValueRef*) {
  auto* host = static_cast<HostFunction*>(JSObjectGetPrivate(function));
  if (!host) return JSValueMakeUndefined(context);
  std::string arg = arg_string(context, count, arguments);
  if (host->num_fn) return JSValueMakeNumber(context, host->num_fn(host->userdata, arg.c_str()));
  if (host->void_fn) host->void_fn(host->userdata, arg.c_str());
  return JSValueMakeUndefined(context);
}

void finalize_host(JSObjectRef function) {
  delete static_cast<HostFunction*>(JSObjectGetPrivate(function));
}

JSClassRef host_function_class() {
  static JSClassRef cls = [] {
    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.className = "RngHostFunction";
    definition.callAsFunction = call_host;
    definition.finalize = finalize_host;
    return JSClassCreate(&definition);
  }();
  return cls;
}

void install_host(Box* box, const char* name, HostFunction* host) {
  JSObjectRef function = JSObjectMake(box->context, host_function_class(), host);
  JSStringRef property = JSStringCreateWithUTF8CString(name);
  JSObjectSetProperty(box->context, JSContextGetGlobalObject(box->context), property,
                      function, kJSPropertyAttributeNone, nullptr);
  JSStringRelease(property);
}

void keep_external_bytes(void*, void*) {}
}  // namespace

extern "C" {

void* rng_jsc_create(void) {
  JSGlobalContextRef context = JSGlobalContextCreate(nullptr);
  return context ? new Box{context} : nullptr;
}

void rng_jsc_destroy(void* handle) {
  auto* box = static_cast<Box*>(handle);
  if (!box) return;
  JSGlobalContextRelease(box->context);
  delete box;
}

int rng_jsc_eval(void* handle, const uint8_t* data, size_t len, const char* url,
                 char* errbuf, size_t errcap) {
  auto* box = static_cast<Box*>(handle);
  std::string source(reinterpret_cast<const char*>(data), len);
  JSStringRef script = JSStringCreateWithUTF8CString(source.c_str());
  JSStringRef source_url = JSStringCreateWithUTF8CString(url ? url : "bundle");
  JSValueRef exception = nullptr;
  JSEvaluateScript(box->context, script, nullptr, source_url, 1, &exception);
  JSStringRelease(source_url);
  JSStringRelease(script);
  if (!exception) return 0;
  std::string message = value_string(box->context, exception);
  set_err(errbuf, errcap, message.c_str());
  return 1;
}

int rng_jsc_measure_jit(void* handle, double* elapsed_ms, char* errbuf,
                        size_t errcap) {
  auto* box = static_cast<Box*>(handle);
  if (!box || !elapsed_ms) {
    set_err(errbuf, errcap, "invalid JavaScriptCore JIT probe arguments");
    return 1;
  }
  static constexpr const char* probe = R"JS(
(function () {
  function mix(seed) {
    for (let i = 0; i < 5000000; i++) {
      seed = (Math.imul(seed ^ i, 1664525) + 1013904223) | 0;
    }
    return seed;
  }
  let value = 0;
  for (let pass = 1; pass <= 2; pass++) value ^= mix(pass);
  return value;
})()
)JS";
  JSStringRef script = JSStringCreateWithUTF8CString(probe);
  JSStringRef source_url = JSStringCreateWithUTF8CString("rngpui-jit-probe.js");
  JSValueRef exception = nullptr;
  auto started = std::chrono::steady_clock::now();
  JSValueRef result =
      JSEvaluateScript(box->context, script, nullptr, source_url, 1, &exception);
  auto finished = std::chrono::steady_clock::now();
  JSStringRelease(source_url);
  JSStringRelease(script);
  if (exception) {
    std::string message = value_string(box->context, exception);
    set_err(errbuf, errcap, message.c_str());
    return 1;
  }
  if (!result || !JSValueIsNumber(box->context, result)) {
    set_err(errbuf, errcap, "JavaScriptCore JIT probe returned a non-number");
    return 1;
  }
  *elapsed_ms = std::chrono::duration<double, std::milli>(finished - started).count();
  return 0;
}

void rng_jsc_install_void_fn(void* handle, const char* name, RngHostVoidFn fn,
                             void* userdata) {
  install_host(static_cast<Box*>(handle), name, new HostFunction{fn, nullptr, userdata});
}

void rng_jsc_install_num_fn(void* handle, const char* name, RngHostNumFn fn,
                            void* userdata) {
  install_host(static_cast<Box*>(handle), name, new HostFunction{nullptr, fn, userdata});
}

int rng_jsc_call1(void* handle, const char* name, const char* arg, char* errbuf,
                  size_t errcap) {
  auto* box = static_cast<Box*>(handle);
  JSStringRef property = JSStringCreateWithUTF8CString(name);
  JSValueRef exception = nullptr;
  JSValueRef value = JSObjectGetProperty(box->context, JSContextGetGlobalObject(box->context),
                                         property, &exception);
  JSStringRelease(property);
  if (exception) {
    std::string message = value_string(box->context, exception);
    set_err(errbuf, errcap, message.c_str());
    return 1;
  }
  if (!JSValueIsObject(box->context, value)) return 0;
  JSObjectRef function = JSValueToObject(box->context, value, &exception);
  if (exception || !function || !JSObjectIsFunction(box->context, function)) return 0;
  JSStringRef argument_string = JSStringCreateWithUTF8CString(arg ? arg : "");
  JSValueRef argument = JSValueMakeString(box->context, argument_string);
  JSObjectCallAsFunction(box->context, function, nullptr, 1, &argument, &exception);
  JSStringRelease(argument_string);
  if (!exception) return 0;
  std::string message = value_string(box->context, exception);
  set_err(errbuf, errcap, message.c_str());
  return 1;
}

void* rng_jsc_shared_buffer_create(size_t len) {
  void* memory = nullptr;
  size_t size = len ? len : 8;
  if (posix_memalign(&memory, 8, size) != 0 || !memory) return nullptr;
  std::memset(memory, 0, size);
  return memory;
}

void rng_jsc_install_shared_buffer(void* handle, const char* name, void* buffer,
                                   size_t len) {
  auto* box = static_cast<Box*>(handle);
  JSValueRef exception = nullptr;
  JSObjectRef array_buffer = JSObjectMakeArrayBufferWithBytesNoCopy(
      box->context, buffer, len, keep_external_bytes, nullptr, &exception);
  if (exception || !array_buffer) return;
  JSStringRef property = JSStringCreateWithUTF8CString(name);
  JSObjectSetProperty(box->context, JSContextGetGlobalObject(box->context), property,
                      array_buffer, kJSPropertyAttributeNone, nullptr);
  JSStringRelease(property);
}

}  // extern "C"
