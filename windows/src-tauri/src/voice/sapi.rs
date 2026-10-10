// Windows' own speech recogniser (SAPI 5), in this process, with a fixed
// grammar: it can only ever hear the wake phrases and the commands it was
// given. It ships with Windows, runs on the machine and needs no download —
// only the English speech pack, which an English Windows has.
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
    SPRAF_TopLevel, SPRST_ACTIVE, SPRST_INACTIVE, SPRS_ACTIVE, SPRS_INACTIVE, SPSTATEHANDLE, SPWT_LEXICAL,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use super::session::{Listen, Raw, Rule, COMMANDS, WAKE_PHRASES};
use super::Unavailable;

const RULE_WAKE: u32 = 1;
const RULE_COMMAND: u32 = 2;
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
    pub fn open() -> Result<Self, Unavailable> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(Unavailable::error)?;
            let com = Com;

            let recognizer: ISpRecognizer =
                CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL).map_err(Unavailable::error)?;

            // An English recogniser, whatever the system's default one is.
            let english = first_token(SPCAT_RECOGNIZERS, w!("Language=409")).ok_or(Unavailable::NoRecogniser)?;
            recognizer.SetRecognizer(&english).map_err(Unavailable::error)?;

            let microphone = default_microphone().ok_or(Unavailable::Microphone)?;
            recognizer.SetInput(&microphone, true).map_err(|_| Unavailable::Microphone)?;
            recognizer.SetRecoState(SPRST_INACTIVE).map_err(Unavailable::error)?;

            let context = recognizer.CreateRecoContext().map_err(Unavailable::error)?;
            context.SetNotifyWin32Event().map_err(Unavailable::error)?;
            let events = interest(SPEI_RECOGNITION) | interest(SPEI_HYPOTHESIS) | interest(SPEI_FALSE_RECOGNITION);
            context.SetInterest(events, events).map_err(Unavailable::error)?;

            let grammar = context.CreateGrammar(1).map_err(Unavailable::error)?;
            add_rule(&grammar, w!("wake"), RULE_WAKE, WAKE_PHRASES).map_err(Unavailable::error)?;
            add_rule(&grammar, w!("command"), RULE_COMMAND, COMMANDS).map_err(Unavailable::error)?;
            grammar.Commit(0).map_err(Unavailable::error)?;

            Ok(Self { recognizer, context, grammar, _com: com })
        }
    }

    /// Turns the ear to the wake phrase or the command, or closes the microphone.
    pub fn listen(&mut self, what: Listen) -> Result<(), Unavailable> {
        unsafe {
            if what == Listen::Nothing {
                return self.recognizer.SetRecoState(SPRST_INACTIVE).map_err(Unavailable::error);
            }
            let (wake, command) = if what == Listen::Wake { (SPRS_ACTIVE, SPRS_INACTIVE) } else { (SPRS_INACTIVE, SPRS_ACTIVE) };
            self.grammar.SetRuleIdState(RULE_WAKE, wake).map_err(Unavailable::error)?;
            self.grammar.SetRuleIdState(RULE_COMMAND, command).map_err(Unavailable::error)?;
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
            let (rule, text, confidence) = read(&result?)?;
            if id == SPEI_RECOGNITION.0 {
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

/// Which rule a result matched, its words, and how sure the engine is (0…1).
unsafe fn read(result: &ISpRecoResult) -> Option<(Rule, String, f32)> {
    unsafe {
        let phrase = result.GetPhrase().ok()?;
        if phrase.is_null() {
            return None;
        }
        let matched = (*phrase).Base.Rule;
        CoTaskMemFree(Some(phrase as *const c_void));
        let rule = match matched.ulId {
            RULE_WAKE => Rule::Wake,
            RULE_COMMAND => Rule::Command,
            _ => return None,
        };
        let mut words = PWSTR::null();
        result.GetText(WHOLE_PHRASE, WHOLE_PHRASE, true, &mut words, None).ok()?;
        let text = words.to_string().unwrap_or_default();
        CoTaskMemFree(Some(words.0 as *const c_void));
        Some((rule, text, matched.SREngineConfidence))
    }
}

/// A top-level rule that hears exactly these phrases. Left inactive.
unsafe fn add_rule(grammar: &ISpRecoGrammar, name: PCWSTR, id: u32, phrases: &[&str]) -> windows::core::Result<()> {
    unsafe {
        let mut start = SPSTATEHANDLE(std::ptr::null_mut());
        grammar.GetRule(name, id, SPRAF_TopLevel.0 as u32, true, &mut start)?;
        for phrase in phrases {
            // No end state: the phrase ends the rule.
            grammar.AddWordTransition(
                start,
                SPSTATEHANDLE(std::ptr::null_mut()),
                &HSTRING::from(*phrase),
                w!(" "),
                SPWT_LEXICAL,
                1.0,
                std::ptr::null(),
            )?;
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

    /// Opens the real recogniser and the real microphone for a moment:
    /// `cargo test -p coucou voice::sapi -- --ignored`.
    #[test]
    #[ignore = "opens the microphone"]
    fn the_recogniser_opens_listens_and_closes() {
        let mut recogniser = Recogniser::open().expect("recogniser");
        recogniser.listen(Listen::Wake).expect("wake");
        let _ = recogniser.next(Duration::from_millis(500));
        recogniser.listen(Listen::Command).expect("command");
        let _ = recogniser.next(Duration::from_millis(500));
        recogniser.listen(Listen::Nothing).expect("closed");
    }
}
