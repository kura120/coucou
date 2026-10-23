// Flow dictation: hold a key anywhere, speak, let go, and the words are pasted
// where the cursor is. Windows only for now.
//
// - logic.rs: the key's states (hold, two taps for hands-free, Esc), pure.
// - os_windows.rs: the low-level keyboard hook, the Ctrl+V, the window in front.
// - paste.rs: the clipboard, the paste, and what is put back.
// - text.rs: the user's replacements and dictionary, pure.
// - pill.rs: the small window that shows it listening.
// - this file: the controller that joins them to the speech service
//   (speech/dictate.rs), and the commands the pill calls.
//
// The rules:
// - Off by default. The hook is installed, and the pill made, only while Flow
//   is on; switching it off removes both.
// - The hook sees every key press on the computer, as any program that listens
//   for a hotkey does. It keeps nothing: it reports the chosen key's down and
//   up, and "another key" or Esc without saying which, only while a dictation
//   is under way. It never swallows a key. Nothing is logged but that a
//   dictation happened.
// - Nothing is recorded. The microphone opens on the key press (so the first
//   word is not lost) and closes when the dictation ends; the audio lives in
//   memory only until it is written down (speech/dictate.rs).
// - 0 % CPU at rest: the hook's thread sleeps in GetMessageW, the controller
//   waits on a channel, and the pill is parked and not drawing.
// - Never blocks anything: the hook hands each event to the controller's
//   thread and returns.

#![cfg_attr(not(windows), allow(dead_code))]

mod logic;
mod paste;
mod pill;
mod text;

#[cfg(windows)]
mod os_windows;
#[cfg(windows)]
use os_windows as os;

/// Where there is no keyboard hook yet, Flow stays off.
#[cfg(not(windows))]
mod os {
    use std::time::Instant;

    use super::logic::FlowKey;
    use super::KeyEvent;

    pub type Sink = Box<dyn Fn(KeyEvent, Instant) + Send + Sync>;
    pub struct KeyListener;

    pub fn listen(_key: FlowKey, _sink: Sink) -> Result<KeyListener, String> {
        Err("Flow is not on this system yet.".into())
    }
    pub fn set_key(_key: FlowKey) {}
    pub fn set_active(_active: bool) {}
    pub fn front_window() -> Option<isize> {
        None
    }
}

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager};

use crate::settings::{FlowPref, Settings};
use crate::speech::{dictate, engine};
use logic::{Action, FlowKey, KeyLogic};

/// What the keyboard hook reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    /// The chosen key went down (also its auto-repeat).
    Down,
    Up,
    /// Esc, while a dictation is under way.
    Escape,
    /// Some other key, while a dictation is under way.
    Other,
}

/// How long a key is held before the pill comes up: a right-hand Ctrl+C is not
/// worth a flash on the screen (the microphone opens at once all the same).
const PILL_DELAY: Duration = Duration::from_millis(150);
/// A little past the double-tap window, so the timer is never early.
const SLACK: Duration = Duration::from_millis(5);

/// What the controller's thread is told.
enum Msg {
    Key(KeyEvent, Instant),
    /// A `dictation` event of the speech service.
    Said { id: u64, phase: String, text: String },
    /// The pill's ✓ and ✕.
    PillFinish,
    PillCancel,
    Stop,
}

struct Running {
    tx: Sender<Msg>,
    /// Ends the hook's thread when dropped.
    _listener: os::KeyListener,
    said: tauri::EventId,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
/// Flow could not start with the settings as they are: not tried again at
/// every save, only after it was switched off and on.
static GAVE_UP: Mutex<bool> = Mutex::new(false);

fn is_on() -> bool {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// At launch and after every save of the settings: Flow on or off, and the key.
pub fn sync(app: &AppHandle, settings: &Settings) {
    let flow = &settings.flow;
    let want = flow.enabled && cfg!(windows);
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    match (want, running.is_some()) {
        (true, false) => {
            if *GAVE_UP.lock().unwrap_or_else(|e| e.into_inner()) {
                return;
            }
            match start(app, flow) {
                Ok(started) => {
                    *running = Some(started);
                    drop(running);
                    crate::log::line("flow: on");
                    // The pill's window, off this handler (see pill.rs).
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        pill::ensure(&app);
                        // Switched off while it was being made.
                        if !is_on() {
                            pill::destroy(&app);
                        }
                    });
                }
                Err(why) => {
                    *GAVE_UP.lock().unwrap_or_else(|e| e.into_inner()) = true;
                    crate::log::line(format!("flow: could not start: {why}"));
                    crate::toast::warn(
                        app,
                        crate::i18n::t("Flow could not start"),
                        Some(crate::i18n::tf("Windows refused the keyboard hook: {why}", &[("why", &why)])),
                    );
                }
            }
        }
        (true, true) => os::set_key(FlowKey::from_setting(&flow.key)),
        (false, true) => {
            let stopped = running.take();
            drop(running);
            if let Some(stopped) = stopped {
                stop(app, stopped);
            }
            crate::log::line("flow: off");
        }
        (false, false) => {
            *GAVE_UP.lock().unwrap_or_else(|e| e.into_inner()) = false;
        }
    }
}

fn start(app: &AppHandle, flow: &FlowPref) -> Result<Running, String> {
    let (tx, rx) = mpsc::channel::<Msg>();
    let keys = tx.clone();
    let listener = os::listen(
        FlowKey::from_setting(&flow.key),
        Box::new(move |event, at| {
            let _ = keys.send(Msg::Key(event, at));
        }),
    )?;
    // What the speech service says, for the id this controller started.
    let heard = tx.clone();
    let said = app.listen("dictation", move |event| {
        #[derive(Deserialize)]
        struct Heard {
            id: u64,
            phase: String,
            #[serde(default)]
            text: String,
        }
        let Ok(h) = serde_json::from_str::<Heard>(event.payload()) else { return };
        // The level is only for the pill's own page.
        if h.phase != "level" && h.phase != "partial" {
            let _ = heard.send(Msg::Said { id: h.id, phase: h.phase, text: h.text });
        }
    });
    let handle = app.clone();
    let spawned = std::thread::Builder::new().name("peika-flow".into()).spawn(move || Controller::new(handle).run(rx));
    if let Err(err) = spawned {
        app.unlisten(said);
        return Err(err.to_string());
    }
    Ok(Running { tx, _listener: listener, said })
}

fn stop(app: &AppHandle, running: Running) {
    app.unlisten(running.said);
    let _ = running.tx.send(Msg::Stop);
    // Dropping `running` ends the hook's thread.
    drop(running);
    pill::destroy(app);
}

fn send(msg: Msg) {
    if let Some(running) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = running.tx.send(msg);
    }
}

// ── The controller ────────────────────────────────────────────────────────────

/// A dictation: the speech service's id for it, and the window that was in
/// front when the key went down, where the words go.
#[derive(Clone, Copy)]
struct Session {
    id: u64,
    front: Option<isize>,
}

struct Controller {
    app: AppHandle,
    origin: Instant,
    logic: KeyLogic,
    /// Listening.
    session: Option<Session>,
    /// Let go, waiting for the words to be written down.
    finishing: Option<Session>,
    /// When the pill is due to come up.
    pill_at: Option<Instant>,
}

impl Controller {
    fn new(app: AppHandle) -> Self {
        Self { app, origin: Instant::now(), logic: KeyLogic::default(), session: None, finishing: None, pill_at: None }
    }

    fn seconds(&self, at: Instant) -> f64 {
        at.saturating_duration_since(self.origin).as_secs_f64()
    }

    /// The thread sleeps until a message comes, or until a wait runs out: the
    /// second tap's, or the pill's.
    fn next_deadline(&self) -> Option<Instant> {
        let tap = self.logic.deadline().map(|s| self.origin + Duration::from_secs_f64(s) + SLACK);
        match (tap, self.pill_at) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        loop {
            let msg = match self.next_deadline() {
                None => match rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => break,
                },
                Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                    Ok(m) => Some(m),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                },
            };
            match msg {
                Some(Msg::Stop) => break,
                Some(m) => self.handle(m),
                None => self.on_timer(),
            }
            os::set_active(self.logic.is_active());
        }
        // Switched off: nothing is left listening or waiting.
        if let Some(s) = self.session.take().or(self.finishing.take()) {
            dictate::cancel(s.id);
        }
        os::set_active(false);
    }

    fn handle(&mut self, msg: Msg) {
        let action = match msg {
            Msg::Key(KeyEvent::Down, at) => self.logic.key_down(self.seconds(at)),
            Msg::Key(KeyEvent::Up, at) => self.logic.key_up(self.seconds(at)),
            Msg::Key(KeyEvent::Escape, _) => self.logic.escape(),
            Msg::Key(KeyEvent::Other, _) => self.logic.other_key(),
            Msg::PillFinish => self.logic.finish_button(),
            Msg::PillCancel => self.logic.escape(),
            Msg::Said { id, phase, text } => {
                self.said(id, &phase, text);
                Action::None
            }
            Msg::Stop => Action::None,
        };
        self.act(action);
    }

    fn on_timer(&mut self) {
        let now = Instant::now();
        let action = self.logic.tick(self.seconds(now));
        self.act(action);
        if self.pill_at.is_some_and(|at| now >= at) {
            self.pill_at = None;
            if let Some(s) = self.session {
                pill::show(&self.app, "listening", s.id);
            }
        }
    }

    fn act(&mut self, action: Action) {
        match action {
            Action::None => {}
            Action::Start => self.begin(),
            Action::Restart => {
                self.cancel();
                self.begin();
            }
            Action::Lock => {
                self.pill_at = None;
                if let Some(s) = self.session {
                    pill::show(&self.app, "locked", s.id);
                }
            }
            Action::Finish => {
                self.pill_at = None;
                if let Some(s) = self.session.take() {
                    dictate::finish(s.id);
                    self.finishing = Some(s);
                    pill::show(&self.app, "working", s.id);
                }
            }
            Action::Cancel => self.cancel(),
        }
    }

    /// The key went down: the microphone opens now.
    fn begin(&mut self) {
        let front = os::front_window();
        match begin_dictation(&self.app) {
            Ok(id) => {
                self.session = Some(Session { id, front });
                self.pill_at = Some(Instant::now() + PILL_DELAY);
            }
            Err(why) => {
                self.logic.reset();
                self.tell_failed(&why);
            }
        }
    }

    fn cancel(&mut self) {
        self.pill_at = None;
        if let Some(s) = self.session.take() {
            dictate::cancel(s.id);
            pill::hide(&self.app);
        }
    }

    fn tell_failed(&self, why: &str) {
        if why.starts_with("The speech engine is not installed") {
            pill::message(&self.app, "noengine", "");
        } else if why.starts_with("Already dictating") {
            pill::message(&self.app, "busy", "");
        } else {
            pill::message(&self.app, "failed", why);
        }
    }

    /// The speech service finished something.
    fn said(&mut self, id: u64, phase: &str, text: String) {
        let listening = self.session.is_some_and(|s| s.id == id);
        let finishing = self.finishing.is_some_and(|s| s.id == id);
        if !listening && !finishing {
            // Not ours: the chat's microphone, or a dictation already cancelled.
            return;
        }
        match phase {
            "final" => {
                // Past the longest a dictation may last, the service ends it.
                let session = if listening {
                    self.logic.reset();
                    self.session.take()
                } else {
                    self.finishing.take()
                };
                let Some(session) = session else { return };
                let app = self.app.clone();
                std::thread::spawn(move || deliver(&app, session, &text));
            }
            "failed" => {
                self.session = None;
                self.finishing = None;
                self.pill_at = None;
                self.logic.reset();
                self.tell_failed(&text);
            }
            "cancelled" => {
                self.session = None;
                self.finishing = None;
                self.pill_at = None;
                self.logic.reset();
                pill::hide(&self.app);
            }
            _ => {}
        }
    }
}

/// `dictate::begin`, tried again for a moment when the last dictation is
/// still ending (it was just cancelled, or is being written down).
fn begin_dictation(app: &AppHandle) -> Result<u64, String> {
    if !engine::installed(engine::Part::Hearing) {
        return Err("The speech engine is not installed (Settings → Voice).".into());
    }
    let mut tries = 0;
    loop {
        match dictate::begin(app) {
            Err(why) if why.starts_with("Already dictating") && tries < 8 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            other => return other,
        }
    }
}

/// The words are in: the text step, then the paste. On its own thread, since
/// the paste waits for the key to be up and for the window.
fn deliver(app: &AppHandle, session: Session, said: &str) {
    let prefs = app
        .try_state::<crate::Shared>()
        .map(|shared| shared.settings.lock().unwrap_or_else(|e| e.into_inner()).flow.clone())
        .unwrap_or_default();
    let words = text::apply(said, &prefs.dictionary, &prefs.replacements);
    // Only that a dictation happened, never what was said.
    if words.is_empty() {
        crate::log::line(format!("flow: dictation {}: nothing heard", session.id));
        pill::message(app, "empty", "");
        return;
    }
    let outcome = paste::paste(&words, session.front, FlowKey::from_setting(&prefs.key));
    crate::log::line(format!("flow: dictation {}: {outcome:?}", session.id));
    match outcome {
        paste::Outcome::Pasted => pill::hide(app),
        paste::Outcome::Copied(paste::Why::Elevated) => pill::message(app, "elevated", ""),
        paste::Outcome::Copied(paste::Why::Away) => pill::message(app, "away", ""),
        paste::Outcome::Copied(paste::Why::Refused) => pill::message(app, "copied", ""),
        paste::Outcome::Failed => pill::message(app, "failed", "the clipboard"),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The pill page asks for what to show when it loads.
#[tauri::command]
pub fn flow_pill_state() -> pill::PillState {
    pill::state()
}

/// The pill's ✓ (hands-free): write down what was said and paste it.
#[tauri::command]
pub fn flow_pill_finish() {
    send(Msg::PillFinish);
}

/// The pill's ✕: stop and paste nothing.
#[tauri::command]
pub fn flow_pill_cancel() {
    send(Msg::PillCancel);
}
