// "OK Coucou" — hands-free voice control. Say the wake phrase (or press the
// "Talk to Coucou" shortcut), the island opens on its listening view, the
// command is heard, and the island understands it and acts (src/voice/). This
// side only listens: it owns the microphone and the recogniser.
//
// The rules, the Mac's (docs/VOICE.md):
// - On this machine only. What the microphone hears never leaves it: a
//   sentence is written down by Windows' recogniser, by the bundled engine,
//   or — when the user chose that as the speech model — by the model server
//   they connected, and then only when that server is on this computer
//   (hear.rs refuses any other address, and the bundled model hears instead).
//   There is no cloud recogniser to fall back on: where there is no local
//   one, Settings says so and nothing listens.
// - The words, once written down, go as text where the user set voice up to
//   reason and nowhere else: the model server chosen for voice (brain.rs,
//   embed.rs), wherever the user pointed it, and — behind its own switch, off
//   by default — the provider chosen for chat (cloud.rs).
// - Nothing is recorded. The log says that something was recognised, never what.
// - Off by default. Off means no thread and a closed microphone.
// - Voice never approves a permission and never sends anything.
//
// One thread owns the recogniser, like the Spotify listener (spotify.rs):
// `sync` starts and stops it on every settings save, and a generation number
// makes an old listener quit. What is heard goes through a `Session`
// (session.rs), which knows nothing of the engines behind it. English only.
// Linux has no system recogniser: nothing listens there yet.
//
// Two engines, each for what it is good at. The wake phrase is Windows' own
// recogniser's (sapi.rs): it hears "coucou" where a free engine writes it a
// different way each time. It is given the wake phrases and nothing else — a
// fixed grammar can only hear the sentences it was given, and no list of
// sentences is kept for voice. The command after it is always free speech,
// by the bundled engine (engine.rs, sherpa.rs): the microphone is read here
// (capture.rs), a sentence is cut out of it (vad.rs) and written down. Where
// that engine's hearing part is not installed, and the model server may not
// hear in its place, nothing listens and the status says why (`noEngine`). For a
// few seconds after a command, another may follow without the wake phrase:
// whatever is said then is handed to the island, which shows something only
// when it is a command, and says so (`voice_followed`).
// The model that writes the sentence down is one of the bundled ones, or the
// model server's own (hear.rs) with a bundled one behind it for the sentences
// the server does not answer for in time.
// And the two may be one breath, "OK Coucou, next track": Windows' recogniser
// says when in the sentence the wake phrase ended, and what the microphone
// gave after that moment is written down.
//
// The listener starts from the settings alone: the island sends it nothing to
// listen for.
//
// The island is told with one event, `voice`: { phase, text }, phase being
// "woke", "partial", "final", "missed" or "cancelled" — and "following" /
// "rested" around the time another command may follow without the wake phrase,
// "again" being a sentence said in that time. Settings follows `voice-status`.
// While the bundled engine listens for a command, `voice-level` says how loud
// the microphone hears (0…1), for the glow under the island.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::island::WINDOW_LABEL;
use crate::settings::{Settings, VoicePref};

mod apps;
pub mod ask_keys;
pub mod brain;
pub mod cloud;
pub mod embed;
#[cfg(windows)]
mod capture;
pub mod engine;
mod hear;
pub mod mcp;
#[cfg(windows)]
mod sapi;
mod sherpa;
mod speak;
mod vad;
mod session;

#[cfg(windows)]
use sapi::Recogniser;
use session::{Heard, Listen, Raw, Rule, Session};

const EVENT: &str = "voice";
const STATUS_EVENT: &str = "voice-status";
const LEVEL_EVENT: &str = "voice-level";
/// How often the island is told the microphone's level: about 15 times a second.
const LEVEL_EVERY: Duration = Duration::from_millis(66);

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
    /// Nothing here can write a command down: the bundled engine's hearing
    /// part is not installed (or will not load), and the model server may
    /// not hear in its place.
    #[cfg_attr(not(windows), allow(dead_code))]
    NoEngine,
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
    /// The speech engine is needed: a command is free speech, and its hearing
    /// part is not on this machine. Settings → Voice offers the download.
    NoEngine,
    Unsupported,
    Error,
}

enum Control {
    Talk,
    Cancel,
    /// What was said without the wake phrase was a command.
    Followed,
    /// The user is done talking: nothing more is listened for until the wake phrase.
    Rest,
    Paused(bool),
    /// Mochi is speaking until then: nothing heard meanwhile is a command.
    Hush(Instant),
    Stop,
}

/// How the listener runs, from the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Plan {
    wake: bool,
    /// Which hearing model it does so with (engine.rs): a new one is a new listener.
    hearing: usize,
    /// The model server is asked to write the command down (hear.rs), and
    /// whether it may be: it is on this computer and has a model.
    server: bool,
    server_here: bool,
    follow_up: u32,
}

/// The longest follow-up time a settings file can ask for, in seconds.
const MAX_FOLLOW_UP: u32 = 30;

struct Shared {
    generation: u64,
    /// The plan, when voice is on in Settings.
    want: Option<Plan>,
    tx: Option<Sender<Control>>,
    paused: bool,
    status: Status,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { generation: 0, want: None, tx: None, paused: false, status: Status::Off });

fn shared() -> MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// How the listener runs, or None when voice is off. The settings say all of
/// it: nothing comes from the island. `engine` in the settings (the older
/// "Hear free speech" switch) no longer chooses anything — a command is
/// always free speech.
fn plan(settings: &Settings) -> Option<Plan> {
    let pref = &settings.voice;
    let server = pref.hearing_model == hear::ID;
    pref.enabled.then(|| Plan {
        wake: pref.wake,
        hearing: engine::choose(&pref.hearing_model),
        server,
        server_here: server && hear::ear(settings).is_ok(),
        follow_up: pref.follow_up.min(MAX_FOLLOW_UP),
    })
}

/// What writes a command down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ears {
    /// The bundled model: alone, or behind the model server for the
    /// sentences that server does not answer for in time.
    bundled: bool,
    /// The model server is asked first (hear.rs).
    server: bool,
}

/// Who hears the command under this plan, `installed` saying whether the
/// bundled engine's hearing part is on this machine. None when nobody can:
/// voice then does not listen at all, the wake phrase included — waking for a
/// command that cannot be heard would be a promise not kept.
#[cfg_attr(not(windows), allow(dead_code))]
fn ears(plan: Plan, installed: bool) -> Option<Ears> {
    let ears = Ears { bundled: installed, server: plan.server_here };
    (ears.bundled || ears.server).then_some(ears)
}

/// Starts, stops or restarts the listener to match the settings. Called at
/// launch and on every save.
pub fn sync(app: &AppHandle, settings: &Settings) {
    let pref = &settings.voice;
    if !(pref.enabled && pref.speak) {
        speak::unload();
    }
    let want = plan(settings);
    let mut s = shared();
    if s.want == want {
        return;
    }
    s.want = want;
    restart(app, s);
}

/// Stops the listener, and starts one when voice is on.
fn restart(app: &AppHandle, mut s: MutexGuard<'static, Shared>) {
    s.generation += 1;
    if let Some(tx) = s.tx.take() {
        let _ = tx.send(Control::Stop);
    }
    let Some(plan) = s.want else {
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
        .spawn(move || listen(&app, generation, plan, &rx));
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

/// An app voice started: its name, and whether it was seen to come.
#[derive(Serialize)]
pub struct Opened {
    name: String,
    /// A window of it came to the front within a couple of seconds. False is
    /// not a failure: Windows was asked, and nothing was seen yet.
    seen: bool,
}

/// How long an app is watched for after it is started.
const SEEN_WITHIN: Duration = Duration::from_millis(2000);

/// "Open Figma": starts the installed app that name means, says which, and
/// whether it was seen to come — so the island says "opened" for what did.
#[tauri::command]
pub async fn voice_open_app(name: String) -> Option<Opened> {
    let installed = apps::installed_lately();
    let app = apps::find(&name, &installed)?.clone();
    crate::log::line("voice: open app");
    let before = front::window();
    app.open();
    let started = Instant::now();
    let mut seen = false;
    while !seen && started.elapsed() < SEEN_WITHIN {
        tokio::time::sleep(Duration::from_millis(100)).await;
        seen = front::came(before, &app.name);
    }
    Some(Opened { name: app.name, seen })
}

/// The window in front, to tell whether an app that was started has come.
#[cfg(windows)]
mod front {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

    /// The window in front now, as a number that can be kept across a wait.
    pub fn window() -> isize {
        unsafe { GetForegroundWindow().0 as isize }
    }

    /// Another program's window has come to the front since `before`, or the
    /// one in front is that app's by its title (it was in front already).
    pub fn came(before: isize, name: &str) -> bool {
        unsafe {
            let now = GetForegroundWindow();
            if now.0.is_null() {
                return false;
            }
            let mut owner = 0u32;
            GetWindowThreadProcessId(now, Some(&mut owner));
            if owner == std::process::id() {
                return false;
            }
            if now.0 as isize != before {
                return true;
            }
            let mut title = [0u16; 256];
            let length = GetWindowTextW(HWND(now.0), &mut title).max(0) as usize;
            super::titled(&String::from_utf16_lossy(&title[..length]), name)
        }
    }
}

#[cfg(not(windows))]
mod front {
    pub fn window() -> isize {
        0
    }

    pub fn came(_before: isize, _name: &str) -> bool {
        false
    }
}

/// A window's title is that app's: it holds the app's name, or its first word
/// when the name is several ("Visual Studio Code" in "main.rs — Visual Studio Code").
#[cfg_attr(not(windows), allow(dead_code))]
fn titled(title: &str, name: &str) -> bool {
    let (title, name) = (title.to_lowercase(), name.to_lowercase());
    let first = name.split_whitespace().next().unwrap_or_default();
    !name.trim().is_empty() && (title.contains(name.trim()) || (first.len() >= 4 && title.split(|c: char| !c.is_alphanumeric()).any(|w| w == first)))
}

/// The installed apps nearest to a name that is none of them, for Mochi to
/// ask about ("Open Spotify?"): nothing is opened.
#[derive(Serialize)]
pub struct NearApps {
    /// The app the name means as `voice_open_app` would find it, if it is one.
    found: Option<String>,
    /// Nearest first, three at most.
    names: Vec<String>,
    /// How near each of them is, 0…1.
    scores: Vec<f32>,
    /// The first is the one to ask about by itself; else the first two are as near.
    clear: bool,
}

#[tauri::command]
pub fn voice_apps_near(said: String) -> NearApps {
    let installed = apps::installed_lately();
    let near = apps::near(&said, &installed);
    NearApps {
        found: apps::find(&said, &installed).map(|app| app.name.clone()),
        names: near.iter().map(|(_, app)| app.name.clone()).collect(),
        scores: near.iter().map(|(score, _)| *score).collect(),
        clear: apps::clear(&near),
    }
}

/// The user's own folders voice may open, by the names `voice_open_folder`
/// takes: those that exist on this machine.
#[tauri::command]
pub fn voice_folders() -> Vec<String> {
    apps::folders()
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
    /// It is being downloaded now: no second download of it is offered.
    downloading: bool,
}

#[tauri::command]
pub fn voice_engine_status(shared: State<crate::Shared>, part: engine::Part) -> EngineStatus {
    // With the model server as the speech model, nothing has to be downloaded to hear.
    if part == engine::Part::Hearing && cfg!(windows) && server_hears(&shared.settings.lock().unwrap()) {
        return EngineStatus { installed: true, download_bytes: 0, available: true, downloading: false };
    }
    EngineStatus {
        installed: engine::installed(part),
        download_bytes: engine::download_bytes(part),
        available: cfg!(windows),
        downloading: engine::downloading(part),
    }
}

/// The settings name the model server as the speech model, and it may hear.
fn server_hears(settings: &Settings) -> bool {
    settings.voice.hearing_model == hear::ID && hear::ear(settings).is_ok()
}

/// A hearing model the user may choose, for Settings → Voice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HearingChoice {
    id: &'static str,
    name: String,
    download_bytes: u64,
    installed: bool,
    /// Not a download: the model of the server chosen for voice, by its name.
    server: bool,
}

/// The bundled models, and after them the model server chosen for voice when
/// it may hear: one on this computer, with a model (hear.rs). For any other
/// server the choice is not there to make.
#[tauri::command]
pub fn voice_hearing_models(shared: State<crate::Shared>) -> Vec<HearingChoice> {
    let mut choices: Vec<HearingChoice> = engine::HEARING_MODELS
        .iter()
        .map(|model| HearingChoice {
            id: model.id,
            name: model.name.to_string(),
            download_bytes: model.download_bytes(),
            installed: model.installed(),
            server: false,
        })
        .collect();
    if let Ok(ear) = hear::ear(&shared.settings.lock().unwrap()) {
        choices.push(HearingChoice { id: hear::ID, name: ear.model().to_string(), download_bytes: 0, installed: true, server: true });
    }
    choices
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
/// A turn put to the cloud model is stopped with it (cloud.rs).
#[tauri::command]
pub fn voice_cancel() {
    send(&shared(), Control::Cancel);
    cloud::cancel();
}

/// The sentence said without the wake phrase was a command, and is done:
/// another may follow it in turn.
#[tauri::command]
pub fn voice_followed() {
    send(&shared(), Control::Followed);
}

/// "Ok done", "never mind", "thanks": the listening view has closed, and no
/// follow-up is listened for.
#[tauri::command]
pub fn voice_rest() {
    send(&shared(), Control::Rest);
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
    /// How sure the speech model was of each word of `text`, 0…1, when it
    /// says: a name it was not sure of is asked about rather than acted on
    /// (src/voice/resolve.ts). Empty when nothing is known.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    sure: Vec<f32>,
}

/// The sentence the bundled model wrote down last, and how sure it was of
/// each word. In memory until the next sentence; never logged.
static SURE: Mutex<Option<(String, Vec<f32>)>> = Mutex::new(None);

/// How sure the model was of the words of `text`, if `text` is its last sentence.
fn sure_of(text: &str) -> Vec<f32> {
    let sure = SURE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    match sure.as_ref() {
        Some((written, sure)) if written == text => sure.clone(),
        _ => Vec::new(),
    }
}

/// Something for the island that is not something heard.
fn note(app: &AppHandle, phase: &'static str) {
    let _ = app.emit_to(WINDOW_LABEL, EVENT, Event { phase, text: String::new(), sure: Vec::new() });
}

fn tell(app: &AppHandle, heard: Heard) {
    let (phase, text) = match heard {
        Heard::Woke => ("woke", String::new()),
        Heard::Partial(text) => ("partial", text),
        Heard::Final(text) => ("final", text),
        Heard::Missed => ("missed", String::new()),
        Heard::Cancelled => ("cancelled", String::new()),
        // The island shows nothing unless it makes a command of it.
        Heard::Again(text) => ("again", text),
    };
    // Never the words: docs/VOICE.md. Nor every sentence said near a microphone.
    if !matches!(phase, "partial" | "again") {
        crate::log::line(format!("voice: {phase}"));
    }
    let sure = if matches!(phase, "final" | "again") { sure_of(&text) } else { Vec::new() };
    let _ = app.emit_to(WINDOW_LABEL, EVENT, Event { phase, text, sure });
}

/// The bundled engine at work: the microphone, the sentence being said, and
/// what writes it down.
#[cfg(windows)]
struct Free {
    /// The bundled model; None when only the model server hears.
    engine: Option<sherpa::Engine>,
    /// Set when the model server is asked first (hear.rs): where the settings
    /// are, which say at every sentence whether it still may be.
    server: Option<AppHandle>,
    /// The names the model server is told may be said: the installed apps'.
    names: Vec<String>,
    capture: Option<capture::Capture>,
    sentences: vad::Sentences,
    buffer: Vec<f32>,
    /// The last sentence that ended while only the wake phrase was listened
    /// for: it may turn out to have had a command after the wake phrase.
    recent: Option<(Instant, Vec<f32>)>,
    /// The sentence being said started with the wake phrase, which ended this
    /// long into it.
    after_wake: Option<Duration>,
    /// The loudest the microphone has heard since it was last asked.
    peak: f32,
}

/// How long ago a sentence may have ended and still be the one Windows'
/// recogniser is reporting the wake phrase of.
#[cfg(windows)]
const SAME_BREATH: Duration = Duration::from_millis(1500);

#[cfg(windows)]
impl Free {
    /// `NoEngine` when the engine is not installed or will not load, and the
    /// model server is not there to hear instead: nothing can write a command
    /// down, and Windows' recogniser is not asked to.
    fn load(app: &AppHandle, plan: Plan) -> Result<Self, Unavailable> {
        if plan.server && !plan.server_here {
            crate::log::line("voice: the model server may not hear (not on this computer, or no model): the bundled model does");
        }
        let Some(ears) = ears(plan, engine::installed(engine::Part::Hearing)) else {
            crate::log::line("voice: the speech engine is needed: its hearing part is not installed");
            return Err(Unavailable::NoEngine);
        };
        let server = ears.server.then(|| app.clone());
        let bundled = ears.bundled;
        // Moonshine fails from ten seconds of sound; a Parakeet or a model server takes a long sentence.
        vad::takes_long_sentences(server.is_some() || engine::hearing().family != engine::Family::Moonshine);
        // A keyboard is as loud as a voice: the detector is what tells them apart.
        let sentences = match sherpa::Detector::load(&engine::runtime_dir(), &engine::detector_file(), vad::SILENCE_SECONDS) {
            Ok(detector) => vad::Sentences::of_voices(detector),
            Err(why) => {
                crate::log::line(format!("voice: no voice detector, loudness instead: {why}"));
                vad::Sentences::default()
            }
        };
        let engine = bundled
            .then(|| sherpa::Engine::load(&engine::runtime_dir(), &engine::model_dir(engine::Part::Hearing), engine::hearing().family))
            .and_then(|loaded| loaded.map_err(|why| crate::log::line(format!("voice: bundled engine: {why}"))).ok());
        if engine.is_none() && server.is_none() {
            return Err(Unavailable::NoEngine);
        }
        let names = if server.is_some() { hear::names(apps::installed_lately().iter().map(|app| app.name.as_str())) } else { Vec::new() };
        let free = Self { engine, server, names, capture: None, sentences, buffer: Vec::new(), recent: None, after_wake: None, peak: 0.0 };
        free.warm();
        Ok(free)
    }

    /// The settings as they are now, when the model server is asked to hear.
    fn asked(&self) -> Option<Settings> {
        use tauri::Manager;
        Some(self.server.as_ref()?.try_state::<crate::Shared>()?.settings.lock().ok()?.clone())
    }

    /// A command is coming: the model server gets its model ready (hear.rs).
    fn warm(&self) {
        if let Some(Ok(ear)) = self.asked().map(|settings| hear::ear(&settings)) {
            hear::warm(ear);
        }
    }

    /// The sentence as the model server wrote it down, when it is asked and
    /// answers in time (hear.rs). The settings are read again each time: a
    /// server that is no longer on this computer is not sent anything.
    fn by_server(&self, samples: &[f32]) -> Option<String> {
        let settings = self.asked()?;
        let heard = hear::ear(&settings).map_err(str::to_string).and_then(|ear| hear::write_down(&ear, samples, &self.names));
        // Why not, never the words.
        heard.map_err(|why| crate::log::line(format!("voice: the model server did not hear: {}", why.chars().take(160).collect::<String>()))).ok()
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

    /// A command is listened for: where recordings stand in for the
    /// microphone (a debug build's `COUCOU_VOICE_WAV`), the next one is said.
    fn say_next(&mut self) {
        if let Some(capture) = self.capture.as_mut() {
            capture.say_next();
        }
    }

    /// What is being said so far is not part of what comes next.
    fn start_over(&mut self) {
        self.sentences.clear();
        self.recent = None;
        self.after_wake = None;
    }

    fn written(&self, samples: &[f32]) -> Raw {
        let samples = vad::fitting(samples);
        // The model server first when it is the speech model; the bundled
        // model for what it did not hear, and nothing when there is neither.
        // Only the bundled model says how sure it is of each word.
        let (heard, sure) = match self.by_server(samples) {
            Some(heard) => (heard, Vec::new()),
            None => self.engine.as_ref().map(|engine| engine.transcribe_sure(vad::SAMPLE_RATE, samples)).unwrap_or_default(),
        };
        let text = session::without_wake(&heard);
        // The wake phrase said again was taken off the front: its words' too.
        let kept = text.split_whitespace().count();
        let sure = if sure.len() >= kept { sure[sure.len() - kept..].to_vec() } else { Vec::new() };
        *SURE.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = (!sure.is_empty()).then(|| (text.clone(), sure));
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
        self.peak = self.peak.max(vad::loudness(&self.buffer));
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

    /// How loud it has been since the last time this was asked, 0…1.
    fn loudest(&mut self) -> f32 {
        std::mem::take(&mut self.peak)
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
    fn load(_app: &AppHandle, _plan: Plan) -> Result<Self, Unavailable> {
        Err(Unavailable::Unsupported)
    }

    fn open(&mut self, _on: bool) -> Result<(), Unavailable> {
        Ok(())
    }

    fn start_over(&mut self) {}

    fn say_next(&mut self) {}

    fn warm(&self) {}

    fn same_breath(&mut self, _wake: Duration) -> Option<Raw> {
        None
    }

    fn next(&mut self, _wait: Duration, _wanted: bool) -> Result<Option<Raw>, Unavailable> {
        Ok(None)
    }

    fn speaking(&self) -> bool {
        false
    }

    fn loudest(&mut self) -> f32 {
        0.0
    }
}

fn listen(app: &AppHandle, generation: u64, plan: Plan, rx: &Receiver<Control>) {
    let wake = plan.wake;
    // What writes the command down comes first: without it nothing listens,
    // not even for the wake phrase.
    let mut free = match Free::load(app, plan) {
        Ok(free) => free,
        Err(why) => return give_up(app, generation, why),
    };
    let mut recogniser = match Recogniser::open() {
        Ok(recogniser) => recogniser,
        Err(why) => return give_up(app, generation, why),
    };
    crate::log::line("voice: on");
    let mut session = Session::new(wake, Duration::from_secs(u64::from(plan.follow_up)));
    let mut paused = false;
    let mut ear = Listen::Nothing;
    let mut held_checked: Option<Instant> = None;
    let mut hush_until: Option<Instant> = None;
    // The command is the rest of the sentence that woke Coucou: not to be forgotten.
    let mut same_breath = false;
    let mut level = vad::Level::default();
    let mut level_told = Instant::now();

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
            // Windows' recogniser only ever hears the wake phrase: it is off
            // through a command and the time another may follow.
            let mut turned = recogniser.listen(want);
            if turned.is_ok() {
                // The microphone stays open through the wake phrase too, so the
                // room is known and a command's first sound is not lost.
                turned = free.open(want != Listen::Nothing);
                if want == Listen::Command {
                    free.say_next();
                    free.warm();
                    if !std::mem::take(&mut same_breath) {
                        free.start_over();
                    }
                }
            }
            // A command is coming: the model that may be asked about it gets ready.
            if want == Listen::Command {
                use tauri::Manager;
                let settings = app.try_state::<crate::Shared>().and_then(|shared| shared.settings.lock().ok().map(|s| s.clone()));
                if let Some(settings) = settings {
                    brain::warm(&settings);
                }
            }
            if let Err(why) = turned {
                if ear == Listen::Command || want == Listen::Command {
                    tell(app, Heard::Cancelled);
                }
                return give_up(app, generation, why);
            }
            // Another command may follow without the wake phrase: the island
            // shows Mochi still listening, and that he has stopped.
            if want == Listen::FollowUp {
                note(app, "following");
            } else if ear == Listen::FollowUp && want != Listen::Command {
                note(app, "rested");
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
            let freely = matches!(ear, Listen::Command | Listen::FollowUp);
            // Windows' recogniser when it is the one listening; else a short nap
            // is the microphone's wait below.
            let mut raw = if freely { None } else { recogniser.next(POLL) };
            {
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
                // The glow under the island moves with the voice, not with Mochi's.
                if freely && level_told.elapsed() >= LEVEL_EVERY {
                    level_told = Instant::now();
                    let loudest = free.loudest();
                    if let Some(level) = level.step(if hushed { 0.0 } else { loudest }) {
                        let _ = app.emit_to(WINDOW_LABEL, LEVEL_EVENT, level);
                    }
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
        Control::Followed => {
            session.followed(Instant::now());
            None
        }
        Control::Rest => {
            session.rest();
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
        Unavailable::NoEngine => (Status::NoEngine, "the speech engine is needed".to_string()),
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
    fn open() -> Result<Self, Unavailable> {
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

#[cfg(test)]
mod plan_tests {
    use super::*;

    fn settings(change: impl FnOnce(&mut VoicePref)) -> Settings {
        let mut settings = Settings::default();
        settings.voice.enabled = true;
        change(&mut settings.voice);
        settings
    }

    #[test]
    fn the_listener_is_planned_from_the_settings_alone() {
        // Off is no listener at all.
        assert_eq!(plan(&Settings::default()), None);
        // On is a listener at once: nothing is waited for from the island.
        let on = plan(&settings(|_| {})).expect("a plan");
        assert!(on.wake);
        assert!(!on.server && !on.server_here);
        assert_eq!(on.follow_up, Settings::default().voice.follow_up);
        // The older "Hear free speech" switch chooses nothing any more: a
        // command is free speech with it and without it.
        let chosen = plan(&settings(|voice| voice.engine = "bundled".into()));
        let not_chosen = plan(&settings(|voice| voice.engine = String::new()));
        assert_eq!(chosen, not_chosen);
        // Only the shortcut wakes, and the follow-up time has a ceiling.
        let quiet = plan(&settings(|voice| {
            voice.wake = false;
            voice.follow_up = 600;
        }))
        .unwrap();
        assert!(!quiet.wake);
        assert_eq!(quiet.follow_up, MAX_FOLLOW_UP);
    }

    #[test]
    fn a_model_server_hears_only_when_it_is_on_this_computer() {
        // Chosen as the speech model, but no server is set up: it may not hear.
        let alone = plan(&settings(|voice| voice.hearing_model = hear::ID.into())).unwrap();
        assert!(alone.server && !alone.server_here);
        // The bundled model then hears, when it is installed; else nobody does.
        assert_eq!(ears(alone, true), Some(Ears { bundled: true, server: false }));
        assert_eq!(ears(alone, false), None);
    }

    #[test]
    fn without_something_to_write_a_command_down_nothing_listens() {
        let on = plan(&settings(|_| {})).unwrap();
        // The hearing part is not installed: no ears, and the status is the engine's.
        assert_eq!(ears(on, false), None);
        assert_eq!(ears(on, true), Some(Ears { bundled: true, server: false }));
        // A model server on this computer hears without the download, and
        // with the bundled model behind it when that is there too.
        let served = Plan { server: true, server_here: true, ..on };
        assert_eq!(ears(served, false), Some(Ears { bundled: false, server: true }));
        assert_eq!(ears(served, true), Some(Ears { bundled: true, server: true }));
    }

    #[test]
    fn the_status_names_the_missing_engine_for_settings() {
        assert_eq!(serde_json::to_value(Status::NoEngine).unwrap(), "noEngine");
        // The ones Settings already knows keep their names.
        assert_eq!(serde_json::to_value(Status::NoRecogniser).unwrap(), "noRecogniser");
        assert_eq!(serde_json::to_value(Status::Listening).unwrap(), "listening");
    }
}

#[cfg(test)]
mod seen_tests {
    use super::titled;

    #[test]
    fn a_window_is_an_apps_by_its_title() {
        assert!(titled("Spotify Premium", "Spotify"));
        assert!(titled("main.rs — coucou — Visual Studio Code", "Visual Studio Code"));
        assert!(titled("#general | Discord", "Discord"));
        // Its first word alone, when it is a word of the title and long enough to mean it.
        assert!(titled("Figma — Untitled", "Figma Desktop"));
        assert!(!titled("Notes on the figmatic method", "Figma Desktop"));
        assert!(!titled("Inbox — Mail", "Spotify"));
        assert!(!titled("An app", "An Application"));
        assert!(!titled("anything", "  "));
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
        let engine = sherpa::Engine::load(&var("COUCOU_VOICE_RUNTIME"), &var("COUCOU_VOICE_MODEL"), sherpa::test_family()).expect("engine");

        let after_wake = |file: &str| -> Option<String> {
            let path = var("COUCOU_VOICE_CLIPS").join(file);
            // Windows' recogniser: is it the wake phrase, and when did it end?
            let mut recogniser = Recogniser::open_on(Some(&path)).expect("recogniser");
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
        let engine = sherpa::Engine::load(&var("COUCOU_VOICE_RUNTIME"), &var("COUCOU_VOICE_MODEL"), sherpa::test_family()).expect("engine");
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
