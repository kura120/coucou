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
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
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
    pub(super) fn set_text(text: &str, private: bool) -> Result<u32, String> {
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

    pub(super) fn clear() {
        if open().is_ok() {
            unsafe {
                let _ = EmptyClipboard();
                let _ = CloseClipboard();
            }
        }
    }

    pub(super) fn paste(text: &str, target: Option<isize>, key: FlowKey) -> Outcome {
        // The window the words are for must be the one in front.
        if let Some(window) = target {
            if !os::bring_to_front(window) {
                return keep(text, Why::Away);
            }
        }
        if os::foreground().is_some_and(os::refuses_input) {
            return keep(text, Why::Elevated);
        }
        // What the clipboard holds, as text. The clipboard may be busy for a
        // moment: a few tries before taking it for empty.
        let had_text = unsafe { IsClipboardFormatAvailable(UNICODE_TEXT) }.is_ok();
        let mut previous = None;
        for _ in 0..3 {
            previous = crate::clipboard::text();
            if previous.is_some() || !had_text {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
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
                // Text that could not be read: the words stay rather than
                // wipe what the user had.
                None if had_text => {}
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

    /// The whole paste into a real window: a small form with a text box is
    /// opened (by PowerShell, on top and focused), the words are pasted into it
    /// by `paste`, and what the text box then holds is read back, with the
    /// clipboard's old text checked as put back. The form takes the keyboard for
    /// a few seconds, so it is not run with the others:
    /// `cargo test -p peika flow::paste -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore = "opens a window, takes the keyboard for a few seconds and uses the real clipboard"]
    fn the_words_are_pasted_into_a_real_window_and_the_old_text_comes_back() {
        use super::imp::{clear, paste, set_text};
        use std::time::Duration;
        const FORM: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
$out = $args[0]
$f = New-Object Windows.Forms.Form; $f.Text = 'PeikaFlowTarget'; $f.Width = 420; $f.Height = 160; $f.TopMost = $true
$tb = New-Object Windows.Forms.TextBox; $tb.Dock = 'Fill'; $f.Controls.Add($tb)
$t = New-Object Windows.Forms.Timer; $t.Interval = 150
$t.Add_Tick({ [IO.File]::WriteAllText("$out.text", $tb.Text) }); $t.Start()
$f.Add_Shown({ $f.Activate(); $tb.Focus(); [IO.File]::WriteAllText("$out.hwnd", $f.Handle.ToInt64().ToString()) })
$c = New-Object Windows.Forms.Timer; $c.Interval = 20000; $c.Add_Tick({ $f.Close() }); $c.Start()
[Windows.Forms.Application]::Run($f)
"#;
        let dir = std::env::temp_dir().join(format!("peika-flow-paste-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("form.ps1");
        std::fs::write(&script, FORM).unwrap();
        let out = dir.join("target");
        let mut command = std::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script).arg(&out);
        let mut form = command.spawn().expect("PowerShell starts");

        let hwnd_file = dir.join("target.hwnd");
        let mut waited = 0;
        while !hwnd_file.exists() && waited < 150 {
            std::thread::sleep(Duration::from_millis(100));
            waited += 1;
        }
        let hwnd: isize = std::fs::read_to_string(&hwnd_file).expect("the form opened").trim().parse().unwrap();
        std::thread::sleep(Duration::from_millis(600));

        let user_text = crate::clipboard::text();
        set_text("the text before the dictation", false).unwrap();
        let words = "Peika Flow: déjà vu, 日本語 🙂";
        let outcome = paste(words, Some(hwnd), FlowKey::RightCtrl);
        std::thread::sleep(Duration::from_millis(900));
        let in_the_box = std::fs::read_to_string(dir.join("target.text")).unwrap_or_default();
        let clipboard_after = crate::clipboard::text();

        let _ = form.kill();
        let _ = std::fs::remove_dir_all(&dir);
        match user_text {
            Some(old) => {
                let _ = set_text(&old, false);
            }
            None => clear(),
        }
        assert_eq!(outcome, Outcome::Pasted);
        assert_eq!(in_the_box.trim_start_matches('\u{feff}'), words);
        assert_eq!(clipboard_after.as_deref(), Some("the text before the dictation"));
    }

    /// The real clipboard: the words go on it as text, in the same unicode the
    /// page sent, and the text that was there comes back. It replaces what the
    /// clipboard holds for a moment (and puts it back), so it is not run
    /// with the others: `cargo test -p peika flow::paste -- --ignored`
    #[cfg(windows)]
    #[test]
    #[ignore = "uses the real clipboard"]
    fn the_words_go_through_the_real_clipboard_and_the_old_text_comes_back() {
        use super::imp::{clear, set_text};
        let before = crate::clipboard::text();
        let words = "Peika Flow test: déjà vu, 日本語, emoji 🙂, a\nsecond line";
        let sequence = set_text(words, true).expect("the clipboard takes text");
        assert_eq!(crate::clipboard::text().as_deref(), Some(words));
        let changed = set_text("someone else copied this", false).expect("a second copy");
        assert!(!restore_wanted(sequence, changed), "a copy since the words is told apart");
        match before {
            Some(old) => {
                set_text(&old, true).expect("the old text goes back");
                assert_eq!(crate::clipboard::text().as_deref(), Some(old.as_str()));
            }
            None => clear(),
        }
    }
}
