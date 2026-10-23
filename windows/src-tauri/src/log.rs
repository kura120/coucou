// Small append-only log at %LOCALAPPDATA%\Peika\peika.log (Windows) or
// ~/.local/share/peika/peika.log (Linux) — the equivalent of nbLog() in
// HookServer.swift. Nothing leaves the machine.
//
// One file stays open behind a lock instead of being opened for every line.
// Past about 1 MB it moves to peika.1.log and a new peika.log starts, so the
// history just before a problem is still there.

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use crate::{platform, settings};

const LOG: &str = "peika.log";
/// The previous log, kept after a rotation (replaced by the next one).
const OLD: &str = "peika.1.log";
/// Past this size (bytes) the log is rotated before the next line.
const LIMIT: u64 = 1_000_000;

/// The open log file, or None while it is not open (yet, or any more).
static WRITER: Mutex<Option<File>> = Mutex::new(None);

pub fn line(message: impl AsRef<str>) {
    let t = platform::local_time();
    let text = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} {}\n",
        t.year,
        t.month,
        t.day,
        t.hour,
        t.minute,
        t.second,
        message.as_ref()
    );
    let dir = settings::local_dir();
    let mut writer = WRITER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    write_line(&mut writer, &dir, LIMIT, &text);
}

/// Appends `text` (one whole line, newline included) to `dir`/peika.log,
/// keeping `slot` open between calls.
fn write_line(slot: &mut Option<File>, dir: &Path, limit: u64, text: &str) {
    let path = dir.join(LOG);
    // One stat per line: its size decides a rotation, and when the file is gone
    // (deleted or renamed), the handle we hold writes to nothing anyone can read.
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > limit => {
            *slot = None;
            rotate(dir);
        }
        Ok(_) => {}
        Err(_) => *slot = None,
    }
    // A write that fails drops the handle, and the second pass reopens it once.
    for _ in 0..2 {
        if slot.is_none() {
            match open(dir) {
                Ok(file) => *slot = Some(file),
                Err(_) => return,
            }
        }
        if let Some(file) = slot.as_mut() {
            if file.write_all(text.as_bytes()).is_ok() {
                return;
            }
        }
        *slot = None;
    }
}

/// Moves the full log to peika.1.log, replacing the one before, so the next
/// line starts a new peika.log. The caller has closed its handle first.
fn rotate(dir: &Path) {
    let path = dir.join(LOG);
    if std::fs::rename(&path, dir.join(OLD)).is_err() {
        // Could not move it (another program may have it open): start over instead.
        let _ = std::fs::remove_file(&path);
    }
}

fn open(dir: &Path) -> std::io::Result<File> {
    platform::ensure_private_dir(dir)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    // Readable by us only, like the macOS log.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(dir.join(LOG))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed when dropped.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir()
                .join(format!("peika-log-{name}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn read(dir: &Path, name: &str) -> String {
        std::fs::read_to_string(dir.join(name)).unwrap_or_default()
    }

    #[test]
    fn lines_are_appended_in_order() {
        let tmp = TempDir::new("order");
        let mut slot = None;
        write_line(&mut slot, tmp.path(), LIMIT, "one\n");
        write_line(&mut slot, tmp.path(), LIMIT, "two\n");
        write_line(&mut slot, tmp.path(), LIMIT, "three\n");
        assert_eq!(read(tmp.path(), LOG), "one\ntwo\nthree\n");
    }

    /// A line of 29 bytes, so a 50-byte limit is passed by the third one.
    fn numbered(n: u32) -> String {
        format!("line {n:02} {}\n", "x".repeat(20))
    }

    #[test]
    fn past_the_limit_the_old_log_becomes_peika_1_and_a_new_one_starts() {
        let tmp = TempDir::new("rotate");
        let mut slot = None;
        for n in 1..=3 {
            write_line(&mut slot, tmp.path(), 50, &numbered(n));
        }
        assert_eq!(
            read(tmp.path(), OLD),
            format!("{}{}", numbered(1), numbered(2))
        );
        assert_eq!(read(tmp.path(), LOG), numbered(3));
    }

    #[test]
    fn a_second_rotation_replaces_peika_1() {
        let tmp = TempDir::new("rotate-twice");
        let mut slot = None;
        for n in 1..=5 {
            write_line(&mut slot, tmp.path(), 50, &numbered(n));
        }
        assert_eq!(
            read(tmp.path(), OLD),
            format!("{}{}", numbered(3), numbered(4))
        );
        assert_eq!(read(tmp.path(), LOG), numbered(5));
    }

    #[cfg(unix)]
    #[test]
    fn a_removed_log_is_started_again() {
        // Only on Unix: Windows does not let a program delete a file another one has open.
        let tmp = TempDir::new("removed");
        let mut slot = None;
        write_line(&mut slot, tmp.path(), LIMIT, "before\n");
        std::fs::remove_file(tmp.path().join(LOG)).unwrap();
        write_line(&mut slot, tmp.path(), LIMIT, "after\n");
        assert_eq!(read(tmp.path(), LOG), "after\n");
    }
}
