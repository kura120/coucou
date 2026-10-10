// Getting the bundled speech engine onto the machine, when the user asks for
// it in Settings → Voice. It is not in the installer: a third-party library and
// a model, 37 MB, that only those who want free speech need.
//
// Two archives from the project's own releases on GitHub, each checked against
// the SHA-256 written here before anything in it is used, then unpacked with
// the system's tar. Only the files that are needed are kept.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::sherpa::VERSION;

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

struct Archive {
    /// Path under RELEASES.
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// The folder the archive unpacks to, and the files kept from it.
    folder: &'static str,
    keep: &'static [&'static str],
    /// Where they go, under `dir()`.
    into: &'static str,
}

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
const MODEL: Archive = Archive {
    url: "asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2",
    sha256: "9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d",
    size: 29_858_559,
    folder: "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27",
    keep: &["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt", "LICENSE"],
    into: "moonshine-tiny-en",
};

/// What is downloaded, for the button in Settings.
pub const DOWNLOAD_BYTES: u64 = RUNTIME.size + MODEL.size;

/// Everything of the engine lives here; removing the folder removes it.
pub fn dir() -> PathBuf {
    crate::settings::local_dir().join("voice").join(format!("sherpa-onnx-{VERSION}"))
}

pub fn runtime_dir() -> PathBuf {
    dir().join(RUNTIME.into)
}

pub fn model_dir() -> PathBuf {
    dir().join(MODEL.into)
}

fn kept(archive: &Archive) -> impl Iterator<Item = PathBuf> + '_ {
    let base = dir().join(archive.into);
    archive.keep.iter().map(move |file| base.join(Path::new(file).file_name().unwrap_or_default()))
}

pub fn installed() -> bool {
    cfg!(windows) && kept(&RUNTIME).chain(kept(&MODEL)).all(|path| path.is_file())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// 0…1 while it downloads, 1 when it is installed.
    done: f64,
    installed: bool,
    /// Why it stopped, when it did.
    error: Option<String>,
}

const PROGRESS_EVENT: &str = "voice-engine";

fn report(app: &AppHandle, done: f64, installed: bool, error: Option<String>) {
    let _ = app.emit(PROGRESS_EVENT, Progress { done, installed, error });
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

async fn fetch(app: &AppHandle, archive: &Archive, to: &Path, before: u64) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let url = reqwest::Url::parse(&format!("{RELEASES}/{}", archive.url)).map_err(|e| e.to_string())?;
    let mut reply = crate::net::client(&url, Duration::from_secs(600))?.get(url).send().await.map_err(|e| e.to_string())?;
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
        let done = (before + got) as f64 / DOWNLOAD_BYTES as f64;
        if done - last >= 0.01 {
            last = done;
            report(app, done.min(0.99), false, None);
        }
    }
    file.flush().await.map_err(|e| e.to_string())
}

#[cfg(windows)]
async fn install_one(app: &AppHandle, archive: &'static Archive, before: u64) -> Result<(), String> {
    let base = dir();
    let work = base.join("download");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let file = work.join("archive.tar.bz2");
    fetch(app, archive, &file, before).await?;

    let target = base.join(archive.into);
    let result = tokio::task::spawn_blocking({
        let (file, work, target) = (file.clone(), work.clone(), target.clone());
        move || -> Result<(), String> {
            if sha256(&file)? != archive.sha256 {
                return Err("the download does not match its checksum".into());
            }
            unpack(&file, &work)?;
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            for name in archive.keep {
                let from = work.join(archive.folder).join(name);
                let to = target.join(Path::new(name).file_name().unwrap_or_default());
                std::fs::copy(&from, &to).map_err(|_| format!("{name} is missing from the download"))?;
            }
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Downloads, checks and unpacks the engine. Progress goes out as
/// `voice-engine` events; the result is said there too.
#[cfg(windows)]
pub async fn install(app: &AppHandle) -> Result<(), String> {
    report(app, 0.0, false, None);
    let result = async {
        install_one(app, &RUNTIME, 0).await?;
        install_one(app, &MODEL, RUNTIME.size).await?;
        if installed() { Ok(()) } else { Err("the engine is incomplete".to_string()) }
    }
    .await;
    crate::log::line(match &result {
        Ok(()) => "voice: engine installed".to_string(),
        Err(why) => format!("voice: engine not installed: {why}"),
    });
    report(app, if result.is_ok() { 1.0 } else { 0.0 }, result.is_ok(), result.clone().err());
    result
}

#[cfg(not(windows))]
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let why = "the speech engine is not available on this system yet".to_string();
    report(app, 0.0, false, Some(why.clone()));
    Err(why)
}

/// Removes the engine and its model from the disk.
pub fn remove() {
    let _ = std::fs::remove_dir_all(dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_downloaded_is_pinned_and_small() {
        for archive in [&RUNTIME, &MODEL] {
            assert_eq!(archive.sha256.len(), 64);
            assert!(archive.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(archive.url.ends_with(".tar.bz2"));
            assert!(!archive.keep.is_empty());
        }
        // The library is the version whose header sherpa.rs was written from.
        assert!(RUNTIME.url.contains(&format!("v{VERSION}")));
        assert!(DOWNLOAD_BYTES < 40 * 1024 * 1024);
        assert!(dir().ends_with(format!("sherpa-onnx-{VERSION}")));
    }

    /// The real thing: downloads nothing, but checks and unpacks archives
    /// already on disk the way `install` does. `COUCOU_VOICE_ARCHIVES` is the
    /// folder holding `runtime-lib.tar.bz2` and `moontiny.tar.bz2`.
    #[test]
    #[cfg(windows)]
    #[ignore = "needs the downloaded archives"]
    fn the_archives_match_their_checksums_and_hold_what_is_kept() {
        let folder = PathBuf::from(std::env::var("COUCOU_VOICE_ARCHIVES").expect("COUCOU_VOICE_ARCHIVES"));
        let work = std::env::temp_dir().join(format!("coucou-voice-test-{}", std::process::id()));
        for (archive, file) in [(&RUNTIME, "runtime-lib.tar.bz2"), (&MODEL, "moontiny.tar.bz2")] {
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
    }
}
