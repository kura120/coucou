// One voice session, whatever recogniser is behind it: what to listen for now,
// and what each thing heard means. No audio, no clock of its own, no Tauri —
// the listener thread (mod.rs) feeds it and the tests script it.
//
//   wake phrase  →  the command, for a few seconds  →  back to the wake phrase
//
// The floors come from one voice on one machine (2026-10-09, Windows' own
// recogniser): the wake phrase scored 0.90–0.94, "coucou" alone and "ok cool,
// cool" 0.77–0.79; commands 0.77–0.95.

use std::time::{Duration, Instant};

/// What wakes Coucou. Never "coucou" alone.
pub const WAKE_PHRASES: &[&str] = &["ok coucou", "okay coucou", "hey coucou"];

/// Under this, a wake phrase is something else that sounded like it.
pub const WAKE_FLOOR: f32 = 0.85;
/// Commands are only listened for after a wake, so they can be heard lower.
pub const COMMAND_FLOOR: f32 = 0.60;

/// How long the command is waited for, and how long once words are coming.
const COMMAND_WAIT: Duration = Duration::from_secs(8);
const SPEAKING_WAIT: Duration = Duration::from_secs(4);

/// What the recogniser should have its ear on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listen {
    /// Microphone closed.
    Nothing,
    Wake,
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Wake,
    Command,
}

/// What a recogniser reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Raw {
    Phrase { rule: Rule, text: String, confidence: f32 },
    /// Words so far, while someone is still speaking.
    Hypothesis { rule: Rule, text: String },
    /// Speech that matched nothing.
    Rejected,
}

/// What the island is told.
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    Woke,
    Partial(String),
    Final(String),
    /// Something was said and it was not a command.
    Missed,
    /// Nothing was said, or listening had to stop.
    Cancelled,
}

pub struct Session {
    /// Listen for the wake phrase all the time; else only the shortcut wakes.
    wake: bool,
    /// Paused, locked or on battery saver: the microphone stays closed.
    held: bool,
    command_until: Option<Instant>,
}

impl Session {
    pub fn new(wake: bool) -> Self {
        Self { wake, held: false, command_until: None }
    }

    pub fn listen(&self) -> Listen {
        if self.command_until.is_some() {
            Listen::Command
        } else if self.held || !self.wake {
            Listen::Nothing
        } else {
            Listen::Wake
        }
    }

    /// The "Talk to Coucou" shortcut, or the island waiting for the answer to
    /// a question it asked: the command, without the wake phrase.
    pub fn talk(&mut self, now: Instant) -> Option<Heard> {
        if self.held || self.command_until.is_some() {
            return None;
        }
        self.command_until = Some(now + COMMAND_WAIT);
        Some(Heard::Woke)
    }

    /// The island closed the listening view itself: it already knows.
    pub fn cancel(&mut self) {
        self.command_until = None;
    }

    pub fn hold(&mut self, held: bool) -> Option<Heard> {
        self.held = held;
        if held && self.command_until.take().is_some() {
            return Some(Heard::Cancelled);
        }
        None
    }

    pub fn heard(&mut self, raw: Raw, now: Instant) -> Option<Heard> {
        match (self.listen(), raw) {
            (Listen::Wake, Raw::Phrase { rule: Rule::Wake, confidence, .. }) if confidence >= WAKE_FLOOR => {
                self.command_until = Some(now + COMMAND_WAIT);
                Some(Heard::Woke)
            }
            (Listen::Command, Raw::Hypothesis { rule: Rule::Command, text }) => {
                self.command_until = Some(now + SPEAKING_WAIT);
                Some(Heard::Partial(text))
            }
            (Listen::Command, Raw::Phrase { rule: Rule::Command, text, confidence }) => {
                self.command_until = None;
                Some(if confidence >= COMMAND_FLOOR { Heard::Final(text) } else { Heard::Missed })
            }
            (Listen::Command, Raw::Rejected) => {
                self.command_until = None;
                Some(Heard::Missed)
            }
            _ => None,
        }
    }

    /// Time passing: a command nobody said ends the session.
    pub fn tick(&mut self, now: Instant) -> Option<Heard> {
        match self.command_until {
            Some(until) if now >= until => {
                self.command_until = None;
                Some(Heard::Cancelled)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wake(confidence: f32) -> Raw {
        Raw::Phrase { rule: Rule::Wake, text: "okay coucou".into(), confidence }
    }

    fn command(text: &str, confidence: f32) -> Raw {
        Raw::Phrase { rule: Rule::Command, text: text.into(), confidence }
    }

    #[test]
    fn the_wake_phrase_opens_a_command_and_the_command_closes_it() {
        let now = Instant::now();
        let mut s = Session::new(true);
        assert_eq!(s.listen(), Listen::Wake);
        assert_eq!(s.heard(wake(0.92), now), Some(Heard::Woke));
        assert_eq!(s.listen(), Listen::Command);
        assert_eq!(s.heard(command("next track", 0.95), now), Some(Heard::Final("next track".into())));
        assert_eq!(s.listen(), Listen::Wake);
    }

    #[test]
    fn what_only_sounds_like_the_wake_phrase_wakes_nothing() {
        // The measured false wakes: "coucou" alone at 0.77, "ok cool, cool" at 0.79.
        let now = Instant::now();
        let mut s = Session::new(true);
        for confidence in [0.77, 0.79, 0.84] {
            assert_eq!(s.heard(wake(confidence), now), None);
            assert_eq!(s.listen(), Listen::Wake);
        }
        // And the lowest real one measured.
        assert_eq!(s.heard(wake(0.90), now), Some(Heard::Woke));
    }

    #[test]
    fn a_command_is_never_taken_without_a_wake() {
        let now = Instant::now();
        let mut s = Session::new(true);
        assert_eq!(s.heard(command("decline", 0.99), now), None);
        assert_eq!(s.heard(Raw::Rejected, now), None);
        assert_eq!(s.listen(), Listen::Wake);
    }

    #[test]
    fn a_wake_phrase_said_again_during_the_command_is_not_a_command() {
        let now = Instant::now();
        let mut s = Session::new(true);
        s.heard(wake(0.95), now);
        assert_eq!(s.heard(wake(0.95), now), None);
        assert_eq!(s.listen(), Listen::Command);
    }

    #[test]
    fn words_so_far_are_shown_and_keep_the_session_open() {
        let now = Instant::now();
        let mut s = Session::new(true);
        s.heard(wake(0.95), now);
        let later = now + Duration::from_secs(7);
        assert_eq!(
            s.heard(Raw::Hypothesis { rule: Rule::Command, text: "set a timer".into() }, later),
            Some(Heard::Partial("set a timer".into()))
        );
        // Past the first eight seconds, but words came a second ago.
        assert_eq!(s.tick(now + Duration::from_secs(9)), None);
        assert_eq!(s.tick(later + SPEAKING_WAIT), Some(Heard::Cancelled));
    }

    #[test]
    fn a_command_heard_too_faintly_or_not_at_all_is_missed() {
        let now = Instant::now();
        let mut s = Session::new(true);
        s.heard(wake(0.95), now);
        assert_eq!(s.heard(command("play", 0.4), now), Some(Heard::Missed));
        s.heard(wake(0.95), now);
        assert_eq!(s.heard(Raw::Rejected, now), Some(Heard::Missed));
        assert_eq!(s.listen(), Listen::Wake);
        // The timer command, the lowest real one measured.
        s.heard(wake(0.95), now);
        assert!(matches!(s.heard(command("set a timer for five minutes", 0.77), now), Some(Heard::Final(_))));
    }

    #[test]
    fn silence_after_the_wake_ends_the_session() {
        let now = Instant::now();
        let mut s = Session::new(true);
        s.heard(wake(0.95), now);
        assert_eq!(s.tick(now + Duration::from_secs(7)), None);
        assert_eq!(s.tick(now + COMMAND_WAIT), Some(Heard::Cancelled));
        assert_eq!(s.listen(), Listen::Wake);
        assert_eq!(s.tick(now + Duration::from_secs(60)), None);
    }

    #[test]
    fn without_the_wake_phrase_the_microphone_opens_only_for_the_shortcut() {
        let now = Instant::now();
        let mut s = Session::new(false);
        assert_eq!(s.listen(), Listen::Nothing);
        assert_eq!(s.talk(now), Some(Heard::Woke));
        assert_eq!(s.listen(), Listen::Command);
        assert_eq!(s.talk(now), None);
        s.heard(command("pause", 0.9), now);
        assert_eq!(s.listen(), Listen::Nothing);
    }

    #[test]
    fn held_means_closed_and_ends_what_was_going_on() {
        let now = Instant::now();
        let mut s = Session::new(true);
        s.heard(wake(0.95), now);
        assert_eq!(s.hold(true), Some(Heard::Cancelled));
        assert_eq!(s.listen(), Listen::Nothing);
        assert_eq!(s.talk(now), None);
        assert_eq!(s.hold(true), None);
        assert_eq!(s.hold(false), None);
        assert_eq!(s.listen(), Listen::Wake);
    }

    #[test]
    fn the_island_closing_the_view_ends_the_session_quietly() {
        let now = Instant::now();
        let mut s = Session::new(true);
        s.heard(wake(0.95), now);
        s.cancel();
        assert_eq!(s.listen(), Listen::Wake);
        assert_eq!(s.tick(now + COMMAND_WAIT), None);
    }

    #[test]
    fn coucou_alone_is_not_a_wake_phrase() {
        assert!(WAKE_PHRASES.iter().all(|p| p.split(' ').count() == 2 && p.ends_with(" coucou")));
    }
}
