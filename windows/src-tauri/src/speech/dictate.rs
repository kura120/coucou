// Dictation: what someone says, written down as they say it, for whoever asked
// (the chat's microphone, Flow). One at a time.
//
// It runs on a thread of its own, holding the microphone's lease (mic.rs), so
// "OK Peika" stands aside meanwhile. The microphone opens first and what it
// hears is kept while the hearing model loads, so the first words are not
// lost; the model then stays loaded a little while after, for the next one.
// Sentences are cut by the voice detector (vad.rs) and written down as each
// ends; while one is being said, it is written down again every so often, so
// the words show as they come.
//
// The island is told with one event, `dictation`:
//   { id, phase, text, level }, phase being "level" (how loud, 0…1, for the
//   dots), "partial" (the text so far), "final" (the whole text, once), or
//   "cancelled" / "failed" (with the reason in `text`).
//
// Nothing is recorded: the samples live in memory until written down, and the
// log says that a dictation happened, never what was said.

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::engine;

const EVENT: &str = "dictation";
/// Written down again while a sentence is being said, at most this often.
const PARTIAL_EVERY: Duration = Duration::from_millis(800);
/// Past this much of a sentence, the partial is written down less often: the
/// cost of writing it all down again grows with it.
const PARTIAL_LONG: usize = vad_rate() * 10;
const PARTIAL_EVERY_LONG: Duration = Duration::from_millis(2000);
/// The level is told about this often.
const LEVEL_EVERY: Duration = Duration::from_millis(66);
/// Nobody dictates for this long: past it, the dictation ends by itself.
const LONGEST: Duration = Duration::from_secs(600);
/// How long the hearing model stays loaded after a dictation.
#[cfg_attr(not(windows), allow(dead_code))]
const MODEL_KEPT: Duration = Duration::from_secs(120);

const fn vad_rate() -> usize {
    super::vad::SAMPLE_RATE as usize
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Said {
    pub id: u64,
    pub phase: &'static str,
    pub text: String,
    pub level: f32,
}

/// The text so far: the sentences already written down, then the one being said.
#[derive(Default, Debug)]
pub struct Transcript {
    done: Vec<String>,
    partial: String,
}

impl Transcript {
    /// A sentence ended and was written down.
    pub fn finished(&mut self, text: &str) {
        let text = text.trim();
        if !text.is_empty() {
            self.done.push(text.to_string());
        }
        self.partial.clear();
    }

    /// The sentence being said, as written down so far.
    pub fn partial(&mut self, text: &str) {
        self.partial = text.trim().to_string();
    }

    pub fn text(&self) -> String {
        let mut all: Vec<&str> = self.done.iter().map(String::as_str).collect();
        if !self.partial.is_empty() {
            all.push(&self.partial);
        }
        all.join(" ")
    }
}

/// What turns the microphone's samples into text, one sentence at a time,
/// with the sentence being said written down again every so often.
pub struct Dictator<'a> {
    engine: &'a super::sherpa::Engine,
    sentences: super::vad::Sentences,
    transcript: Transcript,
    /// What was heard since the last sentence ended. Kept whole while the key
    /// is held: the detector can miss a short phrase, the key cannot.
    current: Vec<f32>,
    /// Something in `current` was loud enough to be a voice: silence alone is
    /// never written down (the model reads words into it).
    voiced: bool,
    last_partial: Instant,
}

/// Loud enough to be a voice (`vad::loudness`, about -50 dB): recorded
/// commands peak between 0.18 and 0.26 on this scale, a quiet room at 0.
const VOICED: f32 = 0.12;
/// The most of `current` kept between sentences: what the model can take.
const KEPT_BETWEEN: usize = vad_rate() * 30;

impl<'a> Dictator<'a> {
    pub fn new(engine: &'a super::sherpa::Engine, sentences: super::vad::Sentences) -> Self {
        Self {
            engine,
            sentences,
            transcript: Transcript::default(),
            current: Vec::new(),
            voiced: false,
            last_partial: Instant::now(),
        }
    }

    fn write_down(&self, samples: &[f32]) -> String {
        self.engine.transcribe_sure(super::vad::SAMPLE_RATE, super::vad::fitting(samples)).0
    }

    /// More of the microphone. The text so far when it changed.
    pub fn feed(&mut self, chunk: &[f32], now: Instant) -> Option<String> {
        self.current.extend_from_slice(chunk);
        self.voiced |= super::vad::loudness(chunk) >= VOICED;
        let changed = if let Some(sentence) = self.sentences.feed(chunk) {
            let text = self.write_down(&sentence);
            self.transcript.finished(&text);
            self.current.clear();
            self.voiced = false;
            true
        } else if (self.sentences.speaking() || self.voiced)
            && partial_due(now.duration_since(self.last_partial), self.current.len())
        {
            self.last_partial = now;
            let text = self.write_down(&self.current);
            self.transcript.partial(&text);
            true
        } else {
            false
        };
        if !self.sentences.speaking() && self.current.len() > KEPT_BETWEEN {
            let extra = self.current.len() - KEPT_BETWEEN;
            self.current.drain(..extra);
        }
        changed.then(|| self.transcript.text())
    }

    /// The end: what was still being said is written down too. The quiet
    /// before the key was let go stays: cutting it at the loudness of a voice
    /// cut the quiet ends of words off ("code", "track"), worse on recordings.
    pub fn finish(mut self) -> String {
        if self.sentences.speaking() || self.voiced {
            let text = self.write_down(&self.current);
            self.transcript.finished(&text);
        }
        self.transcript.text()
    }
}

/// Whether the sentence being said is due to be written down again.
pub fn partial_due(since_last: Duration, sentence_len: usize) -> bool {
    let every = if sentence_len > PARTIAL_LONG { PARTIAL_EVERY_LONG } else { PARTIAL_EVERY };
    since_last >= every
}

/// What the thread is told: go on, finish (write down what is left), or cancel.
const RUN: u8 = 0;
const FINISH: u8 = 1;
const CANCEL: u8 = 2;

struct Running {
    id: u64,
    order: Arc<AtomicU8>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn tell<R: Runtime>(app: &AppHandle<R>, said: Said) {
    let _ = app.emit(EVENT, said);
}

/// Starts a dictation. Err when one is already running, or nothing here can
/// write speech down.
pub fn begin<R: Runtime>(app: &AppHandle<R>) -> Result<u64, String> {
    if !engine::installed(engine::Part::Hearing) {
        return Err("The speech engine is not installed (Settings → Voice).".into());
    }
    let mut running = RUNNING.lock().unwrap();
    if running.is_some() {
        return Err("Already dictating.".into());
    }
    // The model the settings name; the model server's choice falls back to a bundled one.
    if let Some(shared) = app.try_state::<crate::Shared>() {
        engine::choose(&shared.settings.lock().unwrap().voice.hearing_model);
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let order = Arc::new(AtomicU8::new(RUN));
    *running = Some(Running { id, order: order.clone() });
    drop(running);
    crate::log::line(format!("dictation {id}: started"));
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = run(&app, id, &order);
        RUNNING.lock().unwrap().take();
        match outcome {
            Ok(Some(text)) => tell(&app, Said { id, phase: "final", text, level: 0.0 }),
            Ok(None) => tell(&app, Said { id, phase: "cancelled", text: String::new(), level: 0.0 }),
            Err(why) => {
                crate::log::line(format!("dictation {id}: {why}"));
                tell(&app, Said { id, phase: "failed", text: why, level: 0.0 });
            }
        }
        crate::log::line(format!("dictation {id}: over"));
    });
    Ok(id)
}

fn order(id: u64, what: u8) {
    if let Some(running) = RUNNING.lock().unwrap().as_ref().filter(|r| r.id == id) {
        running.order.store(what, Ordering::SeqCst);
    }
}

/// The key was let go, or the button: what is left is written down, then "final".
pub fn finish(id: u64) {
    order(id, FINISH);
}

/// Esc: nothing is written down.
pub fn cancel(id: u64) {
    order(id, CANCEL);
}

#[cfg(windows)]
fn run<R: Runtime>(app: &AppHandle<R>, id: u64, order: &AtomicU8) -> Result<Option<String>, String> {
    use super::{capture, mic, sherpa, vad};

    let _lease = mic::claim(mic::Owner::Dictation);
    let mut microphone = capture::Capture::open().map_err(|e| format!("{e:?}"))?;
    let mut heard: Vec<f32> = Vec::new();
    // Heard while the model loads: kept, and fed once it is ready.
    let _ = microphone.read(Duration::from_millis(10), &mut heard);
    let model = models::take()?;
    vad::takes_long_sentences(engine::hearing().family != engine::Family::Moonshine);
    let sentences = sherpa::Detector::load(&engine::runtime_dir(), &engine::detector_file(), vad::SILENCE_SECONDS)
        .map(vad::Sentences::of_voices)
        .unwrap_or_default();

    let started = Instant::now();
    let mut dictator = Dictator::new(&model.engine, sentences);
    let mut last_level = Instant::now();
    let mut level = vad::Level::default();
    let outcome = loop {
        let what = order.load(Ordering::SeqCst);
        if what == CANCEL {
            break None;
        }
        let mut chunk = std::mem::take(&mut heard);
        if what != FINISH {
            if let Err(e) = microphone.read(Duration::from_millis(50), &mut chunk) {
                break Some(Err(format!("{e:?}")));
            }
        }
        if !chunk.is_empty() {
            if last_level.elapsed() >= LEVEL_EVERY {
                last_level = Instant::now();
                if let Some(l) = level.step(vad::loudness(&chunk)) {
                    tell(app, Said { id, phase: "level", text: String::new(), level: l });
                }
            }
            if let Some(text) = dictator.feed(&chunk, Instant::now()) {
                tell(app, Said { id, phase: "partial", text, level: 0.0 });
            }
        }
        if what == FINISH || started.elapsed() >= LONGEST {
            break Some(Ok(dictator.finish()));
        }
    };
    capture::release_com(microphone);
    models::give_back(model);
    outcome.transpose()
}

#[cfg(not(windows))]
fn run<R: Runtime>(_app: &AppHandle<R>, _id: u64, _order: &AtomicU8) -> Result<Option<String>, String> {
    Err("Dictation is not on this system yet.".into())
}

/// The hearing model, loaded once and kept a while for the next dictation.
#[cfg(windows)]
mod models {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    use super::{engine, MODEL_KEPT};
    use crate::speech::sherpa::Engine;

    pub struct Loaded {
        pub engine: Engine,
        which: usize,
    }

    static KEPT: Mutex<Option<Loaded>> = Mutex::new(None);
    static GENERATION: AtomicU64 = AtomicU64::new(0);

    fn chosen() -> usize {
        engine::HEARING_MODELS.iter().position(|m| std::ptr::eq(m, engine::hearing())).unwrap_or(0)
    }

    /// The kept model if it is still the chosen one, else loaded now.
    pub fn take() -> Result<Loaded, String> {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        let which = chosen();
        if let Some(kept) = KEPT.lock().unwrap().take().filter(|k| k.which == which) {
            return Ok(kept);
        }
        let model = engine::hearing();
        let engine = Engine::load(&engine::runtime_dir(), &engine::model_dir(engine::Part::Hearing), model.family)?;
        Ok(Loaded { engine, which })
    }

    /// Kept for MODEL_KEPT, then unloaded if no dictation took it meanwhile.
    pub fn give_back(model: Loaded) {
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        *KEPT.lock().unwrap() = Some(model);
        std::thread::spawn(move || {
            std::thread::sleep(MODEL_KEPT);
            if GENERATION.load(Ordering::SeqCst) == generation {
                KEPT.lock().unwrap().take();
            }
        });
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Starts a dictation: its id, for `dictation_finish` / `dictation_cancel`.
#[tauri::command]
pub fn dictation_begin(app: AppHandle) -> Result<u64, String> {
    begin(&app)
}

#[tauri::command]
pub fn dictation_finish(id: u64) {
    finish(id);
}

#[tauri::command]
pub fn dictation_cancel(id: u64) {
    cancel(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_is_the_finished_sentences_then_the_one_being_said() {
        let mut t = Transcript::default();
        assert_eq!(t.text(), "");
        t.partial("hello");
        assert_eq!(t.text(), "hello");
        t.partial("hello wor");
        assert_eq!(t.text(), "hello wor");
        t.finished(" Hello world. ");
        assert_eq!(t.text(), "Hello world.");
        t.partial("and then");
        assert_eq!(t.text(), "Hello world. and then");
        // A sentence the model heard nothing in adds nothing.
        t.finished("   ");
        assert_eq!(t.text(), "Hello world.");
        t.finished("Done.");
        assert_eq!(t.text(), "Hello world. Done.");
    }

    #[test]
    fn a_long_sentence_is_written_down_again_less_often() {
        let short = vad_rate() * 3;
        let long = vad_rate() * 15;
        assert!(!partial_due(Duration::from_millis(700), short));
        assert!(partial_due(Duration::from_millis(800), short));
        assert!(!partial_due(Duration::from_millis(1500), long));
        assert!(partial_due(Duration::from_millis(2000), long));
    }

    /// A real recording through the real engine, fed as the microphone would,
    /// in 50 ms chunks: the words come out, and partials come before the end.
    /// `PEIKA_VOICE_RUNTIME`, `PEIKA_VOICE_MODEL`, `PEIKA_VOICE_FAMILY`
    /// (transducer for Parakeet), `PEIKA_VOICE_DETECTOR`, and
    /// `PEIKA_DICTATION_WAV` (16 kHz 16-bit mono) with `PEIKA_DICTATION_SAID`,
    /// a word that must be in the text.
    /// `cargo test -p peika speech::dictate -- --ignored --nocapture`
    #[cfg(all(windows, debug_assertions))]
    #[test]
    #[ignore = "needs the downloaded engine and a recording"]
    fn a_recording_is_written_down_as_it_is_said() {
        use crate::speech::{capture::played::wav_samples, sherpa, vad};
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
        let path = |name: &str| std::path::PathBuf::from(var(name));
        let engine = sherpa::Engine::load(&path("PEIKA_VOICE_RUNTIME"), &path("PEIKA_VOICE_MODEL"), sherpa::test_family()).expect("engine");
        vad::takes_long_sentences(true);
        let detector = sherpa::Detector::load(&path("PEIKA_VOICE_RUNTIME"), &path("PEIKA_VOICE_DETECTOR"), vad::SILENCE_SECONDS).expect("detector");
        let mut samples = wav_samples(&std::fs::read(path("PEIKA_DICTATION_WAV")).unwrap()).expect("16 kHz mono wav");
        // A little quiet after, as when the key is let go a moment later.
        samples.extend(std::iter::repeat_n(0.0, vad_rate() / 2));

        let loudest = samples.chunks(vad_rate() / 20).map(vad::loudness).fold(0.0f32, f32::max);
        let quietest = samples.chunks(vad_rate() / 20).map(vad::loudness).fold(1.0f32, f32::min);
        println!("loudness: quietest {quietest:.2}, loudest {loudest:.2}");
        let mut dictator = Dictator::new(&engine, vad::Sentences::of_voices(detector));
        let mut now = Instant::now();
        let mut partials = Vec::new();
        for chunk in samples.chunks(vad_rate() / 20) {
            now += Duration::from_millis(50);
            if let Some(text) = dictator.feed(chunk, now) {
                partials.push(text);
            }
        }
        let text = dictator.finish();
        println!("partials: {partials:?}\nfinal: {text}");
        let said = var("PEIKA_DICTATION_SAID").to_lowercase();
        assert!(text.to_lowercase().contains(&said), "{said:?} not in {text:?}");
        assert!(!partials.is_empty(), "nothing showed before the end");
    }

    #[test]
    fn only_the_running_dictation_takes_orders() {
        let order = Arc::new(AtomicU8::new(RUN));
        *RUNNING.lock().unwrap() = Some(Running { id: 7, order: order.clone() });
        finish(8);
        assert_eq!(order.load(Ordering::SeqCst), RUN);
        finish(7);
        assert_eq!(order.load(Ordering::SeqCst), FINISH);
        cancel(7);
        assert_eq!(order.load(Ordering::SeqCst), CANCEL);
        RUNNING.lock().unwrap().take();
    }
}
