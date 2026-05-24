#include "gpui_platform.h"
#include <cstring>
#include <mutex>

#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/mounting/ShadowView.h>

namespace facebook::react {

GpuiMountingDelegate::GpuiMountingDelegate(SurfaceId surfaceId)
    : surfaceId_(surfaceId) {}

RootShadowNode::Unshared GpuiMountingDelegate::shadowTreeWillCommit(
    const ShadowTree& /*shadowTree*/,
    const RootShadowNode::Shared& /*oldRootShadowNode*/,
    const RootShadowNode::Unshared& newRootShadowNode,
    const ShadowTreeCommitOptions& /*commitOptions*/) const {
    // Accept the commit as-is. No tree modification.
    return newRootShadowNode;
}

void GpuiMountingDelegate::shadowTreeDidFinishTransaction(
    std::shared_ptr<const MountingCoordinator> mountingCoordinator,
    bool /*mountSynchronously*/) const {

    auto transaction = mountingCoordinator->pullTransaction();
    if (!transaction.has_value()) {
        return;
    }

    const auto& mutations = transaction->getMutations();

    GpuiMutationList flatMutations;
    flatMutations.reserve(mutations.size());

    for (const auto& mutation : mutations) {
        processMutation(mutation, flatMutations);
    }

    if (!flatMutations.empty()) {
        gpui_mount_batch(surfaceId_, flatMutations.data(), flatMutations.size());
    }
}

void GpuiMountingDelegate::flushMutations() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (pendingMutations_.empty()) return;
    gpui_mount_batch(surfaceId_, pendingMutations_.data(), pendingMutations_.size());
    pendingMutations_.clear();
}

void GpuiMountingDelegate::processMutation(
    const ShadowViewMutation& mutation,
    GpuiMutationList& out) const {

    GpuiMutation m = {};
    m.surface_id = surfaceId_;

    const auto& type = mutation.type;

    switch (type) {
        case ShadowViewMutation::Create: {
            m.type = 1;
            auto tag = mutation.newChildShadowView.tag;
            m.child_tag = tag;
            const auto& frame = mutation.newChildShadowView.layoutMetrics.frame;
            m.left = frame.origin.x;
            m.top = frame.origin.y;
            m.width = frame.size.width;
            m.height = frame.size.height;
            if (mutation.newChildShadowView.componentName) {
                std::strncpy(
                    m.component_name,
                    mutation.newChildShadowView.componentName,
                    sizeof(m.component_name) - 1);
            }
            out.push_back(m);
            break;
        }
        case ShadowViewMutation::Delete: {
            m.type = 2;
            m.child_tag = mutation.oldChildShadowView.tag;
            out.push_back(m);
            break;
        }
        case ShadowViewMutation::Insert: {
            m.type = 4;
            m.parent_tag = mutation.parentTag;
            m.child_tag = mutation.newChildShadowView.tag;
            m.index = mutation.index;
            const auto& frame = mutation.newChildShadowView.layoutMetrics.frame;
            m.left = frame.origin.x;
            m.top = frame.origin.y;
            m.width = frame.size.width;
            m.height = frame.size.height;
            out.push_back(m);
            break;
        }
        case ShadowViewMutation::Remove: {
            m.type = 8;
            m.parent_tag = mutation.parentTag;
            m.child_tag = mutation.oldChildShadowView.tag;
            m.index = mutation.index;
            out.push_back(m);
            break;
        }
        case ShadowViewMutation::Update: {
            m.type = 16;
            m.parent_tag = mutation.parentTag;
            m.child_tag = mutation.newChildShadowView.tag;
            const auto& frame = mutation.newChildShadowView.layoutMetrics.frame;
            m.left = frame.origin.x;
            m.top = frame.origin.y;
            m.width = frame.size.width;
            m.height = frame.size.height;
            out.push_back(m);
            break;
        }
    }
}

} // namespace facebook::react
