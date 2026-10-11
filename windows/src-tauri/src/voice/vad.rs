// Is someone speaking? Port of EnergyVAD.swift: plain arithmetic on how loud
// each short frame is, against a noise floor it learns. And, on top of it, the
// sentence itself: the samples from a little before speech started to the
// silence that ended it, kept in memory only until they are written down.

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

/// Cuts a stream of samples into sentences.
#[derive(Default)]
pub struct Sentences {
    vad: EnergyVad,
    /// Samples not yet a whole frame.
    pending: Vec<f32>,
    /// The last moments, while nobody speaks.
    lead_in: std::collections::VecDeque<f32>,
    /// The sentence being said.
    current: Vec<f32>,
}

impl Sentences {
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
            let power = frame.iter().map(|s| f64::from(*s) * f64::from(*s)).sum::<f64>() / FRAME as f64;
            let was_active = self.vad.is_active();
            let event = self.vad.feed(power);
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
                while self.lead_in.len() > LEAD_IN {
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
