// Screen capture — port of the Mac's ScreenCapture.swift.
//
// The capture shortcut (Ctrl+Alt+X) copies the whole screen at once, then a
// see-through window over every monitor dims it and lets a part be dragged
// out (capture.html, src/capture/); Esc, a right click or a click without a
// drag cancels. The part is written as a PNG to Peika's own temp folder, and
// the island shows it on its capture card (src/island/capture.ts): paste it
// back into the window that was in front, copy it, open it in Paint to draw
// on it, or ask the chat about it.
//
// The rules:
// - Nothing is captured without the shortcut, and nothing leaves the machine
//   unless the user asks the chat about it.
// - The image stays in the temp folder only while the card has it: closing
//   the card deletes it, and whatever a crash left is deleted at the next start.
// - The commands only ever touch files in that folder.
//
// The overlay window is made on the first capture and closed again once
// unused for a while (issue #81: a window made after launch works when it asks
// for the island's browser arguments). The corners of the selection are read
// from the cursor, in physical pixels, so monitors with different scales
// cannot shift it; the page only draws the rectangle. Windows only: on Linux
// the shortcut stays reserved (shortcuts.rs).

#[cfg(windows)]
mod win;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::island::WINDOW_LABEL;

pub const LABEL: &str = "capture";
/// The widest the card's preview is drawn.
const THUMB_WIDTH: u32 = 320;
/// A drag shorter than this, either way, is a click: nothing is captured.
const SMALLEST: i32 = 4;

/// Pixels, top-down BGRA.
#[derive(Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

/// What a capture in progress holds: the screen as it was when the shortcut
/// was pressed, where it starts, where Paste goes back to, and where the
/// drag began.
struct Taking {
    screen: Frame,
    origin: (i32, i32),
    front: Option<isize>,
    from: Option<(i32, i32)>,
}

/// The capture on the card: its file and its pixels, for Copy and Paste.
struct OnCard {
    path: PathBuf,
    frame: Frame,
    front: Option<isize>,
}

static TAKING: Mutex<Option<Taking>> = Mutex::new(None);
static ON_CARD: Mutex<Option<OnCard>> = Mutex::new(None);

/// What the island's card receives as `capture-taken`.
#[derive(Serialize, Clone)]
struct Taken {
    path: String,
    width: u32,
    height: u32,
    thumb: String,
}

/// Peika's temp folder for captures.
pub fn dir() -> PathBuf {
    std::env::temp_dir().join("Peika").join("captures")
}

/// A capture file of ours, and nothing else: in `dir`, named as we name them.
fn ours(dir: &Path, path: &Path) -> bool {
    let named = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("capture-") && n.ends_with(".png") && !n.contains(".."));
    named && path.parent() == Some(dir)
}

/// The selection between two corners, inside a screen of `width` × `height`
/// that starts at `origin`: (x, y, width, height) in the screen's pixels, or
/// nothing when it is too small to be a drag.
pub fn selection(origin: (i32, i32), a: (i32, i32), b: (i32, i32), width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let clamp = |v: i32, max: u32| v.clamp(0, max as i32);
    let (ax, ay) = (clamp(a.0 - origin.0, width), clamp(a.1 - origin.1, height));
    let (bx, by) = (clamp(b.0 - origin.0, width), clamp(b.1 - origin.1, height));
    let (x, y) = (ax.min(bx), ay.min(by));
    let (w, h) = ((ax - bx).abs(), (ay - by).abs());
    (w >= SMALLEST && h >= SMALLEST).then_some((x as u32, y as u32, w as u32, h as u32))
}

/// The part of `frame` at (x, y), `width` × `height`, which must be inside it.
pub fn crop(frame: &Frame, x: u32, y: u32, width: u32, height: u32) -> Frame {
    let stride = frame.width as usize * 4;
    let mut bgra = Vec::with_capacity(width as usize * height as usize * 4);
    for row in y..y + height {
        let start = row as usize * stride + x as usize * 4;
        bgra.extend_from_slice(&frame.bgra[start..start + width as usize * 4]);
    }
    Frame { width, height, bgra }
}

/// `frame` at most `max` wide, each pixel the average of those it covers.
pub fn shrink(frame: &Frame, max: u32) -> Frame {
    if frame.width <= max {
        return frame.clone();
    }
    let width = max;
    let height = ((frame.height as u64 * max as u64) / frame.width as u64).max(1) as u32;
    let mut bgra = Vec::with_capacity(width as usize * height as usize * 4);
    for ty in 0..height {
        let (y0, y1) = span(ty, height, frame.height);
        for tx in 0..width {
            let (x0, x1) = span(tx, width, frame.width);
            let mut sum = [0u64; 4];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let at = (sy as usize * frame.width as usize + sx as usize) * 4;
                    for (c, total) in sum.iter_mut().enumerate() {
                        *total += frame.bgra[at + c] as u64;
                    }
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as u64;
            bgra.extend(sum.iter().map(|total| (total / n) as u8));
        }
    }
    Frame { width, height, bgra }
}

/// The source pixels target pixel `i` of `count` covers, out of `size`.
fn span(i: u32, count: u32, size: u32) -> (u32, u32) {
    let start = (i as u64 * size as u64 / count as u64) as u32;
    let end = (((i + 1) as u64 * size as u64).div_ceil(count as u64) as u32).clamp(start + 1, size);
    (start, end)
}

/// The rows of `frame` bottom first, as a DIB on the clipboard has them.
pub fn bottom_up(frame: &Frame) -> Vec<u8> {
    let stride = frame.width as usize * 4;
    frame.bgra.chunks(stride).rev().flatten().copied().collect()
}

/// Deletes what a capture left behind (a crash, a card never closed).
pub fn clear_leftovers() {
    let _ = std::fs::remove_dir_all(dir());
}

// ── The overlay window ────────────────────────────────────────────────────────

fn page_url<R: Runtime>(app: &AppHandle<R>) -> tauri::WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/capture.html");
        return tauri::WebviewUrl::External(base);
    }
    let _ = app;
    tauri::WebviewUrl::App("capture.html".into())
}

/// At launch: only what a crash left behind goes. The overlay itself is made on
/// the first capture, and closed again once unused for a while.
pub fn setup(_app: &AppHandle) {
    clear_leftovers();
}

/// How long the overlay stays made, hidden, after a capture: the next one is
/// instant, and an unused overlay costs nothing.
const OVERLAY_KEPT: std::time::Duration = std::time::Duration::from_secs(300);
/// Bumped by every capture, so only the last hide closes the overlay.
static OVERLAY_GENERATION: AtomicU64 = AtomicU64::new(0);

/// The overlay window: see-through, over everything, out of the taskbar.
#[cfg(windows)]
fn make_overlay<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    let built = tauri::WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Peika")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .disable_drag_drop_handler()
        .visible(false)
        .build();
    built.map_err(|err| crate::log::line(format!("capture window failed: {err}"))).ok()
}

/// The capture shortcut: the screen is copied now, then the overlay comes up
/// over all of it.
#[cfg(windows)]
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if TAKING.lock().unwrap().is_some() {
        return;
    }
    let front = win::front_window();
    let (left, top, width, height) = win::virtual_screen();
    let Some(screen) = win::grab(left, top, width, height) else {
        crate::log::line("capture: the screen could not be copied");
        return;
    };
    *TAKING.lock().unwrap() = Some(Taking { screen, origin: (left, top), front, from: None });
    OVERLAY_GENERATION.fetch_add(1, Ordering::SeqCst);
    // The overlay may have to be made: off the shortcut's handler, where
    // WebView2 would deadlock building a window.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(overlay) = app.get_webview_window(LABEL).or_else(|| make_overlay(&app)) else {
            TAKING.lock().unwrap().take();
            return;
        };
        let _ = overlay.set_position(tauri::PhysicalPosition::new(left, top));
        let _ = overlay.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
        let _ = overlay.show();
        let _ = overlay.set_focus();
        let _ = app.emit_to(LABEL, "capture-start", ());
    });
}

#[cfg(not(windows))]
pub fn start<R: Runtime>(_app: &AppHandle<R>) {}

fn hide_overlay(app: &AppHandle) {
    let Some(overlay) = app.get_webview_window(LABEL) else { return };
    let _ = overlay.hide();
    let generation = OVERLAY_GENERATION.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(OVERLAY_KEPT);
        if OVERLAY_GENERATION.load(Ordering::SeqCst) == generation && TAKING.lock().unwrap().is_none() {
            let _ = overlay.destroy();
        }
    });
}

/// The page saw the button go down: the drag starts where the cursor is.
#[tauri::command]
pub fn capture_from() {
    #[cfg(windows)]
    if let Some(taking) = TAKING.lock().unwrap().as_mut() {
        taking.from = win::cursor();
    }
}

/// Esc, a right click, or a click that was not a drag.
#[tauri::command]
pub fn capture_cancel(app: AppHandle) {
    TAKING.lock().unwrap().take();
    hide_overlay(&app);
}

/// The button came up: what lies between where the drag started and the
/// cursor goes to the card.
#[tauri::command]
pub async fn capture_select(app: AppHandle) -> Result<(), String> {
    let taking = TAKING.lock().unwrap().take();
    hide_overlay(&app);
    #[cfg(windows)]
    {
        let Some(taking) = taking else { return Ok(()) };
        let (Some(from), Some(to)) = (taking.from, win::cursor()) else { return Ok(()) };
        let screen = &taking.screen;
        let Some((x, y, w, h)) = selection(taking.origin, from, to, screen.width, screen.height) else {
            return Ok(());
        };
        let part = crop(screen, x, y, w, h);
        let taken = tauri::async_runtime::spawn_blocking(move || keep(part, taking.front))
            .await
            .map_err(|e| e.to_string())??;
        let _ = app.emit_to(WINDOW_LABEL, "capture-taken", taken);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (taking, app);
        Err("not on this system".into())
    }
}

/// Writes the part and its preview, and keeps it for the card.
#[cfg(windows)]
fn keep(part: Frame, front: Option<isize>) -> Result<Taken, String> {
    let folder = dir();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let path = folder.join(format!("capture-{stamp}.png"));
    win::write_png(&part, &path)?;
    // The preview goes through a file of its own, read back and deleted.
    let preview = folder.join(format!("preview-{stamp}.png"));
    let thumb = win::write_png(&shrink(&part, THUMB_WIDTH), &preview)
        .ok()
        .and_then(|_| std::fs::read(&preview).ok())
        .map(|bytes| format!("data:image/png;base64,{}", crate::claude::base64_for(&bytes)))
        .unwrap_or_default();
    let _ = std::fs::remove_file(&preview);
    let taken = Taken { path: path.to_string_lossy().into_owned(), width: part.width, height: part.height, thumb };
    *ON_CARD.lock().unwrap() = Some(OnCard { path, frame: part, front });
    Ok(taken)
}

// ── What the card does ────────────────────────────────────────────────────────

/// The capture on the card, if `path` is it.
fn on_card(path: &str) -> Result<(Frame, Option<isize>), String> {
    let path = PathBuf::from(path);
    if !ours(&dir(), &path) {
        return Err("not a capture".into());
    }
    let card = ON_CARD.lock().unwrap();
    match card.as_ref() {
        Some(c) if c.path == path => Ok((c.frame.clone(), c.front)),
        _ => Err("that capture is gone".into()),
    }
}

#[tauri::command]
pub async fn capture_copy(path: String) -> Result<(), String> {
    let (frame, _) = on_card(&path)?;
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || win::to_clipboard(&frame)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = frame;
        Err("not on this system".into())
    }
}

#[tauri::command]
pub async fn capture_paste(path: String) -> Result<(), String> {
    let (frame, front) = on_card(&path)?;
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        win::to_clipboard(&frame)?;
        win::paste_into(front)
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = (frame, front);
        Err("not on this system".into())
    }
}

/// Opens the capture in Paint, to draw on it.
#[tauri::command]
pub fn capture_open(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !ours(&dir(), &path) || !path.is_file() {
        return Err("not a capture".into());
    }
    let mut command = std::process::Command::new("mspaint.exe");
    command.arg(&path);
    crate::platform::no_console(&mut command).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The card is closed (or the capture was pasted): the file goes.
#[tauri::command]
pub fn capture_discard(path: String) {
    let path = PathBuf::from(path);
    if !ours(&dir(), &path) {
        return;
    }
    let _ = std::fs::remove_file(&path);
    let mut card = ON_CARD.lock().unwrap();
    if card.as_ref().is_some_and(|c| c.path == path) {
        *card = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32) -> Frame {
        // Each pixel's blue is its x, green its y.
        let mut bgra = Vec::new();
        for y in 0..height {
            for x in 0..width {
                bgra.extend_from_slice(&[x as u8, y as u8, 0, 255]);
            }
        }
        Frame { width, height, bgra }
    }

    #[test]
    fn a_selection_is_the_rectangle_between_the_corners_in_the_screen_s_pixels() {
        // A screen that starts left of the main monitor.
        let origin = (-1920, 0);
        assert_eq!(selection(origin, (-1900, 10), (-1800, 60), 3840, 1080), Some((20, 10, 100, 50)));
        // Dragged up and left: the same rectangle.
        assert_eq!(selection(origin, (-1800, 60), (-1900, 10), 3840, 1080), Some((20, 10, 100, 50)));
        // Past the edge: cut at the edge.
        assert_eq!(selection((0, 0), (1900, 1000), (2500, 1300), 1920, 1080), Some((1900, 1000, 20, 80)));
    }

    #[test]
    fn a_click_or_a_sliver_is_not_a_selection() {
        assert_eq!(selection((0, 0), (10, 10), (10, 10), 100, 100), None);
        assert_eq!(selection((0, 0), (10, 10), (13, 80), 100, 100), None);
        assert_eq!(selection((0, 0), (10, 10), (80, 12), 100, 100), None);
    }

    #[test]
    fn crop_takes_exactly_the_part() {
        let part = crop(&frame(10, 8), 2, 3, 4, 2);
        assert_eq!((part.width, part.height), (4, 2));
        assert_eq!(&part.bgra[..4], &[2, 3, 0, 255]);
        assert_eq!(&part.bgra[part.bgra.len() - 4..], &[5, 4, 0, 255]);
    }

    #[test]
    fn the_preview_is_shrunk_to_its_width_keeping_the_shape() {
        let small = frame(100, 50);
        assert_eq!(shrink(&small, 320).width, 100, "smaller ones stay as they are");
        let big = shrink(&frame(640, 200), 320);
        assert_eq!((big.width, big.height), (320, 100));
        assert_eq!(big.bgra.len(), 320 * 100 * 4);
        // Pixels 0 and 1 averaged: blue 0.5 → 0, and the last one near 639.
        assert_eq!(big.bgra[0], 0);
        assert!(big.bgra[(319 * 4) as usize] >= 126, "blue wraps at 256: 638, 639 → 126, 127");
        let tall = shrink(&frame(1000, 3), 320);
        assert_eq!((tall.width, tall.height), (320, 1));
    }

    #[test]
    fn the_clipboard_gets_the_rows_bottom_first() {
        let f = frame(2, 3);
        let rows = bottom_up(&f);
        assert_eq!(&rows[..4], &[0, 2, 0, 255]);
        assert_eq!(&rows[rows.len() - 4..], &[1, 0, 0, 255]);
    }

    /// The real screen and Windows' own PNG codec: copies a corner of this
    /// screen and writes it. The clipboard is left alone.
    /// `cargo test -p peika capture -- --ignored`
    #[cfg(windows)]
    #[test]
    #[ignore = "reads this machine's screen"]
    fn the_screen_is_copied_and_written_as_a_png() {
        let (left, top, width, height) = win::virtual_screen();
        assert!(width > 0 && height > 0);
        let screen = win::grab(left, top, width, height).expect("the screen");
        assert_eq!(screen.bgra.len(), width as usize * height as usize * 4);
        let part = crop(&screen, 0, 0, 200.min(screen.width), 100.min(screen.height));
        let path = std::env::temp_dir().join(format!("peika-capture-test-{}.png", std::process::id()));
        win::write_png(&shrink(&part, 120), &path).expect("png");
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn only_capture_files_in_peika_s_folder_are_touched() {
        let d = dir();
        assert!(ours(&d, &d.join("capture-1792641600000.png")));
        for not in [
            d.join("preview-1.png"),
            d.join("capture-1.txt"),
            d.join("sub").join("capture-1.png"),
            std::env::temp_dir().join("capture-1.png"),
            PathBuf::from(r"C:\Windows\capture-1.png"),
        ] {
            assert!(!ours(&d, &not), "{}", not.display());
        }
    }
}
