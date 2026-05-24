C++ test suite — RN Fabric renderer tests on GPUI
==================================================

Architecture
------------
RN's Fabric C++ renderer (ShadowNode, ComponentDescriptor, Yoga, MountingManager)
is compiled as a static library from `~/github/react-native` (tag 0.83.2).
Our C++ shim (`gpui_platform.h` / `.cpp`) implements `ShadowTreeDelegate` and
serializes mount mutations to flat C structs for FFI to Rust/GPUI.

```
RN Fabric staticlib (compiled from ~/github/react-native)
    ↓ inherits
GpuiMountingDelegate (our shim)
    ↓ C FFI
gpui_mount_batch() → Rust lib.rs → GPUI elements
```

Status
------
- [x] CMakeLists.txt — builds RN Fabric renderer + Yoga as static libraries
- [x] gpui_platform.h — `GpuiMountingDelegate` implementing `ShadowTreeDelegate`
- [x] gpui_platform.cpp — serializes mutations to `GpuiMutation` C structs
- [x] gtest binary target — links 4 RN test files
- [x] Yoga compiles from source
- [x] Core renderer sources compile
- [ ] Blocked: FB-internal headers (FBReactNativeSpec/EventEmitters.h)

Dependencies
------------
All available via Homebrew:
    brew install cmake   (build system)
    brew install googletest  (test framework)
    brew install folly   (Facebook C++ library)
    brew install glog    (logging)
    brew install fmt double-conversion gflags  (folly deps)
    brew install fast_float  (CSS parser dep)

Build
-----
    mkdir build && cd build
    cmake ../cpp
    cmake --build .
    ./rn_renderer_tests

Next steps
----------
Resolve remaining FB-internal headers in the RN renderer source. The issue is
that RN's OSS release at 0.83.2 has `#include` references to headers in
`FBReactNativeSpec/` that are not distributed. Options:
  (a) Stub out the missing headers with empty implementations
  (b) Cherry-pick only source files needed by the test files, skipping
      components with Meta-internal deps (e.g., modal, scrollview)
  (c) Use RN's BUCK build to resolve the true dependency tree

Test files targeted
-------------------
- core/tests/FindNodeAtPointTest.cpp — hit testing
- core/tests/LayoutableShadowNodeTest.cpp — overflow, layout metrics
- core/tests/ShadowNodeTest.cpp — tree construction, cloning
- core/tests/ComponentDescriptorTest.cpp — component lifecycle
