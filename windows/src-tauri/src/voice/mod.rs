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
// With the bundled engine installed and chosen (engine.rs, sherpa.rs), the
// wake phrase is still Windows' — it hears "coucou" where the free engine does
// not — and the command after it is free speech: the microphone is read here
// (capture.rs), a sentence is cut out of it (vad.rs) and written down. For a
// few seconds after a command, another may follow without the wake phrase.
// And the two may be one breath, "OK Coucou, next track": Windows' recogniser
// says when in the sentence the wake phrase ended, and what the microphone
// gave after that moment is written down.
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
#[cfg(windows)]
mod capture;
pub mod engine;
mod grammar;
#[cfg(windows)]
mod sapi;
mod sherpa;
mod speak;
mod vad;
mod session;

#[cfg(windows)]
use sapi::Recogniser;
use grammar::Grammar;
use session::{Heard, Listen, Raw, Rule, Session};

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
    /// Mochi is speaking until then: nothing heard meanwhile is a command.
    Hush(Instant),
    Stop,
}

/// How the listener runs, from the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Plan {
    wake: bool,
    /// The bundled engine writes down the command, when it is installed.
    free: bool,
    follow_up: u32,
}

/// The longest follow-up time a settings file can ask for, in seconds.
const MAX_FOLLOW_UP: u32 = 30;

struct Shared {
    generation: u64,
    /// The plan, when voice is on in Settings.
    want: Option<Plan>,
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
    if !(pref.enabled && pref.speak) {
        speak::unload();
    }
    let want = pref.enabled.then(|| Plan {
        wake: pref.wake,
        free: pref.engine == "bundled",
        follow_up: pref.follow_up.min(MAX_FOLLOW_UP),
    });
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
    let (Some(plan), Some(grammar)) = (s.want, s.grammar.clone()) else {
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
        .spawn(move || listen(&app, generation, plan, &grammar, &rx));
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

/// Mochi speaks for this long: the listener does not take him for the user.
fn hush(length: Duration) {
    send(&shared(), Control::Hush(Instant::now() + length));
}

/// The island has something for Mochi to say. Said only when speaking is on
/// in Settings and the voice is installed.
pub fn say(app: &AppHandle, pref: &VoicePref, text: &str) {
    if pref.enabled && pref.speak {
        speak::say(app, text, speak::voice_named(&pref.speaker));
    }
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

/// Whether a part of the bundled speech engine is on this machine, and what
/// getting it costs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    installed: bool,
    download_bytes: u64,
    /// False where there is no build of it for this system yet.
    available: bool,
}

#[tauri::command]
pub fn voice_engine_status(part: engine::Part) -> EngineStatus {
    EngineStatus { installed: engine::installed(part), download_bytes: engine::download_bytes(part), available: cfg!(windows) }
}

/// Settings → Voice → Download: fetches that part of the engine. The listener
/// starts again, to hear with it if that is what came.
#[tauri::command]
pub async fn voice_engine_install(app: AppHandle, part: engine::Part) -> Result<(), String> {
    engine::install(&app, part).await?;
    restart(&app, shared());
    Ok(())
}

/// Settings → Voice → Remove: the engine is let go of first, then deleted.
#[tauri::command]
pub fn voice_engine_remove(app: AppHandle, part: engine::Part) {
    speak::unload();
    {
        let mut s = shared();
        s.generation += 1;
        if let Some(tx) = s.tx.take() {
            let _ = tx.send(Control::Stop);
        }
    }
    // The threads unload the library as they stop.
    std::thread::sleep(Duration::from_millis(800));
    engine::remove(part);
    restart(&app, shared());
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
        // The island opens on its listening view again, then hears the command.
        Heard::Again(text) => {
            tell(app, Heard::Woke);
            ("final", text)
        }
    };
    // Never the words: docs/VOICE.md.
    if phase != "partial" {
        crate::log::line(format!("voice: {phase}"));
    }
    let _ = app.emit_to(WINDOW_LABEL, EVENT, Event { phase, text });
}

/// The bundled engine at work: the microphone, the sentence being said, and
/// what writes it down.
#[cfg(windows)]
struct Free {
    engine: sherpa::Engine,
    capture: Option<capture::Capture>,
    sentences: vad::Sentences,
    buffer: Vec<f32>,
    /// The last sentence that ended while only the wake phrase was listened
    /// for: it may turn out to have had a command after the wake phrase.
    recent: Option<(Instant, Vec<f32>)>,
    /// The sentence being said started with the wake phrase, which ended this
    /// long into it.
    after_wake: Option<Duration>,
}

/// How long ago a sentence may have ended and still be the one Windows'
/// recogniser is reporting the wake phrase of.
#[cfg(windows)]
const SAME_BREATH: Duration = Duration::from_millis(1500);

#[cfg(windows)]
impl Free {
    /// None when the engine is not installed or will not load: the grammar
    /// recogniser then hears commands as before.
    fn load() -> Option<Self> {
        if !engine::installed(engine::Part::Hearing) {
            crate::log::line("voice: the bundled engine is chosen but not installed");
            return None;
        }
        match sherpa::Engine::load(&engine::runtime_dir(), &engine::model_dir(engine::Part::Hearing)) {
            Ok(engine) => Some(Self {
                engine,
                capture: None,
                sentences: vad::Sentences::default(),
                buffer: Vec::new(),
                recent: None,
                after_wake: None,
            }),
            Err(why) => {
                crate::log::line(format!("voice: bundled engine: {why}"));
                None
            }
        }
    }

    /// Opens or closes the microphone.
    fn open(&mut self, on: bool) -> Result<(), Unavailable> {
        if on && self.capture.is_none() {
            self.capture = Some(capture::Capture::open()?);
        } else if !on {
            if let Some(capture) = self.capture.take() {
                capture::release_com(capture);
            }
        }
        Ok(())
    }

    /// What is being said so far is not part of what comes next.
    fn start_over(&mut self) {
        self.sentences.clear();
        self.recent = None;
        self.after_wake = None;
    }

    fn written(&self, samples: &[f32]) -> Raw {
        let text = session::without_wake(&self.engine.transcribe(vad::SAMPLE_RATE, samples));
        if text.chars().any(char::is_alphanumeric) {
            Raw::Phrase { rule: Rule::Command, text, confidence: 1.0 }
        } else {
            Raw::Rejected
        }
    }

    /// What was said after the wake phrase in the sentence that had it, or
    /// None when it was the wake phrase alone.
    fn tail(&self, sentence: &[f32], wake: Duration) -> Option<Raw> {
        let from = vad::after_wake(sentence.len(), wake)?;
        match self.written(&sentence[from..]) {
            // Only the end of "coucou" was in there: not a command that was missed.
            Raw::Rejected => None,
            command => Some(command),
        }
    }

    /// The wake phrase was just heard, ending `wake` into its sentence. If
    /// that sentence went on, the rest of it is the command: written down now
    /// when it has already ended, else when it does (`next` knows where to cut).
    fn same_breath(&mut self, wake: Duration) -> Option<Raw> {
        if let Some((ended, sentence)) = self.recent.take() {
            if ended.elapsed() <= SAME_BREATH {
                return self.tail(&sentence, wake);
            }
        }
        if self.sentences.speaking() {
            self.after_wake = Some(wake);
        }
        None
    }

    /// Reads the microphone for at most `wait`. A sentence that just ended
    /// comes back written down — or `Rejected` when it was not words — when
    /// `wanted`; else it is only listened to, so the room stays known.
    fn next(&mut self, wait: Duration, wanted: bool) -> Result<Option<Raw>, Unavailable> {
        let Some(capture) = self.capture.as_mut() else { return Ok(None) };
        self.buffer.clear();
        capture.read(wait, &mut self.buffer)?;
        let Some(sentence) = self.sentences.feed(&self.buffer) else { return Ok(None) };
        if !wanted {
            self.recent = Some((Instant::now(), sentence));
            return Ok(None);
        }
        Ok(match self.after_wake.take() {
            // The wake phrase alone ends its sentence: the command is still to come.
            Some(wake) => self.tail(&sentence, wake),
            None => Some(self.written(&sentence)),
        })
    }

    fn speaking(&self) -> bool {
        self.sentences.speaking()
    }
}

#[cfg(windows)]
impl Drop for Free {
    fn drop(&mut self) {
        let _ = self.open(false);
    }
}

/// No bundled engine for this system yet.
#[cfg(not(windows))]
struct Free;

#[cfg(not(windows))]
impl Free {
    fn load() -> Option<Self> {
        None
    }

    fn open(&mut self, _on: bool) -> Result<(), Unavailable> {
        Ok(())
    }

    fn start_over(&mut self) {}

    fn same_breath(&mut self, _wake: Duration) -> Option<Raw> {
        None
    }

    fn next(&mut self, _wait: Duration, _wanted: bool) -> Result<Option<Raw>, Unavailable> {
        Ok(None)
    }

    fn speaking(&self) -> bool {
        false
    }
}

fn listen(app: &AppHandle, generation: u64, plan: Plan, grammar: &Grammar, rx: &Receiver<Control>) {
    let wake = plan.wake;
    let mut free = if plan.free { Free::load() } else { None };
    // One breath only where the rest of the sentence can be written down.
    let mut recogniser = match Recogniser::open(grammar, free.is_some()) {
        Ok(recogniser) => recogniser,
        Err(why) => return give_up(app, generation, why),
    };
    crate::log::line(if free.is_some() { "voice: on, free speech" } else { "voice: on" });
    // Another command without the wake phrase only where any sentence can be heard.
    let follow_up = if free.is_some() { Duration::from_secs(u64::from(plan.follow_up)) } else { Duration::ZERO };
    let mut session = Session::new(wake, follow_up);
    let mut paused = false;
    let mut ear = Listen::Nothing;
    let mut held_checked: Option<Instant> = None;
    let mut hush_until: Option<Instant> = None;
    // The command is the rest of the sentence that woke Coucou: not to be forgotten.
    let mut same_breath = false;

    loop {
        // Messages first: a wait for speech below never lasts longer than POLL.
        loop {
            let heard = match rx.try_recv() {
                Ok(Control::Stop) | Err(TryRecvError::Disconnected) => return crate::log::line("voice: off"),
                Err(TryRecvError::Empty) => break,
                Ok(control) => apply(&mut session, &mut paused, &mut held_checked, &mut hush_until, control),
            };
            if let Some(heard) = heard {
                tell(app, heard);
            }
        }
        let now = Instant::now();
        // While Mochi speaks, what is waited for waits on, and nothing heard counts.
        let hushed = hush_until.is_some_and(|until| now < until);
        if hushed {
            session.speaking(now);
        }
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
            // With the free engine, Windows' recogniser only ever hears the wake phrase.
            let freely = free.is_some() && matches!(want, Listen::Command | Listen::FollowUp);
            let system = if freely { Listen::Nothing } else { want };
            let mut turned = recogniser.listen(system);
            if let (Ok(()), Some(free)) = (&turned, free.as_mut()) {
                // The microphone stays open through the wake phrase too, so the
                // room is known and a command's first sound is not lost.
                turned = free.open(want != Listen::Nothing);
                if want == Listen::Command && !std::mem::take(&mut same_breath) {
                    free.start_over();
                }
            }
            if let Err(why) = turned {
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
                    if let Some(heard) = apply(&mut session, &mut paused, &mut held_checked, &mut hush_until, control) {
                        tell(app, heard);
                    }
                }
            }
        } else {
            let freely = free.is_some() && matches!(ear, Listen::Command | Listen::FollowUp);
            // Windows' recogniser when it is the one listening; else a short nap
            // is the microphone's wait below.
            let mut raw = if freely { None } else { recogniser.next(POLL) };
            if let Some(free) = free.as_mut() {
                let wait = if freely { POLL } else { Duration::ZERO };
                match free.next(wait, freely) {
                    Ok(sentence) => raw = raw.or(sentence),
                    Err(why) => {
                        if ear == Listen::Command {
                            tell(app, Heard::Cancelled);
                        }
                        return give_up(app, generation, why);
                    }
                }
                if hushed {
                    free.start_over();
                } else if freely && free.speaking() {
                    session.speaking(Instant::now());
                }
            }
            if hushed {
                raw = None;
            }
            let said_wake = matches!(&raw, Some(Raw::Phrase { rule: Rule::Wake, .. }));
            let heard = raw.and_then(|raw| session.heard(raw, Instant::now()));
            let woke = said_wake && heard == Some(Heard::Woke);
            if let Some(heard) = heard {
                tell(app, heard);
            }
            // "OK Coucou, next track": the sentence the wake phrase was in may
            // go on, and what follows it is the command.
            if woke {
                if let Some(free) = free.as_mut() {
                    same_breath = true;
                    if let Some(command) = free.same_breath(recogniser.wake_length()) {
                        if let Some(heard) = session.heard(command, Instant::now()) {
                            tell(app, heard);
                        }
                    }
                }
            }
        }
    }
}

fn apply(
    session: &mut Session,
    paused: &mut bool,
    held_checked: &mut Option<Instant>,
    hush_until: &mut Option<Instant>,
    control: Control,
) -> Option<Heard> {
    match control {
        Control::Hush(until) => {
            *hush_until = Some(until);
            None
        }
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
    fn open(_commands: &Grammar, _tails: bool) -> Result<Self, Unavailable> {
        Err(Unavailable::Unsupported)
    }

    fn wake_length(&self) -> Duration {
        Duration::ZERO
    }

    fn listen(&mut self, _what: Listen) -> Result<(), Unavailable> {
        Ok(())
    }

    fn next(&mut self, wait: Duration) -> Option<session::Raw> {
        std::thread::sleep(wait);
        None
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// One breath, on recorded sentences and without a microphone: Windows'
    /// recogniser hears the wake phrase and says when it ended, the voice
    /// detector cuts the sentence out, and what follows the wake phrase is
    /// written down — or there is nothing after it. `COUCOU_VOICE_CLIPS` holds
    /// `alone.wav` and `with-command.wav` (16 kHz, 16-bit mono, quiet around
    /// the speech); `COUCOU_VOICE_RUNTIME` and `COUCOU_VOICE_MODEL` the engine.
    /// `cargo test -p coucou voice::tests -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the downloaded engine and recorded clips"]
    fn a_command_said_in_the_same_breath_as_the_wake_phrase_is_written_down() {
        let var = |name: &str| std::path::PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set")));
        let engine = sherpa::Engine::load(&var("COUCOU_VOICE_RUNTIME"), &var("COUCOU_VOICE_MODEL")).expect("engine");
        let commands: Vec<String> = vec!["next track".into()];
        let grammar = Grammar::parse(&commands, &BTreeMap::new()).expect("grammar");

        let after_wake = |file: &str| -> Option<String> {
            let path = var("COUCOU_VOICE_CLIPS").join(file);
            // Windows' recogniser: is it the wake phrase, and when did it end?
            let mut recogniser = Recogniser::open_on(&grammar, true, Some(&path)).expect("recogniser");
            recogniser.listen(Listen::Wake).expect("listen");
            let started = Instant::now();
            let mut woke = false;
            while !woke && started.elapsed() < Duration::from_secs(8) {
                woke = matches!(recogniser.next(POLL), Some(Raw::Phrase { rule: Rule::Wake, confidence, .. }) if confidence >= session::WAKE_FLOOR);
            }
            assert!(woke, "{file}: the wake phrase was not heard");
            let wake = recogniser.wake_length();

            // The microphone's side: the same sound, 10 ms at a time.
            let bytes = std::fs::read(&path).expect("wav");
            assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), vad::SAMPLE_RATE, "{file} must be 16 kHz");
            let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
            let samples: Vec<f32> = bytes[data..].chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect();
            let mut sentences = vad::Sentences::default();
            let sentence = samples.chunks(160).find_map(|chunk| sentences.feed(chunk)).unwrap_or_else(|| panic!("{file}: no sentence was cut out"));

            let from = vad::after_wake(sentence.len(), wake)?;
            let text = engine.transcribe(vad::SAMPLE_RATE, &sentence[from..]);
            println!("{file}: the wake phrase ended at {wake:?}; after it: {text:?}");
            Some(text.to_lowercase())
        };

        assert_eq!(after_wake("alone.wav"), None, "nothing follows the wake phrase said alone");
        let command = after_wake("with-command.wav").expect("a command follows");
        for word in std::env::var("COUCOU_VOICE_EXPECT").unwrap_or_default().to_lowercase().split_whitespace() {
            assert!(command.contains(word), "{word:?} not in {command:?}");
        }
    }

    /// The free-speech path on real audio, without a microphone: a recorded
    /// sentence with quiet around it is fed as a microphone would give it, cut
    /// out by the voice detector and written down by the engine.
    /// `COUCOU_VOICE_RUNTIME`, `COUCOU_VOICE_MODEL` and `COUCOU_VOICE_WAV`
    /// (16-bit mono) say where things are.
    /// `cargo test -p coucou voice::tests -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the downloaded engine"]
    fn a_sentence_in_a_stream_is_cut_out_and_written_down() {
        let var = |name: &str| std::path::PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set")));
        let engine = sherpa::Engine::load(&var("COUCOU_VOICE_RUNTIME"), &var("COUCOU_VOICE_MODEL")).expect("engine");
        let bytes = std::fs::read(var("COUCOU_VOICE_WAV")).expect("wav");
        let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as f64;
        let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        let recorded: Vec<f32> = bytes[data..].chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect();
        // To the microphone's rate, the plain way: this is a test, not the capture.
        let step = rate / f64::from(vad::SAMPLE_RATE);
        let speech: Vec<f32> = (0..(recorded.len() as f64 / step) as usize).map(|i| recorded[(i as f64 * step) as usize]).collect();
        let quiet = |seconds: f64| -> Vec<f32> {
            (0..(seconds * f64::from(vad::SAMPLE_RATE)) as usize).map(|i| if i % 3 == 0 { 0.0006 } else { -0.0004 }).collect()
        };
        let stream = [quiet(1.5), speech, quiet(1.5)].concat();

        let mut sentences = vad::Sentences::default();
        let mut heard = Vec::new();
        // 10 ms at a time, like the microphone.
        for chunk in stream.chunks(160) {
            if let Some(sentence) = sentences.feed(chunk) {
                let seconds = sentence.len() as f64 / f64::from(vad::SAMPLE_RATE);
                let text = session::without_wake(&engine.transcribe(vad::SAMPLE_RATE, &sentence));
                println!("a sentence of {seconds:.1} s: {text:?}");
                heard.push(text);
            }
        }
        assert_eq!(heard.len(), 1, "one sentence was said");
        let expected = std::env::var("COUCOU_VOICE_EXPECT").unwrap_or_default().to_lowercase();
        for word in expected.split_whitespace() {
            assert!(heard[0].to_lowercase().contains(word), "{word:?} not in {:?}", heard[0]);
        }
    }
}
