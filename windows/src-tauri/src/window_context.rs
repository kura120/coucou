// The window in front as the chat's context — port of WindowContextCapture.swift.
//
// What is attached: the app's name, the window's title and, for a browser, the
// address in its address bar. Nothing is read from a window without the attach
// shortcut (Ctrl+Alt+F) or Peika dropped on it with Ctrl held, and the chat
// shows what is attached, removable, before anything is sent.
//
// Windows only. The title and the process need no permission there; a
// browser's address comes from UI Automation (the address bar's Value), never
// from Ctrl+L / Ctrl+C, which would overwrite the clipboard. When it cannot be
// read the title goes alone. Linux has no equivalent yet: the shortcut stays
// reserved there (shortcuts.rs).

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::island::WINDOW_LABEL;

/// What the island receives as the `window-context` event: the window, or
/// null when nothing could be read (the island says so with a sound).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    pub app_name: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

const EVENT: &str = "window-context";

fn send<R: Runtime>(app: &AppHandle<R>, context: Option<WindowContext>) {
    crate::log::line(format!(
        "window context: {}",
        context.as_ref().map_or("nothing readable", |c| if c.url.is_some() { "app, title, address" } else { "app, title" })
    ));
    let _ = app.emit_to(WINDOW_LABEL, EVENT, context);
}

/// A readable name for an executable, as the Mac shows an app's localised name.
pub fn app_name(exe_stem: &str) -> String {
    let known = match exe_stem.to_ascii_lowercase().as_str() {
        "chrome" => "Google Chrome",
        "msedge" => "Microsoft Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "vivaldi" => "Vivaldi",
        "opera" => "Opera",
        "arc" => "Arc",
        "code" => "Visual Studio Code",
        "cursor" => "Cursor",
        "windowsterminal" => "Windows Terminal",
        "explorer" => "File Explorer",
        "notepad" => "Notepad",
        "winword" => "Word",
        "excel" => "Excel",
        "powerpnt" => "PowerPoint",
        "outlook" | "olk" => "Outlook",
        "ms-teams" | "teams" => "Microsoft Teams",
        "slack" => "Slack",
        "discord" => "Discord",
        _ => return exe_stem.to_string(),
    };
    known.to_string()
}

/// The browsers whose address bar is read.
pub fn is_browser(exe_stem: &str) -> bool {
    matches!(
        exe_stem.to_ascii_lowercase().as_str(),
        "chrome" | "msedge" | "firefox" | "brave" | "vivaldi" | "opera" | "arc"
    )
}

/// What the address bar says, as an http(s) address, or nothing. Chromium
/// shows the address without its scheme; anything else (chrome://, file://,
/// a search being typed) is not kept.
pub fn web_address(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Some(s.to_string());
    }
    if lower.contains("://") {
        return None;
    }
    // The host, without its port: "about:blank" or "javascript:…" leave a
    // name without a dot, and are dropped below.
    let host = s.split(['/', '?', '#']).next()?;
    let (name, port) = host.split_once(':').unwrap_or((host, ""));
    if !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let plausible = !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !name.starts_with('.')
        && !name.ends_with('.');
    if !plausible {
        return None;
    }
    if name.eq_ignore_ascii_case("localhost") {
        return Some(format!("http://{s}"));
    }
    name.contains('.').then(|| format!("https://{s}"))
}

pub use imp::{ctrl_held, remember_front};

/// The attach shortcut: the window in front, or the one that was before the
/// island took the keyboard. Read off the shortcut's thread: UI Automation
/// can take a moment, the first time, on a browser.
pub fn attach_front<R: Runtime>(app: &AppHandle<R>) {
    let target = imp::front();
    let app = app.clone();
    std::thread::spawn(move || send(&app, target.and_then(imp::read)));
}

/// Peika dropped with Ctrl held: the window under the drop point (physical pixels).
pub fn attach_at<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) {
    let target = imp::at_point(x as i32, y as i32);
    let app = app.clone();
    std::thread::spawn(move || send(&app, target.and_then(imp::read)));
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use ::windows::core::{BOOL, PWSTR};
    use ::windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use ::windows::Win32::System::Variant::{VARIANT, VT_I4};
    use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use ::windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use ::windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_ValuePatternId,
    };
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    use ::windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    };

    use super::{app_name, is_browser, web_address, WindowContext};

    /// The last window in front that was not Peika's, kept when the island
    /// takes the keyboard: then the window in front is Peika's own.
    static LAST_EXTERNAL: AtomicIsize = AtomicIsize::new(0);

    /// How long a browser's address bar gets before the title goes alone.
    const ADDRESS_WAIT: Duration = Duration::from_millis(1500);

    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32)) };
        pid
    }

    fn ours(hwnd: HWND) -> bool {
        pid_of(hwnd) == std::process::id()
    }

    /// Called just before the island takes the keyboard.
    pub fn remember_front() {
        let hwnd = unsafe { GetForegroundWindow() };
        if !hwnd.is_invalid() && !ours(hwnd) {
            LAST_EXTERNAL.store(hwnd.0 as isize, Ordering::Relaxed);
        }
    }

    pub fn front() -> Option<isize> {
        let hwnd = unsafe { GetForegroundWindow() };
        if !hwnd.is_invalid() && !ours(hwnd) {
            return Some(hwnd.0 as isize);
        }
        let raw = LAST_EXTERNAL.load(Ordering::Relaxed);
        let hwnd = HWND(raw as *mut _);
        (raw != 0 && unsafe { IsWindow(Some(hwnd)) }.as_bool()).then_some(raw)
    }

    pub fn ctrl_held() -> bool {
        unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 }
    }

    /// The desktop and the taskbar are not windows to attach.
    const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    /// Hidden by the system (a suspended Store app's frame) though "visible".
    fn cloaked(hwnd: HWND) -> bool {
        let mut value = 0u32;
        let got = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut value as *mut u32 as *mut _,
                std::mem::size_of::<u32>() as u32,
            )
        };
        got.is_ok() && value != 0
    }

    /// The topmost window under the point that is someone's app: not Peika,
    /// not the desktop or the taskbar, not minimised or cloaked.
    pub fn at_point(x: i32, y: i32) -> Option<isize> {
        struct Search {
            point: POINT,
            found: isize,
        }
        unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = unsafe { &mut *(lparam.0 as *mut Search) };
            let mut rect = RECT::default();
            let candidate = unsafe {
                IsWindowVisible(hwnd).as_bool()
                    && !IsIconic(hwnd).as_bool()
                    && GetWindowRect(hwnd, &mut rect).is_ok()
            };
            let p = search.point;
            let inside = p.x >= rect.left && p.x < rect.right && p.y >= rect.top && p.y < rect.bottom;
            if candidate && inside && !ours(hwnd) && !cloaked(hwnd) && !SHELL_CLASSES.contains(&class_of(hwnd).as_str()) {
                search.found = hwnd.0 as isize;
                return false.into();
            }
            true.into()
        }
        // EnumWindows goes from the top of the stack down.
        let mut search = Search { point: POINT { x, y }, found: 0 };
        unsafe {
            let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut _ as isize));
        }
        (search.found != 0).then_some(search.found)
    }

    fn exe_stem(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let got = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(process);
            got.ok()?;
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned())
        }
    }

    fn title_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize]).trim().to_string()
    }

    pub fn read(raw: isize) -> Option<WindowContext> {
        let hwnd = HWND(raw as *mut _);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return None;
        }
        let stem = exe_stem(pid_of(hwnd)).unwrap_or_default();
        let title = title_of(hwnd);
        if stem.is_empty() && title.is_empty() {
            return None;
        }
        let url = if is_browser(&stem) { address_in_time(raw) } else { None };
        Some(WindowContext { app_name: app_name(&stem), title, url })
    }

    /// The address bar, or nothing after ADDRESS_WAIT: Chromium builds its
    /// accessibility tree lazily, and a slow answer must not hold the chat.
    fn address_in_time(raw: isize) -> Option<String> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(address_bar(raw));
        });
        rx.recv_timeout(ADDRESS_WAIT).ok().flatten()
    }

    /// A VT_I4 VARIANT: nothing to free, so no VariantClear.
    fn int_variant(value: i32) -> VARIANT {
        let mut v = VARIANT::default();
        unsafe {
            (*v.Anonymous.Anonymous).vt = VT_I4;
            (*v.Anonymous.Anonymous).Anonymous.lVal = value;
        }
        v
    }

    /// The first edit field of the browser's window is its address bar, in
    /// Chromium and Firefox alike; matched by type, never by its name, which
    /// changes with the language and the version.
    fn address_bar(raw: isize) -> Option<String> {
        let hwnd = HWND(raw as *mut _);
        unsafe {
            let initialised = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let value = (|| -> ::windows::core::Result<String> {
                let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
                let window = uia.ElementFromHandle(hwnd)?;
                let is_edit = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &int_variant(UIA_EditControlTypeId.0))?;
                let field = window.FindFirst(TreeScope_Descendants, &is_edit)?;
                let pattern: IUIAutomationValuePattern = field.GetCurrentPatternAs(UIA_ValuePatternId)?;
                Ok(pattern.CurrentValue()?.to_string())
            })();
            if initialised {
                CoUninitialize();
            }
            web_address(&value.ok()?)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::WindowContext;

    pub fn remember_front() {}
    pub fn front() -> Option<isize> {
        None
    }
    pub fn ctrl_held() -> bool {
        false
    }
    pub fn at_point(_x: i32, _y: i32) -> Option<isize> {
        None
    }
    pub fn read(_raw: isize) -> Option<WindowContext> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_apps_get_their_names_and_others_keep_the_executable_s() {
        assert_eq!(app_name("chrome"), "Google Chrome");
        assert_eq!(app_name("MSEDGE"), "Microsoft Edge");
        assert_eq!(app_name("Code"), "Visual Studio Code");
        assert_eq!(app_name("WindowsTerminal"), "Windows Terminal");
        assert_eq!(app_name("Figma"), "Figma");
        assert_eq!(app_name(""), "");
    }

    #[test]
    fn only_browsers_have_their_address_read() {
        for b in ["chrome", "msedge", "Firefox", "brave", "vivaldi", "opera", "arc"] {
            assert!(is_browser(b), "{b}");
        }
        for other in ["code", "explorer", "slack", ""] {
            assert!(!is_browser(other), "{other}");
        }
    }

    #[test]
    fn an_address_is_kept_only_when_it_is_http_or_https() {
        assert_eq!(web_address("https://github.com/x?y=1").as_deref(), Some("https://github.com/x?y=1"));
        assert_eq!(web_address(" http://example.com ").as_deref(), Some("http://example.com"));
        // Chromium leaves the scheme out.
        assert_eq!(web_address("github.com/kura120/peika").as_deref(), Some("https://github.com/kura120/peika"));
        assert_eq!(web_address("docs.rs:443/serde").as_deref(), Some("https://docs.rs:443/serde"));
        assert_eq!(web_address("localhost:5173/app").as_deref(), Some("http://localhost:5173/app"));
        for not in [
            "", "   ", "chrome://settings", "edge://flags", "file:///C:/x.html", "about:blank",
            "how to cook rice", "peika", "javascript:alert(1)", ".com", "github.", "C:\\Users\\me",
        ] {
            assert_eq!(web_address(not), None, "{not}");
        }
    }

    #[test]
    fn the_event_names_its_fields_as_the_page_reads_them() {
        let with = WindowContext { app_name: "Firefox".into(), title: "Docs".into(), url: Some("https://a.b".into()) };
        assert_eq!(
            serde_json::to_value(&with).unwrap(),
            serde_json::json!({ "appName": "Firefox", "title": "Docs", "url": "https://a.b" })
        );
        let without = WindowContext { app_name: "Code".into(), title: "main.rs".into(), url: None };
        assert_eq!(serde_json::to_value(&without).unwrap(), serde_json::json!({ "appName": "Code", "title": "main.rs" }));
    }
}
