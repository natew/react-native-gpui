use crate::{
    AbsoluteLength, App, Bounds, DefiniteLength, Edges, Length, Pixels, Point, Size, Style, Window,
    point, size,
};
use collections::{FxHashMap, FxHashSet};
use smallvec::SmallVec;
use stacksafe::{StackSafe, stacksafe};
use std::{fmt::Debug, ops::Range};
use taffy::{
    TaffyTree, TraversePartialTree as _,
    geometry::{Point as TaffyPoint, Rect as TaffyRect, Size as TaffySize},
    style::AvailableSpace as TaffyAvailableSpace,
    tree::NodeId,
};

type NodeMeasureFn = StackSafe<
    Box<
        dyn FnMut(
            Size<Option<Pixels>>,
            Size<AvailableSpace>,
            &mut Window,
            &mut App,
        ) -> Size<Pixels>,
    >,
>;

struct NodeContext {
    measure: NodeMeasureFn,
}
pub struct TaffyLayoutEngine {
    taffy: TaffyTree<NodeContext>,
    absolute_layout_bounds: FxHashMap<LayoutId, Bounds<Pixels>>,
    computed_layouts: FxHashSet<LayoutId>,
    // Retained-layout fast path (react-native-gpui patch). gpui is immediate-mode: the
    // taffy tree is rebuilt + re-SOLVED every draw, so an idle "paint-only" frame (a hover
    // background flip, an opacity pulse) pays the full O(total-nodes) flexbox CONSTRAINT
    // SOLVE (~6.4ms at 1300 nodes; the per-node measure callbacks are only ~0.5ms because
    // text shaping is cached) even though no box moved.
    //
    // when the host knows a frame changed only paint-only state, the next draw replays
    // the prior tree's LayoutIds in allocation order. fresh measure closures replace the
    // retained closures in place, then run with the prior solved sizes. no taffy nodes,
    // styles, children, or bounds are rebuilt. a positional kind/count mismatch trips
    // `reuse_desynced`, and the host runs a full layout on the following draw.
    retained: Vec<LayoutId>,
    retained_measured: Vec<bool>,
    prev_bounds: Vec<Bounds<Pixels>>,
    reuse: bool,
    reuse_cursor: usize,
    reuse_desynced: bool,
    // Incremental-layout frame (react-native-gpui patch). A "reuse" frame skips the solve
    // entirely and is only legal when NOTHING moved. Incremental is the middle case: the host
    // proved the node GRAPH is identical (same elements, same order, same child counts) but
    // some nodes' layout inputs changed. We keep the persistent taffy tree instead of
    // clear()ing it, push `set_style` only into nodes whose style actually differs, and mark
    // measured nodes dirty only where content changed. taffy 0.9 keeps per-node caches and
    // clears them up the ancestor chain on mutation, so the solve re-runs only touched
    // branches and reuses everything else.
    incremental: bool,
    // taffy style each retained node was last given, parallel to `retained`.
    prev_styles: Vec<taffy::style::Style>,
    // One-shot, set immediately before an element requests a measured child whose CONTENT
    // changed. A text change never appears in the taffy Style, so without this the node keeps
    // taffy's cached measure and lays out at its old size. Consumed by the next
    // `request_measured_layout`; survives intervening `request_layout` calls by design.
    measure_dirty_next: bool,
}

const EXPECT_MESSAGE: &str = "we should avoid taffy layout errors by construction if possible";

impl TaffyLayoutEngine {
    pub fn new() -> Self {
        let mut taffy = TaffyTree::new();
        taffy.enable_rounding();
        TaffyLayoutEngine {
            taffy,
            absolute_layout_bounds: FxHashMap::default(),
            computed_layouts: FxHashSet::default(),
            retained: Vec::new(),
            retained_measured: Vec::new(),
            prev_bounds: Vec::new(),
            reuse: false,
            reuse_cursor: 0,
            reuse_desynced: false,
            incremental: false,
            prev_styles: Vec::new(),
            measure_dirty_next: false,
        }
    }

    pub fn clear(&mut self) {
        self.taffy.clear();
        self.absolute_layout_bounds.clear();
        self.computed_layouts.clear();
        self.retained.clear();
        self.retained_measured.clear();
        // prev_bounds is intentionally not cleared here. the next full frame replaces
        // it after solving, keeping the previous geometry available for diagnostics in
        // the meantime.
        self.reuse = false;
        self.reuse_cursor = 0;
        self.reuse_desynced = false;
        // the taffy tree is gone, so these styles describe nothing; an incremental frame
        // afterwards would diff against garbage.
        self.incremental = false;
        self.prev_styles.clear();
    }

    /// Begin an incremental-layout frame: keep the persistent taffy tree, replay the prior
    /// nodes in allocation order, and still run the solve — but only nodes whose style
    /// actually changed get `set_style`, and only content-dirty measured nodes are
    /// invalidated, so taffy's caches carry the untouched branches.
    ///
    /// The caller must have proven the node graph is unchanged. A positional mismatch trips
    /// `reuse_desynced` and the host forces a full layout next draw.
    pub fn begin_incremental_frame(&mut self) -> bool {
        if self.prev_bounds.is_empty()
            || self.retained.len() != self.prev_bounds.len()
            || self.retained_measured.len() != self.retained.len()
            || self.prev_styles.len() != self.retained.len()
        {
            return false;
        }
        self.incremental = true;
        self.reuse = false;
        self.reuse_cursor = 0;
        self.reuse_desynced = false;
        self.measure_dirty_next = false;
        true
    }

    /// Mark the NEXT measured node requested this frame as content-dirty.
    pub fn mark_next_measured_dirty(&mut self) {
        self.measure_dirty_next = true;
    }

    /// True while an incremental frame is in progress (persistent tree, partial re-solve).
    pub fn is_incremental(&self) -> bool {
        self.incremental
    }

    /// begin a retained-layout frame: replay the prior nodes + run fresh measures, but
    /// skip node/style reconstruction and the flexbox solve. Returns false
    /// (caller runs a full layout) when there is no prior geometry to reuse yet — the very
    /// first frame, or right after a tree commit.
    pub fn begin_reuse_frame(&mut self) -> bool {
        if self.prev_bounds.is_empty()
            || self.retained.len() != self.prev_bounds.len()
            || self.retained_measured.len() != self.retained.len()
        {
            return false;
        }
        self.reuse = true;
        self.incremental = false;
        self.reuse_cursor = 0;
        self.reuse_desynced = false;
        true
    }

    /// True while a retained-layout frame is in progress (the flexbox solve is skipped).
    pub fn is_reusing(&self) -> bool {
        self.reuse
    }

    /// True when this reuse frame allocated a different node count than the retained frame
    /// — a structural change slipped past the host gate, so the retained geometry is not
    /// trustworthy and the host must force a full relayout next draw.
    pub fn reuse_desynced(&self) -> bool {
        self.reuse_desynced
    }

    pub fn request_layout(
        &mut self,
        style: Style,
        rem_size: Pixels,
        scale_factor: f32,
        children: &[LayoutId],
    ) -> LayoutId {
        if self.reuse {
            let index = self.reuse_cursor;
            self.reuse_cursor += 1;
            if let Some(&id) = self.retained.get(index) {
                if self.retained_measured.get(index).copied() != Some(false) {
                    self.reuse_desynced = true;
                    self.taffy.set_node_context(id.into(), None).ok();
                    self.retained_measured[index] = false;
                }
                return id;
            }
            self.reuse_desynced = true;
        }

        let taffy_style = style.to_taffy(rem_size, scale_factor);

        if self.incremental {
            let index = self.reuse_cursor;
            self.reuse_cursor += 1;
            match self.retained.get(index).copied() {
                // A measured slot or a different child count means the element walk diverged
                // from the frame we are building on, so replaying positionally would attribute
                // geometry to the wrong node.
                Some(id)
                    if self.retained_measured.get(index).copied() == Some(false)
                        && self.taffy.child_count(id.into()) == children.len() =>
                {
                    if self.prev_styles[index] != taffy_style {
                        // set_style clears this node's cache and its ancestors' — exactly the
                        // invalidation we want; clean siblings keep theirs.
                        self.taffy.set_style(id.into(), taffy_style.clone()).ok();
                        self.prev_styles[index] = taffy_style;
                    }
                    return id;
                }
                _ => self.reuse_desynced = true,
            }
            // desynced: fall through and allocate so THIS frame still renders; the host clears
            // the engine at end-of-draw and the next frame is a full layout.
        }

        let id: LayoutId = if children.is_empty() {
            self.taffy
                .new_leaf(taffy_style.clone())
                .expect(EXPECT_MESSAGE)
                .into()
        } else {
            self.taffy
                // This is safe because LayoutId is repr(transparent) to taffy::tree::NodeId.
                .new_with_children(taffy_style.clone(), LayoutId::to_taffy_slice(children))
                .expect(EXPECT_MESSAGE)
                .into()
        };
        self.retained.push(id);
        self.retained_measured.push(false);
        self.prev_styles.push(taffy_style);
        id
    }

    pub fn request_measured_layout(
        &mut self,
        style: Style,
        rem_size: Pixels,
        scale_factor: f32,
        measure: impl FnMut(
            Size<Option<Pixels>>,
            Size<AvailableSpace>,
            &mut Window,
            &mut App,
        ) -> Size<Pixels>
        + 'static,
    ) -> LayoutId {
        let context = NodeContext {
            measure: StackSafe::new(Box::new(measure)),
        };
        if self.reuse {
            let index = self.reuse_cursor;
            self.reuse_cursor += 1;
            if let Some(&id) = self.retained.get(index) {
                if self.retained_measured.get(index).copied() == Some(true) {
                    if let Some(existing) = self.taffy.get_node_context_mut(id.into()) {
                        *existing = context;
                    } else {
                        self.reuse_desynced = true;
                        self.taffy.set_node_context(id.into(), Some(context)).ok();
                    }
                } else {
                    self.reuse_desynced = true;
                    self.taffy.set_node_context(id.into(), Some(context)).ok();
                    self.retained_measured[index] = true;
                }
                return id;
            }

            // a structure change slipped through the host gate. allocate the extra node
            // so this frame stays safe, then force a full rebuild on the next draw.
            self.reuse_desynced = true;
            let taffy_style = style.to_taffy(rem_size, scale_factor);
            let id: LayoutId = self
                .taffy
                .new_leaf_with_context(taffy_style, context)
                .expect(EXPECT_MESSAGE)
                .into();
            self.retained.push(id);
            self.retained_measured.push(true);
            return id;
        }

        let taffy_style = style.to_taffy(rem_size, scale_factor);

        if self.incremental {
            let dirty = std::mem::take(&mut self.measure_dirty_next);
            let index = self.reuse_cursor;
            self.reuse_cursor += 1;
            match self.retained.get(index).copied() {
                Some(id) if self.retained_measured.get(index).copied() == Some(true) => {
                    if self.prev_styles[index] != taffy_style {
                        self.taffy.set_style(id.into(), taffy_style.clone()).ok();
                        self.prev_styles[index] = taffy_style;
                    }
                    // Swap the closure in place. Assigning THROUGH the context does not touch
                    // taffy's dirty bits, so unchanged text keeps its cached measure;
                    // set_node_context would dirty every text node every frame and defeat this
                    // entirely. Content changes arrive via mark_next_measured_dirty instead.
                    if let Some(existing) = self.taffy.get_node_context_mut(id.into()) {
                        *existing = context;
                    } else {
                        self.reuse_desynced = true;
                        self.taffy.set_node_context(id.into(), Some(context)).ok();
                    }
                    if dirty {
                        self.taffy.mark_dirty(id.into()).ok();
                    }
                    return id;
                }
                _ => self.reuse_desynced = true,
            }
        }

        let id: LayoutId = self
            .taffy
            .new_leaf_with_context(taffy_style.clone(), context)
            .expect(EXPECT_MESSAGE)
            .into();
        self.retained.push(id);
        self.retained_measured.push(true);
        self.prev_styles.push(taffy_style);
        id
    }

    // Used to understand performance
    #[allow(dead_code)]
    fn count_all_children(&self, parent: LayoutId) -> anyhow::Result<u32> {
        let mut count = 0;

        for child in self.taffy.children(parent.0)? {
            // Count this child.
            count += 1;

            // Count all of this child's children.
            count += self.count_all_children(LayoutId(child))?
        }

        Ok(count)
    }

    // Used to understand performance
    #[allow(dead_code)]
    fn max_depth(&self, depth: u32, parent: LayoutId) -> anyhow::Result<u32> {
        println!(
            "{parent:?} at depth {depth} has {} children",
            self.taffy.child_count(parent.0)
        );

        let mut max_child_depth = 0;

        for child in self.taffy.children(parent.0)? {
            max_child_depth = std::cmp::max(max_child_depth, self.max_depth(0, LayoutId(child))?);
        }

        Ok(depth + 1 + max_child_depth)
    }

    // Used to understand performance
    #[allow(dead_code)]
    fn get_edges(&self, parent: LayoutId) -> anyhow::Result<Vec<(LayoutId, LayoutId)>> {
        let mut edges = Vec::new();

        for child in self.taffy.children(parent.0)? {
            edges.push((parent, LayoutId(child)));

            edges.extend(self.get_edges(LayoutId(child))?);
        }

        Ok(edges)
    }

    #[stacksafe]
    pub fn compute_layout(
        &mut self,
        id: LayoutId,
        available_space: Size<AvailableSpace>,
        window: &mut Window,
        cx: &mut App,
    ) {
        // retained-layout frame: skip the expensive flexbox solve (~6.4ms at 1300 nodes).
        // invoke each measured node's fresh closure so gpui's text/input elements
        // populate this frame's layout state, then keep using the retained taffy tree and
        // absolute-bounds cache. a node-count mismatch trips `reuse_desynced`, so the host
        // forces a full relayout next draw.
        if self.reuse {
            self.compute_layout_reuse(window, cx);
            return;
        }
        // Incremental frame: taffy will re-measure ONLY the nodes we dirtied, but gpui's
        // text/input elements populate their per-frame paint state inside the measure
        // callback. A clean text node would therefore never run its closure and paint would
        // panic ("measurement has not been performed"). Run every measured closure against
        // its prior solved size first — same reason compute_layout_reuse does it — then the
        // solve re-runs the dirty ones with real constraints and overwrites their state.
        if self.incremental {
            self.run_measured_closures(window, cx);
        }
        // Leaving this here until we have a better instrumentation approach.
        // println!("Laying out {} children", self.count_all_children(id)?);
        // println!("Max layout depth: {}", self.max_depth(0, id)?);

        // Output the edges (branches) of the tree in Mermaid format for visualization.
        // println!("Edges:");
        // for (a, b) in self.get_edges(id)? {
        //     println!("N{} --> N{}", u64::from(a), u64::from(b));
        // }
        //

        if !self.computed_layouts.insert(id) {
            let mut stack = SmallVec::<[LayoutId; 64]>::new();
            stack.push(id);
            while let Some(id) = stack.pop() {
                self.absolute_layout_bounds.remove(&id);
                stack.extend(
                    self.taffy
                        .children(id.into())
                        .expect(EXPECT_MESSAGE)
                        .into_iter()
                        .map(Into::into),
                );
            }
        }

        let scale_factor = window.scale_factor();

        let transform = |v: AvailableSpace| match v {
            AvailableSpace::Definite(pixels) => {
                AvailableSpace::Definite(Pixels(pixels.0 * scale_factor))
            }
            AvailableSpace::MinContent => AvailableSpace::MinContent,
            AvailableSpace::MaxContent => AvailableSpace::MaxContent,
        };
        let available_space = size(
            transform(available_space.width),
            transform(available_space.height),
        );

        self.taffy
            .compute_layout_with_measure(
                id.into(),
                available_space.into(),
                |known_dimensions, available_space, _id, node_context, _style| {
                    let Some(node_context) = node_context else {
                        return taffy::geometry::Size::default();
                    };

                    let known_dimensions = Size {
                        width: known_dimensions.width.map(|e| Pixels(e / scale_factor)),
                        height: known_dimensions.height.map(|e| Pixels(e / scale_factor)),
                    };

                    let available_space: Size<AvailableSpace> = available_space.into();
                    let untransform = |ev: AvailableSpace| match ev {
                        AvailableSpace::Definite(pixels) => {
                            AvailableSpace::Definite(Pixels(pixels.0 / scale_factor))
                        }
                        AvailableSpace::MinContent => AvailableSpace::MinContent,
                        AvailableSpace::MaxContent => AvailableSpace::MaxContent,
                    };
                    let available_space = size(
                        untransform(available_space.width),
                        untransform(available_space.height),
                    );

                    let a: Size<Pixels> =
                        (node_context.measure)(known_dimensions, available_space, window, cx);
                    size(a.width.0 * scale_factor, a.height.0 * scale_factor).into()
                },
            )
            .expect(EXPECT_MESSAGE);

        // Capture this full-layout frame's solved geometry positionally so the NEXT draw,
        // if it's a paint-only frame, can replay it without re-solving. `layout_bounds`
        // resolves + caches each node's absolute rect; we snapshot them in the same
        // allocation order the elements requested them, which the structurally identical
        // reuse frame will replay.
        let nodes = std::mem::take(&mut self.retained);
        let scale = window.scale_factor();
        self.prev_bounds.clear();
        self.prev_bounds.reserve(nodes.len());
        for &node in &nodes {
            let b = self.layout_bounds(node, scale);
            self.prev_bounds.push(b);
        }
        self.retained = nodes;
    }

    /// Run each retained measured node's closure against its previously solved size, so gpui
    /// text/input elements repopulate this frame's layout state without a solve.
    fn run_measured_closures(&mut self, window: &mut Window, cx: &mut App) {
        let expected = self.reuse_cursor.min(self.retained.len());
        for i in 0..expected {
            if !self.retained_measured.get(i).copied().unwrap_or(false) {
                continue;
            }
            let node = self.retained[i];
            let known = self
                .prev_bounds
                .get(i)
                .map(|b| Size {
                    width: Some(b.size.width),
                    height: Some(b.size.height),
                })
                .unwrap_or(Size {
                    width: None,
                    height: None,
                });
            let avail = Size {
                width: known
                    .width
                    .map(AvailableSpace::Definite)
                    .unwrap_or(AvailableSpace::MaxContent),
                height: known
                    .height
                    .map(AvailableSpace::Definite)
                    .unwrap_or(AvailableSpace::MaxContent),
            };
            if let Some(ctx) = self.taffy.get_node_context_mut(node.into()) {
                // SAFETY of re-entrancy: the closure borrows window/cx but not the taffy tree.
                let _ = (ctx.measure)(known, avail, window, cx);
            }
        }
    }

    /// run fresh closures for measured nodes with their retained solved sizes. the tree
    /// and absolute-bounds map already contain the prior full frame, so no copies or
    /// taffy traversal are needed.
    fn compute_layout_reuse(&mut self, window: &mut Window, cx: &mut App) {
        if self.reuse_cursor != self.prev_bounds.len() {
            self.reuse_desynced = true;
        }
        let expected = self.reuse_cursor.min(self.retained.len());
        for i in 0..expected {
            if !self.retained_measured.get(i).copied().unwrap_or(false) {
                continue;
            }
            let node = self.retained[i];
            // run this node's measure closure (if any) so the gpui text/input element
            // populates its layout state for prepaint/paint. The cached known dimensions
            // come from the prior frame's solved size — identical geometry, so the shaping
            // (already cached in the text system) matches exactly.
            if self.taffy.get_node_context(node.into()).is_some() {
                let known = self
                    .prev_bounds
                    .get(i)
                    .map(|b| Size {
                        width: Some(b.size.width),
                        height: Some(b.size.height),
                    })
                    .unwrap_or(Size {
                        width: None,
                        height: None,
                    });
                let avail = Size {
                    width: known
                        .width
                        .map(AvailableSpace::Definite)
                        .unwrap_or(AvailableSpace::MaxContent),
                    height: known
                        .height
                        .map(AvailableSpace::Definite)
                        .unwrap_or(AvailableSpace::MaxContent),
                };
                if let Some(ctx) = self.taffy.get_node_context_mut(node.into()) {
                    // SAFETY of re-entrancy: the measure closure borrows window/cx but not
                    // the taffy tree, so calling it through the &mut context is fine.
                    let _ = (ctx.measure)(known, avail, window, cx);
                }
            }
        }
    }

    pub fn layout_bounds(&mut self, id: LayoutId, scale_factor: f32) -> Bounds<Pixels> {
        if let Some(layout) = self.absolute_layout_bounds.get(&id).cloned() {
            return layout;
        }

        // a retained-layout replay that desynced can allocate an unmatched node. answer
        // with a zero rect rather than panicking if taffy cannot resolve it; the host sees
        // `reuse_desynced()` and forces a full relayout on the next draw.
        let Ok(layout) = self.taffy.layout(id.into()) else {
            return Bounds::default();
        };
        let mut bounds = Bounds {
            origin: point(
                Pixels(layout.location.x / scale_factor),
                Pixels(layout.location.y / scale_factor),
            ),
            size: size(
                Pixels(layout.size.width / scale_factor),
                Pixels(layout.size.height / scale_factor),
            ),
        };

        if let Some(parent_id) = self.taffy.parent(id.0) {
            let parent_bounds = self.layout_bounds(parent_id.into(), scale_factor);
            bounds.origin += parent_bounds.origin;
        }
        self.absolute_layout_bounds.insert(id, bounds);

        bounds
    }
}

/// A unique identifier for a layout node, generated when requesting a layout from Taffy
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
#[repr(transparent)]
pub struct LayoutId(NodeId);

impl LayoutId {
    fn to_taffy_slice(node_ids: &[Self]) -> &[taffy::NodeId] {
        // SAFETY: LayoutId is repr(transparent) to taffy::tree::NodeId.
        unsafe { std::mem::transmute::<&[LayoutId], &[taffy::NodeId]>(node_ids) }
    }
}

impl std::hash::Hash for LayoutId {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        u64::from(self.0).hash(state);
    }
}

impl From<NodeId> for LayoutId {
    fn from(node_id: NodeId) -> Self {
        Self(node_id)
    }
}

impl From<LayoutId> for NodeId {
    fn from(layout_id: LayoutId) -> NodeId {
        layout_id.0
    }
}

trait ToTaffy<Output> {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> Output;
}

impl ToTaffy<taffy::style::Style> for Style {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::Style {
        use taffy::style_helpers::{fr, length, minmax, repeat};

        fn to_grid_line(
            placement: &Range<crate::GridPlacement>,
        ) -> taffy::Line<taffy::GridPlacement> {
            taffy::Line {
                start: placement.start.into(),
                end: placement.end.into(),
            }
        }

        fn to_grid_repeat<T: taffy::style::CheapCloneStr>(
            unit: &Option<u16>,
        ) -> Vec<taffy::GridTemplateComponent<T>> {
            // grid-template-columns: repeat(<number>, minmax(0, 1fr));
            unit.map(|count| vec![repeat(count, vec![minmax(length(0.0), fr(1.0))])])
                .unwrap_or_default()
        }

        taffy::style::Style {
            display: self.display.into(),
            overflow: self.overflow.into(),
            scrollbar_width: self.scrollbar_width.to_taffy(rem_size, scale_factor),
            position: self.position.into(),
            inset: self.inset.to_taffy(rem_size, scale_factor),
            size: self.size.to_taffy(rem_size, scale_factor),
            min_size: self.min_size.to_taffy(rem_size, scale_factor),
            max_size: self.max_size.to_taffy(rem_size, scale_factor),
            aspect_ratio: self.aspect_ratio,
            margin: self.margin.to_taffy(rem_size, scale_factor),
            padding: self.padding.to_taffy(rem_size, scale_factor),
            border: self.border_widths.to_taffy(rem_size, scale_factor),
            align_items: self.align_items.map(|x| x.into()),
            align_self: self.align_self.map(|x| x.into()),
            align_content: self.align_content.map(|x| x.into()),
            justify_content: self.justify_content.map(|x| x.into()),
            gap: self.gap.to_taffy(rem_size, scale_factor),
            flex_direction: self.flex_direction.into(),
            flex_wrap: self.flex_wrap.into(),
            flex_basis: self.flex_basis.to_taffy(rem_size, scale_factor),
            flex_grow: self.flex_grow,
            flex_shrink: self.flex_shrink,
            grid_template_rows: to_grid_repeat(&self.grid_rows),
            grid_template_columns: to_grid_repeat(&self.grid_cols),
            grid_row: self
                .grid_location
                .as_ref()
                .map(|location| to_grid_line(&location.row))
                .unwrap_or_default(),
            grid_column: self
                .grid_location
                .as_ref()
                .map(|location| to_grid_line(&location.column))
                .unwrap_or_default(),
            ..Default::default()
        }
    }
}

impl ToTaffy<f32> for AbsoluteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> f32 {
        match self {
            AbsoluteLength::Pixels(pixels) => {
                let pixels: f32 = pixels.into();
                pixels * scale_factor
            }
            AbsoluteLength::Rems(rems) => {
                let pixels: f32 = (*rems * rem_size).into();
                pixels * scale_factor
            }
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentageAuto> for Length {
    fn to_taffy(
        &self,
        rem_size: Pixels,
        scale_factor: f32,
    ) -> taffy::prelude::LengthPercentageAuto {
        match self {
            Length::Definite(length) => length.to_taffy(rem_size, scale_factor),
            Length::Auto => taffy::prelude::LengthPercentageAuto::auto(),
        }
    }
}

impl ToTaffy<taffy::style::Dimension> for Length {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::prelude::Dimension {
        match self {
            Length::Definite(length) => length.to_taffy(rem_size, scale_factor),
            Length::Auto => taffy::prelude::Dimension::auto(),
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentage> for DefiniteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::LengthPercentage {
        match self {
            DefiniteLength::Absolute(length) => match length {
                AbsoluteLength::Pixels(pixels) => {
                    let pixels: f32 = pixels.into();
                    taffy::style::LengthPercentage::length(pixels * scale_factor)
                }
                AbsoluteLength::Rems(rems) => {
                    let pixels: f32 = (*rems * rem_size).into();
                    taffy::style::LengthPercentage::length(pixels * scale_factor)
                }
            },
            DefiniteLength::Fraction(fraction) => {
                taffy::style::LengthPercentage::percent(*fraction)
            }
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentageAuto> for DefiniteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::LengthPercentageAuto {
        match self {
            DefiniteLength::Absolute(length) => match length {
                AbsoluteLength::Pixels(pixels) => {
                    let pixels: f32 = pixels.into();
                    taffy::style::LengthPercentageAuto::length(pixels * scale_factor)
                }
                AbsoluteLength::Rems(rems) => {
                    let pixels: f32 = (*rems * rem_size).into();
                    taffy::style::LengthPercentageAuto::length(pixels * scale_factor)
                }
            },
            DefiniteLength::Fraction(fraction) => {
                taffy::style::LengthPercentageAuto::percent(*fraction)
            }
        }
    }
}

impl ToTaffy<taffy::style::Dimension> for DefiniteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::Dimension {
        match self {
            DefiniteLength::Absolute(length) => match length {
                AbsoluteLength::Pixels(pixels) => {
                    let pixels: f32 = pixels.into();
                    taffy::style::Dimension::length(pixels * scale_factor)
                }
                AbsoluteLength::Rems(rems) => {
                    taffy::style::Dimension::length((*rems * rem_size * scale_factor).into())
                }
            },
            DefiniteLength::Fraction(fraction) => taffy::style::Dimension::percent(*fraction),
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentage> for AbsoluteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::LengthPercentage {
        match self {
            AbsoluteLength::Pixels(pixels) => {
                let pixels: f32 = pixels.into();
                taffy::style::LengthPercentage::length(pixels * scale_factor)
            }
            AbsoluteLength::Rems(rems) => {
                let pixels: f32 = (*rems * rem_size).into();
                taffy::style::LengthPercentage::length(pixels * scale_factor)
            }
        }
    }
}

impl<T, T2> From<TaffyPoint<T>> for Point<T2>
where
    T: Into<T2>,
    T2: Clone + Debug + Default + PartialEq,
{
    fn from(point: TaffyPoint<T>) -> Point<T2> {
        Point {
            x: point.x.into(),
            y: point.y.into(),
        }
    }
}

impl<T, T2> From<Point<T>> for TaffyPoint<T2>
where
    T: Into<T2> + Clone + Debug + Default + PartialEq,
{
    fn from(val: Point<T>) -> Self {
        TaffyPoint {
            x: val.x.into(),
            y: val.y.into(),
        }
    }
}

impl<T, U> ToTaffy<TaffySize<U>> for Size<T>
where
    T: ToTaffy<U> + Clone + Debug + Default + PartialEq,
{
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> TaffySize<U> {
        TaffySize {
            width: self.width.to_taffy(rem_size, scale_factor),
            height: self.height.to_taffy(rem_size, scale_factor),
        }
    }
}

impl<T, U> ToTaffy<TaffyRect<U>> for Edges<T>
where
    T: ToTaffy<U> + Clone + Debug + Default + PartialEq,
{
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> TaffyRect<U> {
        TaffyRect {
            top: self.top.to_taffy(rem_size, scale_factor),
            right: self.right.to_taffy(rem_size, scale_factor),
            bottom: self.bottom.to_taffy(rem_size, scale_factor),
            left: self.left.to_taffy(rem_size, scale_factor),
        }
    }
}

impl<T, U> From<TaffySize<T>> for Size<U>
where
    T: Into<U>,
    U: Clone + Debug + Default + PartialEq,
{
    fn from(taffy_size: TaffySize<T>) -> Self {
        Size {
            width: taffy_size.width.into(),
            height: taffy_size.height.into(),
        }
    }
}

impl<T, U> From<Size<T>> for TaffySize<U>
where
    T: Into<U> + Clone + Debug + Default + PartialEq,
{
    fn from(size: Size<T>) -> Self {
        TaffySize {
            width: size.width.into(),
            height: size.height.into(),
        }
    }
}

/// The space available for an element to be laid out in
#[derive(Copy, Clone, Default, Debug, Eq, PartialEq)]
pub enum AvailableSpace {
    /// The amount of space available is the specified number of pixels
    Definite(Pixels),
    /// The amount of space available is indefinite and the node should be laid out under a min-content constraint
    #[default]
    MinContent,
    /// The amount of space available is indefinite and the node should be laid out under a max-content constraint
    MaxContent,
}

impl AvailableSpace {
    /// Returns a `Size` with both width and height set to `AvailableSpace::MinContent`.
    ///
    /// This function is useful when you want to create a `Size` with the minimum content constraints
    /// for both dimensions.
    ///
    /// # Examples
    ///
    /// ```
    /// use gpui::AvailableSpace;
    /// let min_content_size = AvailableSpace::min_size();
    /// assert_eq!(min_content_size.width, AvailableSpace::MinContent);
    /// assert_eq!(min_content_size.height, AvailableSpace::MinContent);
    /// ```
    pub const fn min_size() -> Size<Self> {
        Size {
            width: Self::MinContent,
            height: Self::MinContent,
        }
    }
}

impl From<AvailableSpace> for TaffyAvailableSpace {
    fn from(space: AvailableSpace) -> TaffyAvailableSpace {
        match space {
            AvailableSpace::Definite(Pixels(value)) => TaffyAvailableSpace::Definite(value),
            AvailableSpace::MinContent => TaffyAvailableSpace::MinContent,
            AvailableSpace::MaxContent => TaffyAvailableSpace::MaxContent,
        }
    }
}

impl From<TaffyAvailableSpace> for AvailableSpace {
    fn from(space: TaffyAvailableSpace) -> AvailableSpace {
        match space {
            TaffyAvailableSpace::Definite(value) => AvailableSpace::Definite(Pixels(value)),
            TaffyAvailableSpace::MinContent => AvailableSpace::MinContent,
            TaffyAvailableSpace::MaxContent => AvailableSpace::MaxContent,
        }
    }
}

impl From<Pixels> for AvailableSpace {
    fn from(pixels: Pixels) -> Self {
        AvailableSpace::Definite(pixels)
    }
}

impl From<Size<Pixels>> for Size<AvailableSpace> {
    fn from(size: Size<Pixels>) -> Self {
        Size {
            width: AvailableSpace::Definite(size.width),
            height: AvailableSpace::Definite(size.height),
        }
    }
}

#[cfg(test)]
mod retained_layout_tests {
    use super::*;
    use crate::{Bounds, point, px, size};

    // request_layout / request_measured_layout need no Window, so the reuse bookkeeping
    // (retained capture, prev_bounds gating, desync detection) is unit-testable. The
    // measured-closure replay in compute_layout itself needs a Window and is covered by
    // the ts conformance suite (describe/anim/pixel) instead.

    #[test]
    fn begin_reuse_requires_prior_geometry() {
        let mut e = TaffyLayoutEngine::new();
        // no full-layout frame has captured geometry yet → reuse must refuse, so the host
        // falls back to a full layout (the first-frame / post-commit case).
        assert!(!e.begin_reuse_frame());
        assert!(!e.is_reusing());

        // simulate a captured full-layout frame.
        let _ = e.request_layout(Style::default(), px(16.0), 1.0, &[]);
        e.prev_bounds.push(Bounds {
            origin: point(px(0.0), px(0.0)),
            size: size(px(100.0), px(40.0)),
        });
        assert!(e.begin_reuse_frame());
        assert!(e.is_reusing());
        assert!(!e.reuse_desynced());
    }

    #[test]
    fn clear_drops_tree_but_a_full_frame_recaptures() {
        let mut e = TaffyLayoutEngine::new();
        // build two nodes (no Window needed for request_layout).
        let _a = e.request_layout(Style::default(), px(16.0), 1.0, &[]);
        let _b = e.request_layout(Style::default(), px(16.0), 1.0, &[]);
        assert_eq!(e.retained.len(), 2);
        // clear wipes the in-progress tree + retained ids, but intentionally keeps
        // prev_bounds for diagnostics until the following full frame replaces it.
        e.prev_bounds.push(Bounds::default());
        e.clear();
        assert!(e.retained.is_empty());
        assert_eq!(
            e.prev_bounds.len(),
            1,
            "clear must keep prior geometry until the next full frame replaces it"
        );
    }

    #[test]
    fn begin_reuse_replays_the_existing_tree_positionally() {
        let mut e = TaffyLayoutEngine::new();
        let original = e.request_layout(Style::default(), px(16.0), 1.0, &[]);
        e.prev_bounds.push(Bounds::default());
        assert_eq!(e.retained.len(), 1);
        assert!(e.begin_reuse_frame());
        let replayed = e.request_layout(Style::default(), px(16.0), 1.0, &[]);
        assert_eq!(replayed, original);
        assert_eq!(e.retained.len(), 1);
        assert_eq!(e.reuse_cursor, 1);
        assert!(!e.reuse_desynced());
    }

    #[test]
    fn reuse_kind_mismatch_marks_desync_and_keeps_the_current_kind_safe() {
        let mut e = TaffyLayoutEngine::new();
        let original = e.request_layout(Style::default(), px(16.0), 1.0, &[]);
        e.prev_bounds.push(Bounds::default());
        assert!(e.begin_reuse_frame());

        let replayed = e.request_measured_layout(
            Style::default(),
            px(16.0),
            1.0,
            |_, _, _, _| Size::default(),
        );

        assert_eq!(replayed, original);
        assert!(e.reuse_desynced());
        assert_eq!(e.retained_measured, vec![true]);
        assert!(e.taffy.get_node_context(replayed.into()).is_some());
    }
}
