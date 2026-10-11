// The model server hears: instead of a downloaded speech model, the sentence
// that was cut out of the microphone is given, as sound, to the model the
// user chose for voice (Settings → Voice → "Understand free speech with"),
// which writes down the words. Gemma 4 through Ollama does this well.
//
// The one rule, checked here before every request and nowhere else: the
// sound goes to a server on this computer or it goes nowhere. An address
// that is not 127.0.0.1 once cleaned up is refused, whatever the settings
// say, the request follows no redirect and uses no proxy, and the caller
// falls back on the bundled model. The sound is put together in memory and
// never written to disk; what was said is never logged.

// Only Windows has a listener to call this yet (mod.rs).
#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::Url;
use serde_json::{json, Value};

use super::{brain, vad};
use crate::local_chat::{self, Server};
use crate::net;
use crate::settings::Settings;

/// What `voice.hearingModel` says when the model server is to hear. Not one
/// of `engine::HEARING_MODELS`: nothing is downloaded for it.
pub const ID: &str = "server";

/// The listener waits this long and no longer: a model that is already loaded
/// answers in a fraction of a second (gemma4:e4b on a GPU: 0.15 s to 0.4 s),
/// and one that is not has not heard this sentence.
const TIMEOUT: Duration = Duration::from_millis(2500);
/// Eight seconds of speech is some thirty words.
const MAX_TOKENS: u32 = 120;
/// A model that is not in memory takes this long at most to get there
/// (gemma4:e4b: 9 s). Nothing waits for it.
const WARM_UP: Duration = Duration::from_secs(60);

/// The wording that did best of three on 69 synthesised commands with
/// gemma4:e4b (56 written whole, 5 % of words wrong), and that gets an empty
/// answer for silence, noise and a tone.
const PROMPT: &str =
    "Write down exactly what is said in this audio. Only the words, nothing else. If nothing is said, reply with nothing.";

/// A model server that may be given a sentence's sound.
pub struct Ear {
    server: Server,
    /// Its address, cleaned up and checked: on this computer.
    base: Url,
    model: String,
}

impl Ear {
        pub fn model(&self) -> &str {
        &self.model
    }
}

/// The address as requests are sent to it, when it is this computer: every
/// name of this machine becomes 127.0.0.1 when an address is cleaned up
/// (net.rs), so anything else — another machine, a name that only looks like
/// this one, an address with a user name in it — is not.
fn on_this_computer(address: &str) -> Option<Url> {
    let url = net::normalise_server_url(address).ok()?;
    (url.host_str() == Some("127.0.0.1")).then_some(url)
}

/// The server and model chosen for voice, when they may hear: a server on
/// this computer, and a model. Why not, otherwise (for the log).
pub fn ear(settings: &Settings) -> Result<Ear, &'static str> {
    let server = local_chat::server(settings, &settings.voice.brain).ok_or("no model server is chosen for voice")?;
    let model = settings.voice.brain_model.trim().to_string();
    if model.is_empty() {
        return Err("no model is chosen for voice");
    }
    let base = on_this_computer(&server.url).ok_or("the model server is not on this computer")?;
    Ok(Ear { server, base, model })
}

/// The samples as a 16-bit mono WAV file, in memory.
fn wav(samples: &[f32]) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut file = Vec::with_capacity(44 + samples.len() * 2);
    file.extend_from_slice(b"RIFF");
    file.extend_from_slice(&(36 + data).to_le_bytes());
    file.extend_from_slice(b"WAVEfmt ");
    file.extend_from_slice(&16u32.to_le_bytes());
    // PCM, one channel.
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&vad::SAMPLE_RATE.to_le_bytes());
    file.extend_from_slice(&(vad::SAMPLE_RATE * 2).to_le_bytes());
    file.extend_from_slice(&2u16.to_le_bytes());
    file.extend_from_slice(&16u16.to_le_bytes());
    file.extend_from_slice(b"data");
    file.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        file.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    file
}

fn request(model: &str, samples: &[f32]) -> Value {
    json!({
        "model": model,
        "messages": [{ "role": "user", "content": [
            { "type": "text", "text": PROMPT },
            { "type": "input_audio", "input_audio": { "data": crate::claude::base64_for(&wav(samples)), "format": "wav" } },
        ] }],
        "temperature": 0,
        "reasoning_effort": "none",
        "max_tokens": MAX_TOKENS,
        "stream": false,
    })
}

/// The words of an answer: some models put them in quotation marks all the same.
fn words(answer: &Value) -> String {
    brain::read(answer).text.trim_matches(|c: char| c.is_whitespace() || "\"'“”‘’«»".contains(c)).to_string()
}

/// What was said in `samples` (16 kHz mono, a sentence as `vad::fitting`
/// leaves it), written down by the server's model. Holds the calling thread
/// until the answer or `TIMEOUT`. An answer without words is an error too:
/// the caller then has the bundled model, or a command that was missed.
pub fn write_down(ear: &Ear, samples: &[f32]) -> Result<String, String> {
    let client = client(TIMEOUT)?;
    let body = request(&ear.model, samples);
    let answer = tauri::async_runtime::block_on(async {
        // The client's own time limit, and this one over everything.
        tokio::time::timeout(TIMEOUT, local_chat::complete_at(client, &ear.base, &ear.server, &body)).await
    })
    .map_err(|_| "no answer in time".to_string())??;
    let text = words(&answer);
    if text.is_empty() { Err("an answer without words".into()) } else { Ok(text) }
}

/// Straight to the address that was checked: no proxy, and no redirect that
/// could carry the sound somewhere else.
fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout.min(Duration::from_secs(5)))
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// A warm-up is on its way: one at a time.
static WARMING: AtomicBool = AtomicBool::new(false);

/// Gets the model into the server's memory, without waiting for it: a server
/// lets go of a model nobody asked for a few minutes (Ollama: five), loading
/// it again takes longer than `TIMEOUT`, and a request given up on stops the
/// loading. So the model is asked for one word — no sound, nothing of the
/// user's — when the listener starts and each time Coucou is woken; the
/// sentence that follows too soon is the bundled model's.
pub fn warm(ear: Ear) {
    if WARMING.swap(true, Ordering::Relaxed) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(why) = one_word(&ear).await {
            crate::log::line(format!("voice: the model server is not ready to hear: {why}"));
        }
        WARMING.store(false, Ordering::Relaxed);
    });
}

async fn one_word(ear: &Ear) -> Result<(), String> {
    let body = json!({
        "model": ear.model,
        "messages": [{ "role": "user", "content": "ok" }],
        "reasoning_effort": "none",
        "max_tokens": 1,
        "stream": false,
    });
    local_chat::complete_at(client(WARM_UP)?, &ear.base, &ear.server, &body).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_server_on_this_computer_may_hear() {
        for here in [
            "http://127.0.0.1:11434",
            "127.0.0.1:11434",
            "http://localhost:11434/v1",
            "http://LOCALHOST:1234/",
            "http://[::1]:11434",
            "https://127.0.0.1:8443/api",
        ] {
            let url = on_this_computer(here).unwrap_or_else(|| panic!("{here} is this computer"));
            assert_eq!(url.host_str(), Some("127.0.0.1"), "{here}");
        }
        for elsewhere in [
            "",
            "http://192.168.1.20:11434",
            "http://10.0.0.2:11434",
            "https://ollama.example.com",
            // Names and addresses made to look like this computer.
            "http://127.0.0.1.example.com:11434",
            "http://localhost.example.com:11434",
            "http://127.0.0.1@example.com:11434",
            "http://localhost:11434@example.com",
            "http://user:pw@127.0.0.1:11434",
            "http://example.com/127.0.0.1",
            "http://example.com:11434/?host=localhost",
            "http://example.com#@127.0.0.1",
            "http://128.0.0.1:11434",
            "http://[2001:db8::1]:11434",
            "http://[::ffff:192.168.1.20]:11434",
            "ftp://127.0.0.1",
        ] {
            assert!(on_this_computer(elsewhere).is_none(), "{elsewhere} is not this computer");
        }
    }

    #[test]
    fn the_settings_name_an_ear_only_with_a_model_and_a_server_here() {
        let mut settings = Settings::default();
        assert!(ear(&settings).is_err(), "nothing is chosen");
        settings.voice.brain = "ollama".into();
        settings.voice.brain_model = "gemma4:e4b".into();
        assert!(ear(&settings).is_err(), "the server is not connected");
        settings.ollama_url = "http://localhost:11434".into();
        let Ok(heard_by) = ear(&settings) else { panic!("a server on this computer may hear") };
        assert_eq!(heard_by.base.as_str(), "http://127.0.0.1:11434/");
        assert_eq!(heard_by.model(), "gemma4:e4b");
        settings.voice.brain_model = "  ".into();
        assert!(ear(&settings).is_err(), "no model");
        settings.voice.brain_model = "gemma4:e4b".into();
        settings.ollama_url = "http://192.168.1.20:11434".into();
        assert!(ear(&settings).is_err(), "another computer");
        settings.ollama_url = "http://127.0.0.1.example.com:11434".into();
        assert!(ear(&settings).is_err(), "a name that looks like this computer");
    }

    #[test]
    fn the_sound_is_a_wav_file_in_memory() {
        let file = wav(&[0.0, 0.5, -1.0, 2.0]);
        assert_eq!(file.len(), 44 + 8);
        assert_eq!(&file[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(file[4..8].try_into().unwrap()), 36 + 8);
        assert_eq!(&file[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes(file[22..24].try_into().unwrap()), 1, "mono");
        assert_eq!(u32::from_le_bytes(file[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(file[34..36].try_into().unwrap()), 16, "bits");
        assert_eq!(&file[36..40], b"data");
        let samples: Vec<i16> = file[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        // Too loud is as loud as can be, not the other side of zero.
        assert_eq!(samples, [0, 16383, -32767, 32767]);
    }

    #[test]
    fn the_request_carries_the_sound_and_asks_for_no_thinking() {
        let body = request("gemma4:e4b", &[0.0; 160]);
        assert_eq!(body["model"], "gemma4:e4b");
        assert_eq!(body["reasoning_effort"], "none");
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["stream"], false);
        assert!(body.get("tools").is_none());
        let parts = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts[1]["type"], "input_audio");
        assert_eq!(parts[1]["input_audio"]["format"], "wav");
        // "RIFF" in base64.
        assert!(parts[1]["input_audio"]["data"].as_str().unwrap().starts_with("UklGR"));
    }

    #[test]
    fn the_words_are_kept_without_what_a_model_puts_around_them() {
        let answer = |text: &str| json!({ "choices": [{ "message": { "content": text } }] });
        assert_eq!(words(&answer(" \"Open Figma.\"\n")), "Open Figma.");
        assert_eq!(words(&answer("<think>a voice</think>next track")), "next track");
        assert_eq!(words(&answer("“”")), "");
        assert_eq!(words(&json!({})), "");
    }

    /// The real thing: a recorded sentence, written down by a model server on
    /// this computer. `COUCOU_VOICE_WAV` is the sentence (16-bit mono); `COUCOU_VOICE_SERVER` the server's address (Ollama's usual one
    /// when not set) and `COUCOU_VOICE_SERVER_MODEL` its model (gemma4:e4b).
    /// `COUCOU_VOICE_EXPECT` may hold words the text must have.
    /// `cargo test -p coucou voice::hear -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a model server that takes audio, and a recorded sentence"]
    fn a_recorded_sentence_is_written_down_by_the_model_server() {
        let path = std::env::var("COUCOU_VOICE_WAV").expect("COUCOU_VOICE_WAV is not set");
        let bytes = std::fs::read(&path).expect("wav");
        let rate = f64::from(u32::from_le_bytes(bytes[24..28].try_into().unwrap()));
        let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        let recorded: Vec<f32> = bytes[data..].chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect();
        // To the microphone's rate, the plain way: this is a test, not the capture.
        let step = rate / f64::from(vad::SAMPLE_RATE);
        let samples: Vec<f32> = (0..(recorded.len() as f64 / step) as usize).map(|i| recorded[(i as f64 * step) as usize]).collect();
        let samples = vad::fitting(&samples);

        let mut settings = Settings::default();
        settings.voice.brain = "ollama".into();
        settings.ollama_url = std::env::var("COUCOU_VOICE_SERVER").unwrap_or_else(|_| "http://127.0.0.1:11434".into());
        settings.voice.brain_model = std::env::var("COUCOU_VOICE_SERVER_MODEL").unwrap_or_else(|_| "gemma4:e4b".into());
        let heard_by = ear(&settings).expect("a server on this computer");

        let seconds = samples.len() as f64 / f64::from(vad::SAMPLE_RATE);
        // As the listener does when Coucou is woken, but waited for here.
        let started = std::time::Instant::now();
        tauri::async_runtime::block_on(one_word(&heard_by)).expect("the model server answers");
        println!("{} · in memory after {:.2} s", heard_by.model(), started.elapsed().as_secs_f64());
        let mut last = String::new();
        for turn in 1..=4 {
            let started = std::time::Instant::now();
            let written = write_down(&heard_by, samples);
            println!("{} · {seconds:.1} s of sound · try {turn}: {:.2} s · {written:?}", heard_by.model(), started.elapsed().as_secs_f64());
            if let Ok(text) = written {
                last = text;
            }
        }
        assert!(!last.is_empty(), "nothing was written down");
        for word in std::env::var("COUCOU_VOICE_EXPECT").unwrap_or_default().to_lowercase().split_whitespace() {
            assert!(last.to_lowercase().contains(word), "{word:?} not in {last:?}");
        }
    }
}
