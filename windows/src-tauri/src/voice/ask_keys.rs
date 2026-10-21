// The keys that answer a question Peika has on screen: Ctrl+Shift+1…9 for a
// choice (1 and 2 for yes and no), Ctrl+Shift+Enter to confirm what was
// dictated. Held only while the question is there, as a toast holds its Yes
// and No (toast.rs): the island never has the keyboard, so these are global.
//
// A press is only passed on to the island, which knows the question; nothing
// is decided here.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcut, Modifiers, Shortcut};

use crate::island::WINDOW_LABEL;

/// What the island is told: "1"…"9", or "enter".
const EVENT: &str = "voice-ask-key";

const DIGITS: [Code; 9] =
    [Code::Digit1, Code::Digit2, Code::Digit3, Code::Digit4, Code::Digit5, Code::Digit6, Code::Digit7, Code::Digit8, Code::Digit9];

fn with_ctrl_shift(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), code)
}

/// What is held now: how many number keys, and whether Enter.
#[derive(Default, Clone, Copy, PartialEq, Eq)]
struct Held {
    numbers: usize,
    enter: bool,
}

static HELD: Mutex<Held> = Mutex::new(Held { numbers: 0, enter: false });

fn keys(held: Held) -> Vec<Shortcut> {
    let mut keys: Vec<Shortcut> = DIGITS.iter().take(held.numbers).map(|code| with_ctrl_shift(*code)).collect();
    if held.enter {
        keys.push(with_ctrl_shift(Code::Enter));
    }
    keys
}

fn grab<R: Runtime>(app: &AppHandle<R>, held: Held, on: bool) {
    // Where global shortcuts cannot be had (Wayland), a click answers.
    if crate::platform::global_shortcuts_blocked().is_some() {
        return;
    }
    let Some(gs) = app.try_state::<GlobalShortcut<R>>() else { return };
    for shortcut in keys(held) {
        let result = if on { gs.register(shortcut) } else { gs.unregister(shortcut) };
        if let Err(err) = result {
            // Another program has the key: the question is still answered by a click or by voice.
            crate::log::line(format!("voice: ask key {shortcut}: {err}"));
        }
    }
}

/// Holds the keys for the question on screen, in place of whatever was held:
/// none and no Enter lets go of them all.
pub fn hold<R: Runtime>(app: &AppHandle<R>, numbers: usize, enter: bool) {
    let wanted = Held { numbers: numbers.min(DIGITS.len()), enter };
    let mut held = HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if *held == wanted {
        return;
    }
    grab(app, *held, false);
    grab(app, wanted, true);
    *held = wanted;
}

/// shortcuts::apply lets go of every key it finds registered: the question's
/// are taken back if one is still on screen.
pub fn reclaim<R: Runtime>(app: &AppHandle<R>) {
    let held = *HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    grab(app, held, true);
}

/// A key press from the global-shortcut plugin. True when it was one of ours.
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut) -> bool {
    let held = *HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let pressed = DIGITS
        .iter()
        .take(held.numbers)
        .position(|code| with_ctrl_shift(*code).id() == shortcut.id())
        .map(|at| (at + 1).to_string())
        .or_else(|| (held.enter && with_ctrl_shift(Code::Enter).id() == shortcut.id()).then(|| "enter".to_string()));
    let Some(key) = pressed else { return false };
    let _ = app.emit_to(WINDOW_LABEL, EVENT, key);
    true
}

/// The island put a question on screen, or took it away.
#[tauri::command]
pub fn voice_ask_keys(app: AppHandle, numbers: usize, enter: bool) {
    hold(&app, numbers, enter);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keys_are_the_ones_the_question_needs_and_no_more() {
        assert!(keys(Held::default()).is_empty());
        assert_eq!(keys(Held { numbers: 3, enter: false }).len(), 3);
        assert_eq!(keys(Held { numbers: 0, enter: true }).len(), 1);
        let all = keys(Held { numbers: 9, enter: true });
        assert_eq!(all.len(), 10);
        // Each its own key, all with Ctrl+Shift: none is a key that types.
        let mut ids: Vec<u32> = all.iter().map(Shortcut::id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 10);
        assert!(all.iter().all(|key| key.mods == Modifiers::CONTROL | Modifiers::SHIFT));
    }
}
