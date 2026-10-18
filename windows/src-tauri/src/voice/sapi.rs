// Windows' own speech recogniser (SAPI 5), in this process, with a fixed
// grammar: the wake phrases and nothing else. A fixed grammar can only hear
// the sentences it was given, so it is not asked to hear a command: that is
// free speech, written down by the bundled engine (mod.rs). It ships with
// Windows, runs on the machine and needs no download — only the English
// speech pack, which an English Windows has.
//
// SAPI opens the microphone itself and closes it when told to stop: there is
// no audio in this file, and none is kept anywhere.

use std::ffi::c_void;
use std::time::Duration;

use windows::core::{w, Interface, IUnknown, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpObjectTokenCategory, ISpRecoContext, ISpRecoGrammar, ISpRecoResult, ISpRecognizer,
    SpInprocRecognizer, SpObjectToken, SpObjectTokenCategory, SPCAT_AUDIOIN, SPCAT_RECOGNIZERS,
    SPEI_FALSE_RECOGNITION, SPEI_HYPOTHESIS, SPEI_RECOGNITION, SPET_LPARAM_IS_OBJECT, SPEVENT, SPEVENTENUM,
    SPRAF_TopLevel, SPRST_ACTIVE, SPRST_INACTIVE, SPRS_ACTIVE, SPSTATEHANDLE, SPWT_LEXICAL,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use super::session::{Listen, Raw, Rule, WAKE_PHRASES};
use super::Unavailable;

const RULE_WAKE: u32 = 1;
/// "Every element of the phrase" (SPPR_ALL_ELEMENTS).
const WHOLE_PHRASE: u32 = u32::MAX;

/// CoUninitialize once everything made on this thread is gone.
struct Com;

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub struct Recogniser {
    recognizer: ISpRecognizer,
    context: ISpRecoContext,
    grammar: ISpRecoGrammar,
    /// How long into its sentence the last wake phrase heard ended.
    wake_length: Duration,
    // Last: the fields above are released first.
    _com: Com,
}

/// SPFEI(): the bit of an event in an interest mask, with the two reserved
/// bits SAPI checks for.
const fn interest(event: SPEVENTENUM) -> u64 {
    (1u64 << event.0) | (1u64 << 30) | (1u64 << 33)
}

impl Recogniser {
    /// The recogniser, ready and silent: the microphone opens on `listen`.
    /// The wake phrase may be followed by anything in the same breath ("OK
    /// Coucou, next track"). It is reported as the wake phrase either way;
    /// `wake_length` says where in the sentence it ended.
    pub fn open() -> Result<Self, Unavailable> {
        Self::open_on(None)
    }

    /// How long into its sentence the last wake phrase heard ended.
    pub fn wake_length(&self) -> Duration {
        self.wake_length
    }

    /// `recording`: a WAV file to listen to instead of the microphone (tests).
    pub(super) fn open_on(recording: Option<&std::path::Path>) -> Result<Self, Unavailable> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(Unavailable::error)?;
            let com = Com;

            let recognizer: ISpRecognizer =
                CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL).map_err(Unavailable::error)?;

            // An English recogniser, whatever the system's default one is.
            let english = first_token(SPCAT_RECOGNIZERS, w!("Language=409")).ok_or(Unavailable::NoRecogniser)?;
            recognizer.SetRecognizer(&english).map_err(Unavailable::error)?;

            if let Some(file) = recording {
                use windows::Win32::Media::Speech::{ISpStream, SpStream, SPFM_OPEN_READONLY};
                let stream: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL).map_err(Unavailable::error)?;
                stream
                    .BindToFile(&HSTRING::from(file.as_os_str()), SPFM_OPEN_READONLY, None, None, 0)
                    .map_err(Unavailable::error)?;
                recognizer.SetInput(&stream, true).map_err(Unavailable::error)?;
            } else {
                let microphone = default_microphone().ok_or(Unavailable::Microphone)?;
                recognizer.SetInput(&microphone, true).map_err(|_| Unavailable::Microphone)?;
            }
            recognizer.SetRecoState(SPRST_INACTIVE).map_err(Unavailable::error)?;

            let context = recognizer.CreateRecoContext().map_err(Unavailable::error)?;
            context.SetNotifyWin32Event().map_err(Unavailable::error)?;
            let events = interest(SPEI_RECOGNITION) | interest(SPEI_HYPOTHESIS) | interest(SPEI_FALSE_RECOGNITION);
            context.SetInterest(events, events).map_err(Unavailable::error)?;

            let grammar = context.CreateGrammar(1).map_err(Unavailable::error)?;
            add_wake_rule(&grammar).map_err(Unavailable::error)?;
            grammar.Commit(0).map_err(Unavailable::error)?;

            Ok(Self { recognizer, context, grammar, wake_length: Duration::ZERO, _com: com })
        }
    }

    /// Turns the ear to the wake phrase, or closes this recogniser's
    /// microphone: the wake phrase is all it ever hears.
    pub fn listen(&mut self, what: Listen) -> Result<(), Unavailable> {
        unsafe {
            if what != Listen::Wake {
                return self.recognizer.SetRecoState(SPRST_INACTIVE).map_err(Unavailable::error);
            }
            self.grammar.SetRuleIdState(RULE_WAKE, SPRS_ACTIVE).map_err(Unavailable::error)?;
            // Opening the audio is where a microphone that is missing, or
            // refused in Windows' privacy settings, says so.
            self.recognizer.SetRecoState(SPRST_ACTIVE).map_err(|_| Unavailable::Microphone)
        }
    }

    /// The next thing heard, waiting at most `wait` for it.
    pub fn next(&mut self, wait: Duration) -> Option<Raw> {
        unsafe {
            let event = match self.take_event() {
                Some(event) => event,
                None => {
                    let _ = self.context.WaitForNotifyEvent(wait.as_millis() as u32);
                    self.take_event()?
                }
            };
            let id = event._bitfield & 0xFFFF;
            let kind = (event._bitfield >> 16) & 0xFFFF;
            // The event's object is ours to release, whatever the event is.
            let result = (kind == SPET_LPARAM_IS_OBJECT.0 && event.lParam.0 != 0)
                .then(|| IUnknown::from_raw(event.lParam.0 as *mut c_void))
                .and_then(|unknown| unknown.cast::<ISpRecoResult>().ok());

            if id == SPEI_FALSE_RECOGNITION.0 {
                return Some(Raw::Rejected);
            }
            let (rule, text, confidence, said) = read(&result?)?;
            if id == SPEI_RECOGNITION.0 {
                if rule == Rule::Wake {
                    self.wake_length = said;
                }
                Some(Raw::Phrase { rule, text, confidence })
            } else if id == SPEI_HYPOTHESIS.0 {
                Some(Raw::Hypothesis { rule, text })
            } else {
                None
            }
        }
    }

    unsafe fn take_event(&self) -> Option<SPEVENT> {
        let mut event = SPEVENT::default();
        let mut fetched = 0u32;
        unsafe { self.context.GetEvents(1, &mut event, &mut fetched).ok()? };
        (fetched == 1).then_some(event)
    }
}

/// Every wake phrase is two words.
const WAKE_WORDS: usize = 2;

/// Which rule a result matched, its words, how sure the engine is (0…1), and
/// how long into the sentence its first two words ended.
unsafe fn read(result: &ISpRecoResult) -> Option<(Rule, String, f32, Duration)> {
    unsafe {
        let phrase = result.GetPhrase().ok()?;
        if phrase.is_null() {
            return None;
        }
        let matched = (*phrase).Base.Rule;
        // When the wake phrase's last word ended, from the start of the
        // sentence: its first two elements, whatever was said after them.
        let elements = (*phrase).Base.pElements;
        let said = if elements.is_null() {
            0
        } else {
            std::slice::from_raw_parts(elements, (matched.ulCountOfElements as usize).min(WAKE_WORDS))
                .iter()
                .map(|e| e.ulAudioTimeOffset + e.ulAudioSizeTime)
                .max()
                .unwrap_or(0)
        };
        CoTaskMemFree(Some(phrase as *const c_void));
        if matched.ulId != RULE_WAKE {
            return None;
        }
        let rule = Rule::Wake;
        let mut words = PWSTR::null();
        result.GetText(WHOLE_PHRASE, WHOLE_PHRASE, true, &mut words, None).ok()?;
        let text = words.to_string().unwrap_or_default();
        CoTaskMemFree(Some(words.0 as *const c_void));
        // SAPI counts time in 100 ns.
        Some((rule, text, matched.SREngineConfidence, Duration::from_micros(u64::from(said) / 10)))
    }
}

/// Where a rule ends.
const END: SPSTATEHANDLE = SPSTATEHANDLE(std::ptr::null_mut());

/// The first state of a rule the recogniser listens for by itself, left inactive.
unsafe fn rule(grammar: &ISpRecoGrammar, name: &str, id: u32) -> windows::core::Result<SPSTATEHANDLE> {
    unsafe {
        let mut start = END;
        grammar.GetRule(&HSTRING::from(name), id, SPRAF_TopLevel.0 as u32, true, &mut start)?;
        Ok(start)
    }
}

unsafe fn say(grammar: &ISpRecoGrammar, from: SPSTATEHANDLE, to: SPSTATEHANDLE, words: &str) -> windows::core::Result<()> {
    unsafe { grammar.AddWordTransition(from, to, &HSTRING::from(words), w!(" "), SPWT_LEXICAL, 1.0, std::ptr::null()) }
}

/// SPRULETRANS_WILDCARD: a transition that matches any words at all.
const ANYTHING: SPSTATEHANDLE = SPSTATEHANDLE(-1isize as *mut c_void);

unsafe fn add_wake_rule(grammar: &ISpRecoGrammar) -> windows::core::Result<()> {
    unsafe {
        let start = rule(grammar, "wake", RULE_WAKE)?;
        for phrase in WAKE_PHRASES {
            // The phrase, then either nothing or anything.
            let mut said = END;
            grammar.CreateNewState(start, &mut said)?;
            say(grammar, start, said, phrase)?;
            grammar.AddWordTransition(said, END, PCWSTR::null(), w!(" "), SPWT_LEXICAL, 1.0, std::ptr::null())?;
            grammar.AddRuleTransition(said, END, ANYTHING, 1.0, std::ptr::null())?;
        }
        Ok(())
    }
}

unsafe fn category(id: PCWSTR) -> Option<ISpObjectTokenCategory> {
    unsafe {
        let category: ISpObjectTokenCategory = CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL).ok()?;
        category.SetId(id, false).ok()?;
        Some(category)
    }
}

unsafe fn first_token(category_id: PCWSTR, required: PCWSTR) -> Option<ISpObjectToken> {
    unsafe {
        let tokens = category(category_id)?.EnumTokens(required, PCWSTR::null()).ok()?;
        let mut token = None;
        tokens.Next(1, &mut token, None).ok()?;
        token
    }
}

/// The microphone Windows uses by default, as SAPI names it.
unsafe fn default_microphone() -> Option<ISpObjectToken> {
    unsafe {
        let id = category(SPCAT_AUDIOIN)?.GetDefaultTokenId().ok()?;
        let token: windows::core::Result<ISpObjectToken> = CoCreateInstance(&SpObjectToken, None, CLSCTX_ALL);
        let set = token.and_then(|token| token.SetId(PCWSTR::null(), PCWSTR(id.0), false).map(|()| token));
        CoTaskMemFree(Some(id.0 as *const c_void));
        set.ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the recogniser makes of a recorded sentence, with the one-breath
    /// wake rule. `COUCOU_VOICE_CLIPS` is a folder of 16-bit WAV files:
    /// `alone.wav` (the wake phrase), `with-command.wav` (the wake phrase and a
    /// command in one breath) and `other.wav` (neither).
    /// `cargo test -p coucou voice::sapi -- --ignored --nocapture`
    #[test]
    #[ignore = "needs recorded clips"]
    fn the_wake_phrase_is_heard_alone_and_with_a_command_after_it() {
        let folder = std::path::PathBuf::from(std::env::var("COUCOU_VOICE_CLIPS").expect("COUCOU_VOICE_CLIPS"));
        let hear = |file: &str| -> Option<Raw> {
            let mut recogniser = Recogniser::open_on(Some(&folder.join(file))).expect("recogniser");
            recogniser.listen(Listen::Wake).expect("listen");
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(8) {
                match recogniser.next(Duration::from_millis(200)) {
                    Some(Raw::Hypothesis { .. }) | None => {}
                    Some(other) => {
                        println!("  the wake phrase ended {:?} into the sentence", recogniser.wake_length());
                        return Some(other);
                    }
                }
            }
            None
        };
        let alone = hear("alone.wav");
        println!("alone: {alone:?}");
        let with_command = hear("with-command.wav");
        println!("with a command: {with_command:?}");
        let other = hear("other.wav");
        println!("other: {other:?}");
        use crate::voice::session::WAKE_FLOOR;
        assert!(matches!(&alone, Some(Raw::Phrase { rule: Rule::Wake, confidence, .. }) if *confidence >= WAKE_FLOOR));
        assert!(matches!(&with_command, Some(Raw::Phrase { rule: Rule::Wake, confidence, .. }) if *confidence >= WAKE_FLOOR));
        assert!(!matches!(&other, Some(Raw::Phrase { rule: Rule::Wake, confidence, .. }) if *confidence >= WAKE_FLOOR));
    }

    /// Opens the real recogniser and the real microphone for a moment:
    /// `cargo test -p coucou voice::sapi -- --ignored`.
    #[test]
    #[ignore = "opens the microphone"]
    fn the_recogniser_opens_listens_and_closes() {
        let mut recogniser = Recogniser::open().expect("recogniser");
        recogniser.listen(Listen::Wake).expect("wake");
        let _ = recogniser.next(Duration::from_millis(500));
        // A command is not this recogniser's to hear: its microphone closes.
        recogniser.listen(Listen::Command).expect("command");
        assert_eq!(recogniser.next(Duration::from_millis(300)), None);
        recogniser.listen(Listen::Nothing).expect("closed");
    }
}
