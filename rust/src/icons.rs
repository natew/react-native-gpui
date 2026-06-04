// Shared monochrome icon set, embedded so both the raw-gpui showcase and the
// RN-bridge service render byte-identical SVGs. GPUI draws svg() as a single-color
// alpha mask tinted by text_color — exactly an icon system.

use std::borrow::Cow;

use anyhow::Result;
use gpui::{AssetSource, SharedString};

pub fn icon_bytes(path: &str) -> Option<&'static str> {
    Some(match path {
        "send.svg" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.39 1.2L4.2 11.1 13 12l-8.8.9-2.19 6.3a1 1 0 0 0 1.39 1.2z"/></svg>"##
        }
        "sparkle.svg" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l1.9 5.6a4 4 0 0 0 2.5 2.5L22 12l-5.6 1.9a4 4 0 0 0-2.5 2.5L12 22l-1.9-5.6a4 4 0 0 0-2.5-2.5L2 12l5.6-1.9a4 4 0 0 0 2.5-2.5z"/></svg>"##
        }
        "chevron.svg" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="black" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>"##
        }
        "branch.svg" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="5" r="2.4"/><circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="7" r="2.4"/><path d="M6 7.4v9.2M18 9.4c0 4-4 4.6-7 5.2"/></g></svg>"##
        }
        "file.svg" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="black" stroke-width="1.8" stroke-linejoin="round"/><path d="M13 2.5V7.5H18" fill="none" stroke="black" stroke-width="1.8" stroke-linejoin="round"/></svg>"##
        }
        "spinner.svg" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="2.4" stroke-linecap="round"><path d="M12 3v4" opacity="1"/><path d="M12 17v4" opacity="0.35"/><path d="M3 12h4" opacity="0.6"/><path d="M17 12h4" opacity="0.5"/><path d="M5.6 5.6l2.8 2.8" opacity="0.8"/><path d="M15.6 15.6l2.8 2.8" opacity="0.4"/><path d="M18.4 5.6l-2.8 2.8" opacity="0.45"/><path d="M8.4 15.6l-2.8 2.8" opacity="0.7"/></g></svg>"##
        }
        "search.svg" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></g></svg>"##
        }
        _ => return None,
    })
}

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        // an inline SVG document (e.g. serialized by the react-native-svg shim)
        // is its own source — render it directly rather than looking up a name.
        if path.trim_start().starts_with("<svg") {
            return Ok(Some(Cow::Owned(path.as_bytes().to_vec())));
        }
        Ok(icon_bytes(path).map(|s| Cow::Borrowed(s.as_bytes())))
    }
    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(vec![])
    }
}
