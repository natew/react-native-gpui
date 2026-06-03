use gpui::{
    AbsoluteLength, BoxShadow, DefiniteLength, FontWeight, Hsla, Length, Rgba, linear_color_stop,
    linear_gradient, point, px,
};
use serde_json::Value;

/// A RN dimension value: an absolute pixel count, a `"NN%"` fraction of the parent,
/// or `"auto"`. Mirrors RN's `DimensionValue`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dim {
    Px(f32),
    Pct(f32), // stored as a 0..1 fraction
    Auto,
}

impl Dim {
    pub fn from_value(v: &Value) -> Option<Dim> {
        if let Some(n) = v.as_f64() {
            return Some(Dim::Px(n as f32));
        }
        let s = v.as_str()?.trim();
        if s.eq_ignore_ascii_case("auto") {
            return Some(Dim::Auto);
        }
        if let Some(p) = s.strip_suffix('%') {
            return p.trim().parse::<f32>().ok().map(|n| Dim::Pct(n / 100.0));
        }
        s.trim_end_matches("px").trim().parse::<f32>().ok().map(Dim::Px)
    }

    /// As a flex `Length` (size / min / max / inset / margin / flex-basis).
    pub fn to_length(self) -> Length {
        match self {
            Dim::Px(p) => px(p).into(),
            Dim::Pct(f) => Length::Definite(DefiniteLength::Fraction(f)),
            Dim::Auto => Length::Auto,
        }
    }

    /// As a `DefiniteLength` (padding / gap — no `auto`, which collapses to 0).
    pub fn to_definite(self) -> DefiniteLength {
        match self {
            Dim::Px(p) => DefiniteLength::Absolute(AbsoluteLength::Pixels(px(p))),
            Dim::Pct(f) => DefiniteLength::Fraction(f),
            Dim::Auto => DefiniteLength::Absolute(AbsoluteLength::Pixels(px(0.0))),
        }
    }

    /// The pixel value, if this is an absolute length (used to seed the window size).
    pub fn as_px(self) -> Option<f32> {
        match self {
            Dim::Px(p) => Some(p),
            _ => None,
        }
    }
}

/// RN-style properties mapped to GPUI styles.
#[derive(Clone, Debug, Default)]
pub struct ElementStyle {
    // Layout
    pub width: Option<Dim>,
    pub height: Option<Dim>,
    pub min_width: Option<Dim>,
    pub max_width: Option<Dim>,
    pub min_height: Option<Dim>,
    pub max_height: Option<Dim>,

    // Flexbox
    pub flex: Option<f32>,
    pub flex_grow: Option<f32>,
    pub flex_shrink: Option<f32>,
    pub flex_basis: Option<Dim>,
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
    pub top: Option<Dim>,
    pub right: Option<Dim>,
    pub bottom: Option<Dim>,
    pub left: Option<Dim>,

    // Margin
    pub margin: Option<Dim>,
    pub margin_top: Option<Dim>,
    pub margin_right: Option<Dim>,
    pub margin_bottom: Option<Dim>,
    pub margin_left: Option<Dim>,

    // Padding
    pub padding: Option<Dim>,
    pub padding_top: Option<Dim>,
    pub padding_right: Option<Dim>,
    pub padding_bottom: Option<Dim>,
    pub padding_left: Option<Dim>,

    // Border
    pub border_width: Option<f32>,
    pub border_color: Option<u32>,
    pub border_radius: Option<f32>,
    pub border_style: Option<String>,

    // Background
    pub background_color: Option<u32>,
    pub background_image: Option<String>,

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
        // dimension fields: number | "NN%" | "auto"
        macro_rules! d {
            ($field:ident, $key:expr) => {
                s.$field = o.get($key).and_then(Dim::from_value);
            };
        }

        d!(width, "width");
        d!(height, "height");
        d!(min_width, "minWidth");
        d!(max_width, "maxWidth");
        d!(min_height, "minHeight");
        d!(max_height, "maxHeight");
        f!(flex, "flex");
        f!(flex_grow, "flexGrow");
        f!(flex_shrink, "flexShrink");
        d!(flex_basis, "flexBasis");
        f!(gap, "gap");
        f!(row_gap, "rowGap");
        f!(column_gap, "columnGap");
        d!(top, "top");
        d!(right, "right");
        d!(bottom, "bottom");
        d!(left, "left");
        d!(margin, "margin");
        d!(margin_top, "marginTop");
        d!(margin_right, "marginRight");
        d!(margin_bottom, "marginBottom");
        d!(margin_left, "marginLeft");
        d!(padding, "padding");
        d!(padding_top, "paddingTop");
        d!(padding_right, "paddingRight");
        d!(padding_bottom, "paddingBottom");
        d!(padding_left, "paddingLeft");
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
        s!(background_image, "backgroundImage");

        c!(color, "color");
        c!(background_color, "backgroundColor");
        c!(border_color, "borderColor");

        s
    }

    /// Build GPUI Style from ElementStyle.
    pub fn build_gpui_style(&self, default_bg: Option<u32>) -> gpui::Style {
        let mut style = gpui::Style::default();

        // React Native semantics: every View is a flex container that lays its
        // children out in a column by default. GPUI's `Style::default()` is
        // `display: Block` / `flex_direction: Row`, so without this every View
        // would block-stack its children and ignore flex props entirely.
        style.display = match self.display.as_deref() {
            Some("none") => gpui::Display::None,
            _ => gpui::Display::Flex,
        };
        style.flex_direction = gpui::FlexDirection::Column;

        // Match React Native's Yoga engine, not web CSS (which taffy defaults to):
        //  • no content-based automatic minimum size (Yoga's min is 0, web's is
        //    min-content). Without this a `flex:1` ancestor can't be sized smaller
        //    than its content, so a scrolling child grows to its content height and
        //    never actually scrolls.
        //  • flex items don't shrink by default (Yoga shrink=0, web shrink=1), so
        //    scroll content keeps its natural height and overflows rather than
        //    collapsing to fit.
        // Explicit minWidth/minHeight/flexShrink below still override these.
        style.min_size = gpui::Size {
            width: px(0.0).into(),
            height: px(0.0).into(),
        };
        style.flex_shrink = 0.0;

        // Dimensions (number → px, "NN%" → fraction, "auto" → auto)
        if let Some(w) = self.width {
            style.size.width = w.to_length();
        }
        if let Some(h) = self.height {
            style.size.height = h.to_length();
        }

        // Min/Max dimensions
        if let Some(mw) = self.min_width {
            style.min_size.width = mw.to_length();
        }
        if let Some(mw) = self.max_width {
            style.max_size.width = mw.to_length();
        }
        if let Some(mh) = self.min_height {
            style.min_size.height = mh.to_length();
        }
        if let Some(mh) = self.max_height {
            style.max_size.height = mh.to_length();
        }

        // Flexbox — RN's `flex: <n>` shorthand expands first, so an explicit
        // flexGrow/flexShrink/flexBasis below can still override it.
        if let Some(f) = self.flex {
            if f > 0.0 {
                style.flex_grow = f;
                style.flex_shrink = 1.0;
                style.flex_basis = Length::Definite(DefiniteLength::Fraction(0.0)); // 0%
            } else if f == 0.0 {
                style.flex_grow = 0.0;
                style.flex_shrink = 0.0;
            } else {
                style.flex_grow = 0.0;
                style.flex_shrink = 1.0;
            }
        }
        if let Some(f) = self.flex_grow {
            style.flex_grow = f;
        }
        if let Some(f) = self.flex_shrink {
            style.flex_shrink = f;
        }
        if let Some(b) = self.flex_basis {
            style.flex_basis = b.to_length();
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
                        style.inset.top = v.to_length();
                    }
                    if let Some(v) = self.right {
                        style.inset.right = v.to_length();
                    }
                    if let Some(v) = self.bottom {
                        style.inset.bottom = v.to_length();
                    }
                    if let Some(v) = self.left {
                        style.inset.left = v.to_length();
                    }
                }
                _ => {
                    style.position = gpui::Position::Relative;
                }
            }
        }

        // Margin
        if let Some(m) = self.margin {
            style.margin = gpui::Edges::all(m.to_length());
        }
        if let Some(m) = self.margin_top {
            style.margin.top = m.to_length();
        }
        if let Some(m) = self.margin_right {
            style.margin.right = m.to_length();
        }
        if let Some(m) = self.margin_bottom {
            style.margin.bottom = m.to_length();
        }
        if let Some(m) = self.margin_left {
            style.margin.left = m.to_length();
        }

        // Padding
        if let Some(p) = self.padding {
            style.padding = gpui::Edges::all(p.to_definite());
        }
        if let Some(p) = self.padding_top {
            style.padding.top = p.to_definite();
        }
        if let Some(p) = self.padding_right {
            style.padding.right = p.to_definite();
        }
        if let Some(p) = self.padding_bottom {
            style.padding.bottom = p.to_definite();
        }
        if let Some(p) = self.padding_left {
            style.padding.left = p.to_definite();
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

        // Background — a CSS linear-gradient (via `backgroundImage`) wins; else a
        // solid color.
        if let Some(grad) = parse_linear_gradient(self.background_image.as_deref()) {
            style.background = Some(grad.into());
        } else {
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

        // Box shadow — CSS-style string (RN 0.76+ `boxShadow`), supports multiple
        // comma-separated layers and rgba()/#rrggbbaa colors with real alpha.
        if let Some(ref bs) = self.box_shadow {
            let shadows = parse_box_shadows(bs);
            if !shadows.is_empty() {
                style.box_shadow = shadows;
            }
        }

        style
    }

    /// Resolved GPUI font weight, if `fontWeight` was set.
    pub fn gpui_font_weight(&self) -> Option<FontWeight> {
        self.font_weight.as_deref().map(parse_font_weight)
    }
}

fn parse_font_weight(s: &str) -> FontWeight {
    match s.trim().to_ascii_lowercase().as_str() {
        "100" | "thin" => FontWeight::THIN,
        "200" | "extralight" | "ultralight" => FontWeight::EXTRA_LIGHT,
        "300" | "light" => FontWeight::LIGHT,
        "400" | "normal" | "regular" => FontWeight::NORMAL,
        "500" | "medium" => FontWeight::MEDIUM,
        "600" | "semibold" => FontWeight::SEMIBOLD,
        "700" | "bold" => FontWeight::BOLD,
        "800" | "extrabold" => FontWeight::EXTRA_BOLD,
        "900" | "black" | "heavy" => FontWeight::BLACK,
        _ => FontWeight::NORMAL,
    }
}

/// Parse a CSS `linear-gradient(...)` (2-stop) into a GPUI gradient Background.
/// e.g. `linear-gradient(135deg, #8a5cf6, #5b5bd6)`. GPUI supports 2 stops, so
/// the first and last colors are used.
fn parse_linear_gradient(input: Option<&str>) -> Option<gpui::Background> {
    let s = input?.trim();
    let inner = s.strip_prefix("linear-gradient(")?.strip_suffix(')')?;
    let parts = split_top_level_commas(inner);
    if parts.len() < 2 {
        return None;
    }
    // first segment is an angle ("135deg" / "135") or, if it's a color, default to 180deg
    let first = parts[0].trim();
    let (angle, colors) = if first.ends_with("deg") || first.parse::<f32>().is_ok() {
        (
            first.trim_end_matches("deg").trim().parse::<f32>().unwrap_or(180.0),
            &parts[1..],
        )
    } else {
        (180.0, &parts[..])
    };
    if colors.len() < 2 {
        return None;
    }
    let c0 = parse_stop_color(&colors[0])?;
    let c1 = parse_stop_color(&colors[colors.len() - 1])?;
    Some(linear_gradient(
        angle,
        linear_color_stop(c0, 0.0),
        linear_color_stop(c1, 1.0),
    ))
}

fn parse_stop_color(seg: &str) -> Option<Hsla> {
    // a stop is "<color> [<pos>%]"; take the color token
    let tok = seg.trim().split_whitespace().next()?;
    parse_css_color(tok)
}

/// Parse a CSS `box-shadow` value (one or more comma-separated layers) into
/// GPUI `BoxShadow`s. Format per layer: `offsetX offsetY [blur] [spread] color`
/// (color may also lead). `inset` is ignored (GPUI has drop shadows only).
fn parse_box_shadows(input: &str) -> Vec<BoxShadow> {
    split_top_level_commas(input)
        .into_iter()
        .filter_map(|seg| parse_one_shadow(&seg))
        .collect()
}

fn parse_one_shadow(seg: &str) -> Option<BoxShadow> {
    let mut rest = seg.replace("inset", " ");
    let mut color = Hsla {
        h: 0.0,
        s: 0.0,
        l: 0.0,
        a: 0.3,
    };

    // pull out the color token (rgb/rgba(...) or #hex), leaving only lengths
    if let Some(start) = rest.find("rgb") {
        if let Some(close_rel) = rest[start..].find(')') {
            let end = start + close_rel + 1;
            if let Some(c) = parse_css_color(&rest[start..end]) {
                color = c;
            }
            rest.replace_range(start..end, " ");
        }
    } else if let Some(hash) = rest.find('#') {
        let after = &rest[hash..];
        let len = after.find(char::is_whitespace).unwrap_or(after.len());
        if let Some(c) = parse_css_color(&rest[hash..hash + len]) {
            color = c;
        }
        rest.replace_range(hash..hash + len, " ");
    }

    let nums: Vec<f32> = rest
        .split_whitespace()
        .filter_map(|t| t.trim_end_matches("px").parse::<f32>().ok())
        .collect();
    if nums.len() < 2 {
        return None;
    }
    Some(BoxShadow {
        color,
        offset: point(px(nums[0]), px(nums[1])),
        blur_radius: px(nums.get(2).copied().unwrap_or(0.0)),
        spread_radius: px(nums.get(3).copied().unwrap_or(0.0)),
    })
}

fn split_top_level_commas(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in input.chars() {
        match ch {
            '(' => {
                depth += 1;
                cur.push(ch);
            }
            ')' => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if depth == 0 => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, or `black`/`white`.
fn parse_css_color(input: &str) -> Option<Hsla> {
    let s = input.trim();
    let to = |r: u32, g: u32, b: u32, a: f32| {
        Hsla::from(Rgba {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a,
        })
    };
    if let Some(rest) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")) {
        let inner = rest.trim_end_matches(')');
        let parts: Vec<f32> = inner
            .split(',')
            .filter_map(|p| p.trim().parse::<f32>().ok())
            .collect();
        if parts.len() >= 3 {
            let a = parts.get(3).copied().unwrap_or(1.0);
            return Some(to(parts[0] as u32, parts[1] as u32, parts[2] as u32, a));
        }
        return None;
    }
    if let Some(hex) = s.strip_prefix('#') {
        return match hex.len() {
            3 => {
                let r = u32::from_str_radix(&hex[0..1], 16).ok()? * 17;
                let g = u32::from_str_radix(&hex[1..2], 16).ok()? * 17;
                let b = u32::from_str_radix(&hex[2..3], 16).ok()? * 17;
                Some(to(r, g, b, 1.0))
            }
            6 => {
                let v = u32::from_str_radix(hex, 16).ok()?;
                Some(to((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF, 1.0))
            }
            8 => {
                let v = u32::from_str_radix(hex, 16).ok()?;
                Some(to(
                    (v >> 24) & 0xFF,
                    (v >> 16) & 0xFF,
                    (v >> 8) & 0xFF,
                    (v & 0xFF) as f32 / 255.0,
                ))
            }
            _ => None,
        };
    }
    match s {
        "black" => Some(to(0, 0, 0, 1.0)),
        "white" => Some(to(255, 255, 255, 1.0)),
        _ => None,
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
