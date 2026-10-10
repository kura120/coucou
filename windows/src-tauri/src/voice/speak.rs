// Mochi's voice: what a command did, the answer to a question, or the question
// he asks, said out loud. Off by default, and only once the voice has been
// downloaded (engine.rs). Made on this machine, in memory, and handed to the
// island, which plays it like its other sounds — nothing is written to disk.
//
// One thread owns the voice. It is loaded the first time something is said and
// let go when speaking is turned off. A sentence asked for while another is
// being made replaces it: the last thing to say is the one worth hearing.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::engine::{self, Part};
use super::sherpa::{Speaker, Voice};
use crate::island::WINDOW_LABEL;

const EVENT: &str = "voice-speech";
/// A sentence or two: longer answers are shown, not read.
const MAX_CHARS: usize = 220;
/// The room goes on ringing a moment after the last sample.
const TAIL: Duration = Duration::from_millis(350);

struct Job {
    text: String,
    voice: Voice,
}

static SPEAKING: Mutex<Option<Sender<Job>>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Speech {
    sample_rate: u32,
    /// 16-bit mono samples, little-endian, in base64.
    pcm: String,
}

/// "female" or "male", as Settings stores it; anything else is the first.
pub fn voice_named(name: &str) -> Voice {
    if name == "male" { Voice::MALE } else { Voice::FEMALE }
}

/// What may be read out: one line of plain words, not too long. Empty when
/// there is nothing in it to say.
pub fn sayable(text: &str) -> String {
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = line.chars().take(MAX_CHARS).collect();
    if cut.chars().any(char::is_alphanumeric) { cut } else { String::new() }
}

/// Says `text`. Does nothing when the voice is not installed.
pub fn say(app: &AppHandle, text: &str, voice: Voice) {
    let text = sayable(text);
    if text.is_empty() || !engine::installed(Part::Speaking) {
        return;
    }
    let mut speaking = SPEAKING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut job = Job { text, voice };
    if let Some(tx) = speaking.as_ref() {
        match tx.send(job) {
            Ok(()) => return,
            // The thread is gone: start another.
            Err(mpsc::SendError(unsent)) => job = unsent,
        }
    }
    let (tx, rx) = mpsc::channel();
    let _ = tx.send(job);
    *speaking = Some(tx);
    let app = app.clone();
    if let Err(err) = std::thread::Builder::new().name("voice-speak".into()).spawn(move || run(&app, &rx)) {
        crate::log::line(format!("voice: no thread to speak: {err}"));
        *speaking = None;
    }
}

/// Lets go of the voice: speaking was turned off, or it is being removed.
pub fn unload() {
    *SPEAKING.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

fn run(app: &AppHandle, rx: &Receiver<Job>) {
    let speaker = match Speaker::load(&engine::runtime_dir(), &engine::model_dir(Part::Speaking)) {
        Ok(speaker) => speaker,
        Err(why) => return crate::log::line(format!("voice: cannot speak: {why}")),
    };
    crate::log::line("voice: speaking on");
    // Ends when `unload` drops the sender.
    while let Ok(mut job) = rx.recv() {
        while let Ok(newer) = rx.try_recv() {
            job = newer;
        }
        let (samples, sample_rate) = speaker.say(&job.text, job.voice);
        if samples.is_empty() || sample_rate == 0 {
            continue;
        }
        let seconds = samples.len() as f64 / f64::from(sample_rate);
        // Mochi does not listen to himself.
        super::hush(Duration::from_secs_f64(seconds) + TAIL);
        let _ = app.emit_to(WINDOW_LABEL, EVENT, Speech { sample_rate, pcm: base64(&pcm16(&samples)) });
    }
    crate::log::line("voice: speaking off");
}

fn pcm16(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16 | u32::from(*chunk.get(1).unwrap_or(&0)) << 8 | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_the_standard_one() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd, 0x00]), "//79AA==");
    }

    #[test]
    fn samples_become_sixteen_bit_and_never_wrap() {
        assert_eq!(pcm16(&[0.0, 1.0, -1.0]), [0, 0, 0xff, 0x7f, 0x01, 0x80]);
        // Past full scale is held at full scale, not wrapped round to the other side.
        assert_eq!(pcm16(&[2.5, -9.0]), [0xff, 0x7f, 0x01, 0x80]);
    }

    #[test]
    fn what_is_said_is_one_short_line_of_words() {
        assert_eq!(sayable("  GitHub\n added.  "), "GitHub added.");
        assert_eq!(sayable("…"), "");
        assert_eq!(sayable(""), "");
        assert_eq!(sayable(&"word ".repeat(200)).chars().count(), MAX_CHARS);
    }

    #[test]
    fn the_voice_is_the_one_settings_names() {
        assert_eq!(voice_named("female"), Voice::FEMALE);
        assert_eq!(voice_named("male"), Voice::MALE);
        assert_eq!(voice_named(""), Voice::FEMALE);
        assert_eq!(voice_named("robot"), Voice::FEMALE);
        // The same calm pace for both.
        assert_eq!(Voice::FEMALE.speed, Voice::MALE.speed);
        assert!(Voice::FEMALE.speed < 1.0);
    }
}
