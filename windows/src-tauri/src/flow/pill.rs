// The Flow pill: a small window at the bottom centre of the display the cursor
// is on, with Peika, the level of the voice, and a line for whatever needs
// saying ("copied: press Ctrl+V"). It takes no focus, since the words must go
// to the window the user is typing in; it is not in the taskbar; it is
// see-through.
//
// It is made, off the event loop, when Flow is switched on (a window made
// inside a synchronous handler deadlocks WebView2; it asks for the island's
// browser arguments, as a window made after launch must: issue #81), and
// destroyed when Flow is switched off. Between dictations it is out of sight:
// parked off screen, as the toasts' window is, because showing a hidden window
// again may take the keyboard focus from what the user is typing in. The page
// draws only while it has something to show, so a parked pill costs nothing.
//
// What the page shows is one state, kept here so a page that loads late asks
// for it (`flow_pill_state`): "listening", "locked" (hands-free: ✕ and ✓),
// "working" (the words are being written down), "message" (with a code the
// page puts in words), or "hidden".

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "pill";

/// The window's size, logical pixels; the page's card sits at its bottom.
const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 112.0;
/// Kept between the card and the bottom of the work area.
const MARGIN: f64 = 14.0;
/// How long a message stays up.
const MESSAGE_FOR: Duration = Duration::from_millis(4500);
/// How long the page gets to fade out before the window leaves.
const FADE: Duration = Duration::from_millis(260);

/// Parked off screen rather than hidden, for the toasts' reason (toast.rs).
const PARK: bool = cfg!(windows);
const PARKED: (i32, i32) = (-32000, -32000);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PillState {
    pub state: &'static str,
    /// The dictation the level events are about (`dictation` events carry it).
    pub id: u64,
    /// For "message": a code the page puts in words, or the reason itself.
    pub message: String,
    /// For "message": more, when there is more.
    pub detail: String,
}

impl PillState {
    fn hidden() -> Self {
        Self { state: "hidden", id: 0, message: String::new(), detail: String::new() }
    }
}

static CURRENT: Mutex<Option<PillState>> = Mutex::new(None);
/// Bumped by every change, so a late hide never hides what came after it.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn current() -> PillState {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(PillState::hidden)
}

/// What the page asks for when it loads.
pub fn state() -> PillState {
    current()
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/pill.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("pill.html".into())
}

/// The window, made if it is not there. Call it off the event loop.
pub fn ensure(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(existing) = window(app) {
        return Some(existing);
    }
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Peika")
        .inner_size(WIDTH, HEIGHT)
        .resizable(cfg!(target_os = "linux"))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .focusable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .visible(PARK);
    if PARK {
        builder = builder.position(PARKED.0 as f64, PARKED.1 as f64);
    }
    match builder.build() {
        Ok(win) => {
            #[cfg(windows)]
            crate::platform::make_non_activating(&win);
            // Something may have been asked of it while it was being made.
            if current().state != "hidden" {
                place(app, &win);
            }
            Some(win)
        }
        Err(err) => {
            crate::log::line(format!("flow pill window failed: {err}"));
            None
        }
    }
}

/// Takes the window away for good (Flow was switched off).
pub fn destroy(app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Some(win) = window(app) {
        let _ = win.destroy();
    }
}

/// Where the card goes: bottom centre of a work area, `scale` physical pixels
/// to a logical one. (x, y, width, height), physical.
pub fn bottom_centre(work: (i32, i32, u32, u32), scale: f64) -> (i32, i32, u32, u32) {
    let (left, top, width, height) = work;
    let w = (WIDTH * scale).round() as u32;
    let h = (HEIGHT * scale).round() as u32;
    let x = left + (width as i32 - w as i32) / 2;
    let y = top + height as i32 - h as i32 - (MARGIN * scale).round() as i32;
    (x, y, w, h)
}

/// The display the cursor is on, else the main one: (work area, scale).
fn display(app: &AppHandle) -> Option<((i32, i32, u32, u32), f64)> {
    let at = app.cursor_position().ok();
    let monitor = at
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let work = monitor.work_area();
    Some(((work.position.x, work.position.y, work.size.width, work.size.height), monitor.scale_factor()))
}

fn place(app: &AppHandle, win: &WebviewWindow) {
    let Some((work, scale)) = display(app) else { return };
    let (x, y, w, h) = bottom_centre(work, scale);
    // Moved first: Windows rescales a window that changes display.
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(w, h));
    if !PARK {
        let _ = win.show();
    }
    let _ = win.set_always_on_top(true);
}

fn park(win: &WebviewWindow) {
    if PARK {
        let _ = win.set_position(PhysicalPosition::new(PARKED.0, PARKED.1));
    } else {
        let _ = win.hide();
    }
}

fn set(app: &AppHandle, next: PillState) {
    let was_hidden = current().state == "hidden";
    GENERATION.fetch_add(1, Ordering::SeqCst);
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(next.clone());
    if let Some(win) = window(app) {
        // Placed where the cursor's display is each time it comes up.
        if was_hidden && next.state != "hidden" {
            place(app, &win);
        }
        let _ = app.emit_to(LABEL, "flow-pill", next);
    }
}

/// Shows the pill in `state` ("listening", "locked" or "working").
pub fn show(app: &AppHandle, state: &'static str, id: u64) {
    set(app, PillState { state, id, message: String::new(), detail: String::new() });
}

/// Says something for a few seconds, then goes.
pub fn message(app: &AppHandle, code: &str, detail: &str) {
    set(
        app,
        PillState { state: "message", id: 0, message: code.to_string(), detail: detail.to_string() },
    );
    let generation = GENERATION.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(MESSAGE_FOR);
        if GENERATION.load(Ordering::SeqCst) == generation {
            hide(&app);
        }
    });
}

/// The page fades out; the window leaves once it has.
pub fn hide(app: &AppHandle) {
    if current().state == "hidden" {
        return;
    }
    set(app, PillState::hidden());
    let generation = GENERATION.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FADE);
        if GENERATION.load(Ordering::SeqCst) == generation {
            if let Some(win) = window(&app) {
                park(&win);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_sits_at_the_bottom_centre_of_the_work_area() {
        // 1920 x 1040 work area (a taskbar below), 100 %.
        let (x, y, w, h) = bottom_centre((0, 0, 1920, 1040), 1.0);
        assert_eq!((w, h), (WIDTH as u32, HEIGHT as u32));
        assert_eq!(x, (1920 - WIDTH as i32) / 2);
        assert_eq!(y, 1040 - HEIGHT as i32 - MARGIN as i32);
    }

    #[test]
    fn it_follows_the_display_and_its_scale() {
        // A second display to the left of the first, at 150 %.
        let (x, y, w, h) = bottom_centre((-2560, 0, 2560, 1400), 1.5);
        assert_eq!(w, 510);
        assert_eq!(h, 168);
        assert_eq!(x, -2560 + (2560 - 510) / 2);
        assert_eq!(y, 1400 - 168 - 21);
        // Wholly inside the work area.
        assert!(x >= -2560 && x + w as i32 <= 0 && y >= 0 && y + h as i32 <= 1400);
    }

    #[test]
    fn a_display_narrower_than_the_card_does_not_wrap() {
        let (x, _, w, _) = bottom_centre((0, 0, 200, 400), 1.0);
        assert!(w > 200);
        assert_eq!(x, (200 - w as i32) / 2);
    }
}
