cmake_minimum_required(VERSION 3.20)
project(react-native-gpui-tests CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_compile_definitions(GLOG_NO_ABBREVIATED_SEVERITIES GLOG_USE_GLOG_EXPORT)

# ── RN source tree ──────────────────────────────────────────────────

set(RN_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../github/react-native")
set(RN_COMMON "${RN_ROOT}/packages/react-native/ReactCommon")
set(RN_FABRIC "${RN_COMMON}/react/renderer")

message(STATUS "RN ReactCommon: ${RN_COMMON}")

# ── Homebrew deps ────────────────────────────────────────────────────

macro(find_homebrew_lib header lib)
    find_library(${lib}_LIB ${lib} REQUIRED
        PATHS /opt/homebrew/lib /usr/local/lib)
    find_path(${lib}_INC ${header}
        PATHS /opt/homebrew/include /usr/local/include)
    message(STATUS "${lib}: ${${lib}_INC} / ${${lib}_LIB}")
endmacro()

find_homebrew_lib(folly/dynamic.h folly)
find_homebrew_lib(glog/logging.h glog)
find_homebrew_lib(fmt/core.h fmt)
find_homebrew_lib(double-conversion/double-conversion.h double-conversion)
find_homebrew_lib(gflags/gflags.h gflags)
find_homebrew_lib(gtest/gtest.h gtest)

# ── Yoga ─────────────────────────────────────────────────────────────

add_subdirectory("${RN_COMMON}/yoga" "${CMAKE_BINARY_DIR}/yoga" EXCLUDE_FROM_ALL)

# ── RN Fabric sources ───────────────────────────────────────────────

file(GLOB RN_SOURCES CONFIGURE_DEPENDS
    "${RN_FABRIC}/core/*.cpp"
    "${RN_FABRIC}/element/*.cpp"
    "${RN_FABRIC}/components/view/*.cpp"
    "${RN_FABRIC}/components/root/*.cpp"
    "${RN_FABRIC}/mounting/*.cpp"
    "${RN_FABRIC}/graphics/*.cpp"
    "${RN_FABRIC}/debug/*.cpp"
    "${RN_FABRIC}/mapbuffer/*.cpp"
    "${RN_FABRIC}/componentregistry/*.cpp"
    "${RN_FABRIC}/telemetry/*.cpp"
    "${RN_FABRIC}/css/*.cpp"
    "${RN_FABRIC}/runtimescheduler/*.cpp"
    "${RN_COMMON}/react/utils/*.cpp"
    "${RN_COMMON}/react/debug/*.cpp"
    "${RN_COMMON}/react/featureflags/*.cpp"
    "${RN_COMMON}/jsi/*.cpp"
    "${RN_COMMON}/logger/*.cpp"
)

file(GLOB RN_TESTS CONFIGURE_DEPENDS
    "${RN_FABRIC}/core/tests/FindNodeAtPointTest.cpp"
    "${RN_FABRIC}/core/tests/LayoutableShadowNodeTest.cpp"
    "${RN_FABRIC}/core/tests/ShadowNodeTest.cpp"
    "${RN_FABRIC}/core/tests/ComponentDescriptorTest.cpp"
)

# ── Include paths ────────────────────────────────────────────────────

set(PLATFORM_DIRS
    "${RN_FABRIC}/graphics/platform/cxx"
    "${RN_FABRIC}/components/view/platform/cxx"
    "${RN_FABRIC}/components/text/platform/cxx"
    "${RN_FABRIC}/components/modal/platform/cxx"
    "${RN_FABRIC}/components/scrollview/platform/cxx"
    "${RN_FABRIC}/imagemanager/platform/cxx"
    "${RN_FABRIC}/textlayoutmanager/platform/cxx"
    "${RN_COMMON}/react/utils/platform/cxx"
)

set(RN_INCLUDES
    "${RN_COMMON}"
    "${RN_COMMON}/runtimeexecutor"
    "${RN_COMMON}/runtimeexecutor/platform/cxx"
    "${RN_COMMON}/runtimeexecutor/platform/ios"
    "${RN_COMMON}/callinvoker"
    "${RN_FABRIC}/core" "${RN_FABRIC}/core/tests"
    "${RN_FABRIC}/components/view" "${RN_FABRIC}/components/root"
    "${RN_FABRIC}/mounting" "${RN_FABRIC}/element"
    "${RN_FABRIC}/graphics" "${RN_FABRIC}/debug"
    "${RN_FABRIC}/mapbuffer" "${RN_FABRIC}/componentregistry"
    "${RN_FABRIC}/telemetry" "${RN_FABRIC}/css"
    "${RN_FABRIC}/runtimescheduler"
    "${RN_FABRIC}/scheduler" "${RN_FABRIC}/uimanager"
    "${RN_COMMON}/react/utils" "${RN_COMMON}/react/debug"
    "${RN_COMMON}/react/featureflags"
    "${RN_COMMON}/jsi" "${RN_COMMON}/jsi/jsi"
    "${RN_COMMON}/logger" "${RN_COMMON}/yoga"
    ${PLATFORM_DIRS}
    "${folly_INC}" "${glog_INC}" "${fmt_INC}"
    "/opt/homebrew/include"
    "/opt/homebrew/include"
    "/opt/homebrew/include"
)

# ── RN renderer static library ──────────────────────────────────────

add_library(rn_react_renderer STATIC ${RN_SOURCES})
target_include_directories(rn_react_renderer PUBLIC ${RN_INCLUDES})
target_compile_options(rn_react_renderer PRIVATE
    -Wall -fexceptions -frtti
    -DFOLLY_NO_CONFIG=1 -DLOG_TAG=\"ReactNative\"
)
target_link_libraries(rn_react_renderer PUBLIC
    ${folly_LIB} ${glog_LIB} ${fmt_LIB}
    ${double-conversion_LIB} ${gflags_LIB}
    yogacore
)

# ── Platform shim ───────────────────────────────────────────────────

add_library(gpui_platform STATIC gpui_platform.cpp)
target_include_directories(gpui_platform PRIVATE . ${RN_INCLUDES})
target_link_libraries(gpui_platform PUBLIC rn_react_renderer)

# ── Test binary ─────────────────────────────────────────────────────

add_executable(rn_renderer_tests ${RN_TESTS})
target_include_directories(rn_renderer_tests PRIVATE . ${RN_INCLUDES})
target_link_libraries(rn_renderer_tests
    gpui_platform rn_react_renderer ${gtest_LIB}
    ${folly_LIB} ${glog_LIB} ${fmt_LIB}
    ${double-conversion_LIB} ${gflags_LIB}
    yogacore
)
