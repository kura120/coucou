// The clipboard's text, for Paste in the right-click menu (src/views/menu.ts).
//
// The page cannot read the clipboard itself without the webview asking the
// user each time, and the island's window does not even have the keyboard
// most of the time. Only text is read, only when Paste is clicked, and it goes
// nowhere but into the field that was right-clicked.
//
// Windows only for now: on Linux the page asks the webview's own clipboard
// (None here), and Ctrl+V works as it always did.

/// The most text Paste takes, in UTF-16 units: a field is not a file.
#[cfg(windows)]
const MAX_UNITS: usize = 1024 * 1024;

#[cfg(windows)]
pub fn text() -> Option<String> {
    use ::windows::Win32::Foundation::HGLOBAL;
    use ::windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use ::windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    /// CF_UNICODETEXT: NUL-terminated UTF-16.
    const UNICODE_TEXT: u32 = 13;

    unsafe {
        OpenClipboard(None).ok()?;
        let text = (|| {
            let memory = HGLOBAL(GetClipboardData(UNICODE_TEXT).ok()?.0);
            let start = GlobalLock(memory) as *const u16;
            if start.is_null() {
                return None;
            }
            // Never past the block Windows handed over, terminator or not.
            let units = std::slice::from_raw_parts(start, (GlobalSize(memory) / 2).min(MAX_UNITS));
            let len = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
            let text = String::from_utf16_lossy(&units[..len]);
            let _ = GlobalUnlock(memory);
            Some(text)
        })();
        let _ = CloseClipboard();
        text.filter(|t| !t.is_empty())
    }
}

#[cfg(not(windows))]
pub fn text() -> Option<String> {
    None
}
