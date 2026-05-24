#pragma once

#include <memory>
#include <vector>

#include <react/renderer/mounting/MountingCoordinator.h>
#include <react/renderer/mounting/ShadowTreeDelegate.h>
#include <react/renderer/mounting/ShadowViewMutation.h>

namespace facebook::react {

// ── Flat C struct for FFI ───────────────────────────────────────────

#pragma pack(push, 1)
struct GpuiMutation {
    uint8_t type;        // 1=Create, 2=Delete, 4=Insert, 8=Remove, 16=Update
    int64_t parent_tag;
    int64_t child_tag;
    int32_t index;
    float left;
    float top;
    float width;
    float height;
    char component_name[64];
    uint64_t surface_id;
};
#pragma pack(pop)

using GpuiMutationList = std::vector<GpuiMutation>;

// ── Rust FFI functions (implemented in lib.rs, exported from cdylib) ─

extern "C" {
    void gpui_mount_batch(uint64_t surface_id, const GpuiMutation* mutations, size_t count);
    void gpui_create_surface(uint64_t surface_id, float width, float height);
    bool gpui_is_initialized();
}

// ── Platform delegate ───────────────────────────────────────────────

class GpuiMountingDelegate final : public ShadowTreeDelegate {
public:
    explicit GpuiMountingDelegate(SurfaceId surfaceId);

    RootShadowNode::Unshared shadowTreeWillCommit(
        const ShadowTree& shadowTree,
        const RootShadowNode::Shared& oldRootShadowNode,
        const RootShadowNode::Unshared& newRootShadowNode,
        const ShadowTreeCommitOptions& commitOptions) const override;

    void shadowTreeDidFinishTransaction(
        std::shared_ptr<const MountingCoordinator> mountingCoordinator,
        bool mountSynchronously) const override;

private:
    SurfaceId surfaceId_;
    mutable GpuiMutationList pendingMutations_;
    mutable std::mutex mutex_;

    void flushMutations() const;
    void processMutation(const ShadowViewMutation& mutation, GpuiMutationList& out) const;
};

} // namespace facebook::react
