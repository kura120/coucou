// What Peika does to the words before pasting them: the user's replacements
// ("cloud code" → "Claude Code") and dictionary (a word spelled the way the
// user spells it). Ported from upstream's flow/text.rs (FlowText.swift); nothing
// here touches the OS, so it runs in the tests as it is.
//
// Snippets, per-app styles and clean-up by a model are not here yet.

/// Replacements first, then the dictionary's words get their exact spelling.
pub fn apply(text: &str, words: &[String], replacements: &[(String, String)]) -> String {
    let mut out = text.trim().to_string();
    for (from, to) in replacements {
        // A replacement with nothing to put would only delete the word.
        if !to.is_empty() {
            out = replacing(from, to, &out);
        }
    }
    for word in words {
        if is_plain_word(word) {
            out = replacing(word, word, &out);
        }
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// The letters-and-digits runs of a phrase: "Rendez-vous !" → ["Rendez", "vous"].
pub fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for c in s.chars() {
        if is_word_char(c) {
            current.push(c);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// A run of word characters in a text, by char index.
struct Run {
    start: usize,
    end: usize,
    lower: String,
}

fn runs(chars: &[char]) -> Vec<Run> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if is_word_char(chars[i]) {
            let start = i;
            while i < chars.len() && is_word_char(chars[i]) {
                i += 1;
            }
            let lower: String = chars[start..i].iter().collect::<String>().to_lowercase();
            out.push(Run { start, end: i, lower });
        } else {
            i += 1;
        }
    }
    out
}

/// Every occurrence of `phrase`, ignoring case and what separates its words
/// ("rendez vous", "Rendez-vous"), but only as whole words: "art" never matches
/// in "partir".
pub fn replacing(phrase: &str, replacement: &str, text: &str) -> String {
    let wanted: Vec<String> = tokens(phrase).into_iter().map(|t| t.to_lowercase()).collect();
    if wanted.is_empty() {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let runs = runs(&chars);
    let mut out = String::with_capacity(text.len());
    let mut copied = 0; // char index copied up to
    let mut i = 0;
    while i + wanted.len() <= runs.len() {
        let matches = wanted.iter().enumerate().all(|(k, w)| runs[i + k].lower == *w);
        if matches {
            let start = runs[i].start;
            let end = runs[i + wanted.len() - 1].end;
            out.extend(&chars[copied..start]);
            out.push_str(replacement);
            copied = end;
            i += wanted.len();
        } else {
            i += 1;
        }
    }
    out.extend(&chars[copied..]);
    out
}

/// Only words made of letters, digits, spaces, hyphens and apostrophes get
/// their spelling fixed: "C++" would match every lone "c".
pub fn is_plain_word(word: &str) -> bool {
    let letters = word.chars().filter(|c| c.is_alphanumeric()).count();
    letters >= 2 && word.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '\'' | '’'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rep(from: &str, to: &str) -> (String, String) {
        (from.to_string(), to.to_string())
    }

    #[test]
    fn replacements_ignore_case_and_separators_but_keep_whole_words() {
        assert_eq!(replacing("cloud code", "Claude Code", "j'ouvre Cloud-Code ce matin"), "j'ouvre Claude Code ce matin");
        assert_eq!(replacing("rendez vous", "rendez-vous", "un Rendez vous demain"), "un rendez-vous demain");
        assert_eq!(replacing("art", "ART", "partir à l'art"), "partir à l'ART");
        assert_eq!(replacing("", "x", "rien"), "rien");
        assert_eq!(replacing("open ai", "x", "I use OpenAI and open-ai"), "I use OpenAI and x");
    }

    #[test]
    fn the_dictionary_fixes_the_spelling_of_plain_words_only() {
        let words = vec!["Supabase".to_string(), "C++".to_string(), "Next.js".to_string()];
        assert_eq!(apply("on passe sur supabase et c", &words, &[]), "on passe sur Supabase et c");
        assert!(is_plain_word("Claude Code"));
        assert!(is_plain_word("aujourd'hui"));
        assert!(!is_plain_word("C++"));
        assert!(!is_plain_word("x"));
    }

    #[test]
    fn replacements_come_before_the_dictionary() {
        let words = vec!["Peika".to_string()];
        let reps = vec![rep("pay ka", "peika")];
        assert_eq!(apply("ask pay ka now", &words, &reps), "ask Peika now");
    }

    #[test]
    fn a_replacement_runs_over_what_the_one_before_wrote() {
        let reps = vec![rep("cloud code", "Claude Code"), rep("claude code", "Claude Code CLI")];
        assert_eq!(apply("open cloud code", &[], &reps), "open Claude Code CLI");
    }

    #[test]
    fn a_replacement_with_nothing_to_put_is_left_alone() {
        let reps = vec![rep("um", ""), rep("", "x")];
        assert_eq!(apply("um hello", &[], &reps), "um hello");
    }

    #[test]
    fn the_words_are_trimmed_and_nothing_gives_nothing() {
        assert_eq!(apply("  hello world \n", &[], &[]), "hello world");
        assert_eq!(apply("   ", &["Peika".to_string()], &[rep("a", "b")]), "");
        assert_eq!(apply("", &[], &[]), "");
    }

    #[test]
    fn the_replacement_is_put_in_as_written() {
        // Dollar signs and braces mean nothing here.
        assert_eq!(apply("price tag", &[], &[rep("price tag", "${1} {name}")]), "${1} {name}");
        assert_eq!(apply("multi", &[], &[rep("multi", "one\ntwo")]), "one\ntwo");
    }

    #[test]
    fn tokens_are_the_runs_of_letters_and_digits() {
        assert_eq!(tokens("Rendez-vous !"), vec!["Rendez", "vous"]);
        assert!(tokens(" ?! ").is_empty());
    }
}
