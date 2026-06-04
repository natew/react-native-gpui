use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, RenderOnce, Styled, Window, div,
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
        }
    }
}

impl RenderOnce for ReactInputElement {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        match entity(self.element.global_id) {
            Some(state) => {
                let mut input = Input::new(&state).appearance(false).focus_bordered(false);
                if self.element.element_type == "textarea" {
                    input = input.h_full();
                }
                div()
                    .size_full()
                    .on_key_down({
                        let state = state.clone();
                        move |event: &KeyDownEvent, window: &mut Window, cx: &mut App| {
                            let keystroke = &event.keystroke;
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

impl IntoElement for ReactInputElement {
    type Element = AnyElement;
    fn into_element(self) -> Self::Element {
        gpui::Component::new(self).into_any_element()
    }
}
