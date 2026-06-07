use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, Display, Element, ElementId, Entity, GlobalElementId,
    InteractiveElement as _, IntoElement, KeyDownEvent, LayoutId, ParentElement as _, Pixels,
    Styled, Window, div,
};
use gpui_component::input::{Input, InputState};

use crate::elements::{ReactElement, report_layout};
use crate::style::ElementStyle;

// The service owns the persistent InputState entities; it publishes a snapshot
// here each render so the (stateless) input element can resolve its entity by id.
thread_local! {
    static ENTITIES: RefCell<HashMap<u64, Entity<InputState>>> = RefCell::new(HashMap::new());
}

pub fn set_entities(map: HashMap<u64, Entity<InputState>>) {
    ENTITIES.with(|e| *e.borrow_mut() = map);
}

fn entity(id: u64) -> Option<Entity<InputState>> {
    ENTITIES.with(|e| e.borrow().get(&id).cloned())
}

/// `<TextInput>` / `<TextArea>` → gpui-component's real Input (editing, selection,
/// double-click word-select, copy/paste, IME). `appearance(false)` drops its own
/// border/bg so it sits inside our styled container.
pub struct ReactInputElement {
    element: Arc<ReactElement>,
    _window_id: u64,
    _parent_style: Option<ElementStyle>,
    child: Option<AnyElement>,
}

impl ReactInputElement {
    pub fn new(
        element: Arc<ReactElement>,
        window_id: u64,
        parent_style: Option<ElementStyle>,
    ) -> Self {
        Self {
            element,
            _window_id: window_id,
            _parent_style: parent_style,
            child: None,
        }
    }

    fn build_child(&self) -> AnyElement {
        match entity(self.element.global_id) {
            Some(state) => {
                let editable = self.element.editable;
                let listens_key_press = self.element.listens("keyPress");
                let element_id = self.element.global_id;
                let mut input = Input::new(&state)
                    .appearance(false)
                    .focus_bordered(false)
                    .disabled(!editable);
                if self.element.element_type == "textarea" {
                    input = input.h_full();
                }
                div()
                    .size_full()
                    .on_key_down(move |event: &KeyDownEvent, _: &mut Window, _: &mut App| {
                        if !editable || !listens_key_press {
                            return;
                        }
                        let key = js_key(&event.keystroke);
                        if key == "Enter" {
                            return;
                        }
                        crate::bridge::key_press(
                            element_id,
                            &key,
                            event.keystroke.modifiers.shift,
                            event.keystroke.modifiers.control,
                            event.keystroke.modifiers.alt,
                            event.keystroke.modifiers.platform,
                        );
                    })
                    .child(input)
                    .into_any_element()
            }
            None => div().into_any_element(),
        }
    }
}

fn js_key(keystroke: &gpui::Keystroke) -> String {
    if keystroke.key == "enter" || keystroke.key_char.as_deref() == Some("\n") {
        "Enter".to_string()
    } else {
        keystroke
            .key_char
            .clone()
            .unwrap_or_else(|| js_named_key(&keystroke.key))
    }
}

fn js_named_key(key: &str) -> String {
    match key {
        "escape" => "Escape",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        other => other,
    }
    .to_string()
}

impl Element for ReactInputElement {
    type RequestLayoutState = LayoutId;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Integer(self.element.global_id))
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, LayoutId) {
        let style = self.element.build_gpui_style(None);
        if style.display == Display::None {
            self.child = None;
            let layout_id = window.request_layout(style, [], cx);
            return (layout_id, layout_id);
        }

        let mut child = self.build_child();
        let child_layout_id = child.request_layout(window, cx);
        let layout_id = window.request_layout(style, std::iter::once(child_layout_id), cx);
        self.child = Some(child);
        (layout_id, child_layout_id)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut LayoutId,
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.element.style.is_display_none() {
            return;
        }

        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);
        report_layout(&self.element, bounds);

        if let Some(child) = self.child.as_mut() {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut LayoutId,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.element.style.is_display_none() {
            return;
        }

        if let Some(child) = self.child.as_mut() {
            child.paint(window, cx);
        }
    }
}

impl IntoElement for ReactInputElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::js_named_key;

    #[test]
    fn maps_gpui_navigation_keys_to_js_names() {
        assert_eq!(js_named_key("escape"), "Escape");
        assert_eq!(js_named_key("up"), "ArrowUp");
        assert_eq!(js_named_key("down"), "ArrowDown");
        assert_eq!(js_named_key("left"), "ArrowLeft");
        assert_eq!(js_named_key("right"), "ArrowRight");
    }
}
