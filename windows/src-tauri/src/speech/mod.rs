// The speech service: turning the microphone into text, for whoever asks.
//
// Voice ("OK Peika") was its first user and these parts were written for it
// (src/voice/). They live here so dictation and the Notetaker use the same
// engine, the same downloaded models and the same microphone code, rather
// than a second copy of each:
//
// - engine.rs: the bundled engine's parts (the runtime, the hearing models,
//   the voice detector, the speaking voice), downloaded on request into the
//   user's folder and pinned by SHA-256.
// - sherpa.rs: sherpa-onnx, loaded from that folder as a DLL. Nothing of it is
//   linked into the installer.
// - capture.rs: the default microphone through WASAPI, 16 kHz mono (Windows).
// - vad.rs: sentences cut out of what the microphone hears.
// - mic.rs: who listens. WASAPI lets several readers share the microphone, so
//   the rule is about listening, not the device: while someone dictates or a
//   note records, voice stands aside, or it would take their words for
//   commands, and it comes back after.
//
// The rules are voice's, and hold for every user: nothing is recorded unless a
// feature that writes audio says so with its own switch, what the microphone
// hears stays on this machine, and the log never says what was heard.

#[cfg(windows)]
pub mod capture;
pub mod engine;
pub mod mic;
pub mod sherpa;
pub mod vad;

/// Why the microphone cannot be read.
#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum MicError {
    /// No microphone, or Windows refuses it to desktop apps.
    Missing,
    Error(String),
}

#[cfg(windows)]
impl MicError {
    fn error(err: windows::core::Error) -> Self {
        Self::Error(format!("{:#010x}", err.code().0))
    }
}
