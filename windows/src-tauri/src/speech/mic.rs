// Who listens to the microphone.
//
// WASAPI lets several readers share the microphone, so this is not a lock on
// the device. It is the one rule about listening: voice ("OK Peika") listens
// for its wake phrase all the time; while someone dictates, or a note records,
// it stands aside — it would take their words for commands — and it comes
// back when they are done. Whoever needs the microphone for that claims a
// lease and holds it for as long as it listens; dropping the lease ends it.
//
// Voice looks at `generation` on every turn of its loop, so a claim or a
// release is seen within one wait for speech (voice/mod.rs).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// What listens, besides voice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// Flow dictation and the Notetaker are the ones that will claim it.
#[cfg_attr(not(test), allow(dead_code))]
pub enum Owner {
    /// Held key or hands-free dictation, or the chat's microphone.
    Dictation,
    /// A call being recorded.
    Note,
}

static LEASES: Mutex<Vec<(u64, Owner)>> = Mutex::new(Vec::new());
static NEXT: AtomicU64 = AtomicU64::new(1);
/// Bumped on every claim and release.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The microphone is `owner`'s until this is dropped.
#[derive(Debug)]
#[must_use = "the lease ends as soon as it is dropped"]
pub struct Lease {
    id: u64,
    #[cfg_attr(not(test), allow(dead_code))]
    owner: Owner,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Lease {
    pub fn owner(&self) -> Owner {
        self.owner
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut leases = LEASES.lock().unwrap_or_else(|e| e.into_inner());
        leases.retain(|(id, _)| *id != self.id);
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

/// `owner` listens from now until the lease is dropped.
#[cfg_attr(not(test), allow(dead_code))]
pub fn claim(owner: Owner) -> Lease {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    LEASES.lock().unwrap_or_else(|e| e.into_inner()).push((id, owner));
    GENERATION.fetch_add(1, Ordering::SeqCst);
    Lease { id, owner }
}

/// Someone other than voice listens: voice holds off until they are done.
pub fn voice_stands_aside() -> bool {
    !LEASES.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
}

/// Changes with every claim and release, for whoever must notice one.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test: the leases are process-wide, and tests run in parallel.
    #[test]
    fn voice_stands_aside_while_any_lease_is_held_and_notices_each_change() {
        let start = generation();
        assert!(!voice_stands_aside());

        let dictation = claim(Owner::Dictation);
        assert_eq!(dictation.owner(), Owner::Dictation);
        assert!(voice_stands_aside());
        let after_claim = generation();
        assert_ne!(after_claim, start);

        let note = claim(Owner::Note);
        drop(dictation);
        assert!(voice_stands_aside(), "the note still listens");
        assert_ne!(generation(), after_claim);

        drop(note);
        assert!(!voice_stands_aside());
    }
}
