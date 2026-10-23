// The key logic of Flow dictation, with nothing from the OS in it. Ported from
// upstream's flow/logic.rs (itself FlowKeyLogic.swift).
//
// - Hold the key: Peika listens. Let go: the words are pasted where you type.
// - Two quick taps: hands-free, until the next tap.
// - Esc, or another key pressed while the key is held (a shortcut such as
//   Ctrl+C), cancels.
//
// Listening starts on the first press, so a word said right away is not lost; a
// press too short to be a hold waits a moment for the second tap, and is
// dropped if none comes.
//
// One thing is added to upstream's: the key's own auto-repeat. While the key
// stays down after a cancel (Ctrl+C with right Ctrl) or after the tap that
// ends a hands-free dictation, the repeats must not begin another one, so the
// logic remembers that the key is down until it hears it come up.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Idle,
    Holding { since: f64 },
    TapWait { until: f64 },
    Locked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    /// Open the microphone.
    Start,
    /// Hands-free: keep listening after the key is released.
    Lock,
    /// Stop listening and paste what was said.
    Finish,
    /// Stop listening and paste nothing.
    Cancel,
    /// The last listen was dropped (too short) and a new one begins.
    Restart,
}

/// A press shorter than this is a tap.
pub const HOLD_THRESHOLD: f64 = 0.30;
/// The second tap of a double tap comes within this.
pub const DOUBLE_TAP_WINDOW: f64 = 0.40;
/// A key reported down this long ago with no repeat since has been let go
/// without us hearing it (the hook was busy, the secure desktop was up).
const STALE_DOWN: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeyLogic {
    phase: Phase,
    /// The key is down, as far as we know, since the last event at this time.
    down: Option<f64>,
}

impl Default for KeyLogic {
    fn default() -> Self {
        Self { phase: Phase::Idle, down: None }
    }
}

impl KeyLogic {
    #[cfg(test)]
    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn is_active(&self) -> bool {
        self.phase != Phase::Idle
    }

    /// When the wait for a second tap runs out, if one is under way.
    pub fn deadline(&self) -> Option<f64> {
        match self.phase {
            Phase::TapWait { until } => Some(until),
            _ => None,
        }
    }

    pub fn key_down(&mut self, t: f64) -> Action {
        // Auto-repeat of a key already down is not a press.
        if self.down.is_some_and(|last| t - last < STALE_DOWN) {
            self.down = Some(t);
            return Action::None;
        }
        self.down = Some(t);
        match self.phase {
            Phase::Idle => {
                self.phase = Phase::Holding { since: t };
                Action::Start
            }
            Phase::Holding { .. } => Action::None,
            Phase::TapWait { until } => {
                if t <= until {
                    self.phase = Phase::Locked;
                    Action::Lock
                } else {
                    // The wait ran out unnoticed: start afresh.
                    self.phase = Phase::Holding { since: t };
                    Action::Restart
                }
            }
            Phase::Locked => {
                self.phase = Phase::Idle;
                Action::Finish
            }
        }
    }

    pub fn key_up(&mut self, t: f64) -> Action {
        self.down = None;
        let Phase::Holding { since } = self.phase else { return Action::None };
        if t - since >= HOLD_THRESHOLD {
            self.phase = Phase::Idle;
            return Action::Finish;
        }
        self.phase = Phase::TapWait { until: t + DOUBLE_TAP_WINDOW };
        Action::None
    }

    /// Another key while the key is held, or between the two taps: it was a
    /// shortcut, not dictation.
    pub fn other_key(&mut self) -> Action {
        match self.phase {
            Phase::Holding { .. } | Phase::TapWait { .. } => {
                self.phase = Phase::Idle;
                Action::Cancel
            }
            Phase::Idle | Phase::Locked => Action::None,
        }
    }

    pub fn escape(&mut self) -> Action {
        if self.phase == Phase::Idle {
            return Action::None;
        }
        self.phase = Phase::Idle;
        Action::Cancel
    }

    /// Called when the double-tap window may have run out.
    pub fn tick(&mut self, t: f64) -> Action {
        match self.phase {
            Phase::TapWait { until } if t > until => {
                self.phase = Phase::Idle;
                Action::Cancel
            }
            _ => Action::None,
        }
    }

    /// The pill's ✓ in hands-free: the same as the third tap.
    pub fn finish_button(&mut self) -> Action {
        if self.phase == Phase::Locked {
            self.phase = Phase::Idle;
            Action::Finish
        } else {
            Action::None
        }
    }

    /// The listen ended on its own (no microphone, nothing heard…).
    pub fn reset(&mut self) {
        self.phase = Phase::Idle;
    }
}

/// The key held to dictate. A key that is a modifier on its own, so holding it
/// does nothing in any app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlowKey {
    #[default]
    RightCtrl,
    RightAlt,
    RightShift,
}

impl FlowKey {
    /// The value kept in settings.json. A name this build does not know reads
    /// as the default, as the other choices do.
    pub fn from_setting(name: &str) -> Self {
        match name {
            "RightAlt" => FlowKey::RightAlt,
            "RightShift" => FlowKey::RightShift,
            _ => FlowKey::RightCtrl,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_then_release_pastes() {
        let mut k = KeyLogic::default();
        assert_eq!(k.key_down(0.0), Action::Start);
        assert_eq!(k.key_down(0.1), Action::None); // key repeat
        assert_eq!(k.key_up(1.2), Action::Finish);
        assert!(!k.is_active());
    }

    #[test]
    fn two_quick_taps_go_hands_free_and_a_third_pastes() {
        let mut k = KeyLogic::default();
        assert_eq!(k.key_down(0.0), Action::Start);
        assert_eq!(k.key_up(0.1), Action::None);
        assert_eq!(k.deadline(), Some(0.1 + DOUBLE_TAP_WINDOW));
        assert_eq!(k.key_down(0.3), Action::Lock);
        assert_eq!(k.key_up(0.35), Action::None);
        assert_eq!(k.phase(), Phase::Locked);
        assert_eq!(k.deadline(), None);
        assert_eq!(k.key_down(5.0), Action::Finish);
        assert!(!k.is_active());
    }

    #[test]
    fn a_lone_tap_is_dropped_once_the_window_runs_out() {
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        k.key_up(0.1);
        assert_eq!(k.tick(0.3), Action::None);
        assert_eq!(k.tick(0.6), Action::Cancel);
        assert!(!k.is_active());
        // A press after an unnoticed timeout starts afresh.
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        k.key_up(0.1);
        assert_eq!(k.key_down(2.0), Action::Restart);
    }

    #[test]
    fn a_shortcut_or_esc_cancels() {
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        assert_eq!(k.other_key(), Action::Cancel);
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        k.key_up(0.1);
        assert_eq!(k.other_key(), Action::Cancel, "a key between the two taps");
        // Typing while hands-free is fine; Esc ends it.
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        k.key_up(0.1);
        k.key_down(0.2);
        k.key_up(0.25);
        assert_eq!(k.other_key(), Action::None);
        assert_eq!(k.escape(), Action::Cancel);
        assert_eq!(k.escape(), Action::None);
    }

    #[test]
    fn nothing_happens_without_a_press() {
        let mut k = KeyLogic::default();
        assert_eq!(k.key_up(0.0), Action::None);
        assert_eq!(k.other_key(), Action::None);
        assert_eq!(k.escape(), Action::None);
        assert_eq!(k.tick(10.0), Action::None);
        assert_eq!(k.finish_button(), Action::None);
    }

    #[test]
    fn the_repeat_of_a_key_held_after_a_cancel_starts_nothing() {
        // Right Ctrl held for Ctrl+C: the C cancels, the repeats go on.
        let mut k = KeyLogic::default();
        assert_eq!(k.key_down(0.0), Action::Start);
        assert_eq!(k.other_key(), Action::Cancel);
        assert_eq!(k.key_down(0.5), Action::None);
        assert_eq!(k.key_down(0.53), Action::None);
        assert!(!k.is_active());
        // Let go, and the next press is a press again.
        assert_eq!(k.key_up(1.0), Action::None);
        assert_eq!(k.key_down(2.0), Action::Start);
    }

    #[test]
    fn the_repeat_of_the_tap_that_ends_hands_free_starts_nothing() {
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        k.key_up(0.1);
        k.key_down(0.2);
        k.key_up(0.25);
        assert_eq!(k.key_down(5.0), Action::Finish);
        assert_eq!(k.key_down(5.5), Action::None);
        assert_eq!(k.key_down(5.53), Action::None);
        assert_eq!(k.key_up(6.0), Action::None);
        assert!(!k.is_active());
    }

    #[test]
    fn the_repeat_of_the_second_tap_does_not_end_hands_free_at_once() {
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        k.key_up(0.1);
        assert_eq!(k.key_down(0.2), Action::Lock);
        assert_eq!(k.key_down(0.7), Action::None);
        assert_eq!(k.phase(), Phase::Locked);
    }

    #[test]
    fn a_key_up_we_never_heard_does_not_block_the_next_press() {
        let mut k = KeyLogic::default();
        assert_eq!(k.key_down(0.0), Action::Start);
        assert_eq!(k.escape(), Action::Cancel);
        // Seconds later, with no repeat in between, it is a new press.
        assert_eq!(k.key_down(10.0), Action::Start);
    }

    #[test]
    fn the_pill_s_check_mark_pastes_a_hands_free_dictation_only() {
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        assert_eq!(k.finish_button(), Action::None, "not while the key is held");
        k.key_up(0.1);
        k.key_down(0.2);
        k.key_up(0.25);
        assert_eq!(k.finish_button(), Action::Finish);
        assert!(!k.is_active());
    }

    #[test]
    fn a_failed_start_leaves_the_logic_idle() {
        let mut k = KeyLogic::default();
        k.key_down(0.0);
        k.reset();
        assert!(!k.is_active());
        k.key_up(0.1);
        assert_eq!(k.key_down(1.0), Action::Start);
    }

    #[test]
    fn the_keys_in_settings() {
        assert_eq!(FlowKey::from_setting("RightCtrl"), FlowKey::RightCtrl);
        assert_eq!(FlowKey::from_setting("RightAlt"), FlowKey::RightAlt);
        assert_eq!(FlowKey::from_setting("RightShift"), FlowKey::RightShift);
        assert_eq!(FlowKey::from_setting("F13"), FlowKey::RightCtrl);
        assert_eq!(FlowKey::from_setting(""), FlowKey::RightCtrl);
    }
}
