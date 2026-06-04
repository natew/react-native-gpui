use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, Entity, GlobalElementId, InteractiveElement as _,
    IntoElement, KeyDownEvent, LayoutId, ParentElement as _, Pixels, Styled, Window, div,
};
use gpui_component::input::{Input, InputState};

use crate::elements::ReactElement;
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
                let element_type = self.element.element_type.clone();
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
                    .on_key_down({
                        let state = state.clone();
                        move |event: &KeyDownEvent, window: &mut Window, cx: &mut App| {
                            let keystroke = &event.keystroke;
                            if !editable {
                                cx.stop_propagation();
                                return;
                            }
                            let key = js_key(keystroke);
                            if listens_key_press {
                                crate::bridge::key_press(
                                    element_id,
                                    &key,
                                    keystroke.modifiers.shift,
                                    keystroke.modifiers.control,
                                    keystroke.modifiers.alt,
                                    keystroke.modifiers.platform,
                                );
                            }
                            if element_type == "textarea"
                                && key == "Enter"
                                && !keystroke.modifiers.control
                                && !keystroke.modifiers.alt
                                && !keystroke.modifiers.platform
                            {
                                if keystroke.modifiers.shift {
                                    state.update(cx, |input, cx| {
                                        input.insert("\n".to_string(), window, cx);
                                    });
                                    cx.stop_propagation();
                                    return;
                                }
                                if listens_key_press {
                                    cx.stop_propagation();
                                    return;
                                }
                            }
                            let Some(text) = keystroke.key_char.as_deref() else {
                                return;
                            };
                            if text == "\n"
                                || text == "\t"
                                || keystroke.modifiers.control
                                || keystroke.modifiers.platform
                                || keystroke.modifiers.function
                            {
                                return;
                            }
                            let text = text.to_string();
                            state.update(cx, |input, cx| {
                                input.insert(text, window, cx);
                            });
                            cx.stop_propagation();
                        }
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
            .unwrap_or_else(|| keystroke.key.clone())
    }
}

impl Element for ReactInputElement {
    type RequestLayoutState = ();
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
    ) -> (LayoutId, ()) {
        let mut child = self.build_child();
        let layout_id = child.request_layout(window, cx);
        self.child = Some(child);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        #[cfg(target_os = "macos")]
        crate::ax::update_frame(window, &self.element, bounds);

        if let Some(child) = self.child.as_mut() {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
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
