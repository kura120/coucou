// Getting the bundled speech engine onto the machine, when the user asks for
// it in Settings → Voice. It is not in the installer: a third-party library and
// its models, which only those who want them need. Two parts, each asked for
// on its own:
//
//   hearing   the library, a model that writes down what is said and a small
//             one that tells a voice from a noise (38 MB)
//   speaking  the library and a model that says a sentence out loud (129 MB)
//
// Archives from the projects' own releases on GitHub, each checked against the
// SHA-256 written here before anything in it is used, then unpacked with the
// system's tar. Only the files that are needed are kept. What is already here
// is not fetched again.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::sherpa::VERSION;

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

struct Archive {
    /// Path under RELEASES.
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

/// Moonshine tiny, English, quantised (MIT). On 54 synthesised commands it got
/// 12 % of the words wrong; the streaming model tried first got 54 %.
const HEARING: Archive = Archive {
    url: "asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2",
    sha256: "9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d",
    size: 29_858_559,
    folder: "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27",
    keep: &["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt", "LICENSE"],
    into: "moonshine-tiny-en",
};

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
    fn model(self) -> &'static Archive {
        match self {
            Part::Hearing => &HEARING,
            Part::Speaking => &SPEAKING,
        }
    }

    /// Everything this part is made of, the library first.
    fn archives(self) -> &'static [&'static Archive] {
        match self {
            Part::Hearing => &[&RUNTIME, &HEARING, &DETECTOR],
            Part::Speaking => &[&RUNTIME, &SPEAKING],
        }
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
    dir().join(part.model().into)
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
    let url = reqwest::Url::parse(&format!("{RELEASES}/{}", archive.url)).map_err(|e| e.to_string())?;
    let mut reply = crate::net::client(&url, Duration::from_secs(900))?.get(url).send().await.map_err(|e| e.to_string())?;
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

/// Downloads, checks and unpacks one part of the engine. Progress goes out as
/// `voice-engine` events; the result is said there too.
#[cfg(windows)]
pub async fn install(app: &AppHandle, part: Part) -> Result<(), String> {
    report(app, part, 0.0, false, None);
    let total = download_bytes(part);
    let result = async {
        let mut before = 0;
        for archive in part.archives().iter().copied().filter(|archive| !present(archive)) {
            install_one(app, part, archive, before, total).await?;
            before += archive.size;
        }
        if installed(part) { Ok(()) } else { Err("the engine is incomplete".to_string()) }
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

/// Removes one part's model from the disk, and the library with the last of them.
pub fn remove(part: Part) {
    for archive in part.archives().iter().filter(|archive| archive.into != RUNTIME.into) {
        let _ = std::fs::remove_dir_all(dir().join(archive.into));
    }
    let other = if part == Part::Hearing { Part::Speaking } else { Part::Hearing };
    if !present(other.model()) {
        let _ = std::fs::remove_dir_all(dir());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_downloaded_is_pinned() {
        for archive in [&RUNTIME, &HEARING, &DETECTOR, &SPEAKING] {
            assert_eq!(archive.sha256.len(), 64);
            assert!(archive.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(!archive.keep.is_empty());
            // A download that is not an archive is one file, kept under its own name.
            assert!(archive.packed() || (archive.keep.len() == 1 && archive.url.ends_with(archive.keep[0])));
        }
        assert!(detector_file().ends_with("silero_vad.onnx"));
        // The library is the version whose header sherpa.rs was written from.
        assert!(RUNTIME.url.contains(&format!("v{VERSION}")));
        assert!(RUNTIME.size + HEARING.size + DETECTOR.size < 40 * 1024 * 1024);
        assert!(dir().ends_with(format!("sherpa-onnx-{VERSION}")));
        assert_ne!(model_dir(Part::Hearing), model_dir(Part::Speaking));
    }

    /// The real thing: downloads nothing, but checks and unpacks archives
    /// already on disk the way `install` does. `COUCOU_VOICE_ARCHIVES` is the
    /// folder holding `runtime-lib.tar.bz2`, `moontiny.tar.bz2`,
    /// `supertonic.tar.bz2` and `silero_vad.onnx`.
    #[test]
    #[cfg(windows)]
    #[ignore = "needs the downloaded archives"]
    fn the_archives_match_their_checksums_and_hold_what_is_kept() {
        let folder = PathBuf::from(std::env::var("COUCOU_VOICE_ARCHIVES").expect("COUCOU_VOICE_ARCHIVES"));
        let work = std::env::temp_dir().join(format!("coucou-voice-test-{}", std::process::id()));
        for (archive, file) in [(&RUNTIME, "runtime-lib.tar.bz2"), (&HEARING, "moontiny.tar.bz2"), (&SPEAKING, "supertonic.tar.bz2")] {
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
        let detector = folder.join(DETECTOR.keep[0]);
        assert_eq!(std::fs::metadata(&detector).unwrap().len(), DETECTOR.size);
        assert_eq!(sha256(&detector).unwrap(), DETECTOR.sha256);
    }
}
