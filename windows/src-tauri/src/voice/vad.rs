// Is someone speaking? Port of EnergyVAD.swift: plain arithmetic on how loud
// each short frame is, against a noise floor it learns. And, on top of it, the
// sentence itself: the samples from a little before speech started to the
// silence that ended it, kept in memory only until they are written down.
//
// Loudness cannot tell a voice from a keyboard. With the bundled engine a
// small model says who is speaking instead (sherpa.rs `Detector`), and the
// arithmetic stays for when that model is not there.

use super::sherpa;

/// 16 kHz mono is what the recogniser wants and what the capture gives.
pub const SAMPLE_RATE: u32 = 16_000;
/// About 23 ms: the Mac's 43 frames a second.
pub const FRAME: usize = 372;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    None,
    Start,
    End,
}

/// Frames before anything may trigger: about half a second of learning the room.
const CALIBRATION_FRAMES: u32 = 22;
/// Power over noise that starts a segment, and under which a frame is silence.
const RISE: f64 = 8.0;
const FALL: f64 = 2.0;
/// About 800 ms of silence ends a segment.
const SILENCE_FRAMES: u32 = 35;
/// About 7 s: continuous noise — music, a fan — is not one endless sentence,
/// and the model that writes a sentence down fails on ten seconds or more
/// (measured: 8 s is written, 10 s is not). A command is shorter than that.
const MAX_ACTIVE_FRAMES: u32 = 300;

/// The most that is ever handed to the model: 8 s.
pub const LONGEST: usize = (SAMPLE_RATE as usize) * 8;

/// A sentence as the model can take it: its last eight seconds at most.
pub fn fitting(sentence: &[f32]) -> &[f32] {
    &sentence[sentence.len().saturating_sub(LONGEST)..]
}

#[derive(Debug, Clone)]
pub struct EnergyVad {
    active: bool,
    noise: f64,
    calibrated: u32,
    silent: u32,
    active_frames: u32,
    segment_sum: f64,
    segment_count: u32,
}

impl Default for EnergyVad {
    fn default() -> Self {
        Self { active: false, noise: 1e-7, calibrated: 0, silent: 0, active_frames: 0, segment_sum: 0.0, segment_count: 0 }
    }
}

impl EnergyVad {
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Back to "nobody is speaking", keeping what was learnt of the room.
    pub fn reset(&mut self) {
        self.active = false;
        self.silent = 0;
        self.active_frames = 0;
        self.segment_sum = 0.0;
        self.segment_count = 0;
    }

    /// One frame's mean-square power.
    pub fn feed(&mut self, power: f64) -> Event {
        if self.calibrated < CALIBRATION_FRAMES {
            self.calibrated += 1;
            self.noise = self.noise * 0.85 + power * 0.15;
            return Event::None;
        }
        if !self.active {
            self.noise = self.noise * 0.995 + power * 0.005;
            if power > self.noise * RISE {
                self.active = true;
                self.silent = 0;
                self.active_frames = 0;
                self.segment_sum = power;
                self.segment_count = 1;
                return Event::Start;
            }
            return Event::None;
        }
        self.active_frames += 1;
        self.segment_sum += power;
        self.segment_count += 1;
        if self.active_frames >= MAX_ACTIVE_FRAMES {
            // Music or a fan: that is the room now.
            self.noise = self.segment_sum / f64::from(self.segment_count.max(1));
            self.reset();
            return Event::End;
        }
        if power < self.noise * FALL {
            self.silent += 1;
            self.noise = self.noise * 0.999 + power * 0.001;
            if self.silent >= SILENCE_FRAMES {
                self.reset();
                return Event::End;
            }
        } else {
            self.silent = 0;
        }
        Event::None
    }
}

/// What is kept from before speech was noticed, so its first sound is not cut.
const LEAD_IN: usize = (SAMPLE_RATE as usize) * 3 / 10;
/// The silence that ends a sentence, which is still at its end.
const TRAILING: usize = SILENCE_FRAMES as usize * FRAME;
/// The same, as the voice detector is told it.
pub const SILENCE_SECONDS: f32 = TRAILING as f32 / SAMPLE_RATE as f32;
/// Under this much speech after the wake phrase, nothing was said after it.
const SHORTEST_TAIL: usize = (SAMPLE_RATE as usize) * 35 / 100;
/// The cut is made a little before the wake phrase is said to end: the two
/// clocks are not the same one, and a command's first sound matters more than
/// the wake phrase's last.
const CUT_EARLY: usize = (SAMPLE_RATE as usize) * 5 / 100;

/// For a sentence (as `Sentences` gives it) that began with the wake phrase,
/// which ended `wake` after speech started: where what was said after it
/// begins, or None when nothing was — the wake phrase alone.
pub fn after_wake(sentence_len: usize, wake: std::time::Duration) -> Option<usize> {
    let wake_end = LEAD_IN + (wake.as_secs_f64() * f64::from(SAMPLE_RATE)) as usize;
    let speech_end = sentence_len.saturating_sub(TRAILING);
    (speech_end >= wake_end + SHORTEST_TAIL).then(|| wake_end.saturating_sub(CUT_EARLY))
}
/// A sound shorter than this is a click or a cough, not a sentence.
const SHORTEST: usize = (SAMPLE_RATE as usize) * 3 / 10;

/// How loud these samples are, for the island's glow: 0 for a quiet room,
/// 1 for a voice close to the microphone (-55 dB to -15 dB).
pub fn loudness(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let power = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum::<f64>() / samples.len() as f64;
    let decibels = 10.0 * power.max(1e-12).log10();
    ((decibels + 55.0) / 40.0).clamp(0.0, 1.0) as f32
}

/// The level the island is told: it rises at once and falls away gently, and
/// silence is said once, not fifteen times a second.
#[derive(Default)]
pub struct Level {
    shown: f32,
}

impl Level {
    /// `peak`: the loudest since the last time. What to tell the island, if anything.
    pub fn step(&mut self, peak: f32) -> Option<f32> {
        let level = peak.max(self.shown * 0.7);
        let level = if level < 0.03 { 0.0 } else { level };
        if level == 0.0 && self.shown == 0.0 {
            return None;
        }
        self.shown = level;
        Some(level)
    }
}

/// What says whether someone is speaking.
enum Hears {
    /// By how loud it is.
    Loudness(EnergyVad),
    /// By the voice detector, which knows a voice from a noise.
    Voice { detector: sherpa::Detector, active: bool, frames: u32 },
}

impl Default for Hears {
    fn default() -> Self {
        Self::Loudness(EnergyVad::default())
    }
}

impl Hears {
    fn is_active(&self) -> bool {
        match self {
            Self::Loudness(vad) => vad.is_active(),
            Self::Voice { active, .. } => *active,
        }
    }

    fn reset(&mut self) {
        match self {
            Self::Loudness(vad) => vad.reset(),
            Self::Voice { detector, active, frames } => {
                detector.reset();
                *active = false;
                *frames = 0;
            }
        }
    }

    /// How long after speech began `Start` is said.
    fn late(&self) -> usize {
        match self {
            Self::Loudness(_) => 0,
            Self::Voice { .. } => sherpa::Detector::LATE,
        }
    }

    fn feed(&mut self, frame: &[f32]) -> Event {
        match self {
            Self::Loudness(vad) => vad.feed(frame.iter().map(|s| f64::from(*s) * f64::from(*s)).sum::<f64>() / frame.len() as f64),
            Self::Voice { detector, active, frames } => match (*active, detector.feed(frame)) {
                (false, true) => {
                    *active = true;
                    *frames = 0;
                    Event::Start
                }
                (true, false) => {
                    *active = false;
                    Event::End
                }
                (true, true) => {
                    *frames += 1;
                    if *frames < MAX_ACTIVE_FRAMES {
                        return Event::None;
                    }
                    // Someone who never stops: what follows is another sentence.
                    detector.reset();
                    *active = false;
                    Event::End
                }
                (false, false) => Event::None,
            },
        }
    }
}

/// Cuts a stream of samples into sentences.
#[derive(Default)]
pub struct Sentences {
    vad: Hears,
    /// Samples not yet a whole frame.
    pending: Vec<f32>,
    /// The last moments, while nobody speaks.
    lead_in: std::collections::VecDeque<f32>,
    /// The sentence being said.
    current: Vec<f32>,
}

impl Sentences {
    /// Sentences cut where the voice detector hears a voice, not where it is loud.
    pub fn of_voices(detector: sherpa::Detector) -> Self {
        Self { vad: Hears::Voice { detector, active: false, frames: 0 }, ..Self::default() }
    }

    pub fn speaking(&self) -> bool {
        self.vad.is_active()
    }

    /// Forgets the sentence being said, if any: what follows is a new one.
    pub fn clear(&mut self) {
        self.vad.reset();
        self.pending.clear();
        self.lead_in.clear();
        self.current.clear();
    }

    /// More samples from the microphone. Returns a sentence when one just ended.
    pub fn feed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        self.pending.extend_from_slice(samples);
        let mut ended = None;
        let mut at = 0;
        while self.pending.len() - at >= FRAME {
            let frame = &self.pending[at..at + FRAME];
            at += FRAME;
            let was_active = self.vad.is_active();
            let event = self.vad.feed(frame);
            if was_active || event == Event::Start {
                if event == Event::Start {
                    self.current.clear();
                    self.current.extend(self.lead_in.drain(..));
                }
                self.current.extend_from_slice(frame);
                if event == Event::End {
                    let sentence = std::mem::take(&mut self.current);
                    let spoken = sentence.len().saturating_sub(TRAILING + LEAD_IN);
                    if spoken >= SHORTEST {
                        ended = Some(sentence);
                    }
                }
            } else {
                self.lead_in.extend(frame.iter().copied());
                // The start of a voice is noticed late: that much more is kept.
                while self.lead_in.len() > LEAD_IN + self.vad.late() {
                    self.lead_in.pop_front();
                }
            }
        }
        self.pending.drain(..at);
        ended
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUIET: f64 = 1e-6;
    const LOUD: f64 = 1e-2;

    fn calibrated() -> EnergyVad {
        let mut vad = EnergyVad::default();
        for _ in 0..CALIBRATION_FRAMES {
            assert_eq!(vad.feed(QUIET), Event::None);
        }
        vad
    }

    // EnergyVADTests, ported.
    #[test]
    fn nothing_triggers_while_it_learns_the_room() {
        let mut vad = EnergyVad::default();
        for _ in 0..CALIBRATION_FRAMES {
            assert_eq!(vad.feed(LOUD), Event::None);
        }
        assert!(!vad.is_active());
    }

    #[test]
    fn speech_starts_a_segment_and_silence_ends_it() {
        let mut vad = calibrated();
        assert_eq!(vad.feed(LOUD), Event::Start);
        assert!(vad.is_active());
        for _ in 0..10 {
            assert_eq!(vad.feed(LOUD), Event::None);
        }
        for _ in 0..SILENCE_FRAMES - 1 {
            assert_eq!(vad.feed(QUIET), Event::None);
        }
        assert_eq!(vad.feed(QUIET), Event::End);
        assert!(!vad.is_active());
    }

    #[test]
    fn a_pause_inside_a_sentence_does_not_end_it() {
        let mut vad = calibrated();
        vad.feed(LOUD);
        for _ in 0..SILENCE_FRAMES - 5 {
            assert_eq!(vad.feed(QUIET), Event::None);
        }
        assert_eq!(vad.feed(LOUD), Event::None);
        for _ in 0..SILENCE_FRAMES - 1 {
            assert_eq!(vad.feed(QUIET), Event::None);
        }
        assert_eq!(vad.feed(QUIET), Event::End);
    }

    #[test]
    fn quiet_sounds_do_not_start_anything() {
        let mut vad = calibrated();
        for _ in 0..200 {
            assert_eq!(vad.feed(QUIET * 3.0), Event::None);
        }
    }

    #[test]
    fn noise_that_never_stops_is_cut_and_becomes_the_room() {
        let mut vad = calibrated();
        assert_eq!(vad.feed(LOUD), Event::Start);
        let mut ended = false;
        for _ in 0..MAX_ACTIVE_FRAMES {
            if vad.feed(LOUD) == Event::End {
                ended = true;
                break;
            }
        }
        assert!(ended);
        // The same level no longer triggers: it is the room now.
        for _ in 0..50 {
            assert_eq!(vad.feed(LOUD), Event::None);
        }
    }

    #[test]
    fn reset_keeps_what_was_learnt() {
        let mut vad = calibrated();
        vad.feed(LOUD);
        vad.reset();
        assert!(!vad.is_active());
        // No calibration again: speech triggers at once.
        assert_eq!(vad.feed(LOUD), Event::Start);
    }

    fn tone(seconds: f64, level: f32) -> Vec<f32> {
        (0..(seconds * f64::from(SAMPLE_RATE)) as usize).map(|i| if i % 2 == 0 { level } else { -level }).collect()
    }

    #[test]
    fn a_sentence_comes_out_whole_with_its_lead_in() {
        let mut sentences = Sentences::default();
        assert_eq!(sentences.feed(&tone(1.0, 0.001)), None);
        // Fed in uneven chunks, as a microphone gives them.
        let speech = tone(1.5, 0.3);
        let mut out = None;
        for chunk in speech.chunks(441) {
            out = out.or(sentences.feed(chunk));
        }
        assert!(sentences.speaking());
        assert_eq!(out, None);
        let sentence = sentences.feed(&tone(1.2, 0.001)).expect("the silence ends it");
        assert!(!sentences.speaking());
        let seconds = sentence.len() as f64 / f64::from(SAMPLE_RATE);
        // 0.3 s before, 1.5 s of speech, 0.8 s of the silence that ended it.
        assert!((2.4..2.8).contains(&seconds), "{seconds}");
        // The quiet lead-in is there, then the speech.
        assert!(sentence[..LEAD_IN / 2].iter().all(|s| s.abs() < 0.01));
        assert!(sentence[LEAD_IN + FRAME..LEAD_IN + FRAME * 2].iter().all(|s| s.abs() > 0.2));
    }

    #[test]
    fn what_follows_the_wake_phrase_is_cut_out_or_there_is_nothing() {
        use std::time::Duration;
        let seconds = |s: f64| (s * f64::from(SAMPLE_RATE)) as usize;
        // 0.3 s lead-in, "okay coucou" for 0.9 s, "next track" for 0.8 s, then the silence.
        let sentence = LEAD_IN + seconds(0.9 + 0.8) + TRAILING;
        let cut = after_wake(sentence, Duration::from_millis(900)).expect("a command followed");
        assert_eq!(cut, LEAD_IN + seconds(0.9) - CUT_EARLY);
        // The wake phrase alone, even with a breath after it.
        assert_eq!(after_wake(LEAD_IN + seconds(0.9) + TRAILING, Duration::from_millis(900)), None);
        assert_eq!(after_wake(LEAD_IN + seconds(0.9 + 0.2) + TRAILING, Duration::from_millis(900)), None);
        // A sentence shorter than the wake phrase is said to be: nothing after it.
        assert_eq!(after_wake(seconds(0.5), Duration::from_millis(900)), None);
        assert_eq!(after_wake(0, Duration::ZERO), None);
    }

    #[test]
    fn no_sentence_is_longer_than_the_model_can_take() {
        // Someone who never stops, or music: cut, and what comes out fits.
        let mut sentences = Sentences::default();
        sentences.feed(&tone(1.0, 0.001));
        let mut longest = 0;
        for chunk in tone(40.0, 0.3).chunks(160) {
            if let Some(sentence) = sentences.feed(chunk) {
                longest = longest.max(sentence.len());
            }
        }
        assert!(longest > 0, "it was cut at least once");
        assert!(longest <= LONGEST, "{} samples", longest);
        // And whatever is handed over is cut to fit, keeping its end.
        let long: Vec<f32> = (0..LONGEST + 5000).map(|i| i as f32).collect();
        let fit = fitting(&long);
        assert_eq!(fit.len(), LONGEST);
        assert_eq!(fit[fit.len() - 1], (LONGEST + 4999) as f32);
        assert_eq!(fitting(&long[..100]).len(), 100);
    }

    /// Typing, as a microphone next to the keyboard gives it: a short burst of
    /// noise that dies away, a few times a second, over a quiet room.
    #[cfg(windows)]
    fn typing(seconds: f64) -> Vec<f32> {
        let mut seed = 0x2545_f491u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 23) as f32 - 1.0
        };
        let mut out: Vec<f32> = (0..(seconds * f64::from(SAMPLE_RATE)) as usize).map(|_| noise() * 0.0008).collect();
        let mut at = SAMPLE_RATE as usize;
        let mut key = 0usize;
        while at + 800 < out.len() {
            for i in 0..640 {
                out[at + i] += noise() * 0.35 * (-(i as f32) / 120.0).exp();
            }
            // Between 110 and 250 ms from one key to the next.
            key += 1;
            at += 1760 + (key * 977) % 2240;
        }
        out
    }

    /// With the real detector on disk (`COUCOU_VOICE_RUNTIME`, and
    /// `COUCOU_VOICE_DETECTOR` for `silero_vad.onnx`): typing is loud enough
    /// to be cut out as a sentence by loudness, and is not one for the
    /// detector — which still cuts out a spoken sentence (`COUCOU_VOICE_WAV`,
    /// 16 kHz, 16-bit mono), typed over or not, where loudness does.
    /// `cargo test -p coucou voice::vad -- --ignored --nocapture`
    #[test]
    #[cfg(windows)]
    #[ignore = "needs the downloaded engine"]
    fn typing_is_not_a_sentence_for_the_voice_detector_and_speech_still_is() {
        let var = |name: &str| std::path::PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set")));
        let of_voices = || {
            Sentences::of_voices(sherpa::Detector::load(&var("COUCOU_VOICE_RUNTIME"), &var("COUCOU_VOICE_DETECTOR"), SILENCE_SECONDS).expect("detector"))
        };
        // 10 ms at a time, like the microphone.
        let cut = |sentences: &mut Sentences, stream: &[f32]| -> Vec<Vec<f32>> {
            stream.chunks(160).filter_map(|chunk| sentences.feed(chunk)).collect()
        };
        let seconds = |sentence: &Vec<f32>| sentence.len() as f64 / f64::from(SAMPLE_RATE);

        let keys = typing(8.0);
        let by_loudness = cut(&mut Sentences::default(), &keys);
        let mut voices = of_voices();
        let by_voice = cut(&mut voices, &keys);
        println!("typing: {} by loudness, {} by voice", by_loudness.len(), by_voice.len());
        assert!(!by_loudness.is_empty(), "the typing here is not loud enough to prove anything");
        assert!(by_voice.is_empty() && !voices.speaking(), "typing was taken for a voice");

        let bytes = std::fs::read(var("COUCOU_VOICE_WAV")).expect("wav");
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), SAMPLE_RATE, "the clip must be 16 kHz");
        let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        let speech: Vec<f32> = bytes[data..].chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect();
        let quiet = |seconds: f64| tone(seconds, 0.0005);
        let stream = [quiet(1.5), speech, quiet(1.5)].concat();

        let by_loudness = cut(&mut Sentences::default(), &stream);
        let by_voice = cut(&mut of_voices(), &stream);
        assert_eq!((by_loudness.len(), by_voice.len()), (1, 1), "one sentence was said");
        println!("speech: {:.2} s by loudness, {:.2} s by voice", seconds(&by_loudness[0]), seconds(&by_voice[0]));
        // The same sentence, from as early: what is cut after the wake phrase
        // (`after_wake`) counts from its start.
        assert!((seconds(&by_loudness[0]) - seconds(&by_voice[0])).abs() < 0.25);
        let starts = |sentence: &Vec<f32>| sentence.iter().position(|s| s.abs() > 0.02).expect("speech in it");
        println!("speech starts {} samples in by loudness, {} by voice", starts(&by_loudness[0]), starts(&by_voice[0]));
        assert!(starts(&by_voice[0]).abs_diff(LEAD_IN) < 1600, "the voice starts {} samples in", starts(&by_voice[0]));

        // Said while typing: still one sentence, and it ends.
        let mut typed_over = stream.clone();
        for (sample, key) in typed_over.iter_mut().zip(typing(seconds(&stream))) {
            *sample += key * 0.5;
        }
        let over = cut(&mut of_voices(), &[typed_over, typing(3.0)].concat());
        println!("typed over: {} sentence(s), {:?} s", over.len(), over.iter().map(seconds).collect::<Vec<_>>());
        assert_eq!(over.len(), 1, "one sentence was said over the typing");
        assert!(seconds(&over[0]) < seconds(&by_voice[0]) + 0.6);
    }

    #[test]
    fn the_level_follows_the_voice_and_says_silence_once() {
        assert_eq!(loudness(&[]), 0.0);
        assert_eq!(loudness(&tone(0.1, 0.0005)), 0.0);
        assert_eq!(loudness(&tone(0.1, 0.5)), 1.0);
        let speaking = loudness(&tone(0.1, 0.05));
        assert!((0.6..0.8).contains(&speaking), "{speaking}");
        assert!(loudness(&tone(0.1, 0.01)) < speaking);

        let mut level = Level::default();
        // A quiet room: nothing to tell.
        assert_eq!(level.step(0.0), None);
        assert_eq!(level.step(0.01), None);
        // A voice: at once. Then it falls away, and silence is told one time.
        assert_eq!(level.step(0.8), Some(0.8));
        let mut told = Vec::new();
        for _ in 0..20 {
            told.extend(level.step(0.0));
        }
        assert!(told.windows(2).all(|pair| pair[1] < pair[0]), "{told:?}");
        assert_eq!(told.last(), Some(&0.0));
        assert!((5..15).contains(&told.len()), "{told:?}");
        assert_eq!(level.step(0.0), None);
    }

    #[test]
    fn a_click_is_not_a_sentence_and_clear_forgets_one_half_said() {
        let mut sentences = Sentences::default();
        sentences.feed(&tone(1.0, 0.001));
        sentences.feed(&tone(0.1, 0.3));
        assert_eq!(sentences.feed(&tone(1.2, 0.001)), None);

        sentences.feed(&tone(1.0, 0.3));
        assert!(sentences.speaking());
        sentences.clear();
        assert!(!sentences.speaking());
        assert_eq!(sentences.feed(&tone(1.2, 0.001)), None);
    }
}
