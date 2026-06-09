//! On-demand annotated tree dump for the `rngpui` developer CLI.
//!
//! The native service owns both the authored React tree (style + a11y) and the
//! post-layout geometry: every painted element reports its window-coordinate rect
//! into `bridge::LAST_FRAME` keyed by `globalId` (see `elements::report_layout`).
//!
//! This module merges the two: it walks the live `ReactElement` tree the service is
//! currently rendering, and for every node emits the authored facts (type, testID /
//! identifier / nativeID / label / text / value / events) PLUS the computed bounds
//! and resolved style. That is the one source of truth the CLI reads to answer
//! "where is this node and what does it look like" without a screenshot.

use std::sync::Arc;

use gpui::{Hsla, Rgba};
use serde_json::{Map, Value, json};

use crate::bridge;
use crate::elements::{NativeResizeEdge, ReactElement};
use crate::style::{Dim, ElementStyle};

/// Serialize the full tree rooted at `root` into a JSON object, annotating each node
/// with computed window-coordinate bounds from the paint pass.
pub fn dump_tree(root: &Arc<ReactElement>) -> Value {
    dump_node(root)
}

fn dump_node(el: &Arc<ReactElement>) -> Value {
    let mut obj = Map::new();
    obj.insert("globalId".into(), json!(el.global_id));
    obj.insert("type".into(), json!(el.element_type));

    if let Some(text) = el.text.as_ref() {
        obj.insert("text".into(), json!(text));
    }
    if let Some(value) = el.value.as_ref() {
        obj.insert("value".into(), json!(value));
    }
    if let Some(src) = el.src.as_ref() {
        obj.insert("src".into(), json!(src));
    }
    // authored JSX source location ("<abs-path>:<line>:<col>") from the inspector
    // side-table — lets the CLI surface where each node came from.
    if let Some(source) = crate::inspector::source_for(el.global_id) {
        obj.insert("source".into(), json!(source));
    }
    if !el.events.is_empty() {
        obj.insert("events".into(), json!(el.events));
    }
    if let Some(group) = el.native_list_group.as_ref() {
        obj.insert("nativeListGroup".into(), json!(group));
    }
    if let Some(key) = el.native_layout_key.as_ref() {
        obj.insert("nativeLayoutKey".into(), json!(key));
    }
    if let Some(resize) = el.native_resize.as_ref() {
        let mut native = Map::new();
        native.insert("target".into(), json!(resize.target));
        native.insert("edge".into(), json!(native_resize_edge_label(resize.edge)));
        if let Some(min) = resize.min {
            native.insert("min".into(), json!(min));
        }
        if let Some(max) = resize.max {
            native.insert("max".into(), json!(max));
        }
        obj.insert("nativeResize".into(), Value::Object(native));
    }

    // accessibility / identity — flattened to the keys selectors match against, so the
    // CLI can resolve `composer:input` against testID/identifier/nativeID/label.
    let a = &el.accessibility;
    let mut ax = Map::new();
    if let Some(v) = a.identifier.as_ref() {
        ax.insert("identifier".into(), json!(v));
    }
    if let Some(v) = a.test_id.as_ref() {
        ax.insert("testID".into(), json!(v));
    }
    if let Some(v) = a.native_id.as_ref() {
        ax.insert("nativeID".into(), json!(v));
    }
    if let Some(v) = a.label.as_ref() {
        ax.insert("label".into(), json!(v));
    }
    if let Some(v) = a.role.as_ref() {
        ax.insert("role".into(), json!(v));
    }
    if !ax.is_empty() {
        obj.insert("accessibility".into(), Value::Object(ax));
    }

    // computed, post-layout, window-coordinate bounds — the whole reason this dump
    // exists. `None` means the node was never painted (display:none, zero-area, or
    // off the rendered subtree); the CLI treats a missing/degenerate rect as "not
    // visible".
    if let Some((x, y, width, height)) = bridge::cached_layout(el.global_id) {
        obj.insert(
            "bounds".into(),
            json!({ "x": x, "y": y, "width": width, "height": height }),
        );
    }

    // resolved style facts — the parsed ElementStyle, not the authored JSON (the
    // service discards the raw object at parse time). When reanimated has a live
    // animated overlay for this node, report the MERGED style so the dump reflects the
    // per-frame spring value (the conformance harness reads this to assert the ramp).
    let effective_style = el
        .style_json
        .as_ref()
        .filter(|_| crate::anim_overlay::has_overlay(el.global_id))
        .and_then(|base_json| {
            crate::anim_overlay::merged_style(el.global_id, &el.style, base_json)
        });
    let style = resolved_style(effective_style.as_ref().unwrap_or(&el.style));
    if !style.is_empty() {
        obj.insert("style".into(), Value::Object(style));
    }

    let children: Vec<Value> = el.children.iter().map(dump_node).collect();
    if !children.is_empty() {
        obj.insert("children".into(), json!(children));
    }

    Value::Object(obj)
}

fn resolved_style(style: &ElementStyle) -> Map<String, Value> {
    let mut m = Map::new();
    insert_dim(&mut m, "width", style.width);
    insert_dim(&mut m, "height", style.height);
    insert_dim(&mut m, "minWidth", style.min_width);
    insert_dim(&mut m, "maxWidth", style.max_width);
    insert_dim(&mut m, "minHeight", style.min_height);
    insert_dim(&mut m, "maxHeight", style.max_height);
    if let Some(v) = style.flex {
        m.insert("flex".into(), json!(v));
    }
    if let Some(v) = style.flex_grow {
        m.insert("flexGrow".into(), json!(v));
    }
    if let Some(v) = style.flex_shrink {
        m.insert("flexShrink".into(), json!(v));
    }
    insert_dim(&mut m, "flexBasis", style.flex_basis);
    if let Some(v) = style.flex_direction.as_ref() {
        m.insert("flexDirection".into(), json!(v));
    }
    if let Some(v) = style.justify_content.as_ref() {
        m.insert("justifyContent".into(), json!(v));
    }
    if let Some(v) = style.align_items.as_ref() {
        m.insert("alignItems".into(), json!(v));
    }
    if let Some(v) = style.align_self.as_ref() {
        m.insert("alignSelf".into(), json!(v));
    }
    if let Some(v) = style.gap {
        m.insert("gap".into(), json!(v));
    }
    if let Some(v) = style.row_gap {
        m.insert("rowGap".into(), json!(v));
    }
    if let Some(v) = style.column_gap {
        m.insert("columnGap".into(), json!(v));
    }
    if let Some(v) = style.position.as_ref() {
        m.insert("position".into(), json!(v));
    }
    if let Some(v) = style.display.as_ref() {
        m.insert("display".into(), json!(v));
    }
    if let Some(v) = style.z_index {
        m.insert("zIndex".into(), json!(v));
    }
    if let Some(v) = style.opacity {
        m.insert("opacity".into(), json!(v));
    }
    if let Some(c) = style.background_color {
        m.insert("backgroundColor".into(), json!(hsla_to_hex(c)));
    }
    if let Some(v) = style.background_image.as_ref() {
        m.insert("backgroundImage".into(), json!(v));
    }
    if let Some(c) = style.color {
        m.insert("color".into(), json!(hsla_to_hex(c)));
    }
    if let Some(c) = style.border_color {
        m.insert("borderColor".into(), json!(hsla_to_hex(c)));
    }
    if let Some(v) = style.border_width {
        m.insert("borderWidth".into(), json!(v));
    }
    if let Some(v) = style.overflow.as_ref() {
        m.insert("overflow".into(), json!(v));
    }
    insert_dim(&mut m, "padding", style.padding);
    insert_dim(&mut m, "paddingTop", style.padding_top);
    insert_dim(&mut m, "paddingRight", style.padding_right);
    insert_dim(&mut m, "paddingBottom", style.padding_bottom);
    insert_dim(&mut m, "paddingLeft", style.padding_left);
    if let Some(v) = style.box_shadow.as_ref() {
        m.insert("boxShadow".into(), json!(v));
    }
    m
}

fn insert_dim(m: &mut Map<String, Value>, key: &str, d: Option<Dim>) {
    if let Some(d) = d {
        m.insert(key.into(), json!(dim_to_string(d)));
    }
}

fn dim_to_string(d: Dim) -> String {
    match d {
        Dim::Px(p) => format!("{p}"),
        Dim::Pct(f) => format!("{}%", f * 100.0),
        Dim::Auto => "auto".to_string(),
    }
}

fn native_resize_edge_label(edge: NativeResizeEdge) -> &'static str {
    match edge {
        NativeResizeEdge::Left => "left",
        NativeResizeEdge::Right => "right",
        NativeResizeEdge::Top => "top",
        NativeResizeEdge::Bottom => "bottom",
    }
}

/// Hsla → `#rrggbb` or `#rrggbbaa` (when not fully opaque). Mirrors the hex format the
/// pixel-sampling JS side parses, so dump style colors compare directly to sampled
/// pixel colors.
pub fn hsla_to_hex(c: Hsla) -> String {
    let rgba: Rgba = c.into();
    let to_u8 = |f: f32| (f.clamp(0.0, 1.0) * 255.0).round() as u8;
    let (r, g, b, a) = (to_u8(rgba.r), to_u8(rgba.g), to_u8(rgba.b), to_u8(rgba.a));
    if a == 255 {
        format!("#{r:02x}{g:02x}{b:02x}")
    } else {
        format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
    }
}
