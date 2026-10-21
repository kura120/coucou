// Getting the bundled speech engine onto the machine, when the user asks for
// it in Settings → Voice. It is not in the installer: a third-party library and
// its models, which only those who want them need. Two parts, each asked for
// on its own:
//
//   hearing   the library, a model that writes down what is said and a small
//             one that tells a voice from a noise (468 MB with the model
//             used until another is chosen; 38 MB with the smallest)
//   speaking  the library and a model that says a sentence out loud (129 MB)
//
// Archives from the projects' own releases on GitHub — or, for a model that is
// only published file by file, its files at one pinned revision — each checked
// against the SHA-256 written here before anything in it is used, then
// unpacked with the system's tar. Only the files that are needed are kept.
// What is already here is not fetched again.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::sherpa::VERSION;

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

struct Archive {
    /// Path under RELEASES, or a whole https address pinned to one revision.
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// The folder the archive unpacks to, and the files kept from it. A
    /// download that is not an archive is the one file kept.
    folder: &'static str,
    keep: &'static [&'static str],
    /// Where they go, under `dir()`.
    into: &'static str,
}

impl Archive {
    fn packed(&self) -> bool {
        self.url.ends_with(".tar.bz2")
    }

    fn address(&self) -> String {
        if self.url.starts_with("https://") { self.url.to_string() } else { format!("{RELEASES}/{}", self.url) }
    }
}

/// A file of Parakeet 0.6b v3, which is published file by file (the k2-fsa
/// project's own copy on Hugging Face), at the revision upstream Peika pins too.
macro_rules! parakeet_v3 {
    ($file:literal) => {
        concat!("https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/", $file)
    };
}

/// The library, with speech recognition and synthesis both.
const RUNTIME: Archive = Archive {
    url: "v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-lib.tar.bz2",
    sha256: "3c43d1efba780d7ae7f5d64cae08803dcecf417109a5f593684e536f3cbd5cf1",
    size: 7_383_373,
    folder: "sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-lib",
    keep: &["lib/onnxruntime.dll", "lib/sherpa-onnx-c-api.dll"],
    into: "runtime",
};

/// How a hearing model is put together, which is how it is loaded (sherpa.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// An encoder and a merged decoder.
    Moonshine,
    /// An encoder, a decoder and a joiner (NVIDIA's Parakeet).
    Transducer,
}

/// A model that writes down what is said. English, all but Parakeet v3.
pub struct Hearing {
    /// What the settings file says: never renamed.
    pub id: &'static str,
    pub name: &'static str,
    pub family: Family,
    /// What is downloaded for it: one archive, or its files one by one. All go to the same folder.
    files: &'static [Archive],
}

/// The models the user may choose from, the smallest and fastest first.
/// Measured on 69 synthesised commands (three voices, 2026-10-10), as words
/// wrong and sentences written whole — and on twelve sentences of a real voice
/// with an accent, which is what decided the default (`DEFAULT_HEARING`):
///
///   Moonshine tiny    13 %   45   real voice: 76 %   a hundredth of the sentence's length to write
///   Parakeet 110m      8 %   52               44 %   three hundredths
///   Parakeet 0.6b v2   4 %   57               15 %   a tenth: 0.3 s for a 3 s sentence
///
/// Tried and left out: Moonshine base (9 %, no better than Parakeet 110m for
/// its size), Canary 180m (7 %, three times slower than Parakeet 110m) and
/// Whisper base.en and small.en (8 % and 5 %, three and nine times slower than
/// the Parakeet next to them).
pub const HEARING_MODELS: &[Hearing] = &[
    // MIT.
    Hearing {
        id: "moonshine-tiny",
        name: "Moonshine tiny",
        family: Family::Moonshine,
        files: &[Archive {
            url: "asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2",
            sha256: "9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d",
            size: 29_858_559,
            folder: "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27",
            keep: &["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt", "LICENSE"],
            into: "moonshine-tiny-en",
        }],
    },
    // NVIDIA's, CC BY 4.0; quantised.
    Hearing {
        id: "parakeet-110m",
        name: "Parakeet 110m",
        family: Family::Transducer,
        files: &[Archive {
            url: "asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2",
            sha256: "f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b",
            size: 108_035_095,
            folder: "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8",
            keep: &["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
            into: "parakeet-110m-en",
        }],
    },
    Hearing {
        id: "parakeet-0.6b",
        name: "Parakeet 0.6b",
        family: Family::Transducer,
        files: &[Archive {
            url: "asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
            sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
            size: 482_468_385,
            folder: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
            keep: &["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
            into: "parakeet-0.6b-v2-en",
        }],
    },
    // The same model trained on 25 European languages, which it tells apart
    // by itself. Not measured here yet. Published as separate files, pinned
    // to one revision with each file's SHA-256 (as upstream Peika's speech/mod.rs).
    Hearing {
        id: "parakeet-0.6b-v3",
        name: "Parakeet 0.6b v3 (25 languages)",
        family: Family::Transducer,
        files: &[
            Archive {
                url: parakeet_v3!("encoder.int8.onnx"),
                sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
                size: 652_184_281,
                folder: "",
                keep: &["encoder.int8.onnx"],
                into: "parakeet-0.6b-v3",
            },
            Archive {
                url: parakeet_v3!("decoder.int8.onnx"),
                sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
                size: 11_845_275,
                folder: "",
                keep: &["decoder.int8.onnx"],
                into: "parakeet-0.6b-v3",
            },
            Archive {
                url: parakeet_v3!("joiner.int8.onnx"),
                sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
                size: 6_355_277,
                folder: "",
                keep: &["joiner.int8.onnx"],
                into: "parakeet-0.6b-v3",
            },
            Archive {
                url: parakeet_v3!("tokens.txt"),
                sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
                size: 93_939,
                folder: "",
                keep: &["tokens.txt"],
                into: "parakeet-0.6b-v3",
            },
        ],
    },
];

/// The model used until another is chosen: the only one that wrote a real
/// voice down well enough to act on, at the price of the largest download.
pub const DEFAULT_HEARING: &str = "parakeet-0.6b";

fn default_at() -> usize {
    HEARING_MODELS.iter().position(|model| model.id == DEFAULT_HEARING).unwrap_or(0)
}

/// Which of them is the hearing model: its place in the list above. Set from
/// the settings before anything listens.
static CHOSEN: AtomicUsize = AtomicUsize::new(0);

/// The settings name a hearing model; one they do not know is the default.
/// When they name the model server instead (hear.rs), this is the model that
/// hears a sentence the server did not: the smallest that is installed.
/// Returns its place in the list, for whoever must notice a change.
pub fn choose(id: &str) -> usize {
    let at = if id == super::hear::ID {
        HEARING_MODELS.iter().position(Hearing::installed).unwrap_or(0)
    } else {
        HEARING_MODELS.iter().position(|model| model.id == id).unwrap_or_else(default_at)
    };
    CHOSEN.store(at, Ordering::Relaxed);
    at
}

/// The hearing model in use.
pub fn hearing() -> &'static Hearing {
    &HEARING_MODELS[CHOSEN.load(Ordering::Relaxed).min(HEARING_MODELS.len() - 1)]
}

impl Hearing {
    pub fn installed(&self) -> bool {
        self.files.iter().all(present)
    }

    pub fn download_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }
}

/// Silero VAD (MIT): says whether a sound is a voice, so that typing is not
/// cut out as a sentence and written down.
const DETECTOR: Archive = Archive {
    url: "asr-models/silero_vad.onnx",
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    size: 643_854,
    folder: "",
    keep: &["silero_vad.onnx"],
    into: "silero-vad",
};

/// Supertonic 3, quantised: the voice that was picked by ear among Kokoro,
/// Kitten, Piper and Pocket for being calm. Its code is MIT, its model
/// OpenRAIL-M; it needs no pronunciation data of another licence.
const SPEAKING: Archive = Archive {
    url: "tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2",
    sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
    size: 128_774_318,
    folder: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
    keep: &[
        "duration_predictor.int8.onnx",
        "text_encoder.int8.onnx",
        "vector_estimator.int8.onnx",
        "vocoder.int8.onnx",
        "tts.json",
        "unicode_indexer.bin",
        "voice.bin",
        "LICENSE",
    ],
    into: "supertonic-3",
};

/// What can be asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Hearing,
    Speaking,
}

impl Part {
    /// The model's downloads: one archive, or a model's files one by one, all into one folder.
    fn model(self) -> &'static [Archive] {
        match self {
            Part::Hearing => hearing().files,
            Part::Speaking => std::slice::from_ref(&SPEAKING),
        }
    }

    /// Everything this part is made of, the library first.
    fn archives(self) -> Vec<&'static Archive> {
        let mut all = vec![&RUNTIME];
        all.extend(self.model());
        if self == Part::Hearing {
            all.push(&DETECTOR);
        }
        all
    }
}

/// Everything of the engine lives here; removing the folder removes it.
pub fn dir() -> PathBuf {
    crate::settings::local_dir().join("voice").join(format!("sherpa-onnx-{VERSION}"))
}

pub fn runtime_dir() -> PathBuf {
    dir().join(RUNTIME.into)
}

pub fn model_dir(part: Part) -> PathBuf {
    dir().join(part.model()[0].into)
}

pub fn detector_file() -> PathBuf {
    dir().join(DETECTOR.into).join(DETECTOR.keep[0])
}

fn kept(archive: &Archive) -> impl Iterator<Item = PathBuf> + '_ {
    let base = dir().join(archive.into);
    archive.keep.iter().map(move |file| base.join(Path::new(file).file_name().unwrap_or_default()))
}

fn present(archive: &Archive) -> bool {
    kept(archive).all(|path| path.is_file())
}

pub fn installed(part: Part) -> bool {
    cfg!(windows) && part.archives().iter().all(|archive| present(archive))
}

/// What asking for this part downloads now: what it is made of and is not
/// here yet — not the library when the other part has brought it already.
pub fn download_bytes(part: Part) -> u64 {
    part.archives().iter().filter(|archive| !present(archive)).map(|archive| archive.size).sum()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    part: Part,
    /// 0…1 while it downloads, 1 when it is installed.
    done: f64,
    installed: bool,
    /// Why it stopped, when it did.
    error: Option<String>,
}

const PROGRESS_EVENT: &str = "voice-engine";

fn report(app: &AppHandle, part: Part, done: f64, installed: bool, error: Option<String>) {
    let _ = app.emit(PROGRESS_EVENT, Progress { part, done, installed, error });
}

/// A tool of the system's own, by its full path: never whatever `tar` or
/// `certutil` happens to be first on PATH.
#[cfg(windows)]
fn system_tool(name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(name)
}

#[cfg(windows)]
fn sha256(file: &Path) -> Result<String, String> {
    let out = crate::platform::no_console(Command::new(system_tool("certutil.exe")).arg("-hashfile").arg(file).arg("SHA256"))
        .output()
        .map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|line| line.trim().replace(' ', "").to_lowercase())
        .find(|line| line.len() == 64 && line.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "the download could not be checked".to_string())
}

#[cfg(windows)]
fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let status = crate::platform::no_console(
        Command::new(system_tool("tar.exe")).arg("-xjf").arg(archive).arg("-C").arg(into),
    )
    .status()
    .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("the download could not be unpacked".into()) }
}

/// Downloads `archive` to `to`, saying how far along the whole job is:
/// `before` bytes were fetched already, of `total`.
#[cfg(windows)]
async fn fetch(app: &AppHandle, part: Part, archive: &Archive, to: &Path, before: u64, total: u64) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let url = reqwest::Url::parse(&archive.address()).map_err(|e| e.to_string())?;
    // A quarter of an hour for what is small, an hour for the largest model.
    let patience = Duration::from_secs(if archive.size > 200_000_000 { 3600 } else { 900 });
    let mut reply = crate::net::client(&url, patience)?.get(url).send().await.map_err(|e| e.to_string())?;
    if !reply.status().is_success() {
        return Err(format!("HTTP {}", reply.status().as_u16()));
    }
    let mut file = tokio::fs::File::create(to).await.map_err(|e| e.to_string())?;
    let mut got = 0u64;
    let mut last = 0.0;
    while let Some(chunk) = reply.chunk().await.map_err(|e| e.to_string())? {
        got += chunk.len() as u64;
        // Bigger than what was promised is not the file this was written for.
        if got > archive.size {
            return Err("the download is not the expected file".into());
        }
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        let done = (before + got) as f64 / total as f64;
        if done - last >= 0.01 {
            last = done;
            report(app, part, done.min(0.99), false, None);
        }
    }
    file.flush().await.map_err(|e| e.to_string())
}

#[cfg(windows)]
async fn install_one(app: &AppHandle, part: Part, archive: &'static Archive, before: u64, total: u64) -> Result<(), String> {
    let base = dir();
    let work = base.join(format!("download-{}", archive.into));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let file = work.join("download");
    let fetched = fetch(app, part, archive, &file, before, total).await;

    let target = base.join(archive.into);
    let result = match fetched {
        Err(why) => Err(why),
        Ok(()) => tokio::task::spawn_blocking({
            let (file, work, target) = (file.clone(), work.clone(), target.clone());
            move || -> Result<(), String> {
                if sha256(&file)? != archive.sha256 {
                    return Err("the download does not match its checksum".into());
                }
                if archive.packed() {
                    unpack(&file, &work)?;
                }
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                for name in archive.keep {
                    let from = if archive.packed() { work.join(archive.folder).join(name) } else { file.clone() };
                    let to = target.join(Path::new(name).file_name().unwrap_or_default());
                    std::fs::copy(&from, &to).map_err(|_| format!("{name} is missing from the download"))?;
                }
                Ok(())
            }
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|done| done),
    };
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// One download at a time. Two at once — the button pressed again in a
/// Settings window opened anew, or both parts wanting the library — worked in
/// the same folder, and each wiped what the other had fetched: a model that
/// "could not be unpacked", then one that "could not be checked".
#[cfg(windows)]
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// How many downloads of each part are under way or waiting their turn.
static UNDER_WAY: [AtomicUsize; 2] = [AtomicUsize::new(0), AtomicUsize::new(0)];

/// Whether that part is being downloaded right now: Settings then offers no
/// second download of it.
pub fn downloading(part: Part) -> bool {
    UNDER_WAY[part as usize].load(Ordering::Relaxed) > 0
}

/// Counts a download for as long as it lives, however it ends.
struct Counted(Part);

impl Counted {
    fn new(part: Part) -> Self {
        UNDER_WAY[part as usize].fetch_add(1, Ordering::Relaxed);
        Self(part)
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        UNDER_WAY[self.0 as usize].fetch_sub(1, Ordering::Relaxed);
    }
}

/// Downloads, checks and unpacks one part of the engine. Progress goes out as
/// `voice-engine` events; the result is said there too. Asked for again while
/// it is under way, it waits its turn and finds everything there.
#[cfg(windows)]
pub async fn install(app: &AppHandle, part: Part) -> Result<(), String> {
    let _counted = Counted::new(part);
    report(app, part, 0.0, false, None);
    let _turn = ONE_AT_A_TIME.lock().await;
    // What was asked for: the hearing model chosen now, whatever is chosen
    // by the time it has arrived.
    let archives = part.archives();
    let missing: Vec<&'static Archive> = archives.iter().copied().filter(|archive| !present(archive)).collect();
    let total: u64 = missing.iter().map(|archive| archive.size).sum();
    let result = async {
        let mut before = 0;
        for archive in missing {
            install_one(app, part, archive, before, total).await?;
            before += archive.size;
        }
        if archives.iter().all(|archive| present(archive)) { Ok(()) } else { Err("the engine is incomplete".to_string()) }
    }
    .await;
    crate::log::line(match &result {
        Ok(()) => format!("voice: {part:?} installed"),
        Err(why) => format!("voice: {part:?} not installed: {why}"),
    });
    report(app, part, if result.is_ok() { 1.0 } else { 0.0 }, result.is_ok(), result.clone().err());
    result
}

#[cfg(not(windows))]
pub async fn install(app: &AppHandle, part: Part) -> Result<(), String> {
    let why = "the speech engine is not available on this system yet".to_string();
    report(app, part, 0.0, false, Some(why.clone()));
    Err(why)
}

/// Removes one part's models from the disk — every hearing model that was
/// ever chosen, not only today's — and the library with the last of them.
pub fn remove(part: Part) {
    let mut archives = part.archives();
    if part == Part::Hearing {
        archives.extend(HEARING_MODELS.iter().flat_map(|model| model.files));
    }
    for archive in archives.iter().filter(|archive| archive.into != RUNTIME.into) {
        let _ = std::fs::remove_dir_all(dir().join(archive.into));
    }
    let other = if part == Part::Hearing { Part::Speaking } else { Part::Hearing };
    if !other.model().iter().all(present) {
        let _ = std::fs::remove_dir_all(dir());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_is_counted_while_it_lives_and_only_for_its_part() {
        // Speaking's count is this test's alone: no other test downloads anything.
        assert!(!downloading(Part::Speaking));
        let first = Counted::new(Part::Speaking);
        let second = Counted::new(Part::Speaking);
        assert!(downloading(Part::Speaking));
        drop(first);
        assert!(downloading(Part::Speaking), "one is still waiting its turn");
        drop(second);
        assert!(!downloading(Part::Speaking));
    }

    #[test]
    fn what_is_downloaded_is_pinned() {
        let models = HEARING_MODELS.iter().flat_map(|model| model.files);
        for archive in [&RUNTIME, &DETECTOR, &SPEAKING].into_iter().chain(models) {
            assert_eq!(archive.sha256.len(), 64);
            assert!(archive.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(!archive.keep.is_empty());
            // A download that is not an archive is one file, kept under its own name.
            assert!(archive.packed() || (archive.keep.len() == 1 && archive.url.ends_with(archive.keep[0])));
        }
        assert!(detector_file().ends_with("silero_vad.onnx"));
        // The library is the version whose header sherpa.rs was written from.
        assert!(RUNTIME.url.contains(&format!("v{VERSION}")));
        // The smallest stays small, for whoever would rather have that.
        assert!(RUNTIME.size + HEARING_MODELS[0].download_bytes() + DETECTOR.size < 40 * 1024 * 1024);
        // The model nobody chose is one of the list, and the settings start with it.
        assert_eq!(HEARING_MODELS[default_at()].id, DEFAULT_HEARING);
        assert_eq!(crate::settings::VoicePref::default().hearing_model, DEFAULT_HEARING);
        assert_eq!(HEARING_MODELS[choose("a-model-of-another-build")].id, DEFAULT_HEARING);
        choose(DEFAULT_HEARING);
        // Each model has its own name and folder, and the settings' names are plain.
        for (i, model) in HEARING_MODELS.iter().enumerate() {
            assert!(model.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.'));
            assert!(HEARING_MODELS[..i].iter().all(|other| other.id != model.id && other.files[0].into != model.files[0].into));
            // A model's files all go to its one folder, and its tokens are among them.
            assert!(model.files.iter().all(|file| file.into == model.files[0].into));
            assert!(model.files.iter().any(|file| file.keep.contains(&"tokens.txt")));
            // Its files are fetched only over https, from the release page or one pinned revision.
            assert!(model.files.iter().all(|file| file.address().starts_with("https://")));
            assert!(model.files.iter().all(|file| !file.url.starts_with("https://") || file.url.contains("/resolve/") && !file.url.contains("/resolve/main/")));
            // "server" is the model server's name in the settings (hear.rs).
            assert_ne!(model.id, super::super::hear::ID);
        }
        assert!(dir().ends_with(format!("sherpa-onnx-{VERSION}")));
        assert_ne!(model_dir(Part::Hearing), model_dir(Part::Speaking));
    }

    /// The real thing: downloads nothing, but checks and unpacks archives
    /// already on disk the way `install` does. `PEIKA_VOICE_ARCHIVES` is the
    /// folder holding `runtime-lib.tar.bz2`, `moontiny.tar.bz2`,
    /// `supertonic.tar.bz2` and `silero_vad.onnx`.
    #[test]
    #[cfg(windows)]
    #[ignore = "needs the downloaded archives"]
    fn the_archives_match_their_checksums_and_hold_what_is_kept() {
        let folder = PathBuf::from(std::env::var("PEIKA_VOICE_ARCHIVES").expect("PEIKA_VOICE_ARCHIVES"));
        let work = std::env::temp_dir().join(format!("peika-voice-test-{}", std::process::id()));
        for (archive, file) in
            [(&RUNTIME, "runtime-lib.tar.bz2"), (&HEARING_MODELS[0].files[0], "moontiny.tar.bz2"), (&SPEAKING, "supertonic.tar.bz2")]
        {
            let path = folder.join(file);
            assert_eq!(std::fs::metadata(&path).unwrap().len(), archive.size, "{file}");
            assert_eq!(sha256(&path).unwrap(), archive.sha256, "{file}");
            let _ = std::fs::remove_dir_all(&work);
            std::fs::create_dir_all(&work).unwrap();
            unpack(&path, &work).unwrap();
            for name in archive.keep {
                assert!(work.join(archive.folder).join(name).is_file(), "{name}");
            }
        }
        let _ = std::fs::remove_dir_all(&work);
        // The larger hearing models, when they are there too, under their own names.
        for model in HEARING_MODELS[1..].iter().filter(|model| model.files.len() == 1) {
            let archive = &model.files[0];
            let path = folder.join(Path::new(archive.url).file_name().unwrap());
            if !path.is_file() {
                continue;
            }
            assert_eq!(std::fs::metadata(&path).unwrap().len(), archive.size, "{}", model.id);
            assert_eq!(sha256(&path).unwrap(), archive.sha256, "{}", model.id);
            let _ = std::fs::remove_dir_all(&work);
            std::fs::create_dir_all(&work).unwrap();
            unpack(&path, &work).unwrap();
            for name in archive.keep {
                assert!(work.join(archive.folder).join(name).is_file(), "{}: {name}", model.id);
            }
            let _ = std::fs::remove_dir_all(&work);
        }
        let detector = folder.join(DETECTOR.keep[0]);
        assert_eq!(std::fs::metadata(&detector).unwrap().len(), DETECTOR.size);
        assert_eq!(sha256(&detector).unwrap(), DETECTOR.sha256);
    }
}
