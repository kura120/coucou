// The words go where you type: onto the clipboard as text (kept out of
// Windows' clipboard history and cloud clipboard), Ctrl+V in the window that
// was in front when the key went down, and the clipboard's text put back a
// moment later, unless something else was copied meanwhile.
//
// Only the clipboard's text is saved and put back. An image or files copied
// before are replaced by the words (the clipboard holds one thing at a time).
//
// When Ctrl+V cannot reach the window, the words stay on the clipboard instead
// and the pill says so: an elevated window drops keystrokes from a program
// that is not (UIPI), and a window Peika cannot bring back to the front is not
// one to type into blindly.

use super::logic::FlowKey;

/// What happened to the words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Pasted,
    /// On the clipboard only, for the user to paste.
    Copied(Why),
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// The window runs elevated and Peika does not (UIPI).
    Elevated,
    /// The window that was in front is gone or could not be brought back.
    Away,
    /// Windows took fewer keystrokes than were sent.
    Refused,
}

/// How long the words stay on the clipboard after the paste, before the old
/// text comes back.
#[cfg(any(windows, test))]
const RESTORE_AFTER_MS: u64 = 300;

/// Whether the clipboard goes back to what it held: only when nobody copied
/// anything since the words were put there.
#[cfg(any(windows, test))]
fn restore_wanted(sequence_then: u32, sequence_now: u32) -> bool {
    sequence_then == sequence_now
}

#[cfg(windows)]
pub fn paste(text: &str, target: Option<isize>, key: FlowKey) -> Outcome {
    imp::paste(text, target, key)
}

#[cfg(not(windows))]
pub fn paste(_text: &str, _target: Option<isize>, _key: FlowKey) -> Outcome {
    Outcome::Failed
}

#[cfg(windows)]
mod imp {
    use std::time::Duration;

    use ::windows::core::{w, PCWSTR};
    use ::windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use ::windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
        SetClipboardData,
    };
    use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    use super::{restore_wanted, FlowKey, Outcome, Why, RESTORE_AFTER_MS};
    use crate::flow::os;

    /// CF_UNICODETEXT.
    const UNICODE_TEXT: u32 = 13;

    /// A block of global memory holding `bytes`, for the clipboard to own.
    fn global(bytes: &[u8]) -> Result<HGLOBAL, String> {
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|_| "out of memory".to_string())?;
            let at = GlobalLock(memory) as *mut u8;
            if at.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("out of memory".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), at, bytes.len());
            let _ = GlobalUnlock(memory);
            Ok(memory)
        }
    }

    /// The clipboard may be held by another program for a moment (a clipboard
    /// manager reading it): a few tries.
    fn open() -> Result<(), String> {
        for _ in 0..10 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err("the clipboard is busy".into())
    }

    /// Puts `format`'s flag on what the clipboard holds now.
    unsafe fn flag(name: PCWSTR, value: u32) {
        let format = RegisterClipboardFormatW(name);
        if format == 0 {
            return;
        }
        if let Ok(memory) = global(&value.to_le_bytes()) {
            if SetClipboardData(format, Some(HANDLE(memory.0))).is_err() {
                let _ = GlobalFree(Some(memory));
            }
        }
    }

    /// `text` is the clipboard's only content, and for a dictation, out of the
    /// clipboard history and the cloud clipboard. Returns the clipboard's
    /// sequence number right after, to tell later whether it changed.
    fn set_text(text: &str, private: bool) -> Result<u32, String> {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
        let memory = global(&bytes)?;
        if let Err(err) = open() {
            unsafe {
                let _ = GlobalFree(Some(memory));
            }
            return Err(err);
        }
        let set = unsafe {
            let _ = EmptyClipboard();
            // Once set, the clipboard owns the memory.
            let set = SetClipboardData(UNICODE_TEXT, Some(HANDLE(memory.0)));
            if set.is_err() {
                let _ = GlobalFree(Some(memory));
            } else if private {
                flag(w!("CanIncludeInClipboardHistory"), 0);
                flag(w!("CanUploadToCloudClipboard"), 0);
                flag(w!("ExcludeClipboardContentFromMonitorProcessing"), 0);
            }
            set
        };
        unsafe {
            let _ = CloseClipboard();
        }
        set.map_err(|_| "the clipboard refused the text".to_string())?;
        Ok(unsafe { GetClipboardSequenceNumber() })
    }

    fn clear() {
        if open().is_ok() {
            unsafe {
                let _ = EmptyClipboard();
                let _ = CloseClipboard();
            }
        }
    }

    pub fn paste(text: &str, target: Option<isize>, key: FlowKey) -> Outcome {
        // The window the words are for must be the one in front.
        if let Some(window) = target {
            if !os::bring_to_front(window) {
                return keep(text, Why::Away);
            }
        }
        if os::foreground().is_some_and(os::refuses_input) {
            return keep(text, Why::Elevated);
        }
        let previous = crate::clipboard::text();
        let sequence = match set_text(text, true) {
            Ok(n) => n,
            Err(err) => {
                crate::log::line(format!("flow: clipboard: {err}"));
                return Outcome::Failed;
            }
        };
        // Give the clipboard a moment to be announced before the window reads it.
        std::thread::sleep(Duration::from_millis(40));
        os::wait_key_released(key);
        if let Err(err) = os::send_paste() {
            crate::log::line(format!("flow: paste keystroke: {err}"));
            return Outcome::Copied(Why::Refused);
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(RESTORE_AFTER_MS));
            if !restore_wanted(sequence, unsafe { GetClipboardSequenceNumber() }) {
                return;
            }
            match previous {
                Some(old) => {
                    let _ = set_text(&old, true);
                }
                None => clear(),
            }
        });
        Outcome::Pasted
    }

    /// The words are left on the clipboard for the user to paste.
    fn keep(text: &str, why: Why) -> Outcome {
        match set_text(text, true) {
            Ok(_) => Outcome::Copied(why),
            Err(err) => {
                crate::log::line(format!("flow: clipboard: {err}"));
                Outcome::Failed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_old_text_comes_back_only_if_nothing_was_copied_since() {
        assert!(restore_wanted(41, 41));
        assert!(!restore_wanted(41, 42));
    }

    #[test]
    fn the_words_stay_on_the_clipboard_for_a_moment_only() {
        assert!((200..=400).contains(&RESTORE_AFTER_MS));
    }
}
