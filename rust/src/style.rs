use gpui::{Hsla, Rgba, px};
use serde_json::Value;

/// RN-style properties mapped to GPUI styles.
#[derive(Clone, Debug, Default)]
pub struct ElementStyle {
    // Layout
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub min_width: Option<f32>,
    pub max_width: Option<f32>,
    pub min_height: Option<f32>,
    pub max_height: Option<f32>,

    // Flexbox
    pub flex: Option<f32>,
    pub flex_grow: Option<f32>,
    pub flex_shrink: Option<f32>,
    pub flex_basis: Option<f32>,
    pub flex_direction: Option<String>,
    pub flex_wrap: Option<String>,
    pub justify_content: Option<String>,
    pub align_items: Option<String>,
    pub align_self: Option<String>,
    pub align_content: Option<String>,
    pub gap: Option<f32>,
    pub row_gap: Option<f32>,
    pub column_gap: Option<f32>,
    pub display: Option<String>,

    // Position
    pub position: Option<String>,
    pub top: Option<f32>,
    pub right: Option<f32>,
    pub bottom: Option<f32>,
    pub left: Option<f32>,

    // Margin
    pub margin: Option<f32>,
    pub margin_top: Option<f32>,
    pub margin_right: Option<f32>,
    pub margin_bottom: Option<f32>,
    pub margin_left: Option<f32>,

    // Padding
    pub padding: Option<f32>,
    pub padding_top: Option<f32>,
    pub padding_right: Option<f32>,
    pub padding_bottom: Option<f32>,
    pub padding_left: Option<f32>,

    // Border
    pub border_width: Option<f32>,
    pub border_color: Option<u32>,
    pub border_radius: Option<f32>,
    pub border_style: Option<String>,

    // Background
    pub background_color: Option<u32>,

    // Text
    pub color: Option<u32>,
    pub font_size: Option<f32>,
    pub font_weight: Option<String>,
    pub font_family: Option<String>,
    pub line_height: Option<f32>,
    pub text_align: Option<String>,
    pub letter_spacing: Option<f32>,

    // Opacity
    pub opacity: Option<f32>,

    // Overflow
    pub overflow: Option<String>,

    // Transform
    pub transform: Option<String>,

    // Cursor
    pub cursor: Option<String>,

    // Box shadow
    pub box_shadow: Option<String>,

    // Elevation / z-index
    pub z_index: Option<i32>,
}

impl ElementStyle {
    pub fn from_json(obj: &Value) -> Self {
        let mut s = Self::default();
        if !obj.is_object() {
            return s;
        }
        let o = obj.as_object().unwrap();

        macro_rules! f {
            ($field:ident, $key:expr) => {
                s.$field = o.get($key).and_then(|v| v.as_f64()).map(|v| v as f32);
            };
        }
        macro_rules! i {
            ($field:ident, $key:expr) => {
                s.$field = o.get($key).and_then(|v| v.as_i64()).map(|v| v as i32);
            };
        }
        macro_rules! s {
            ($field:ident, $key:expr) => {
                s.$field = o.get($key).and_then(|v| v.as_str()).map(|s| s.to_string());
            };
        }
        macro_rules! c {
            ($field:ident, $key:expr) => {
                s.$field = o.get($key).and_then(|v| parse_hex_color(v));
            };
        }

        f!(width, "width");
        f!(height, "height");
        f!(min_width, "minWidth");
        f!(max_width, "maxWidth");
        f!(min_height, "minHeight");
        f!(max_height, "maxHeight");
        f!(flex, "flex");
        f!(flex_grow, "flexGrow");
        f!(flex_shrink, "flexShrink");
        f!(flex_basis, "flexBasis");
        f!(gap, "gap");
        f!(row_gap, "rowGap");
        f!(column_gap, "columnGap");
        f!(top, "top");
        f!(right, "right");
        f!(bottom, "bottom");
        f!(left, "left");
        f!(margin, "margin");
        f!(margin_top, "marginTop");
        f!(margin_right, "marginRight");
        f!(margin_bottom, "marginBottom");
        f!(margin_left, "marginLeft");
        f!(padding, "padding");
        f!(padding_top, "paddingTop");
        f!(padding_right, "paddingRight");
        f!(padding_bottom, "paddingBottom");
        f!(padding_left, "paddingLeft");
        f!(border_width, "borderWidth");
        f!(border_radius, "borderRadius");
        f!(font_size, "fontSize");
        f!(line_height, "lineHeight");
        f!(letter_spacing, "letterSpacing");
        f!(opacity, "opacity");

        i!(z_index, "zIndex");

        s!(flex_direction, "flexDirection");
        s!(flex_wrap, "flexWrap");
        s!(justify_content, "justifyContent");
        s!(align_items, "alignItems");
        s!(align_self, "alignSelf");
        s!(align_content, "alignContent");
        s!(position, "position");
        s!(display, "display");
        s!(overflow, "overflow");
        s!(font_weight, "fontWeight");
        s!(font_family, "fontFamily");
        s!(text_align, "textAlign");
        s!(cursor, "cursor");
        s!(transform, "transform");
        s!(border_style, "borderStyle");
        s!(box_shadow, "boxShadow");

        c!(color, "color");
        c!(background_color, "backgroundColor");
        c!(border_color, "borderColor");

        s
    }

    /// Build GPUI Style from ElementStyle.
    pub fn build_gpui_style(&self, default_bg: Option<u32>) -> gpui::Style {
        let mut style = gpui::Style::default();

        // Dimensions
        if let Some(w) = self.width {
            style.size.width = px(w).into();
        }
        if let Some(h) = self.height {
            style.size.height = px(h).into();
        }

        // Min/Max dimensions
        if let Some(mw) = self.min_width {
            style.min_size.width = px(mw).into();
        }
        if let Some(mw) = self.max_width {
            style.max_size.width = px(mw).into();
        }
        if let Some(mh) = self.min_height {
            style.min_size.height = px(mh).into();
        }
        if let Some(mh) = self.max_height {
            style.max_size.height = px(mh).into();
        }

        // Flexbox
        if let Some(f) = self.flex_grow {
            style.flex_grow = f;
        }
        if let Some(f) = self.flex_shrink {
            style.flex_shrink = f;
        }
        if let Some(b) = self.flex_basis {
            style.flex_basis = px(b).into();
        }
        if let Some(ref d) = self.flex_direction {
            style.flex_direction = parse_flex_direction(d);
        }
        if let Some(ref w) = self.flex_wrap {
            style.flex_wrap = parse_flex_wrap(w);
        }
        if let Some(ref j) = self.justify_content {
            style.justify_content = Some(parse_justify_content(j));
        }
        if let Some(ref a) = self.align_items {
            style.align_items = Some(parse_align_items(a));
        }
        if let Some(ref a) = self.align_self {
            style.align_self = parse_align_self(a);
        }
        if let Some(g) = self.gap {
            style.gap = gpui::Size {
                width: px(g).into(),
                height: px(g).into(),
            };
        }
        if let Some(g) = self.row_gap {
            style.gap.height = px(g).into();
        }
        if let Some(g) = self.column_gap {
            style.gap.width = px(g).into();
        }

        // Position
        if let Some(ref p) = self.position {
            match p.as_str() {
                "absolute" => {
                    style.position = gpui::Position::Absolute;
                    if let Some(v) = self.top {
                        style.inset.top = px(v).into();
                    }
                    if let Some(v) = self.right {
                        style.inset.right = px(v).into();
                    }
                    if let Some(v) = self.bottom {
                        style.inset.bottom = px(v).into();
                    }
                    if let Some(v) = self.left {
                        style.inset.left = px(v).into();
                    }
                }
                _ => {
                    style.position = gpui::Position::Relative;
                }
            }
        }

        // Margin
        if let Some(m) = self.margin {
            style.margin = gpui::Edges::all(px(m).into());
        }
        if let Some(m) = self.margin_top {
            style.margin.top = px(m).into();
        }
        if let Some(m) = self.margin_right {
            style.margin.right = px(m).into();
        }
        if let Some(m) = self.margin_bottom {
            style.margin.bottom = px(m).into();
        }
        if let Some(m) = self.margin_left {
            style.margin.left = px(m).into();
        }

        // Padding
        if let Some(p) = self.padding {
            style.padding = gpui::Edges::all(px(p).into());
        }
        if let Some(p) = self.padding_top {
            style.padding.top = px(p).into();
        }
        if let Some(p) = self.padding_right {
            style.padding.right = px(p).into();
        }
        if let Some(p) = self.padding_bottom {
            style.padding.bottom = px(p).into();
        }
        if let Some(p) = self.padding_left {
            style.padding.left = px(p).into();
        }

        // Border
        let mut has_border = false;
        let mut border_width_val = 0.0;
        if let Some(bw) = self.border_width {
            border_width_val = bw;
            has_border = bw > 0.0;
        }
        if has_border {
            style.border_widths = gpui::Edges::all(px(border_width_val).into());
            let border_c = self
                .border_color
                .map(|c| {
                    Hsla::from(Rgba {
                        r: ((c >> 16) & 0xFF) as f32 / 255.0,
                        g: ((c >> 8) & 0xFF) as f32 / 255.0,
                        b: (c & 0xFF) as f32 / 255.0,
                        a: 1.0,
                    })
                })
                .unwrap_or(Hsla::from(Rgba {
                    r: 0.0,
                    g: 0.0,
                    b: 0.0,
                    a: 1.0,
                }));
            style.border_color = Some(border_c);
        }
        if let Some(br) = self.border_radius {
            style.corner_radii = gpui::Corners::all(px(br).into());
        }

        // Background
        let bg = self.background_color.or(default_bg).map(|c| {
            Hsla::from(Rgba {
                r: ((c >> 16) & 0xFF) as f32 / 255.0,
                g: ((c >> 8) & 0xFF) as f32 / 255.0,
                b: (c & 0xFF) as f32 / 255.0,
                a: 1.0,
            })
        });
        if let Some(bg) = bg {
            style.background = Some(bg.into());
        }

        // Opacity
        if let Some(o) = self.opacity {
            style.opacity = Some(o);
        }

        // Overflow
        if let Some(ref o) = self.overflow {
            match o.as_str() {
                "hidden" => {
                    style.overflow.x = gpui::Overflow::Hidden;
                    style.overflow.y = gpui::Overflow::Hidden;
                }
                "scroll" | "auto" => {
                    style.overflow.x = gpui::Overflow::Scroll;
                    style.overflow.y = gpui::Overflow::Scroll;
                }
                _ => {}
            }
        }

        style
    }
}

fn parse_flex_direction(d: &str) -> gpui::FlexDirection {
    match d {
        "row" => gpui::FlexDirection::Row,
        "row-reverse" => gpui::FlexDirection::RowReverse,
        "column-reverse" => gpui::FlexDirection::ColumnReverse,
        _ => gpui::FlexDirection::Column,
    }
}

fn parse_flex_wrap(w: &str) -> gpui::FlexWrap {
    match w {
        "wrap" => gpui::FlexWrap::Wrap,
        "wrap-reverse" => gpui::FlexWrap::WrapReverse,
        _ => gpui::FlexWrap::NoWrap,
    }
}

fn parse_justify_content(j: &str) -> gpui::JustifyContent {
    match j {
        "center" => gpui::JustifyContent::Center,
        "flex-end" | "end" => gpui::JustifyContent::FlexEnd,
        "space-between" => gpui::JustifyContent::SpaceBetween,
        "space-around" => gpui::JustifyContent::SpaceAround,
        "space-evenly" => gpui::JustifyContent::SpaceEvenly,
        _ => gpui::JustifyContent::FlexStart,
    }
}

fn parse_align_items(a: &str) -> gpui::AlignItems {
    match a {
        "center" => gpui::AlignItems::Center,
        "flex-end" | "end" => gpui::AlignItems::FlexEnd,
        "stretch" => gpui::AlignItems::Stretch,
        "baseline" => gpui::AlignItems::Baseline,
        _ => gpui::AlignItems::FlexStart,
    }
}

fn parse_align_self(a: &str) -> Option<gpui::AlignSelf> {
    match a {
        "auto" => None,
        "center" => Some(gpui::AlignSelf::Center),
        "flex-end" | "end" => Some(gpui::AlignSelf::FlexEnd),
        "stretch" => Some(gpui::AlignSelf::Stretch),
        "baseline" => Some(gpui::AlignSelf::Baseline),
        "flex-start" | "start" => Some(gpui::AlignSelf::FlexStart),
        _ => None,
    }
}

fn parse_hex_color(v: &Value) -> Option<u32> {
    let s = v.as_str()?;
    let s = s.trim_start_matches('#');
    if s.len() == 6 {
        u32::from_str_radix(s, 16).ok()
    } else if s.len() == 3 {
        let r = u32::from_str_radix(&s[0..1], 16).ok()? * 17;
        let g = u32::from_str_radix(&s[1..2], 16).ok()? * 17;
        let b = u32::from_str_radix(&s[2..3], 16).ok()? * 17;
        Some((r << 16) | (g << 8) | b)
    } else {
        None
    }
}
