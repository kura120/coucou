// Toasts: short notes in the top-right corner of the island's display, and
// Yes/No decisions with a keyboard shortcut on each button.
//
// One call from anywhere shows one:
//
//   toast::warn(&app, title, text);                         // a warning, nothing more
//   toast::show(&app, Toast::new(Kind::Info, title).text(text).pill("ai_ollama"));
//   let answer = toast::ask(&app, Toast::new(Kind::Warning, title).decision()).await;
//
// and a page does the same through `toast_show` / `toast_ask` (src/toast/api.ts).
// A decision's answer goes back to whoever asked; the toast knows nothing about
// who that is.
//
// A toast NEVER approves a Claude Code or Codex permission and never sends an
// email: those need a click on their own card in the island (CLAUDE.md). This
// file has no way to reach either — keep it that way; a caller may ask a
// question here and do something with the answer, but not those.
//
// The toasts live in their own window, made once at launch before the island's
// webview (WebView2 brings a later window up blank: see create_settings_window)
// and shown only while a toast is on screen. The stack itself — what is shown,
// for how long, the animations — is the page's (src/toast/stack.ts); this file
// owns the window, the answers, and the decision shortcuts:
//   * Windows and X11: Shift+Y / Shift+N, registered while a decision is on
//     screen and released with it;
//   * Wayland: the same keys asked of the desktop's GlobalShortcuts portal, on
//     a session of their own, closed with the last decision;
//   * nowhere else: the buttons only.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcut, Modifiers, Shortcut};
use tokio::sync::oneshot;

use crate::island;
use crate::platform::{self, DesktopMode};

pub const LABEL: &str = "toast";

/// Width of the window and of every toast, logical pixels (toast.css).
pub const WIDTH: f64 = 340.0;
/// Kept between the toasts and the top and right edges of the work area.
const MARGIN: f64 = 12.0;
/// The tallest the page may ask for: three toasts with their longest text.
const MAX_HEIGHT: f64 = 720.0;

/// Windows parks the window off-screen instead of hiding it, for the reason
/// desktop.rs gives: showing a hidden window again may take the keyboard focus
/// from what the user is typing in. A window created visible and only moved
/// never does.
const PARK: bool = cfg!(windows);
const PARKED: (i32, i32) = (-32000, -32000);

// ── Decision keys ─────────────────────────────────────────────────────────────
//
// The one place they are chosen. Held only while a decision is on screen —
// but while they are, Shift+Y no longer types a capital Y in other apps.
// Ctrl+Shift+Y / Ctrl+Shift+N would leave typing alone, at the cost of a
// three-key press.

const YES_KEY: (Modifiers, Code) = (Modifiers::SHIFT, Code::KeyY);
const NO_KEY: (Modifiers, Code) = (Modifiers::SHIFT, Code::KeyN);
/// What the buttons show; in step with the keys above.
const YES_LABEL: &str = "Shift+Y";
const NO_LABEL: &str = "Shift+N";
/// Wayland: the keys as the XDG shortcuts spec writes them.
#[cfg(target_os = "linux")]
const YES_TRIGGER: &str = "SHIFT+y";
#[cfg(target_os = "linux")]
const NO_TRIGGER: &str = "SHIFT+n";
/// Ids the portal files the two shortcuts under.
#[cfg(target_os = "linux")]
const YES_ID: &str = "toastYes";
#[cfg(target_os = "linux")]
const NO_ID: &str = "toastNo";

fn yes_shortcut() -> Shortcut {
    Shortcut::new(Some(YES_KEY.0), YES_KEY.1)
}

fn no_shortcut() -> Shortcut {
    Shortcut::new(Some(NO_KEY.0), NO_KEY.1)
}

// ── What a toast is ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Info,
    Success,
    Warning,
    Error,
}

/// Yes and No buttons. A label left out is the toast's own "Yes" / "No".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Actions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no: Option<String>,
}

/// One toast — the same shape the page knows (`ToastSpec` in src/toast/stack.ts).
/// Texts are shown as given: a caller passes them already translated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    /// Empty: one is made up. A toast with the id of one still on screen
    /// replaces it in place.
    #[serde(default)]
    pub id: String,
    pub kind: Kind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// A pill ID: the toast takes that pill's colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pill: Option<String>,
    /// Life on screen; left out, the kind's default (a decision then waits
    /// for its answer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Actions>,
}

impl Toast {
    pub fn new(kind: Kind, title: impl Into<String>) -> Self {
        Self { id: String::new(), kind, title: title.into(), text: None, pill: None, duration_ms: None, actions: None }
    }

    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn pill(mut self, pill: impl Into<String>) -> Self {
        self.pill = Some(pill.into());
        self
    }

    pub fn duration_ms(mut self, ms: u64) -> Self {
        self.duration_ms = Some(ms);
        self
    }

    /// Yes and No buttons, with their shortcuts.
    pub fn decision(mut self) -> Self {
        self.actions = Some(Actions::default());
        self
    }

    /// Yes and No buttons under labels of the caller's.
    pub fn decision_labeled(mut self, yes: impl Into<String>, no: impl Into<String>) -> Self {
        self.actions = Some(Actions { yes: Some(yes.into()), no: Some(no.into()) });
        self
    }
}

/// How a toast ended. Anything but a click on Yes or No — its time ran out,
/// it was closed, replaced, or could not be shown — is `Dismissed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Yes,
    No,
    Dismissed,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Inner {
    /// The page listens: toasts go straight to it.
    ready: bool,
    /// Shown before the page was listening.
    backlog: Vec<Toast>,
    /// Callers waiting for an answer, by toast id.
    waiting: HashMap<String, oneshot::Sender<Answer>>,
    /// The window is on screen (placed, not parked).
    shown: bool,
    /// The decision keys are ours.
    keys_held: bool,
}

pub struct Toasts {
    mode: DesktopMode,
    inner: Mutex<Inner>,
    next: AtomicU64,
    #[cfg(target_os = "linux")]
    portal: Mutex<wayland::Link>,
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Made at launch, before the island's webview (see the top of this file).
pub fn setup(app: &AppHandle) {
    let mode = platform::desktop_mode();
    match create_window(app) {
        Some(win) if platform::prepare_toast_window(&win, mode, MARGIN) => {}
        Some(win) => {
            let _ = win.destroy();
        }
        None => {}
    }
    crate::log::line(format!(
        "toasts: {}",
        if window(app).is_some() { mode.as_str() } else { "no window" }
    ));
    app.manage(Arc::new(Toasts {
        mode,
        inner: Mutex::new(Inner::default()),
        next: AtomicU64::new(0),
        #[cfg(target_os = "linux")]
        portal: Mutex::new(wayland::Link::default()),
    }));
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/toast.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("toast.html".into())
}

fn create_window(app: &AppHandle) -> Option<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Coucou")
        .inner_size(WIDTH, 1.0)
        // GTK won't size a non-resizable window below its natural size (see
        // island::apply_geometry). Windows would grow resize borders instead.
        .resizable(cfg!(target_os = "linux"))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .focusable(false)
        .visible(PARK);
    if PARK {
        builder = builder.position(PARKED.0 as f64, PARKED.1 as f64);
    }
    match builder.build() {
        Ok(win) => Some(win),
        Err(err) => {
            crate::log::line(format!("toast window failed: {err}"));
            None
        }
    }
}

// ── Showing toasts ────────────────────────────────────────────────────────────

/// Shows a toast and returns its id. Never waits.
pub fn show(app: &AppHandle, mut toast: Toast) -> String {
    let Some(toasts) = app.try_state::<Arc<Toasts>>() else { return toast.id };
    if toast.id.trim().is_empty() {
        toast.id = format!("toast-{}", toasts.next.fetch_add(1, Ordering::Relaxed) + 1);
    }
    let id = toast.id.clone();
    if window(app).is_none() {
        // Nowhere to show it: whoever waits hears so at once.
        settle(&toasts, &id, Answer::Dismissed);
        return id;
    }
    let mut inner = toasts.inner.lock().unwrap();
    if inner.ready {
        drop(inner);
        let _ = app.emit_to(LABEL, "toast-push", &toast);
    } else {
        inner.backlog.push(toast);
    }
    id
}

/// A warning toast in one call: `title`, and `text` when there is one.
pub fn warn(app: &AppHandle, title: impl Into<String>, text: Option<String>) -> String {
    let mut toast = Toast::new(Kind::Warning, title);
    toast.text = text.filter(|t| !t.trim().is_empty());
    show(app, toast)
}

/// Shows `toast` and waits for how it ends. Give it `.decision()` for Yes/No;
/// anything else ends `Dismissed`.
pub async fn ask(app: &AppHandle, mut toast: Toast) -> Answer {
    let Some(toasts) = app.try_state::<Arc<Toasts>>() else { return Answer::Dismissed };
    if toast.id.trim().is_empty() {
        toast.id = format!("toast-{}", toasts.next.fetch_add(1, Ordering::Relaxed) + 1);
    }
    let (tx, rx) = oneshot::channel();
    // A question asked again under the same id: the first asker is let go.
    if let Some(old) = toasts.inner.lock().unwrap().waiting.insert(toast.id.clone(), tx) {
        let _ = old.send(Answer::Dismissed);
    }
    show(app, toast);
    rx.await.unwrap_or(Answer::Dismissed)
}

/// Takes a toast back before it ends by itself (a question that no longer
/// stands). Its asker hears `Dismissed`.
pub fn dismiss(app: &AppHandle, id: &str) {
    let Some(toasts) = app.try_state::<Arc<Toasts>>() else { return };
    let removed = {
        let mut inner = toasts.inner.lock().unwrap();
        let before = inner.backlog.len();
        inner.backlog.retain(|t| t.id != id);
        before != inner.backlog.len()
    };
    if removed {
        settle(&toasts, id, Answer::Dismissed);
    } else {
        let _ = app.emit_to(LABEL, "toast-dismiss", id.to_string());
    }
}

fn settle(toasts: &Toasts, id: &str, answer: Answer) {
    if let Some(tx) = toasts.inner.lock().unwrap().waiting.remove(id) {
        let _ = tx.send(answer);
    }
}

// ── The window ────────────────────────────────────────────────────────────────

/// Puts the window in the top-right corner of the work area of the island's
/// display, `height` logical pixels tall; 0 takes it off screen.
fn layout(app: &AppHandle, toasts: &Toasts, height: f64) {
    let Some(win) = window(app) else { return };
    if height <= 0.0 {
        let was_shown = std::mem::replace(&mut toasts.inner.lock().unwrap().shown, false);
        if !was_shown {
            return;
        }
        if PARK {
            let _ = win.set_position(PhysicalPosition::new(PARKED.0, PARKED.1));
        } else {
            let _ = win.hide();
        }
        return;
    }
    let height = height.min(MAX_HEIGHT);
    let appearing = !toasts.inner.lock().unwrap().shown;
    match toasts.mode {
        DesktopMode::Layer => {
            // Anchored to the corner (platform::prepare_toast_window): only the
            // display it is on and its size change. The display only as it
            // appears — setting it remaps a surface already on screen.
            if appearing {
                if let Some(island) = island::window(app) {
                    let w = win.clone();
                    let _ = app.run_on_main_thread(move || {
                        platform::layer_display(&island, &w);
                    });
                }
            }
            let _ = win.set_size(tauri::LogicalSize::new(WIDTH, height));
        }
        _ => {
            if let Some((x, y, scale)) = corner(app) {
                let size = PhysicalSize::new((WIDTH * scale).round() as u32, (height * scale).round() as u32);
                let pos = PhysicalPosition::new((x - WIDTH * scale).round() as i32, y.round() as i32);
                // Moved first: Windows rescales a window that changes display.
                let _ = win.set_position(pos);
                let _ = win.set_size(size);
            } else {
                let _ = win.set_size(tauri::LogicalSize::new(WIDTH, height));
            }
        }
    }
    toasts.inner.lock().unwrap().shown = true;
    if appearing {
        if !PARK {
            let _ = win.show();
        }
        let _ = win.set_always_on_top(true);
    }
}

/// Top-right corner of the island's work area, inside the margin: (right
/// edge, top edge, scale), physical pixels.
fn corner(app: &AppHandle) -> Option<(f64, f64, f64)> {
    let island = island::window(app)?;
    let monitor = island.current_monitor().ok().flatten().or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let right = work.position.x as f64 + work.size.width as f64 - MARGIN * scale;
    let top = work.position.y as f64 + MARGIN * scale;
    Some((right, top, scale))
}

// ── Decision keys ─────────────────────────────────────────────────────────────

/// What the buttons show next to Yes and No; none where no key can be held.
#[derive(Serialize, Clone)]
pub struct KeyLabels {
    yes: &'static str,
    no: &'static str,
}

fn key_labels() -> Option<KeyLabels> {
    match platform::global_shortcuts_blocked() {
        None => Some(KeyLabels { yes: YES_LABEL, no: NO_LABEL }),
        #[cfg(target_os = "linux")]
        Some("wayland") => Some(KeyLabels { yes: YES_LABEL, no: NO_LABEL }),
        _ => None,
    }
}

/// Takes the decision keys (`on`) or gives them back.
fn hold_keys(app: &AppHandle, toasts: &Toasts, on: bool) {
    {
        let mut inner = toasts.inner.lock().unwrap();
        if inner.keys_held == on {
            return;
        }
        inner.keys_held = on;
    }
    match platform::global_shortcuts_blocked() {
        None => grab(app, on),
        #[cfg(target_os = "linux")]
        Some("wayland") => wayland::hold(app, toasts, on),
        _ => {}
    }
}

/// Windows and X11: registers or unregisters the two keys.
fn grab<R: Runtime>(app: &AppHandle<R>, on: bool) {
    let Some(gs) = app.try_state::<GlobalShortcut<R>>() else { return };
    for shortcut in [yes_shortcut(), no_shortcut()] {
        let result = if on { gs.register(shortcut) } else { gs.unregister(shortcut) };
        if let Err(err) = result {
            crate::log::line(format!("toasts: {} {shortcut}: {err}", if on { "register" } else { "unregister" }));
        }
    }
}

/// shortcuts::apply lets go of every key it finds registered, ours included:
/// it calls this afterwards to take the decision keys back if a decision is
/// still on screen.
pub fn reclaim_keys<R: Runtime>(app: &AppHandle<R>) {
    let Some(toasts) = app.try_state::<Arc<Toasts>>() else { return };
    if toasts.inner.lock().unwrap().keys_held && platform::global_shortcuts_blocked().is_none() {
        grab(app, true);
    }
}

/// A key press from the global-shortcut plugin. True when it was one of ours.
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut) -> bool {
    let answer = if shortcut.id() == yes_shortcut().id() {
        "yes"
    } else if shortcut.id() == no_shortcut().id() {
        "no"
    } else {
        return false;
    };
    // The page answers the decision nearest the top.
    let _ = app.emit_to(LABEL, "toast-key", answer);
    true
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastBoot {
    /// What was shown before the page listened.
    backlog: Vec<Toast>,
    keys: Option<KeyLabels>,
}

/// The toast page is listening.
#[tauri::command]
pub fn toast_ready(toasts: State<Arc<Toasts>>) -> ToastBoot {
    let mut inner = toasts.inner.lock().unwrap();
    inner.ready = true;
    ToastBoot { backlog: std::mem::take(&mut inner.backlog), keys: key_labels() }
}

/// A page shows a toast. Returns its id.
#[tauri::command]
pub fn toast_show(app: AppHandle, toast: Toast) -> String {
    show(&app, toast)
}

/// A page shows a toast and waits for how it ends.
#[tauri::command]
pub async fn toast_ask(app: AppHandle, toast: Toast) -> Answer {
    ask(&app, toast).await
}

#[tauri::command]
pub fn toast_dismiss(app: AppHandle, id: String) {
    dismiss(&app, &id);
}

/// The toast page: how a toast ended.
#[tauri::command]
pub fn toast_answer(toasts: State<Arc<Toasts>>, id: String, answer: Answer) {
    settle(&toasts, &id, answer);
}

/// The toast page: the stack is `height` logical pixels tall (0: empty).
#[tauri::command]
pub fn toast_layout(app: AppHandle, toasts: State<Arc<Toasts>>, height: f64) {
    layout(&app, &toasts, height);
}

/// The toast page: a decision is on screen (`on`), or none is any more.
#[tauri::command]
pub fn toast_keys(app: AppHandle, toasts: State<Arc<Toasts>>, on: bool) {
    hold_keys(&app, &toasts, on);
}

// ── Samples, for review ───────────────────────────────────────────────────────

/// `coucou --toast-sample <info|success|warning|error|decision|all>`, sent
/// to the running app (or given at launch): shows sample toasts, so the look
/// and the keys can be checked without a real caller. Not translated on
/// purpose — nothing a user meets.
pub fn sample_from_args(args: &[String]) -> Option<String> {
    let at = args.iter().position(|a| a == "--toast-sample")?;
    Some(args.get(at + 1).cloned().unwrap_or_else(|| "all".into()))
}

pub fn show_sample(app: &AppHandle, which: &str) {
    let all = which == "all";
    if all || which == "info" {
        show(app, Toast::new(Kind::Info, "Sample: info").text("Mochi has something to tell you. It goes away by itself."));
    }
    if all || which == "success" {
        show(app, Toast::new(Kind::Success, "Sample: success").text("Everything went well.").pill("integration_github"));
    }
    if all || which == "warning" {
        warn(
            app,
            "Sample: warning",
            Some("Your question goes to a model server that is not on this machine.".into()),
        );
    }
    if which == "error" {
        show(app, Toast::new(Kind::Error, "Sample: error").text("Something went wrong."));
    }
    if all || which == "decision" {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let toast = Toast::new(Kind::Warning, "Sample: decision")
                .id("sample-decision")
                .text("Send this question to the server anyway?")
                .pill("ai_ollama")
                .decision();
            let answer = ask(&app, toast).await;
            crate::log::line(format!("toasts: sample decision answered {answer:?}"));
            // Custom labels, same keys.
            let toast = Toast::new(Kind::Info, "Sample: decision with labels")
                .text(format!("The first one was answered {answer:?}. Keep going?"))
                .decision_labeled("Keep going", "Stop");
            let answer = ask(&app, toast).await;
            show(&app, Toast::new(Kind::Success, format!("Sample: answered {answer:?}")).duration_ms(3000));
        });
    }
}

// ── Wayland: the GlobalShortcuts portal ───────────────────────────────────────

/// The decision keys on Wayland: a portal session of their own (portal.rs),
/// opened while a decision is on screen and closed with it, so the keys go
/// back to the other apps. The island's shortcuts keep theirs.
#[cfg(target_os = "linux")]
mod wayland {
    use super::*;
    use crate::portal::{self, Event, Wanted};

    #[derive(Default)]
    pub enum Link {
        #[default]
        NotStarted,
        Running { handle: portal::Handle, gen: u64 },
        /// No portal: the buttons only, for the rest of the run.
        Gone,
    }

    pub fn hold(app: &AppHandle, toasts: &Toasts, on: bool) {
        let mut link = toasts.portal.lock().unwrap();
        if matches!(*link, Link::Gone) || (!on && matches!(*link, Link::NotStarted)) {
            return;
        }
        if matches!(*link, Link::NotStarted) {
            let events = app.clone();
            *link = match portal::start(move |event| on_event(&events, event)) {
                Some(handle) => Link::Running { handle, gen: 0 },
                None => Link::Gone,
            };
        }
        let Link::Running { handle, gen } = &mut *link else { return };
        *gen += 1;
        let sent = if on {
            handle.bind(
                *gen,
                vec![
                    Wanted {
                        id: YES_ID.into(),
                        description: crate::i18n::t("Answer yes to the notification"),
                        trigger: Some(YES_TRIGGER.into()),
                    },
                    Wanted {
                        id: NO_ID.into(),
                        description: crate::i18n::t("Answer no to the notification"),
                        trigger: Some(NO_TRIGGER.into()),
                    },
                ],
            )
        } else {
            handle.release()
        };
        if !sent {
            *link = Link::Gone;
        }
    }

    fn on_event(app: &AppHandle, event: Event) {
        match event {
            Event::Activated(id) => {
                let answer = match id.as_str() {
                    YES_ID => "yes",
                    NO_ID => "no",
                    _ => return,
                };
                let _ = app.emit_to(LABEL, "toast-key", answer);
            }
            Event::Failed { reason, .. } => crate::log::line(format!("toasts: portal: {reason}")),
            Event::Unavailable(reason) => {
                crate::log::line(format!("toasts: no shortcuts portal ({reason})"));
                if let Some(toasts) = app.try_state::<Arc<Toasts>>() {
                    *toasts.portal.lock().unwrap() = Link::Gone;
                }
            }
            Event::Bound { .. } | Event::Changed { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_toast_reads_and_writes_the_pages_shape() {
        let toast = Toast::new(Kind::Warning, "Remote model")
            .text("Your question leaves this machine.")
            .pill("ai_ollama")
            .duration_ms(6000)
            .decision();
        let json = serde_json::to_value(&toast).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "", "kind": "warning", "title": "Remote model",
                "text": "Your question leaves this machine.", "pill": "ai_ollama",
                "durationMs": 6000, "actions": {}
            })
        );
        // What a page sends: only what it needs.
        let from_page: Toast = serde_json::from_str(r#"{"kind":"info","title":"Hi"}"#).unwrap();
        assert_eq!(from_page, Toast::new(Kind::Info, "Hi"));
        let labeled: Toast =
            serde_json::from_str(r#"{"kind":"error","title":"Q","actions":{"yes":"Send","no":"Keep"}}"#).unwrap();
        assert_eq!(labeled.actions, Some(Actions { yes: Some("Send".into()), no: Some("Keep".into()) }));
    }

    #[test]
    fn answers_are_lowercase_words() {
        assert_eq!(serde_json::to_string(&Answer::Yes).unwrap(), "\"yes\"");
        assert_eq!(serde_json::from_str::<Answer>("\"dismissed\"").unwrap(), Answer::Dismissed);
    }

    #[test]
    fn the_decision_keys_are_told_apart() {
        assert_ne!(yes_shortcut().id(), no_shortcut().id());
        assert_eq!(yes_shortcut().id(), Shortcut::new(Some(Modifiers::SHIFT), Code::KeyY).id());
    }

    #[test]
    fn samples_come_from_the_command_line() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(sample_from_args(&args(&["coucou", "--toast-sample", "decision"])).as_deref(), Some("decision"));
        assert_eq!(sample_from_args(&args(&["coucou", "--toast-sample"])).as_deref(), Some("all"));
        assert_eq!(sample_from_args(&args(&["coucou", "--shortcut", "openChat"])), None);
    }
}
