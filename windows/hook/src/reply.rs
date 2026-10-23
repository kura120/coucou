//! What the relay prints back to the agent — the only place that knows each
//! agent's stdout contract. Same replies as the Mac relay (HookServer.swift).
//!
//! The one rule that matters: **nothing that allows anything is ever printed
//! without a decision a human clicked.** With no decision the reply is silence,
//! an empty `{}`, or Copilot's explicit "ask", and every agent then asks in its
//! own terminal exactly as if Peika were not installed.

use serde_json::{json, Map, Value};

/// The agents whose permission requests the island can answer: Claude Code
/// (no `--agent`), Codex, Copilot CLI and Muse Code. Any decision for another
/// agent is ignored here too, whatever the app sent.
pub fn takes_decisions(agent: &str) -> bool {
    matches!(agent, "" | "codex" | "copilot" | "muse")
}

/// Agents that read a JSON object on stdout after every hook and get `{}` —
/// "no opinion" — when there is nothing to say.
fn wants_json(agent: &str) -> bool {
    matches!(agent, "gemini" | "antigravity" | "copilot" | "muse")
}

/// The line to print for `event` from `agent`, given the island's `decision`
/// (`None`: nobody clicked) and, for Claude Code's AskUserQuestion, the
/// question as it was asked.
pub fn stdout(agent: &str, event: &str, decision: Option<&str>, question: Option<&Value>) -> Option<String> {
    stdout_with(agent, event, decision, question, None)
}

/// `stdout`, with the `permission_suggestions` Claude Code sent along with the
/// request: what an "always" click may hand back to be remembered (see
/// `remembered_rules`). Any other agent ignores them.
pub fn stdout_with(
    agent: &str,
    event: &str,
    decision: Option<&str>,
    question: Option<&Value>,
    suggestions: Option<&Value>,
) -> Option<String> {
    if event != "PermissionRequest" {
        // Antigravity reads "{}" on PreToolUse as a denial. "ask" keeps its own prompt
        // (and the user's Always Allow): Peika never allows a tool by itself.
        if agent.eq_ignore_ascii_case("antigravity") && event == "PreToolUse" {
            return Some(r#"{"decision":"ask"}"#.to_string());
        }
        return wants_json(agent).then(|| "{}".to_string());
    }
    let decision = decision.filter(|_| takes_decisions(agent));
    match agent {
        // Copilot CLI and Muse Code read a bare permissionDecision. Copilot is
        // fail-closed: it must always get valid JSON, so silence is an "ask".
        "copilot" | "muse" => {
            let word = match decision.map(str::trim) {
                Some("allow" | "always") => Some("allow"),
                Some("deny") => Some("deny"),
                _ => None,
            };
            match word {
                Some(word) => Some(json!({ "permissionDecision": word }).to_string()),
                None if agent == "copilot" => Some(json!({ "permissionDecision": "ask" }).to_string()),
                None => None,
            }
        }
        // Claude Code and Codex share the documented hookSpecificOutput. Only
        // Claude Code asks questions.
        "" => decision.and_then(|d| match (d.trim(), suggestions) {
            ("always", Some(suggestions)) => always_json(suggestions).or_else(|| decision_json(d, question)),
            _ => decision_json(d, question),
        }),
        _ => decision.and_then(|d| decision_json(d, None)),
    }
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
///
/// `question` is the AskUserQuestion input, when that is what is being asked:
/// the island may then answer it, which Claude Code takes as the same input
/// with an `answers` map added. Nothing else of the input can be changed from
/// the island, and no other tool's input can be changed at all.
pub fn decision_json(decision: &str, question: Option<&Value>) -> Option<String> {
    if decision.trim_start().starts_with('{') {
        let reply = serde_json::from_str::<Value>(decision).ok()?;
        let answers = reply.get("answers")?.as_object()?;
        let question = question?;
        if !answers_fit(question, answers) {
            return None;
        }
        let mut input = question.as_object()?.clone();
        input.insert("answers".into(), Value::Object(answers.clone()));
        return Some(
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": "allow", "updatedInput": input },
                }
            })
            .to_string(),
        );
    }
    let behavior = match decision.trim() {
        // "always" is a plain allow here: remembering it is `always_json`'s
        // business, and only Claude Code, which brought the suggestion, gets that.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Peika"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// Where Claude Code may be told to keep a rule (the `destination` of a permission update).
const DESTINATIONS: &[&str] = &["session", "localSettings", "projectSettings", "userSettings"];

/// The rules Claude Code itself suggested remembering for this request, as its
/// own "don't ask again" would add them, and nothing else: only `addRules`
/// entries that *allow*, rebuilt field by field so that nothing else of the
/// suggestion rides along. A mode change (`setMode`), a directory, a deny or
/// ask rule is never taken from here: those are not what "Always" means.
/// Peika adds no rule of its own, and stores none.
pub fn remembered_rules(suggestions: &Value) -> Vec<Value> {
    let Some(entries) = suggestions.as_array() else { return Vec::new() };
    entries
        .iter()
        .filter_map(|entry| {
            if entry.get("type")?.as_str()? != "addRules" || entry.get("behavior")?.as_str()? != "allow" {
                return None;
            }
            let destination = entry.get("destination")?.as_str()?;
            if !DESTINATIONS.contains(&destination) {
                return None;
            }
            let rules: Vec<Value> = entry
                .get("rules")?
                .as_array()?
                .iter()
                .map(|rule| {
                    let tool = rule.get("toolName")?.as_str().filter(|t| !t.is_empty())?;
                    match rule.get("ruleContent") {
                        None | Some(Value::Null) => Some(json!({ "toolName": tool })),
                        Some(Value::String(content)) => Some(json!({ "toolName": tool, "ruleContent": content })),
                        Some(_) => None,
                    }
                })
                .collect::<Option<_>>()?;
            if rules.is_empty() {
                return None;
            }
            Some(json!({ "type": "addRules", "rules": rules, "behavior": "allow", "destination": destination }))
        })
        .collect()
}

/// The reply to an "always" click on Claude Code's card: an allow that also
/// carries `updatedPermissions`, so Claude Code remembers the rule itself.
/// `None` when it suggested nothing that can be remembered; the caller then
/// answers a plain allow. See https://code.claude.com/docs/en/hooks
/// ("PermissionRequest decision control", "Permission update entries").
pub fn always_json(suggestions: &Value) -> Option<String> {
    let rules = remembered_rules(suggestions);
    if rules.is_empty() {
        return None;
    }
    Some(
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow", "updatedPermissions": rules },
            }
        })
        .to_string(),
    )
}

/// True when `answers` answers exactly the questions Claude Code asked: one entry
/// per question, keyed by its text; a single-select answer is one of its option
/// labels (a string), a multi-select answer a non-empty list of distinct labels
/// (Claude Code 2.1.136+ takes the list, as the Mac sends it). Same rule as
/// `QuestionPayload.accepts` on macOS.
fn answers_fit(question: &Value, answers: &Map<String, Value>) -> bool {
    let Some(items) = question.get("questions").and_then(|q| q.as_array()) else { return false };
    if items.is_empty() || items.len() != answers.len() {
        return false;
    }
    items.iter().all(|item| {
        let Some(text) = item.get("question").and_then(|q| q.as_str()) else { return false };
        let labels: Vec<&str> = item
            .get("options")
            .and_then(|o| o.as_array())
            .map(|opts| opts.iter().filter_map(|o| o.get("label").and_then(|l| l.as_str())).collect())
            .unwrap_or_default();
        let multi = item.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false);
        match answers.get(text) {
            Some(Value::String(pick)) if !multi => labels.contains(&pick.as_str()),
            Some(Value::Array(picks)) if multi => {
                let picks: Vec<&str> = picks.iter().filter_map(|p| p.as_str()).collect();
                let mut seen = picks.clone();
                seen.sort_unstable();
                seen.dedup();
                !picks.is_empty() && seen.len() == picks.len() && picks.iter().all(|p| labels.contains(p))
            }
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENTS: &[&str] = &[
        "", "gemini", "antigravity", "cursor", "codex", "copilot", "muse", "opencode", "amp",
        "hermes", "claude-desktop", "my-tool",
    ];
    const EVENTS: &[&str] = &[
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
        "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd", "Interrupt",
        "SubagentStart", "SubagentStop", "",
    ];

    /// Whatever a reply says, does it let anything through?
    fn allows(out: &str) -> bool {
        let v: Value = serde_json::from_str(out).expect("every reply is JSON");
        let text = v.to_string();
        // Any decision counts as one, except "ask" (Antigravity's PreToolUse): that hands the
        // choice back to the agent's own prompt.
        let decided = v.get("decision").map_or(false, |d| d.as_str() != Some("ask"));
        text.contains("allow") || decided || v.get("permission").is_some() || v.get("continue").is_some()
    }

    #[test]
    fn nothing_is_ever_allowed_without_a_decision() {
        for agent in AGENTS {
            for event in EVENTS {
                if let Some(out) = stdout(agent, event, None, None) {
                    assert!(!allows(&out), "{agent:?} {event} printed {out} with nobody clicking");
                }
                // A decline, a timeout or garbage from the app is no decision either.
                for not_a_decision in ["", "ask", "maybe", "{\"permissionDecision\":\"allow\"}"] {
                    if let Some(out) = stdout(agent, event, Some(not_a_decision), None) {
                        assert!(!allows(&out), "{agent:?} {event} {not_a_decision:?} printed {out}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_decision_only_counts_on_a_permission_request_from_an_agent_that_takes_one() {
        for agent in AGENTS {
            for event in EVENTS.iter().filter(|e| **e != "PermissionRequest") {
                if let Some(out) = stdout(agent, event, Some("allow"), None) {
                    assert!(!allows(&out), "{agent:?} {event}: {out}");
                }
            }
            let out = stdout(agent, "PermissionRequest", Some("allow"), None);
            assert_eq!(out.as_deref().is_some_and(allows), takes_decisions(agent), "{agent:?}: {out:?}");
        }
    }

    #[test]
    fn each_agent_gets_its_own_reply_shape() {
        let allow = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;
        let deny = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Peika"}}}"#;
        for agent in ["", "codex"] {
            assert_eq!(stdout(agent, "PermissionRequest", Some("allow"), None).unwrap(), allow);
            assert_eq!(stdout(agent, "PermissionRequest", Some("always"), None).unwrap(), allow);
            assert_eq!(stdout(agent, "PermissionRequest", Some("deny"), None).unwrap(), deny);
            assert_eq!(stdout(agent, "PermissionRequest", None, None), None);
            assert_eq!(stdout(agent, "PreToolUse", None, None), None);
        }
        for agent in ["copilot", "muse"] {
            assert_eq!(stdout(agent, "PermissionRequest", Some("allow"), None).unwrap(), r#"{"permissionDecision":"allow"}"#);
            assert_eq!(stdout(agent, "PermissionRequest", Some("deny"), None).unwrap(), r#"{"permissionDecision":"deny"}"#);
            assert_eq!(stdout(agent, "PreToolUse", None, None).unwrap(), "{}");
        }
        // Copilot is fail-closed: no decision is an explicit "ask", never silence.
        assert_eq!(stdout("copilot", "PermissionRequest", None, None).unwrap(), r#"{"permissionDecision":"ask"}"#);
        assert_eq!(stdout("muse", "PermissionRequest", None, None), None);
        // Antigravity needs a decision on PreToolUse: "ask" leaves it to Antigravity's own prompt;
        // other lifecycle events receive "{}".
        assert_eq!(stdout("antigravity", "PreToolUse", None, None).unwrap(), r#"{"decision":"ask"}"#);
        for event in ["PostToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("antigravity", event, None, None).unwrap(), "{}");
        }
        // Gemini CLI reads "{}" as "no opinion".
        for event in ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("gemini", event, None, None).unwrap(), "{}");
        }
        // Cursor: silence, which Cursor reads as "carry on as usual".
        for event in ["PreToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("cursor", event, None, None), None);
        }
        // Hermes approvals are not supported: its decisions are never relayed.
        assert_eq!(stdout("hermes", "PermissionRequest", Some("allow"), None), None);
    }

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", None).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert!(decision_json("always", None).unwrap().contains(r#""behavior":"allow""#));
    }

    fn suggestions() -> Value {
        json!([
            { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm run test:*" }],
              "behavior": "allow", "destination": "localSettings" },
            { "type": "setMode", "mode": "bypassPermissions", "destination": "session" },
            { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "deny", "destination": "userSettings" },
            { "type": "addDirectories", "directories": ["/etc"], "destination": "session" },
        ])
    }

    const PLAIN_ALLOW: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;

    #[test]
    fn always_hands_claude_code_its_own_rule_back_and_nothing_else() {
        let out = stdout_with("", "PermissionRequest", Some("always"), None, Some(&suggestions())).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let decision = &v["hookSpecificOutput"]["decision"];
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(decision["behavior"], "allow");
        // The one allow rule; the mode change, the deny rule and the directory stay out.
        assert_eq!(
            decision["updatedPermissions"],
            json!([{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm run test:*" }],
                     "behavior": "allow", "destination": "localSettings" }])
        );
        assert!(decision.get("updatedInput").is_none());
    }

    #[test]
    fn a_plain_allow_never_remembers_anything() {
        assert_eq!(stdout_with("", "PermissionRequest", Some("allow"), None, Some(&suggestions())).unwrap(), PLAIN_ALLOW);
        let deny = stdout_with("", "PermissionRequest", Some("deny"), None, Some(&suggestions())).unwrap();
        assert!(!deny.contains("updatedPermissions") && !allows(&deny));
        // No click, no rule.
        assert_eq!(stdout_with("", "PermissionRequest", None, None, Some(&suggestions())), None);
    }

    #[test]
    fn always_without_a_rule_to_remember_is_a_plain_allow() {
        for none in [json!([]), json!("x"), json!(null), json!([{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }])] {
            assert_eq!(stdout_with("", "PermissionRequest", Some("always"), None, Some(&none)).unwrap(), PLAIN_ALLOW, "{none}");
        }
        assert_eq!(stdout_with("", "PermissionRequest", Some("always"), None, None).unwrap(), PLAIN_ALLOW);
    }

    #[test]
    fn only_well_formed_allow_rules_are_remembered() {
        let bad = json!([
            { "type": "addRules", "rules": [], "behavior": "allow", "destination": "session" },
            { "type": "addRules", "rules": [{ "toolName": "" }], "behavior": "allow", "destination": "session" },
            { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": 3 }], "behavior": "allow", "destination": "session" },
            { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "/etc/passwd" },
            { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "ask", "destination": "session" },
            { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow" },
        ]);
        assert!(remembered_rules(&bad).is_empty());
        // Extra fields do not ride along.
        let extra = json!([{ "type": "addRules", "rules": [{ "toolName": "Read", "extra": 1 }], "behavior": "allow",
                             "destination": "session", "mode": "bypassPermissions" }]);
        assert_eq!(
            remembered_rules(&extra),
            vec![json!({ "type": "addRules", "rules": [{ "toolName": "Read" }], "behavior": "allow", "destination": "session" })]
        );
    }

    #[test]
    fn only_claude_code_remembers() {
        assert_eq!(stdout_with("codex", "PermissionRequest", Some("always"), None, Some(&suggestions())).unwrap(), PLAIN_ALLOW);
        for agent in ["copilot", "muse"] {
            assert_eq!(
                stdout_with(agent, "PermissionRequest", Some("always"), None, Some(&suggestions())).unwrap(),
                r#"{"permissionDecision":"allow"}"#
            );
        }
        // Hermes' decisions are not relayed at all.
        assert_eq!(stdout_with("hermes", "PermissionRequest", Some("always"), None, Some(&suggestions())), None);
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", None).is_none());
        assert!(decision_json("maybe", None).is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, None).is_none());
    }

    #[test]
    fn an_answered_question_goes_back_as_the_same_input_plus_answers() {
        let question = json!({
            "questions": [{ "question": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] }]
        });
        let out = stdout("", "PermissionRequest", Some(r#"{"answers":{"Which one?":"B"}}"#), Some(&question)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let decision = &v["hookSpecificOutput"]["decision"];
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["questions"], question["questions"]);
        assert_eq!(decision["updatedInput"]["answers"]["Which one?"], "B");
        // Only Claude Code asks questions: an answer for anyone else is nothing.
        assert!(stdout("codex", "PermissionRequest", Some(r#"{"answers":{"Which one?":"B"}}"#), Some(&question)).is_none());
    }

    #[test]
    fn answers_are_only_accepted_for_a_question() {
        assert!(decision_json(r#"{"answers":{"q":"a"}}"#, None).is_none());
        let question = json!({ "questions": [] });
        assert!(decision_json(r#"{"answers":{}}"#, Some(&question)).is_none());
        assert!(decision_json(r#"{"answers":{"q":1}}"#, Some(&question)).is_none());
        assert!(decision_json(r#"{"command":"rm -rf /"}"#, Some(&question)).is_none());
    }

    #[test]
    fn answers_must_match_the_questions_asked() {
        let q = json!({ "questions": [
            { "question": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] },
            { "question": "Extras?", "multiSelect": true,
              "options": [{ "label": "Tests" }, { "label": "Docs" }, { "label": "Lint" }] }
        ]});
        let ok = |a: &str| decision_json(a, Some(&q)).is_some();
        assert!(ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests","Docs"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"C","Extras?":["Tests"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests"],"Other?":"x"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":["A"],"Extras?":["Tests"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":"Tests"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":[]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests","Tests"]}}"#));
    }
}
