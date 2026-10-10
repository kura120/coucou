// Windows' own speech recogniser (SAPI 5), in this process, with a fixed
// grammar: it can only ever hear the wake phrases and the commands it was
// given (grammar.rs). A slot of a command is a rule of its own, so "replace
// {pill} with {pill}" is one path and not every pair of pills written out. It ships with Windows, runs on the machine and needs no download —
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

use super::grammar::{Grammar, Part};
use super::session::{Listen, Raw, Rule, WAKE_PHRASES};
use super::Unavailable;

const RULE_WAKE: u32 = 1;
const RULE_COMMAND: u32 = 2;
/// Slot rules are numbered from here, in the grammar's order.
const RULE_SLOTS: u32 = 10;
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
    pub fn open(commands: &Grammar) -> Result<Self, Unavailable> {
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
            add_wake_rule(&grammar).map_err(Unavailable::error)?;
            add_command_rule(&grammar, commands).map_err(Unavailable::error)?;
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

/// Where a rule ends.
const END: SPSTATEHANDLE = SPSTATEHANDLE(std::ptr::null_mut());

/// A rule's first state. `top_level`: one the recogniser listens for by
/// itself, left inactive; else one that only other rules lead to.
unsafe fn rule(grammar: &ISpRecoGrammar, name: &str, id: u32, top_level: bool) -> windows::core::Result<SPSTATEHANDLE> {
    unsafe {
        let mut start = END;
        let attributes = if top_level { SPRAF_TopLevel.0 as u32 } else { 0 };
        grammar.GetRule(&HSTRING::from(name), id, attributes, true, &mut start)?;
        Ok(start)
    }
}

unsafe fn say(grammar: &ISpRecoGrammar, from: SPSTATEHANDLE, to: SPSTATEHANDLE, words: &str) -> windows::core::Result<()> {
    unsafe { grammar.AddWordTransition(from, to, &HSTRING::from(words), w!(" "), SPWT_LEXICAL, 1.0, std::ptr::null()) }
}

unsafe fn add_wake_rule(grammar: &ISpRecoGrammar) -> windows::core::Result<()> {
    unsafe {
        let start = rule(grammar, "wake", RULE_WAKE, true)?;
        for phrase in WAKE_PHRASES {
            say(grammar, start, END, phrase)?;
        }
        Ok(())
    }
}

/// One rule per slot, hearing any of its values, and the command rule: each
/// command a path of words and slots from its start to its end.
unsafe fn add_command_rule(grammar: &ISpRecoGrammar, commands: &Grammar) -> windows::core::Result<()> {
    unsafe {
        let mut slots = std::collections::BTreeMap::new();
        for (index, (name, values)) in commands.slots.iter().enumerate() {
            let start = rule(grammar, &format!("slot_{name}"), RULE_SLOTS + index as u32, false)?;
            for value in values {
                say(grammar, start, END, value)?;
            }
            slots.insert(name.as_str(), start);
        }
        let start = rule(grammar, "command", RULE_COMMAND, true)?;
        for command in &commands.commands {
            let mut from = start;
            for (index, part) in command.iter().enumerate() {
                let to = if index + 1 == command.len() {
                    END
                } else {
                    let mut next = END;
                    grammar.CreateNewState(start, &mut next)?;
                    next
                };
                match part {
                    Part::Words(words) => say(grammar, from, to, words)?,
                    // Grammar::parse only lets through slots that have values.
                    Part::Slot(name) => grammar.AddRuleTransition(from, to, slots[name.as_str()], 1.0, std::ptr::null())?,
                }
                from = to;
            }
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
        let slots = std::collections::BTreeMap::from([("pill".to_string(), vec!["github".to_string(), "n eight n".to_string()])]);
        let commands: Vec<String> =
            ["next track", "add {pill}", "replace {pill} with {pill}", "{pill}"].iter().map(|s| s.to_string()).collect();
        let grammar = Grammar::parse(&commands, &slots).expect("grammar");
        let mut recogniser = Recogniser::open(&grammar).expect("recogniser");
        recogniser.listen(Listen::Wake).expect("wake");
        let _ = recogniser.next(Duration::from_millis(500));
        recogniser.listen(Listen::Command).expect("command");
        let _ = recogniser.next(Duration::from_millis(500));
        recogniser.listen(Listen::Nothing).expect("closed");
    }
}
