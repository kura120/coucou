// The commands a fixed-grammar recogniser listens for, as the island gives
// them (src/voice/grammar.ts): sentences, with `{slot}` standing for any one
// of that slot's values — "replace {pill} with {pill}".
//
// It comes from a webview, so it is checked before it gets anywhere near the
// recogniser: plain lowercase words only, and bounded.

use std::collections::BTreeMap;

const MAX_COMMANDS: usize = 200;
const MAX_PARTS: usize = 12;
const MAX_SLOTS: usize = 8;
const MAX_VALUES: usize = 200;
const MAX_WORDS: usize = 6;

/// One stretch of a command: words said as they are, or a slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    Words(String),
    Slot(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Grammar {
    pub commands: Vec<Vec<Part>>,
    pub slots: BTreeMap<String, Vec<String>>,
}

fn is_word(word: &str) -> bool {
    !word.is_empty() && word.len() <= 24 && word.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn is_phrase(text: &str) -> bool {
    let words: Vec<&str> = text.split(' ').collect();
    words.len() <= MAX_WORDS && words.iter().all(|w| is_word(w))
}

impl Grammar {
    /// The grammar, or why it is refused whole: a page that sends something
    /// odd is a bug to see in the log, not something to half-listen to.
    pub fn parse(commands: &[String], slots: &BTreeMap<String, Vec<String>>) -> Result<Self, String> {
        if commands.is_empty() || commands.len() > MAX_COMMANDS {
            return Err(format!("{} commands", commands.len()));
        }
        if slots.len() > MAX_SLOTS {
            return Err(format!("{} slots", slots.len()));
        }
        for (name, values) in slots {
            if !is_word(name) {
                return Err("a slot's name is not a word".into());
            }
            if values.is_empty() || values.len() > MAX_VALUES || !values.iter().all(|v| is_phrase(v)) {
                return Err(format!("slot {name} has values that cannot be said"));
            }
        }
        let mut parsed = Vec::with_capacity(commands.len());
        for command in commands {
            let mut parts: Vec<Part> = Vec::new();
            for token in command.split(' ') {
                if let Some(slot) = token.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
                    if !slots.contains_key(slot) {
                        return Err("a command uses a slot that has no values".into());
                    }
                    parts.push(Part::Slot(slot.to_string()));
                } else if !is_word(token) {
                    return Err("a command has something that is not a word".into());
                } else if let Some(Part::Words(words)) = parts.last_mut() {
                    words.push(' ');
                    words.push_str(token);
                } else {
                    parts.push(Part::Words(token.to_string()));
                }
            }
            if parts.len() > MAX_PARTS {
                return Err("a command is too long".into());
            }
            parsed.push(parts);
        }
        Ok(Self { commands: parsed, slots: slots.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn slots(list: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        list.iter().map(|(name, values)| (name.to_string(), strings(values))).collect()
    }

    #[test]
    fn words_and_slots_are_told_apart_and_words_are_kept_together() {
        let g = Grammar::parse(
            &strings(&["next track", "replace {pill} with {pill}", "{pill}"]),
            &slots(&[("pill", &["github", "n eight n"])]),
        )
        .unwrap();
        assert_eq!(g.commands[0], [Part::Words("next track".into())]);
        assert_eq!(
            g.commands[1],
            [
                Part::Words("replace".into()),
                Part::Slot("pill".into()),
                Part::Words("with".into()),
                Part::Slot("pill".into()),
            ]
        );
        assert_eq!(g.commands[2], [Part::Slot("pill".into())]);
        assert_eq!(g.slots["pill"], ["github", "n eight n"]);
    }

    #[test]
    fn anything_that_is_not_plain_words_is_refused() {
        let pill = slots(&[("pill", &["github"])]);
        for bad in ["", "Play", "play  music", "play music!", "add {nothing}", "add {pill", "<rule>", "caf\u{e9}"] {
            assert!(Grammar::parse(&strings(&[bad]), &pill).is_err(), "{bad:?}");
        }
        assert!(Grammar::parse(&[], &pill).is_err());
        assert!(Grammar::parse(&strings(&["play"]), &slots(&[("pill", &[])])).is_err());
        assert!(Grammar::parse(&strings(&["play"]), &slots(&[("pill", &["Git Hub"])])).is_err());
        assert!(Grammar::parse(&strings(&["play"]), &slots(&[("a pill", &["github"])])).is_err());
    }

    #[test]
    fn it_is_bounded() {
        let none = BTreeMap::new();
        let many: Vec<String> = (0..=MAX_COMMANDS).map(|_| "play".to_string()).collect();
        assert!(Grammar::parse(&many, &none).is_err());
        let long = vec!["{p} ".repeat(MAX_PARTS + 1).trim().to_string()];
        assert!(Grammar::parse(&long, &slots(&[("p", &["a"])])).is_err());
        let values: Vec<String> = (0..=MAX_VALUES).map(|_| "a".to_string()).collect();
        assert!(Grammar::parse(&strings(&["play"]), &BTreeMap::from([("p".to_string(), values)])).is_err());
    }
}
