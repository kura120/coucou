// Flow dictation on Windows, the parts that talk to the system: the key,
// through a low-level keyboard hook; the Ctrl+V, through SendInput; and the
// window in front.
//
// The hook only watches. It never swallows a key (every event goes on to
// CallNextHookEx), keeps no record of any key, and reports four things and
// nothing more:
//   - the chosen key going down and up;
//   - Esc, but only while a dictation is under way;
//   - "another key", without saying which, but only while a dictation is
//     under way (a shortcut such as Ctrl+C cancels it).
// It is installed only while Flow is on, on a thread of its own that sleeps in
// GetMessageW, so it costs nothing while nothing is typed.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ::windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, IsWindow,
    PostThreadMessageW, SetForegroundWindow, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
    LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use super::logic::FlowKey;
use super::KeyEvent;

const VK_ESCAPE: u32 = 0x1B;
const VK_V: u16 = 0x56;
const VK_CONTROL: u16 = 0x11;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_RCONTROL: u32 = 0xA3;
const VK_RMENU: u32 = 0xA5;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_CAPITAL: u32 = 0x14;

/// Modifier keys never count as "another key": pressing Ctrl then Shift is
/// not a shortcut with a letter, and AltGr even sends a fake left Ctrl with
/// every right Alt.
fn is_modifier(vk: u32) -> bool {
    matches!(vk, 0x10 | 0x11 | 0x12 | VK_LSHIFT..=VK_RMENU | VK_LWIN | VK_RWIN | VK_CAPITAL)
}

/// Where the hook reports to; the callback only hands the event to the
/// controller's thread, so the hook returns at once (Windows drops a hook that
/// is slow).
pub type Sink = Box<dyn Fn(KeyEvent, Instant) + Send + Sync>;

static SINK: Mutex<Option<Sink>> = Mutex::new(None);
static KEY: AtomicU8 = AtomicU8::new(0);
/// A dictation is under way: only then are Esc and other keys reported.
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn key_code(key: FlowKey) -> u8 {
    match key {
        FlowKey::RightCtrl => 0,
        FlowKey::RightAlt => 1,
        FlowKey::RightShift => 2,
    }
}

fn key_vk(key: FlowKey) -> u32 {
    match key {
        FlowKey::RightCtrl => VK_RCONTROL,
        FlowKey::RightAlt => VK_RMENU,
        FlowKey::RightShift => VK_RSHIFT,
    }
}

/// The key to watch for, changed without reinstalling the hook.
pub fn set_key(key: FlowKey) {
    KEY.store(key_code(key), Ordering::Relaxed);
}

/// Whether a dictation is under way, from the controller.
pub fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::Relaxed);
}

fn send(event: KeyEvent) {
    if let Some(sink) = SINK.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        sink(event, Instant::now());
    }
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        // Our own Ctrl+V, and other programs' synthetic keys, are not the user's.
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
            on_key(info.vkCode, down, up);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn on_key(vk: u32, down: bool, up: bool) {
    let ours = match KEY.load(Ordering::Relaxed) {
        0 => vk == VK_RCONTROL,
        1 => vk == VK_RMENU,
        _ => vk == VK_RSHIFT,
    };
    if ours {
        if down {
            send(KeyEvent::Down);
        } else if up {
            send(KeyEvent::Up);
        }
        return;
    }
    if !down || !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    if vk == VK_ESCAPE {
        send(KeyEvent::Escape);
    } else if !is_modifier(vk) {
        send(KeyEvent::Other);
    }
}

/// The hook's thread; it ends when dropped.
pub struct KeyListener {
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for KeyListener {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        *SINK.lock().unwrap_or_else(|e| e.into_inner()) = None;
        ACTIVE.store(false, Ordering::Relaxed);
    }
}

pub fn listen(key: FlowKey, sink: Sink) -> Result<KeyListener, String> {
    set_key(key);
    ACTIVE.store(false, Ordering::Relaxed);
    *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32, String>>();
    let thread = std::thread::Builder::new()
        .name("peika-flow-keys".into())
        .spawn(move || unsafe {
            let module = GetModuleHandleW(None).ok();
            let handle = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module.map(Into::into), 0) {
                Ok(h) => h,
                Err(err) => {
                    let _ = ready_tx.send(Err(err.to_string()));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWindowsHookEx(handle);
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(thread_id)) => Ok(KeyListener { thread_id, thread: Some(thread) }),
        Ok(Err(err)) => {
            *SINK.lock().unwrap_or_else(|e| e.into_inner()) = None;
            Err(err)
        }
        Err(_) => {
            *SINK.lock().unwrap_or_else(|e| e.into_inner()) = None;
            Err("the keyboard hook did not start".into())
        }
    }
}

/// Waits (up to a second) until the dictation key is up, so the paste is a
/// plain Ctrl+V and not Ctrl+Alt+V or Ctrl+Shift+V.
pub fn wait_key_released(key: FlowKey) {
    let vk = key_vk(key) as i32;
    let until = Instant::now() + Duration::from_secs(1);
    while Instant::now() < until {
        let state = unsafe { GetAsyncKeyState(vk) } as u16;
        if state & 0x8000 == 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn key_input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                ..Default::default()
            },
        },
    }
}

/// Ctrl+V in the window in front. An error when Windows took fewer keystrokes
/// than were sent.
pub fn send_paste() -> Result<(), String> {
    let keys = [key_input(VK_CONTROL, false), key_input(VK_V, false), key_input(VK_V, true), key_input(VK_CONTROL, true)];
    let sent = unsafe { SendInput(&keys, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == keys.len() {
        Ok(())
    } else {
        Err(format!("Windows took {sent} of {} keystrokes", keys.len()))
    }
}

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

fn process_of(window: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid as *mut u32)) };
    pid
}

/// The window in front now.
pub fn foreground() -> Option<isize> {
    let window = unsafe { GetForegroundWindow() };
    (!window.0.is_null()).then_some(window.0 as isize)
}

/// The window in front, unless it is Peika's own: where the words go back to.
pub fn front_window() -> Option<isize> {
    foreground().filter(|raw| process_of(hwnd(*raw)) != std::process::id())
}

/// Brings `raw` to the front if it is still there and was not already.
/// Whether it is in front afterwards.
pub fn bring_to_front(raw: isize) -> bool {
    if foreground() == Some(raw) {
        return true;
    }
    unsafe {
        if !IsWindow(Some(hwnd(raw))).as_bool() {
            return false;
        }
        // Windows may refuse to a program that is not the one being typed in.
        let _ = SetForegroundWindow(hwnd(raw));
    }
    // Let it take the keyboard before the keys arrive.
    std::thread::sleep(Duration::from_millis(120));
    foreground() == Some(raw)
}

/// Whether the process at `pid` runs elevated. None when that cannot be told:
/// a program without elevation is refused the token of an elevated one, which
/// is itself the answer.
fn elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut info = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let read = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut info as *mut TOKEN_ELEVATION as *mut c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        read.ok()?;
        Some(info.TokenIsElevated != 0)
    }
}

fn we_are_elevated() -> bool {
    static ELEVATED: OnceLock<bool> = OnceLock::new();
    *ELEVATED.get_or_init(|| elevated(unsafe { GetCurrentProcess() }).unwrap_or(false))
}

/// Whether Windows will drop the keystrokes sent to `raw` (UIPI): it belongs to
/// an elevated program and Peika is not one. Said before sending, since
/// SendInput does not always say so afterwards.
pub fn refuses_input(raw: isize) -> bool {
    if we_are_elevated() {
        return false;
    }
    let pid = process_of(hwnd(raw));
    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            // Even this much is refused: a program above us.
            return true;
        };
        // No token to read is what an elevated program looks like from here.
        let refused = elevated(process).unwrap_or(true);
        let _ = CloseHandle(process);
        refused
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_are_not_another_key() {
        for vk in [0x10, 0x11, 0x12, VK_LSHIFT, VK_RSHIFT, 0xA2, VK_RCONTROL, 0xA4, VK_RMENU, VK_LWIN, VK_RWIN, VK_CAPITAL] {
            assert!(is_modifier(vk), "{vk:#x}");
        }
        for vk in [0x41, 0x43, 0x20, 0x0D, 0x70] {
            assert!(!is_modifier(vk), "{vk:#x}");
        }
    }

    #[test]
    fn the_key_codes_are_the_keys_virtual_codes() {
        assert_eq!(key_vk(FlowKey::RightCtrl), 0xA3);
        assert_eq!(key_vk(FlowKey::RightAlt), 0xA5);
        assert_eq!(key_vk(FlowKey::RightShift), 0xA1);
    }

    /// What the hook reports for a run of keys, as the events it sent.
    fn reported(key: FlowKey, active: bool, keys: &[(u32, bool)]) -> Vec<KeyEvent> {
        use std::sync::{Arc, Mutex};
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        *SINK.lock().unwrap() = Some(Box::new(move |event, _| sink.lock().unwrap().push(event)));
        set_key(key);
        set_active(active);
        for (vk, down) in keys {
            on_key(*vk, *down, !*down);
        }
        *SINK.lock().unwrap() = None;
        set_active(false);
        let out = seen.lock().unwrap().clone();
        out
    }

    // One test, since the hook's state is shared by the whole process.
    #[test]
    fn the_hook_reports_the_chosen_key_and_little_else() {
        use KeyEvent::*;
        // The chosen key, down and up, whether or not a dictation is under way.
        let ctrl = [(VK_RCONTROL, true), (VK_RCONTROL, false)];
        assert_eq!(reported(FlowKey::RightCtrl, false, &ctrl), vec![Down, Up]);
        // Not the other keys of the choice, nor the left Ctrl.
        assert!(reported(FlowKey::RightCtrl, true, &[(VK_RMENU, true), (VK_RSHIFT, true), (0xA2, true)]).is_empty());
        assert_eq!(reported(FlowKey::RightAlt, false, &[(VK_RMENU, true), (VK_RMENU, false)]), vec![Down, Up]);
        assert_eq!(reported(FlowKey::RightShift, false, &[(VK_RSHIFT, true), (VK_RSHIFT, false)]), vec![Down, Up]);
        // With nothing under way, no other key is reported: not Esc, not a letter.
        assert!(reported(FlowKey::RightCtrl, false, &[(VK_ESCAPE, true), (0x41, true), (0x20, true)]).is_empty());
        // Under way: Esc, and "another key" without saying which; modifiers and
        // releases of other keys are not.
        let typed = [(VK_ESCAPE, true), (0x43, true), (0x43, false), (VK_LSHIFT, true), (0xA2, true)];
        assert_eq!(reported(FlowKey::RightCtrl, true, &typed), vec![Escape, Other]);
        // AltGr sends a fake left Ctrl with every right Alt: not a shortcut.
        assert!(reported(FlowKey::RightAlt, true, &[(0xA2, true), (VK_RMENU, true)]) == vec![Down]);
        // The real hook installs on its thread, and leaves with the listener.
        let listener = listen(FlowKey::RightCtrl, Box::new(|_, _| {})).expect("the keyboard hook installs");
        assert!(SINK.lock().unwrap().is_some());
        drop(listener);
        assert!(SINK.lock().unwrap().is_none(), "nothing is left reporting once the listener is gone");
    }

    #[test]
    fn this_process_can_tell_whether_it_is_elevated() {
        // Either answer is right; asking must not fail or hang.
        let _ = we_are_elevated();
    }

    #[test]
    fn our_own_window_is_not_refused() {
        // The test process owns no window in front; a window of this process is
        // never above it. The process id is read without a window.
        assert_eq!(process_of(hwnd(0)), 0);
        assert!(!refuses_input(0));
    }
}
