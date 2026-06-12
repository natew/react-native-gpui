use gpui::{
    AbsoluteLength, BoxShadow, CursorStyle, DefiniteLength, FontWeight, Hsla, Length, Rgba,
    linear_color_stop, linear_gradient, point, px,
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
        s.trim_end_matches("px")
            .trim()
            .parse::<f32>()
            .ok()
            .map(Dim::Px)
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
    pub border_top_width: Option<f32>,
    pub border_right_width: Option<f32>,
    pub border_bottom_width: Option<f32>,
    pub border_left_width: Option<f32>,
    pub border_color: Option<Hsla>,
    pub border_radius: Option<f32>,
    pub border_top_left_radius: Option<f32>,
    pub border_top_right_radius: Option<f32>,
    pub border_bottom_left_radius: Option<f32>,
    pub border_bottom_right_radius: Option<f32>,
    pub border_style: Option<String>,

    // Background
    pub background_color: Option<Hsla>,
    pub background_image: Option<String>,

    // Text
    pub color: Option<Hsla>,
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

    // Transform: parsed RN transform ops (`[{translateY: 24}, {scale: 0.92}]`),
    // applied at paint via gpui's element-transform stack (never affects layout)
    pub transform: Option<Vec<TransformOp>>,

    // Cursor
    pub cursor: Option<String>,

    // Box shadow
    pub box_shadow: Option<String>,

    // Elevation / z-index
    pub z_index: Option<i32>,
}

impl ElementStyle {
    pub fn is_display_none(&self) -> bool {
        self.display.as_deref() == Some("none")
    }

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
                s.$field = o
                    .get($key)
                    .and_then(|v| v.as_str())
                    .and_then(parse_css_color);
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
        // tamagui expands `borderWidth`/`borderColor` to per-side keys (like
        // `rounded` → corners), so read the sides too or side borders go missing.
        f!(border_top_width, "borderTopWidth");
        f!(border_right_width, "borderRightWidth");
        f!(border_bottom_width, "borderBottomWidth");
        f!(border_left_width, "borderLeftWidth");
        f!(border_radius, "borderRadius");
        // tamagui's `rounded` shorthand expands to the four corner keys, not the
        // `borderRadius` shorthand — read both so rounded corners actually apply.
        f!(border_top_left_radius, "borderTopLeftRadius");
        f!(border_top_right_radius, "borderTopRightRadius");
        f!(border_bottom_left_radius, "borderBottomLeftRadius");
        f!(border_bottom_right_radius, "borderBottomRightRadius");
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
        s.transform = o.get("transform").and_then(parse_transform_ops);
        s!(border_style, "borderStyle");
        s!(box_shadow, "boxShadow");
        s!(background_image, "backgroundImage");

        c!(color, "color");
        c!(background_color, "backgroundColor");
        // gpui supports a single border color; accept the shorthand or any side
        // (tamagui emits side colors, not the `borderColor` shorthand).
        s.border_color = o
            .get("borderColor")
            .or_else(|| o.get("borderTopColor"))
            .or_else(|| o.get("borderRightColor"))
            .or_else(|| o.get("borderBottomColor"))
            .or_else(|| o.get("borderLeftColor"))
            .and_then(|v| v.as_str())
            .and_then(parse_css_color);

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

        // Box model: RN/web-RN use border-box (a fixed width/height *includes*
        // padding + border), but taffy is content-box. Subtract padding+border
        // from fixed px sizes so a `maxWidth: 780` with padding wraps text at the
        // same width as the web build (otherwise the content is wider → fewer
        // wrapped lines → layout drift). Percent/auto are left to the engine.
        let bw = |side: Option<f32>| side.or(self.border_width).unwrap_or(0.0);
        let pad_h = self
            .padding_left
            .or(self.padding)
            .and_then(Dim::as_px)
            .unwrap_or(0.0)
            + self
                .padding_right
                .or(self.padding)
                .and_then(Dim::as_px)
                .unwrap_or(0.0)
            + bw(self.border_left_width)
            + bw(self.border_right_width);
        let pad_v = self
            .padding_top
            .or(self.padding)
            .and_then(Dim::as_px)
            .unwrap_or(0.0)
            + self
                .padding_bottom
                .or(self.padding)
                .and_then(Dim::as_px)
                .unwrap_or(0.0)
            + bw(self.border_top_width)
            + bw(self.border_bottom_width);
        let bb = |d: Dim, inset: f32| -> Length {
            match d {
                Dim::Px(p) => px((p - inset).max(0.0)).into(),
                other => other.to_length(),
            }
        };

        // Dimensions (number → px, "NN%" → fraction, "auto" → auto)
        if let Some(w) = self.width {
            style.size.width = bb(w, pad_h);
        }
        if let Some(h) = self.height {
            style.size.height = bb(h, pad_v);
        }

        // Min/Max dimensions
        if let Some(mw) = self.min_width {
            style.min_size.width = bb(mw, pad_h);
        }
        if let Some(mw) = self.max_width {
            style.max_size.width = bb(mw, pad_h);
        }
        if let Some(mh) = self.min_height {
            style.min_size.height = bb(mh, pad_v);
        }
        if let Some(mh) = self.max_height {
            style.max_size.height = bb(mh, pad_v);
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

        // Border — per-side widths (tamagui emits side-specific keys; fall back to
        // the `borderWidth` shorthand).
        let bwsh = self.border_width;
        let bt = self.border_top_width.or(bwsh).unwrap_or(0.0);
        let brw = self.border_right_width.or(bwsh).unwrap_or(0.0);
        let bbw = self.border_bottom_width.or(bwsh).unwrap_or(0.0);
        let blw = self.border_left_width.or(bwsh).unwrap_or(0.0);
        if bt > 0.0 || brw > 0.0 || bbw > 0.0 || blw > 0.0 {
            style.border_widths = gpui::Edges {
                top: px(bt).into(),
                right: px(brw).into(),
                bottom: px(bbw).into(),
                left: px(blw).into(),
            };
            let border_c = self.border_color.unwrap_or(Hsla {
                h: 0.0,
                s: 0.0,
                l: 0.0,
                a: 1.0,
            });
            style.border_color = Some(border_c);
        }
        let r = self.border_radius;
        let tl = self.border_top_left_radius.or(r).unwrap_or(0.0);
        let tr = self.border_top_right_radius.or(r).unwrap_or(0.0);
        let bl = self.border_bottom_left_radius.or(r).unwrap_or(0.0);
        let brr = self.border_bottom_right_radius.or(r).unwrap_or(0.0);
        if tl > 0.0 || tr > 0.0 || bl > 0.0 || brr > 0.0 {
            style.corner_radii = gpui::Corners {
                top_left: px(tl).into(),
                top_right: px(tr).into(),
                bottom_left: px(bl).into(),
                bottom_right: px(brr).into(),
            };
        }

        // Background — a CSS linear-gradient (via `backgroundImage`) wins; else a
        // solid color.
        if let Some(grad) = parse_linear_gradient(self.background_image.as_deref()) {
            style.background = Some(grad.into());
        } else {
            let bg = self
                .background_color
                .or_else(|| default_bg.map(u32_to_hsla));
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

        if let Some(ref cursor) = self.cursor {
            style.mouse_cursor = parse_cursor_style(cursor);
        }

        style
    }

    /// Resolved GPUI font weight, if `fontWeight` was set.
    pub fn gpui_font_weight(&self) -> Option<FontWeight> {
        self.font_weight.as_deref().map(parse_font_weight)
    }

    /// Resolved GPUI font family. Maps tamagui/web generic families to real
    /// installed faces so native text matches the web's system font.
    pub fn gpui_font_family(&self) -> Option<gpui::SharedString> {
        self.font_family.as_deref().map(map_font_family)
    }
}

fn map_font_family(f: &str) -> gpui::SharedString {
    // take the first family in a CSS stack, strip quotes
    let first = f
        .split(',')
        .next()
        .unwrap_or(f)
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    match first.to_ascii_lowercase().as_str() {
        // web `-apple-system` at UI/body sizes renders SF Pro *Text* (the small
        // optical master); match it explicitly so glyph advances/wrapping line up.
        "" | "system" | "system-ui" | "-apple-system" | "blinkmacsystemfont" | "sans-serif" => {
            "SF Pro Text".into()
        }
        "ui-monospace" | "monospace" | "sfmono-regular" => "Menlo".into(),
        _ => first.to_string().into(),
    }
}

pub fn parse_font_weight(s: &str) -> FontWeight {
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

fn parse_cursor_style(cursor: &str) -> Option<CursorStyle> {
    match cursor.trim().to_ascii_lowercase().as_str() {
        "auto" | "default" => Some(CursorStyle::Arrow),
        "none" => Some(CursorStyle::None),
        "pointer" => Some(CursorStyle::PointingHand),
        "text" => Some(CursorStyle::IBeam),
        "vertical-text" => Some(CursorStyle::IBeamCursorForVerticalLayout),
        "crosshair" => Some(CursorStyle::Crosshair),
        "grab" => Some(CursorStyle::OpenHand),
        "grabbing" => Some(CursorStyle::ClosedHand),
        "w-resize" => Some(CursorStyle::ResizeLeft),
        "e-resize" => Some(CursorStyle::ResizeRight),
        "ew-resize" => Some(CursorStyle::ResizeLeftRight),
        "n-resize" => Some(CursorStyle::ResizeUp),
        "s-resize" => Some(CursorStyle::ResizeDown),
        "ns-resize" => Some(CursorStyle::ResizeUpDown),
        "nwse-resize" => Some(CursorStyle::ResizeUpLeftDownRight),
        "nesw-resize" => Some(CursorStyle::ResizeUpRightDownLeft),
        "col-resize" => Some(CursorStyle::ResizeColumn),
        "row-resize" => Some(CursorStyle::ResizeRow),
        "not-allowed" => Some(CursorStyle::OperationNotAllowed),
        "alias" => Some(CursorStyle::DragLink),
        "copy" => Some(CursorStyle::DragCopy),
        "context-menu" => Some(CursorStyle::ContextualMenu),
        _ => None,
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
            first
                .trim_end_matches("deg")
                .trim()
                .parse::<f32>()
                .unwrap_or(180.0),
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
pub(crate) fn parse_box_shadows(input: &str) -> Vec<BoxShadow> {
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

    // pull out the color token (rgb/rgba/hsl/hsla(...) or #hex), leaving only lengths
    if let Some(start) = find_css_color_function(&rest) {
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

fn find_css_color_function(input: &str) -> Option<usize> {
    match (input.find("rgb"), input.find("hsl")) {
        (Some(rgb), Some(hsl)) => Some(rgb.min(hsl)),
        (Some(rgb), None) => Some(rgb),
        (None, Some(hsl)) => Some(hsl),
        (None, None) => None,
    }
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
pub fn parse_css_color(input: &str) -> Option<Hsla> {
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
    if let Some(rest) = s.strip_prefix("hsla(").or_else(|| s.strip_prefix("hsl(")) {
        // CSS `hsl(h, s%, l%, a)` maps straight onto GPUI's native Hsla.
        let inner = rest.trim_end_matches(')');
        let nums: Vec<f32> = inner
            .split(',')
            .filter_map(|p| {
                p.trim()
                    .trim_end_matches('%')
                    .trim_end_matches("deg")
                    .trim()
                    .parse::<f32>()
                    .ok()
            })
            .collect();
        if nums.len() >= 3 {
            return Some(Hsla {
                h: (nums[0] / 360.0).rem_euclid(1.0),
                s: (nums[1] / 100.0).clamp(0.0, 1.0),
                l: (nums[2] / 100.0).clamp(0.0, 1.0),
                a: nums.get(3).copied().unwrap_or(1.0).clamp(0.0, 1.0),
            });
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

pub fn u32_to_hsla(c: u32) -> Hsla {
    Hsla::from(Rgba {
        r: ((c >> 16) & 0xFF) as f32 / 255.0,
        g: ((c >> 8) & 0xFF) as f32 / 255.0,
        b: (c & 0xFF) as f32 / 255.0,
        a: 1.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_shadow_parser_extracts_hsla_color() {
        let shadows = parse_box_shadows(
            "0 12px 32px -8px hsla(240, 10%, 10%, 0.08), 0 2px 8px -2px hsla(240, 10%, 10%, 0.05)",
        );

        assert_eq!(shadows.len(), 2);
        assert_eq!(f32::from(shadows[0].offset.x), 0.0);
        assert_eq!(f32::from(shadows[0].offset.y), 12.0);
        assert_eq!(f32::from(shadows[0].blur_radius), 32.0);
        assert_eq!(f32::from(shadows[0].spread_radius), -8.0);
        assert!((shadows[0].color.h - (240.0 / 360.0)).abs() < 0.001);
        assert!((shadows[0].color.a - 0.08).abs() < 0.001);
        assert!((shadows[1].color.a - 0.05).abs() < 0.001);
    }
}

/// One RN transform list entry. Parsed from the array form reanimated and RN both emit:
/// `transform: [{translateY: 24}, {scale: 0.92}, {rotate: "45deg"}]`. Percent translate
/// and skew are not supported (silently skipped).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransformOp {
    TranslateX(f32),
    TranslateY(f32),
    Scale(f32),
    ScaleX(f32),
    ScaleY(f32),
    /// radians, clockwise
    Rotate(f32),
}

pub fn parse_transform_ops(value: &Value) -> Option<Vec<TransformOp>> {
    let items = value.as_array()?;
    let mut ops = Vec::with_capacity(items.len());
    for item in items {
        let obj = item.as_object()?;
        for (k, v) in obj {
            let num = v.as_f64().map(|n| n as f32);
            match (k.as_str(), num) {
                ("translateX", Some(n)) => ops.push(TransformOp::TranslateX(n)),
                ("translateY", Some(n)) => ops.push(TransformOp::TranslateY(n)),
                ("scale", Some(n)) => ops.push(TransformOp::Scale(n)),
                ("scaleX", Some(n)) => ops.push(TransformOp::ScaleX(n)),
                ("scaleY", Some(n)) => ops.push(TransformOp::ScaleY(n)),
                ("rotate" | "rotateZ", _) => {
                    if let Some(rad) = parse_angle(v) {
                        ops.push(TransformOp::Rotate(rad));
                    }
                }
                _ => {}
            }
        }
    }
    if ops.is_empty() { None } else { Some(ops) }
}

fn parse_angle(v: &Value) -> Option<f32> {
    if let Some(n) = v.as_f64() {
        return Some(n as f32); // bare number = radians (reanimated convention)
    }
    let s = v.as_str()?.trim();
    if let Some(deg) = s.strip_suffix("deg") {
        return deg.trim().parse::<f32>().ok().map(f32::to_radians);
    }
    if let Some(rad) = s.strip_suffix("rad") {
        return rad.trim().parse::<f32>().ok();
    }
    None
}

/// Fold transform ops into a gpui matrix around the element's center (RN's default
/// transform origin), in scaled (device) pixel space. Ops compose with CSS semantics:
/// the last op in the list applies to the element first. Returns `None` for an
/// identity result so untransformed nodes skip the transform stack entirely.
pub fn transform_ops_matrix(
    ops: &[TransformOp],
    bounds: gpui::Bounds<gpui::Pixels>,
    scale_factor: f32,
) -> Option<gpui::TransformationMatrix> {
    use gpui::TransformationMatrix;
    let center = bounds.center().scale(scale_factor);
    let neg_center = bounds.center().map(|v| v * -1.0).scale(scale_factor);
    let mut m = TransformationMatrix::unit().translate(center);
    for op in ops {
        m = match *op {
            TransformOp::TranslateX(x) => m.translate(point(px(x), px(0.0)).scale(scale_factor)),
            TransformOp::TranslateY(y) => m.translate(point(px(0.0), px(y)).scale(scale_factor)),
            TransformOp::Scale(s) => m.scale(gpui::size(s, s)),
            TransformOp::ScaleX(s) => m.scale(gpui::size(s, 1.0)),
            TransformOp::ScaleY(s) => m.scale(gpui::size(1.0, s)),
            TransformOp::Rotate(rad) => m.rotate(gpui::radians(rad)),
        };
    }
    m = m.translate(neg_center);
    if m == TransformationMatrix::unit() {
        None
    } else {
        Some(m)
    }
}
