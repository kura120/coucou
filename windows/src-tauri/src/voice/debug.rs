// The voice debug log, opt-in (Settings → Voice → "Keep a debug log"): every
// turn — what was heard, what the embedding model ranked, what the models
// were asked and answered, what ran and what came of it, what Mochi said — is
// written to voice-debug.log beside coucou.log, on this computer only. It is
// the one place what was said is written down, and only while the user has
// it on: turning it off deletes the file. coucou.log still never holds it.
//
// The island writes the lines (src/voice/turn.ts `trace`); Rust checks the
// setting again before each write, so a line sent after it was turned off is
// dropped.

use std::io::Write;
use std::path::PathBuf;

use tauri::State;

use crate::{platform, settings};

/// Past this the file starts again, the last one kept as voice-debug.old.log.
const MOST_BYTES: u64 = 5_000_000;
/// What one call may write: a turn's lines, each cut.
const MOST_LINES: usize = 200;
const MOST_LINE: usize = 8_000;

pub fn file() -> PathBuf {
    settings::local_dir().join("voice-debug.log")
}

fn old_file() -> PathBuf {
    settings::local_dir().join("voice-debug.old.log")
}

/// The lines, each with the time, as they are written.
pub fn stamped(lines: &[String], stamp: &str) -> String {
    lines
        .iter()
        .take(MOST_LINES)
        .map(|line| {
            let cut: String = line.chars().take(MOST_LINE).collect();
            // One line in the file for one line given: what spans lines is kept on one.
            format!("{stamp} {}\n", cut.replace(['\r', '\n'], " ⏎ "))
        })
        .collect()
}

fn write(lines: &[String]) {
    let t = platform::local_time();
    let stamp = format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", t.year, t.month, t.day, t.hour, t.minute, t.second);
    let dir = settings::local_dir();
    if platform::ensure_private_dir(&dir).is_err() {
        return;
    }
    let path = file();
    if std::fs::metadata(&path).map(|m| m.len() > MOST_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, old_file());
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    if let Ok(mut out) = options.open(path) {
        let _ = out.write_all(stamped(lines, &stamp).as_bytes());
    }
}

/// Appends a turn's lines, only while the debug log is on.
#[tauri::command]
pub fn voice_debug_log(shared: State<crate::Shared>, lines: Vec<String>) {
    let on = shared.settings.lock().map(|s| s.voice.debug_log).unwrap_or(false);
    if on && !lines.is_empty() {
        write(&lines);
    }
}

/// Deletes the log and the one before it: done when the user turns it off.
#[tauri::command]
pub fn voice_debug_clear() {
    let _ = std::fs::remove_file(file());
    let _ = std::fs::remove_file(old_file());
}

/// Opens the folder that holds the log.
#[tauri::command]
pub fn voice_debug_reveal() {
    let dir = settings::local_dir();
    let _ = std::fs::create_dir_all(&dir);
    platform::reveal_folder(&dir.to_string_lossy());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_line_is_one_line_stamped_and_bounded() {
        let lines = vec!["heard: pause the music".to_string(), "model said:\nPaused.".to_string(), "x".repeat(MOST_LINE + 50)];
        let out = stamped(&lines, "2026-10-18 12:00:00");
        let written: Vec<&str> = out.lines().collect();
        assert_eq!(written.len(), 3);
        assert_eq!(written[0], "2026-10-18 12:00:00 heard: pause the music");
        assert_eq!(written[1], "2026-10-18 12:00:00 model said: ⏎ Paused.");
        assert_eq!(written[2].chars().count(), "2026-10-18 12:00:00 ".len() + MOST_LINE);
        let many: Vec<String> = (0..MOST_LINES + 10).map(|i| i.to_string()).collect();
        assert_eq!(stamped(&many, "t").lines().count(), MOST_LINES);
    }

    #[test]
    fn the_log_is_its_own_file_beside_coucou_log() {
        assert!(file().ends_with("voice-debug.log"));
        assert_eq!(file().parent(), old_file().parent());
        assert_ne!(file(), settings::local_dir().join("coucou.log"));
    }
}
