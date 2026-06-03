# react-native-gpui

React Native for GPUI. A Fabric-compatible renderer with GPUI as the platform backend, piggybacking on RN's existing C++ test suite and Fantom integration tests.

## Architecture

```
JS (React components)
  ↓ React reconciler
Fabric C++ shadow tree  ──── compiled from RN, unmodified
  ↓
Yoga layout             ──── compiled from RN, unmodified
  ↓ mount instructions
Mounting layer          ──── compiled from RN, unmodified
  ↓ platform delegate
C++ shim (~200 lines)   ──── adapts RN platform interface to C FFI
  ↓ FFI
Rust runtime            ──── implements platform delegate in terms of GPUI
  ↓
GPUI elements
```

This is RN's actual Fabric renderer (ShadowNode, ComponentDescriptor, Yoga, MountingManager) compiled as a C++ static library. The only thing we replace is the platform backend — instead of iOS UIView / Android View, mount instructions create GPUI elements.

## Why This Works

RN's Fabric renderer is **cross-platform by design**. The `ReactCommon/react/renderer/` directory has zero UIKit/Android imports. The platform dependency is concentrated in three replaceable interfaces:

| RN interface | our impl | what it does |
|---|---|---|
| `MountingCoordinator::getDelegate()` | `GpuiMountingDelegate` | receives mount instructions, creates/updates GPUI elements |
| `TextLayoutManager` | `GpuiTextLayoutManager` | measures text via GPUI's text system |
| `ImageManager` | `GpuiImageManager` | loads images via GPUI's image cache |

Everything else — shadow tree construction, Yoga layout, event dispatch, commit lifecycle — runs RN's exact C++ code.

## Tier 1: RN's C++ Renderer Tests via Our Platform

RN has 62 C++ test files (~14k lines) under `ReactCommon/react/renderer/*/tests/`. The ones that test our renderer contract:

| test file | what it proves |
|---|---|
| `core/tests/FindNodeAtPointTest.cpp` | hit testing through transforms, scroll offsets, clipped overflow |
| `core/tests/LayoutableShadowNodeTest.cpp` | overflow inset computation, layout metrics |
| `core/tests/ShadowNodeTest.cpp` | tree construction, cloning, family sharing |
| `core/tests/ComponentDescriptorTest.cpp` | component creation lifecycle |
| `components/view/tests/LayoutTest.cpp` | hit slop, transforms (scale/translate), clipping |
| `components/view/tests/ViewTest.cpp` | yoga props, background, border metrics |
| `mounting/tests/*` (4 files) | commit ordering, state reconciliation, stacking context |
| `components/scrollview/tests/ScrollViewTest.cpp` | scroll offset, content size |
| `uimanager/tests/PointerEventsProcessorTest.cpp` | pointer capture, event routing |

**How**: Compile RN's test `.cpp` files as a gtest binary. Link against RN's Fabric staticlib (unchanged renderer) plus our C++ shim (platform delegate). The gtest binary runs unmodified RN tests against our Rust/GPUI platform.

**CMake build**:
```
target_sources(tests PRIVATE
    # RN's test files (referenced from ~/github/react-native)
    ${RN_SRC}/react/renderer/core/tests/FindNodeAtPointTest.cpp
    ${RN_SRC}/react/renderer/components/view/tests/LayoutTest.cpp
    ...
    # Our C++ shim
    cpp/gpui_platform.cpp
)
target_link_libraries(tests PRIVATE
    react_renderer        # RN's compiled Fabric
    gpui_rust             # our Rust staticlib via C FFI
    gtest
)
```

## Tier 2: Fantom Integration Tests

RN has ~2600 lines of Fantom test JS across 20 files. These test the full JS→C++ pipeline:

```js
const root = Fantom.createRoot();
Fantom.runTask(() => {
    root.render(<Pressable style={{width: 100}} />);
});
expect(root.getRenderedOutput().toJSX()).toEqual(
    <rn-view accessible="true" width="100.000000" />
);
```

Fantom asserts are on **cross-platform values** (layout metrics, resolved props) — the same values our GPUI platform receives from Fabric. The JS tests run unmodified against our platform.

**What we supply**:
- The `NativeFantom` native module (implemented in Rust, exposed as a TurboModule)
- A JS runtime that can load RN's JS library (Bun's JSC works)
- Our GPUI platform backend (same as tier 1)

**Test runner**: Bun + Jest, loading RN's JS library from `~/github/react-native`, with our Rust `NativeFantom` module as the native backend.

## Where RN's Own Tests Don't Help

These areas need our own tests:

| area | why |
|---|---|
| GPUI element rendering | whether GPUI `div()` matches RN's `<View>` visually |
| Touch → event pipeline | whether a GPUI mouse click produces the right RN event |
| Gesture responder arbitration | RN's `onStartShouldSetResponder` etc. running atop GPUI events |
| Animation → GPUI frame sync | whether RN's Animated drives GPUI `request_animation_frame()` |
| Scroll physics | whether GPUI scroll matches RN's momentum/deceleration |

For these, the approach is a Fantom-inspired Rust test framework: render a component, dispatch a synthetic GPUI event, assert on the side effect (callback called, element moved, animation queued).

## Starting Today: First 7 Days

### Day 1: C++ build infra + empty platform delegate

```
~/react-native-gpui/
├── Cargo.toml
├── rust/
│   ├── src/lib.rs            # single FFI export: gpui_create_window
│   └── cpp/
│       ├── CMakeLists.txt    # compiles RN's Fabric + our shim
│       ├── gpui_platform.h   # delegate interface
│       └── gpui_platform.cpp # stub: logs mount instructions
├── scripts/
│   └── fetch-rn-headers.sh   # symlinks to ~/github/react-native
└── test/
    └── run_rn_tests.cpp      # include one RN test, link against shim
```

Goal: `cmake --build` produces a gtest binary that compiles and links. Tests fail in an informative way (the platform delegate is a stub).

### Day 2: Rust platform delegate — mount instruction processing

- Receive mount instructions (Create, Insert, Update, Remove) via C FFI
- Maintain a tree of GPUI element IDs
- `getRenderedOutput()` returns the tree as JSON (matching RN's `NativeFantom` shape)
- Link against GPUI's `App::test()` context

Goal: a single View mount in Rust returns the right JSON tree.

### Day 3: Run first RN test successfully

- Pick the simplest test: `ShadowNodeTest.cpp` — constructs a tree of ViewShadowNodes, checks children count
- Fix shim until it passes
- Then `FindNodeAtPointTest.cpp` — needs working layout metrics + hit testing

Goal: 2-3 RN C++ test files pass against our GPUI platform.

### Day 4-5: Full tier 1 suite

- Implement all platform delegate methods (mount, text measure, image load stubs)
- Get all ~14 renderer-contract test files passing
- CI: `cmake --build && ctest` runs RN's renderer tests against our platform

Goal: `bun run test:conformance:rn-renderer` passes.

### Day 6-7: React reconciler + first JS component

- React reconciler host config that calls our Rust runtime via Bun FFI
- `<View>` component: JS → reconciler → Rust → GPUI
- GPUI window shows a rendered RN View

Goal: a running GPUI window with `<View style={{width:100, height:100, backgroundColor:'red'}} />` rendered correctly.

## Key Files — C++ Shim Surface

The entire C++ shim, annotated:

```cpp
// gpui_platform.h — RN expects this interface
class GpuiMountingDelegate : public MountingDelegate {
    void mountingLayerDidMount(
        const SharedMutationList& mutations,
        SurfaceId surfaceId) override
    {
        // Each mutation: Create/Insert/Update/Remove/Replace
        // Serialize to C struct, call Rust FFI
        for (auto& mutation : mutations) {
            gpui_apply_mutation(
                (int)mutation.getType(),
                mutation.getChildList().to_vector()
            );
        }
    }
};

// FFI functions (Rust exports via extern "C")
extern "C" {
    void gpui_apply_mutation(int type, uint64_t* ids, size_t count);
    char* gpui_get_rendered_output(uint64_t surface_id);
    void gpui_create_surface(uint64_t surface_id, float width, float height);
}
```

## Key Decisions

| decision | choice | reason |
|---|---|---|
| RN C++ or Rust shadow tree? | **RN's C++ compiled as staticlib** | zero reimplementation risk; RN's tests pass against RN's code |
| JS runtime | **Bun (JavaScriptCore)** | already works with Bun.FFI for native modules, RN's JS lib runs on JSC |
| Yoga binding | **RN's built-in Yoga** | compiled as part of Fabric; no separate crate |
| Text measurement | **GPUI's text system** | via custom TextLayoutManager |
| Image loading | **Stub for tier 1** | real impl deferred |
| React reconciler | **react-reconciler** | same approach as gpui-react, but targeting our shadow tree |

## Risk Register

| risk | mitigation |
|---|---|
| RN's C++ uses ObjC types in platform paths | only in `mounting/` platform delegates — we replace those. Core renderer is pure C++20 |
| RN's C++ build system is complex | CMake is well-defined for the renderer subset. FetchContent from `~/github/react-native` |
| Bun FFI perf for high-frequency mutations | batched mount instruction arrays, single FFI call per frame |
| GPUI API incompatibility | GPUI is crate 0.2.2, Rust 2024 edition. We match that and build against `~/github/zed` |
| RN's tests depend on Yoga internals | we compile RN's Yoga directly; no FFI boundary for layout |

## Summary

```
RN C++ renderer tests (unmodified .cpp files from ~/github/react-native)
        │ compile against
        ▼
RN Fabric staticlib + our C++ shim + gtest
        │ links
        ▼
gtest binary → tier 1 pass/fail
```

The stack is: RN's code unchanged + our ~200 line C++ shim + our Rust runtime + GPUI. Every passing RN test is a proof point that our renderer matches RN's semantics.

For today: build the CMake + Cargo skeleton, get one RN test compiling against a stub platform delegate, and watch it fail predictably.
