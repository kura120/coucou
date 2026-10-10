// One voice session, whatever recogniser is behind it: what to listen for now,
// and what each thing heard means. No audio, no clock of its own, no Tauri —
// the listener thread (mod.rs) feeds it and the tests script it.
//
//   wake phrase  →  the command, for a few seconds  →  back to the wake phrase
//
// With an engine that hears free speech there is one more step: for a few
// seconds after a command, another one may be said without the wake phrase.
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

/// While the card of a command is on screen, before the follow-up time starts.
const RESULT_SHOWN: Duration = Duration::from_secs(2);

/// What the recogniser should have its ear on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listen {
    /// Microphone closed.
    Nothing,
    Wake,
    Command,
    /// Another command, should one be said: nothing is waited for.
    FollowUp,
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
    /// Another command, said without the wake phrase after the last one.
    Again(String),
}

/// A sentence as the free-speech engine wrote it, without the wake phrase if
/// it was said again: "Okay, Coucou, next track." is "next track.". The engine
/// writes "coucou" a different way each time, so it is recognised by its
/// place — the word after "ok" or "hey", set off by a comma — not its spelling.
pub fn without_wake(text: &str) -> String {
    let text = text.trim();
    let mut words = text.split_whitespace();
    let bare = |w: &str| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    let Some(first) = words.next() else { return String::new() };
    if !matches!(bare(first).as_str(), "ok" | "okay" | "hey") {
        return text.to_string();
    }
    // "Okay, Kalku, next…" or "Okay kauku, next…": up to three words of name.
    let rest: Vec<&str> = words.collect();
    for (i, word) in rest.iter().enumerate().take(3) {
        if word.ends_with([',', '.', '!']) && i + 1 < rest.len() {
            return rest[i + 1..].join(" ");
        }
    }
    text.to_string()
}

pub struct Session {
    /// Listen for the wake phrase all the time; else only the shortcut wakes.
    wake: bool,
    /// Paused, locked or on battery saver: the microphone stays closed.
    held: bool,
    command_until: Option<Instant>,
    /// How long after a command another may follow without the wake phrase;
    /// zero where the engine cannot tell a command from any other sentence.
    follow_up: Duration,
    follow_until: Option<Instant>,
}

impl Session {
    pub fn new(wake: bool, follow_up: Duration) -> Self {
        Self { wake, held: false, command_until: None, follow_up, follow_until: None }
    }

    pub fn listen(&self) -> Listen {
        if self.command_until.is_some() {
            Listen::Command
        } else if self.follow_until.is_some() {
            Listen::FollowUp
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
        self.follow_until = None;
        Some(Heard::Woke)
    }

    /// The island closed the listening view itself: it already knows.
    pub fn cancel(&mut self) {
        self.command_until = None;
    }

    pub fn hold(&mut self, held: bool) -> Option<Heard> {
        self.held = held;
        if held {
            self.follow_until = None;
            if self.command_until.take().is_some() {
                return Some(Heard::Cancelled);
            }
        }
        None
    }

    /// A command is over: another may follow for a while.
    fn ended(&mut self, now: Instant) {
        self.command_until = None;
        self.follow_until = (!self.follow_up.is_zero() && !self.held).then(|| now + RESULT_SHOWN + self.follow_up);
    }

    /// Someone is in the middle of a sentence: whatever is waited for waits on.
    pub fn speaking(&mut self, now: Instant) {
        for until in [&mut self.command_until, &mut self.follow_until].into_iter().flatten() {
            *until = (*until).max(now + SPEAKING_WAIT);
        }
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
                self.ended(now);
                Some(if confidence >= COMMAND_FLOOR { Heard::Final(text) } else { Heard::Missed })
            }
            (Listen::Command, Raw::Rejected) => {
                self.ended(now);
                Some(Heard::Missed)
            }
            // Noise or a sentence that was not words is not an answer to anything.
            (Listen::FollowUp, Raw::Phrase { rule: Rule::Command, text, confidence }) if confidence >= COMMAND_FLOOR => {
                self.ended(now);
                Some(Heard::Again(text))
            }
            _ => None,
        }
    }

    /// Time passing: a command nobody said ends the session.
    pub fn tick(&mut self, now: Instant) -> Option<Heard> {
        if self.follow_until.is_some_and(|until| now >= until) {
            self.follow_until = None;
        }
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

    /// A session with a grammar engine: no follow-up.
    fn grammar(wake: bool) -> Session {
        Session::new(wake, Duration::ZERO)
    }

    #[test]
    fn the_wake_phrase_said_again_is_taken_off_what_was_written() {
        // As Moonshine wrote them, from four synthetic voices.
        assert_eq!(without_wake("Okay, Calku, next track."), "next track.");
        assert_eq!(without_wake("Okay kauku, add github and versal."), "add github and versal.");
        assert_eq!(without_wake("Ok, how cue, add git hub and versal."), "add git hub and versal.");
        assert_eq!(without_wake("Okay, Kalku. Add GitHub and Verso."), "Add GitHub and Verso.");
        assert_eq!(without_wake("Hey, cow-coo! pause"), "pause");
        // Not a wake phrase: left as it is.
        assert_eq!(without_wake("Next track."), "Next track.");
        assert_eq!(without_wake("okay next track"), "okay next track");
        assert_eq!(without_wake("Okay, cool."), "Okay, cool.");
        assert_eq!(without_wake("  "), "");
    }

    #[test]
    fn after_a_command_another_may_follow_without_the_wake_phrase() {
        let now = Instant::now();
        let mut s = Session::new(true, Duration::from_secs(8));
        s.heard(wake(0.95), now);
        assert_eq!(s.heard(command("next track", 1.0), now), Some(Heard::Final("next track".into())));
        assert_eq!(s.listen(), Listen::FollowUp);
        // Seven seconds later, still inside the two of the card and the eight after.
        let later = now + Duration::from_secs(7);
        assert_eq!(s.heard(command("and the one after", 1.0), later), Some(Heard::Again("and the one after".into())));
        // Which opens a new window in turn.
        assert_eq!(s.listen(), Listen::FollowUp);
        assert_eq!(s.tick(later + Duration::from_secs(9)), None);
        assert_eq!(s.listen(), Listen::FollowUp);
        assert_eq!(s.tick(later + Duration::from_secs(10)), None);
        assert_eq!(s.listen(), Listen::Wake);
    }

    #[test]
    fn what_is_not_words_during_the_follow_up_is_ignored_and_nothing_is_announced_when_it_ends() {
        let now = Instant::now();
        let mut s = Session::new(true, Duration::from_secs(8));
        s.heard(wake(0.95), now);
        s.heard(command("pause", 1.0), now);
        assert_eq!(s.heard(Raw::Rejected, now), None);
        assert_eq!(s.heard(wake(0.99), now), None);
        assert_eq!(s.listen(), Listen::FollowUp);
        assert_eq!(s.tick(now + Duration::from_secs(60)), None);
        assert_eq!(s.listen(), Listen::Wake);
    }

    #[test]
    fn a_sentence_being_said_keeps_the_follow_up_open_until_it_ends() {
        let now = Instant::now();
        let mut s = Session::new(true, Duration::from_secs(8));
        s.heard(wake(0.95), now);
        s.heard(command("pause", 1.0), now);
        let late = now + Duration::from_millis(9900);
        s.speaking(late);
        assert_eq!(s.tick(late + Duration::from_secs(3)), None);
        assert_eq!(s.listen(), Listen::FollowUp);
        assert!(matches!(s.heard(command("add github", 1.0), late + Duration::from_secs(3)), Some(Heard::Again(_))));
    }

    #[test]
    fn the_shortcut_and_a_hold_both_end_the_follow_up() {
        let now = Instant::now();
        let mut s = Session::new(true, Duration::from_secs(8));
        s.heard(wake(0.95), now);
        s.heard(command("pause", 1.0), now);
        assert_eq!(s.talk(now), Some(Heard::Woke));
        assert_eq!(s.listen(), Listen::Command);
        s.heard(command("play", 1.0), now);
        assert_eq!(s.listen(), Listen::FollowUp);
        assert_eq!(s.hold(true), None);
        assert_eq!(s.listen(), Listen::Nothing);
        // And a command that ends while held opens none.
        s.hold(false);
        s.heard(wake(0.95), now);
        s.hold(true);
        s.hold(false);
        assert_eq!(s.listen(), Listen::Wake);
    }

    #[test]
    fn a_grammar_engine_has_no_follow_up() {
        let now = Instant::now();
        let mut s = grammar(true);
        s.heard(wake(0.95), now);
        s.heard(command("pause", 0.9), now);
        assert_eq!(s.listen(), Listen::Wake);
    }

    fn wake(confidence: f32) -> Raw {
        Raw::Phrase { rule: Rule::Wake, text: "okay coucou".into(), confidence }
    }

    fn command(text: &str, confidence: f32) -> Raw {
        Raw::Phrase { rule: Rule::Command, text: text.into(), confidence }
    }

    #[test]
    fn the_wake_phrase_opens_a_command_and_the_command_closes_it() {
        let now = Instant::now();
        let mut s = grammar(true);
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
        let mut s = grammar(true);
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
        let mut s = grammar(true);
        assert_eq!(s.heard(command("decline", 0.99), now), None);
        assert_eq!(s.heard(Raw::Rejected, now), None);
        assert_eq!(s.listen(), Listen::Wake);
    }

    #[test]
    fn a_wake_phrase_said_again_during_the_command_is_not_a_command() {
        let now = Instant::now();
        let mut s = grammar(true);
        s.heard(wake(0.95), now);
        assert_eq!(s.heard(wake(0.95), now), None);
        assert_eq!(s.listen(), Listen::Command);
    }

    #[test]
    fn words_so_far_are_shown_and_keep_the_session_open() {
        let now = Instant::now();
        let mut s = grammar(true);
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
        let mut s = grammar(true);
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
        let mut s = grammar(true);
        s.heard(wake(0.95), now);
        assert_eq!(s.tick(now + Duration::from_secs(7)), None);
        assert_eq!(s.tick(now + COMMAND_WAIT), Some(Heard::Cancelled));
        assert_eq!(s.listen(), Listen::Wake);
        assert_eq!(s.tick(now + Duration::from_secs(60)), None);
    }

    #[test]
    fn without_the_wake_phrase_the_microphone_opens_only_for_the_shortcut() {
        let now = Instant::now();
        let mut s = grammar(false);
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
        let mut s = grammar(true);
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
        let mut s = grammar(true);
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
