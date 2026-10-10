// "OK Coucou" — hands-free voice control. Say the wake phrase (or press the
// "Talk to Coucou" shortcut), the island opens on its listening view, the
// command is heard, and the island understands it and acts (src/voice/). This
// side only listens: it owns the microphone and the recogniser.
//
// The rules, the Mac's (docs/VOICE.md):
// - On this machine only. No audio and no text leaves it, there is no cloud
//   recogniser to fall back on: where there is no local one, Settings says so
//   and nothing listens.
// - Nothing is recorded. The log says that something was recognised, never what.
// - Off by default. Off means no thread and a closed microphone.
// - Voice never approves a permission and never sends anything.
//
// One thread owns the recogniser, like the Spotify listener (spotify.rs):
// `sync` starts and stops it on every settings save, and a generation number
// makes an old listener quit. What is heard goes through a `Session`
// (session.rs), which knows nothing of the engine behind it; Windows' own
// recogniser is the one engine for now (sapi.rs), English only. Linux has no
// system recogniser: it waits for the bundled engine.
//
// A fixed-grammar recogniser hears only what it was given. The commands come
// from the island (`voice_grammar`), which writes them next to the parser
// that understands them: nothing listens until it has sent them.
//
// The island is told with one event, `voice`: { phase, text }, phase being
// "woke", "partial", "final", "missed" or "cancelled". Settings follows
// `voice-status`.

use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::settings::VoicePref;

mod apps;
pub mod brain;
mod grammar;
#[cfg(windows)]
mod sapi;
mod session;

#[cfg(windows)]
use sapi::Recogniser;
use grammar::Grammar;
use session::{Heard, Listen, Session};

const EVENT: &str = "voice";
const STATUS_EVENT: &str = "voice-status";

/// How long one wait for speech lasts before the thread looks at its messages.
const POLL: Duration = Duration::from_millis(200);
/// How often the lock screen and battery saver are looked at.
const HOLD_CHECK: Duration = Duration::from_secs(2);

/// Why nothing can listen here.
#[derive(Debug)]
pub enum Unavailable {
    /// No English speech recogniser installed.
    NoRecogniser,
    /// No microphone, or Windows refuses it to desktop apps.
    Microphone,
    /// No recogniser for this system in this version.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    Error(String),
}

impl Unavailable {
    #[cfg(windows)]
    fn error(err: windows::core::Error) -> Self {
        Self::Error(format!("{:#010x}", err.code().0))
    }
}

/// What Settings → Voice shows next to the switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Off,
    /// Hearing the wake phrase, or a command.
    Listening,
    /// Microphone closed until the shortcut is pressed.
    Shortcut,
    /// Coucou is paused, the screen is locked, or battery saver is on.
    Paused,
    NoRecogniser,
    Microphone,
    Unsupported,
    Error,
}

enum Control {
    Talk,
    Cancel,
    Paused(bool),
    Stop,
}

struct Shared {
    generation: u64,
    /// The wake setting, when voice is on in Settings.
    want: Option<bool>,
    /// What the island said can be heard; None until it has.
    grammar: Option<Arc<Grammar>>,
    tx: Option<Sender<Control>>,
    paused: bool,
    status: Status,
}

static SHARED: Mutex<Shared> =
    Mutex::new(Shared { generation: 0, want: None, grammar: None, tx: None, paused: false, status: Status::Off });

fn shared() -> MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Starts, stops or restarts the listener to match the settings. Called at
/// launch and on every save.
pub fn sync(app: &AppHandle, pref: &VoicePref) {
    let want = pref.enabled.then_some(pref.wake);
    let mut s = shared();
    if s.want == want {
        return;
    }
    s.want = want;
    restart(app, s);
}

/// The commands that can be heard, from the island. A listener already
/// running starts again with them.
#[tauri::command]
pub fn voice_grammar(app: AppHandle, commands: Vec<String>, slots: BTreeMap<String, Vec<String>>) {
    let grammar = match Grammar::parse(&commands, &slots) {
        Ok(grammar) => grammar,
        Err(why) => return crate::log::line(format!("voice: grammar refused: {why}")),
    };
    let mut s = shared();
    if s.grammar.as_deref() == Some(&grammar) {
        return;
    }
    s.grammar = Some(Arc::new(grammar));
    restart(&app, s);
}

/// Stops the listener, and starts one when voice is on and there is something
/// to listen for.
fn restart(app: &AppHandle, mut s: MutexGuard<'static, Shared>) {
    s.generation += 1;
    if let Some(tx) = s.tx.take() {
        let _ = tx.send(Control::Stop);
    }
    let (Some(wake), Some(grammar)) = (s.want, s.grammar.clone()) else {
        drop(s);
        set_status(app, None, Status::Off);
        return;
    };
    let (tx, rx) = mpsc::channel();
    if s.paused {
        let _ = tx.send(Control::Paused(true));
    }
    s.tx = Some(tx);
    let generation = s.generation;
    drop(s);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("voice".into())
        .spawn(move || listen(&app, generation, wake, &grammar, &rx));
    if let Err(err) = spawned {
        crate::log::line(format!("voice: no thread: {err}"));
    }
}

/// Tray → Pause closes the microphone too.
pub fn set_paused(paused: bool) {
    let mut s = shared();
    s.paused = paused;
    send(&s, Control::Paused(paused));
}

/// The "Talk to Coucou" shortcut. Does nothing while voice is off.
pub fn talk() {
    send(&shared(), Control::Talk);
}

fn send(s: &Shared, control: Control) {
    if let Some(tx) = &s.tx {
        let _ = tx.send(control);
    }
}

#[tauri::command]
pub fn voice_status() -> Status {
    shared().status
}

/// The island asked a question and waits for the answer: a command, without
/// the wake phrase.
#[tauri::command]
pub fn voice_talk() {
    talk();
}

/// "Open Figma": starts the Start-menu app that name means, and says which.
#[tauri::command]
pub fn voice_open_app(name: String) -> Option<String> {
    let installed = apps::installed();
    let app = apps::find(&name, &installed)?;
    crate::log::line("voice: open app");
    crate::platform::reveal_folder(&app.path.to_string_lossy());
    Some(app.name.clone())
}

/// "Open my downloads": one of the user's own folders, and which.
#[tauri::command]
pub fn voice_open_folder(name: String) -> Option<String> {
    let (folder, path) = apps::folder(&name)?;
    crate::log::line("voice: open folder");
    crate::platform::reveal_folder(&path.to_string_lossy());
    Some(folder)
}

/// The island left the listening view by itself (Escape, a card coming up).
#[tauri::command]
pub fn voice_cancel() {
    send(&shared(), Control::Cancel);
}

/// `generation`: only the listener still in charge may speak; None for `sync`.
fn set_status(app: &AppHandle, generation: Option<u64>, status: Status) {
    {
        let mut s = shared();
        if generation.is_some_and(|g| g != s.generation) || s.status == status {
            return;
        }
        s.status = status;
    }
    let _ = app.emit(STATUS_EVENT, status);
}

#[derive(Clone, Serialize)]
struct Event {
    phase: &'static str,
    text: String,
}

fn tell(app: &AppHandle, heard: Heard) {
    let (phase, text) = match heard {
        Heard::Woke => ("woke", String::new()),
        Heard::Partial(text) => ("partial", text),
        Heard::Final(text) => ("final", text),
        Heard::Missed => ("missed", String::new()),
        Heard::Cancelled => ("cancelled", String::new()),
    };
    // Never the words: docs/VOICE.md.
    if phase != "partial" {
        crate::log::line(format!("voice: {phase}"));
    }
    let _ = app.emit_to(WINDOW_LABEL, EVENT, Event { phase, text });
}

fn listen(app: &AppHandle, generation: u64, wake: bool, grammar: &Grammar, rx: &Receiver<Control>) {
    let mut recogniser = match Recogniser::open(grammar) {
        Ok(recogniser) => recogniser,
        Err(why) => return give_up(app, generation, why),
    };
    crate::log::line("voice: on");
    let mut session = Session::new(wake);
    let mut paused = false;
    let mut ear = Listen::Nothing;
    let mut held_checked: Option<Instant> = None;

    loop {
        // Messages first: a wait for speech below never lasts longer than POLL.
        loop {
            let heard = match rx.try_recv() {
                Ok(Control::Stop) | Err(TryRecvError::Disconnected) => return crate::log::line("voice: off"),
                Err(TryRecvError::Empty) => break,
                Ok(control) => apply(&mut session, &mut paused, &mut held_checked, control),
            };
            if let Some(heard) = heard {
                tell(app, heard);
            }
        }
        let now = Instant::now();
        if held_checked.is_none_or(|at| now.duration_since(at) >= HOLD_CHECK) {
            held_checked = Some(now);
            if let Some(heard) = session.hold(paused || system_hold()) {
                tell(app, heard);
            }
        }
        if let Some(heard) = session.tick(now) {
            tell(app, heard);
        }

        let want = session.listen();
        if want != ear {
            if let Err(why) = recogniser.listen(want) {
                if ear == Listen::Command || want == Listen::Command {
                    tell(app, Heard::Cancelled);
                }
                return give_up(app, generation, why);
            }
            ear = want;
            let status = match want {
                Listen::Nothing if wake => Status::Paused,
                Listen::Nothing => Status::Shortcut,
                _ => Status::Listening,
            };
            set_status(app, Some(generation), status);
        }

        if ear == Listen::Nothing {
            // Microphone closed: sleep on the messages, not on the recogniser.
            match rx.recv_timeout(HOLD_CHECK) {
                Ok(Control::Stop) | Err(RecvTimeoutError::Disconnected) => return crate::log::line("voice: off"),
                Err(RecvTimeoutError::Timeout) => {}
                Ok(control) => {
                    if let Some(heard) = apply(&mut session, &mut paused, &mut held_checked, control) {
                        tell(app, heard);
                    }
                }
            }
        } else if let Some(raw) = recogniser.next(POLL) {
            if let Some(heard) = session.heard(raw, Instant::now()) {
                tell(app, heard);
            }
        }
    }
}

fn apply(session: &mut Session, paused: &mut bool, held_checked: &mut Option<Instant>, control: Control) -> Option<Heard> {
    match control {
        Control::Talk => session.talk(Instant::now()),
        Control::Cancel => {
            session.cancel();
            None
        }
        Control::Paused(on) => {
            *paused = on;
            // Looked at again at once, with the lock screen and battery saver.
            *held_checked = None;
            None
        }
        Control::Stop => None,
    }
}

fn give_up(app: &AppHandle, generation: u64, why: Unavailable) {
    let (status, detail) = match why {
        Unavailable::NoRecogniser => (Status::NoRecogniser, "no English recogniser".to_string()),
        Unavailable::Microphone => (Status::Microphone, "no microphone".to_string()),
        Unavailable::Unsupported => (Status::Unsupported, "not on this system".to_string()),
        Unavailable::Error(code) => (Status::Error, code),
    };
    crate::log::line(format!("voice: unavailable: {detail}"));
    set_status(app, Some(generation), status);
}

/// The screen is locked, or Windows is saving battery: no listening meanwhile.
#[cfg(windows)]
fn system_hold() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP,
    };
    unsafe {
        // The input desktop cannot be opened while the lock screen has it.
        let locked = match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) {
            Ok(desktop) => {
                let _ = CloseDesktop(desktop);
                false
            }
            Err(_) => true,
        };
        let mut power = SYSTEM_POWER_STATUS::default();
        let saving = GetSystemPowerStatus(&mut power).is_ok() && power.SystemStatusFlag == 1;
        locked || saving
    }
}

#[cfg(not(windows))]
fn system_hold() -> bool {
    false
}

/// Where the system has no recogniser of its own: nothing to open.
#[cfg(not(windows))]
struct Recogniser;

#[cfg(not(windows))]
impl Recogniser {
    fn open(_commands: &Grammar) -> Result<Self, Unavailable> {
        Err(Unavailable::Unsupported)
    }

    fn listen(&mut self, _what: Listen) -> Result<(), Unavailable> {
        Ok(())
    }

    fn next(&mut self, wait: Duration) -> Option<session::Raw> {
        std::thread::sleep(wait);
        None
    }
}
