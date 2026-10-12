// What a sentence means when the parser does not know: the question is put to
// the model server the user connected (Ollama, LM Studio or their own), with
// the tools Coucou offers and the last few turns, so "what about Steam?" comes
// with what it follows. Those turns are the island's, kept in memory there for
// a minute and a half: nothing of them is kept here, written or logged. The model proposes — tool calls, or a short answer —
// and the island decides what is done with them (src/voice/tools.ts). Nothing
// here acts.
//
// The sentence and what the island says about the app's state go to that
// server and nowhere else. A server that is not this machine was chosen by
// the user; a toast says so the first time, once per address.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::i18n::{t, tf};
use crate::settings::Settings;
use crate::{local_chat, net, toast};

/// A voice command is waited for; a model that takes longer has not answered.
const TIMEOUT: Duration = Duration::from_secs(12);
/// What the island may send: a prompt and a tool list, not a document.
const MAX_SYSTEM: usize = 16 * 1024;
const MAX_SAID: usize = 600;
const MAX_TOOLS: usize = 48 * 1024;
const MAX_CALLS: usize = 6;
/// The turns before this one: a few exchanges, each a sentence and a line.
const MAX_TURNS: usize = 6;
const MAX_TURN_CALLS: usize = 3;
const MAX_RESULT: usize = 240;
/// This turn's own rounds: the tools the model called and what each gave back,
/// so it can go on from there or say what happened (src/voice/conversation.ts).
const MAX_STEPS: usize = 5;
const MAX_STEP_RESULT: usize = 1200;

/// A turn that came before: what was said, what was done for it (as the tool
/// calls a model would have made) and what came of it.
#[derive(Debug, Deserialize)]
pub struct Turn {
    pub said: String,
    #[serde(default)]
    pub calls: Vec<Called>,
    #[serde(default)]
    pub result: String,
}

#[derive(Debug, Deserialize)]
pub struct Called {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// One round of this turn: the calls the model made, and each one's result as
/// the island checked and ran it — its status first, never only "done".
#[derive(Debug, Deserialize)]
pub struct Step {
    #[serde(default)]
    pub calls: Vec<Called>,
    #[serde(default)]
    pub results: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Call {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Reply {
    pub calls: Vec<Call>,
    pub text: String,
}

/// Loading a model that the server let go of takes about five seconds here.
const WARM_UP: Duration = Duration::from_secs(30);

/// A warm-up is on its way: one at a time.
static WARMING: AtomicBool = AtomicBool::new(false);

/// Coucou was just woken: the model that may be asked about the sentence is
/// got into the server's memory while the sentence is still being said. A
/// server lets go of a model nobody asked for a few minutes (Ollama: five),
/// and the island does not wait long for an answer. One word is asked for —
/// nothing of the user's — and only of a server on this computer: one
/// somewhere else is sent nothing before there is a sentence for it.
pub fn warm(settings: &Settings) {
    let Some(server) = local_chat::server(settings, &settings.voice.brain) else { return };
    let model = settings.voice.brain_model.trim().to_string();
    let here = net::normalise_server_url(&server.url).is_ok_and(|url| net::is_loopback_url(&url));
    if model.is_empty() || !here || WARMING.swap(true, Ordering::Relaxed) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let body = json!({ "model": model, "messages": [{ "role": "user", "content": "ok" }], "max_tokens": 1, "stream": false });
        if let Err(why) = local_chat::complete(&server, &body, WARM_UP).await {
            crate::log::line(format!("voice: the model is not ready: {}", why.chars().take(160).collect::<String>()));
        }
        WARMING.store(false, Ordering::Relaxed);
    });
}

/// Addresses the "not on this machine" toast was shown for, this run.
static WARNED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Something said is about to go to this server: when it is not this computer,
/// a toast says so, once per address. Whatever sends a sentence there calls
/// this first (embed.rs too).
pub(super) fn tell_if_elsewhere(app: &AppHandle, server: &local_chat::Server) {
    let Ok(url) = net::normalise_server_url(&server.url) else { return };
    if net::is_loopback_url(&url) {
        return;
    }
    let address = url.as_str().trim_end_matches('/').to_string();
    if WARNED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(address.clone()) {
        toast::warn(
            app,
            t("What you say goes to another computer"),
            Some(tf("Voice asks the model server at {url}, which is not this machine.", &[("url", &address)])),
        );
    }
}

pub async fn ask(
    app: &AppHandle,
    settings: &Settings,
    system: &str,
    said: &str,
    tools: &Value,
    history: &[Turn],
    steps: &[Step],
) -> Result<Reply, String> {
    let server = local_chat::server(settings, &settings.voice.brain).ok_or("no model server is chosen for voice")?;
    let model = settings.voice.brain_model.trim();
    if model.is_empty() {
        return Err("no model is chosen for voice".into());
    }
    let tools_size = serde_json::to_string(tools).map(|s| s.len()).unwrap_or(usize::MAX);
    if system.len() > MAX_SYSTEM || said.len() > MAX_SAID || tools_size > MAX_TOOLS || !tools.is_array() {
        return Err("voice: request refused".into());
    }
    tell_if_elsewhere(app, &server);
    let body = json!({
        "model": model,
        "messages": with_steps(messages(system, history, said), steps),
        "tools": tools,
        "temperature": 0,
        "stream": false,
    });
    let answer = local_chat::complete(&server, &body, TIMEOUT).await?;
    Ok(read(&answer))
}

/// The conversation as the server is given it: what the app is, the turns so
/// far, the sentence. A turn that called tools is the call and, right after it,
/// its result — a server refuses a call left without one — and one that only
/// answered is its answer. The oldest turns go first when there are too many.
pub fn messages(system: &str, history: &[Turn], said: &str) -> Vec<Value> {
    let cut = |text: &str, most: usize| text.chars().take(most).collect::<String>();
    let mut messages = vec![json!({ "role": "system", "content": system })];
    let turns = &history[history.len().saturating_sub(MAX_TURNS)..];
    for (turn_at, turn) in turns.iter().enumerate() {
        if turn.said.trim().is_empty() {
            continue;
        }
        messages.push(json!({ "role": "user", "content": cut(&turn.said, MAX_SAID) }));
        let result = cut(&turn.result, MAX_RESULT);
        let calls: Vec<&Called> =
            turn.calls.iter().filter(|call| !call.name.trim().is_empty() && call.name.len() <= 64).take(MAX_TURN_CALLS).collect();
        if calls.is_empty() {
            if !result.is_empty() {
                messages.push(json!({ "role": "assistant", "content": result }));
            }
            continue;
        }
        let id = |call_at: usize| format!("call_{turn_at}_{call_at}");
        let called: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(call_at, call)| {
                let arguments = if call.arguments.is_object() { call.arguments.to_string() } else { "{}".to_string() };
                json!({ "id": id(call_at), "type": "function", "function": { "name": call.name.trim(), "arguments": arguments } })
            })
            .collect();
        messages.push(json!({ "role": "assistant", "content": "", "tool_calls": called }));
        for call_at in 0..calls.len() {
            let content = if result.is_empty() { "Done." } else { result.as_str() };
            messages.push(json!({ "role": "tool", "tool_call_id": id(call_at), "content": content }));
        }
    }
    messages.push(json!({ "role": "user", "content": said }));
    messages
}

/// The same conversation, with what this turn has done so far after the
/// sentence: each round's calls and, right after them, their results. A call
/// with no result recorded is answered "No result." rather than left open.
pub fn with_steps(mut messages: Vec<Value>, steps: &[Step]) -> Vec<Value> {
    for (step_at, step) in steps.iter().take(MAX_STEPS).enumerate() {
        let calls: Vec<&Called> =
            step.calls.iter().filter(|call| !call.name.trim().is_empty() && call.name.len() <= 64).take(MAX_CALLS).collect();
        if calls.is_empty() {
            continue;
        }
        let id = |call_at: usize| format!("step_{step_at}_{call_at}");
        let called: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(call_at, call)| {
                let arguments = if call.arguments.is_object() { call.arguments.to_string() } else { "{}".to_string() };
                json!({ "id": id(call_at), "type": "function", "function": { "name": call.name.trim(), "arguments": arguments } })
            })
            .collect();
        messages.push(json!({ "role": "assistant", "content": "", "tool_calls": called }));
        for call_at in 0..calls.len() {
            let result: String = step.results.get(call_at).map(|r| r.chars().take(MAX_STEP_RESULT).collect()).unwrap_or_default();
            let content = if result.trim().is_empty() { "No result.".to_string() } else { result };
            messages.push(json!({ "role": "tool", "tool_call_id": id(call_at), "content": content }));
        }
    }
    messages
}

/// The tool calls and the text of an OpenAI-style answer. Arguments arrive as
/// a JSON string from most servers and as an object from some; what cannot be
/// read is an empty object, which the island's own checks then refuse.
pub fn read(answer: &Value) -> Reply {
    let message = &answer["choices"][0]["message"];
    let calls = message["tool_calls"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|call| {
                    let function = &call["function"];
                    let name = function["name"].as_str()?.trim();
                    if name.is_empty() || name.len() > 64 {
                        return None;
                    }
                    let arguments = match &function["arguments"] {
                        Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| json!({})),
                        Value::Object(map) => Value::Object(map.clone()),
                        _ => json!({}),
                    };
                    let arguments = if arguments.is_object() { arguments } else { json!({}) };
                    Some(Call { name: name.to_string(), arguments })
                })
                .take(MAX_CALLS)
                .collect()
        })
        .unwrap_or_default();
    let text = message["content"].as_str().unwrap_or_default().trim();
    // A reasoning model's thinking is not an answer.
    let text = match text.rfind("</think>") {
        Some(end) => text[end + "</think>".len()..].trim(),
        None => text,
    };
    // An answer of a few sentences is shown whole; a page is not an answer.
    Reply { calls, text: text.chars().take(1500).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earlier_turns_go_before_the_sentence_and_no_call_is_left_without_its_result() {
        let turn = |said: &str, calls: Value, result: &str| -> Turn {
            serde_json::from_value(json!({ "said": said, "calls": calls, "result": result })).unwrap()
        };
        let history = vec![
            turn("open spotify", json!([{ "name": "open_app", "arguments": { "name": "Spotify" } }]), "Spotify opened"),
            turn("what's playing", json!([]), "Get Lucky"),
            turn("add github and pause", json!([{ "name": "add_pills", "arguments": { "pills": ["GitHub"] } }, { "name": "music" }]), ""),
            turn("  ", json!([{ "name": "music" }]), "x"),
            turn("mumble", json!([{ "name": "" }]), ""),
        ];
        let messages = messages("system", &history, "what about steam");
        let roles: Vec<&str> = messages.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["system", "user", "assistant", "tool", "user", "assistant", "user", "assistant", "tool", "tool", "user", "user"]);
        assert_eq!(messages[2]["tool_calls"][0]["function"]["arguments"], "{\"name\":\"Spotify\"}");
        assert_eq!(messages[3]["content"], "Spotify opened");
        assert_eq!(messages[5]["content"], "Get Lucky");
        assert_eq!(messages[7]["tool_calls"][1]["function"]["arguments"], "{}");
        assert_eq!(messages[9]["content"], "Done.");
        assert_eq!(messages.last().unwrap(), &json!({ "role": "user", "content": "what about steam" }));
        // Every call has its result, by the same id, right after it.
        for (at, message) in messages.iter().enumerate() {
            for (n, call) in message["tool_calls"].as_array().into_iter().flatten().enumerate() {
                let result = &messages[at + 1 + n];
                assert_eq!(result["role"], "tool");
                assert_eq!(result["tool_call_id"], call["id"]);
            }
        }
        // No history is the two messages it always was.
        assert_eq!(super::messages("s", &[], "hi").len(), 2);

        // This turn's rounds follow the sentence: the calls, then each one's result.
        let steps: Vec<Step> = serde_json::from_value(json!([
            { "calls": [{ "name": "open_app", "arguments": { "name": "Spotify" } }, { "name": "music", "arguments": { "action": "play" } }],
              "results": ["{\"status\":\"done\",\"verified\":true}"] },
            { "calls": [], "results": [] },
            { "calls": [{ "name": "set_timer", "arguments": "not an object" }], "results": ["{\"status\":\"failed\"}"] },
        ]))
        .unwrap();
        let stepped = with_steps(super::messages("s", &[], "open spotify and play"), &steps);
        assert_eq!(stepped.len(), 2 + 3 + 2);
        assert_eq!(stepped[1]["content"], "open spotify and play");
        assert_eq!(stepped[2]["tool_calls"][1]["id"], "step_0_1");
        assert_eq!(stepped[3]["tool_call_id"], "step_0_0");
        assert_eq!(stepped[3]["content"], "{\"status\":\"done\",\"verified\":true}");
        // A call whose result was not recorded is not left without one.
        assert_eq!(stepped[4]["content"], "No result.");
        assert_eq!(stepped[5]["tool_calls"][0]["function"]["arguments"], "{}");
        assert_eq!(stepped[6]["tool_call_id"], "step_2_0");
        let many: Vec<Step> = (0..9).map(|_| Step { calls: vec![Called { name: "music".into(), arguments: json!({}) }], results: vec![] }).collect();
        assert_eq!(with_steps(Vec::new(), &many).len(), MAX_STEPS * 2);
        // Only the last few turns, and long ones cut.
        let many: Vec<Turn> = (0..20).map(|i| turn(&format!("turn {i}"), json!([]), &"x".repeat(1000))).collect();
        let messages = super::messages("s", &many, "now");
        assert_eq!(messages.len(), 2 + 2 * MAX_TURNS);
        assert_eq!(messages[1]["content"], "turn 14");
        assert_eq!(messages[2]["content"].as_str().unwrap().len(), MAX_RESULT);
    }

    #[test]
    fn tool_calls_are_read_whether_arguments_come_as_text_or_as_an_object() {
        let answer = json!({ "choices": [{ "message": { "content": "", "tool_calls": [
            { "function": { "name": "music", "arguments": "{\"action\":\"pause\"}" } },
            { "function": { "name": "add_pills", "arguments": { "pills": ["GitHub"] } } },
        ] } }] });
        assert_eq!(
            read(&answer),
            Reply {
                calls: vec![
                    Call { name: "music".into(), arguments: json!({ "action": "pause" }) },
                    Call { name: "add_pills".into(), arguments: json!({ "pills": ["GitHub"] }) },
                ],
                text: String::new(),
            }
        );
    }

    #[test]
    fn an_answer_in_words_is_kept_without_its_thinking() {
        let answer = json!({ "choices": [{ "message": { "content": "<think>hmm</think>\n The CI is passing. " } }] });
        assert_eq!(read(&answer), Reply { calls: vec![], text: "The CI is passing.".into() });
    }

    #[test]
    fn what_cannot_be_read_becomes_nothing_rather_than_an_error() {
        assert_eq!(read(&json!({})), Reply::default());
        assert_eq!(read(&json!({ "choices": [] })), Reply::default());
        let odd = json!({ "choices": [{ "message": { "content": 12, "tool_calls": [
            { "function": { "name": "", "arguments": "{}" } },
            { "function": { "arguments": "{}" } },
            { "function": { "name": "music", "arguments": "not json" } },
            { "function": { "name": "music", "arguments": "[1,2]" } },
            { "function": { "name": "music", "arguments": 4 } },
        ] } }] });
        let reply = read(&odd);
        assert_eq!(reply.text, "");
        assert_eq!(reply.calls.len(), 3);
        assert!(reply.calls.iter().all(|c| c.name == "music" && c.arguments == json!({})));
    }

    #[test]
    fn a_model_that_calls_everything_is_cut_short() {
        let many: Vec<Value> = (0..40).map(|_| json!({ "function": { "name": "music", "arguments": "{}" } })).collect();
        let answer = json!({ "choices": [{ "message": { "tool_calls": many } }] });
        assert_eq!(read(&answer).calls.len(), MAX_CALLS);
    }
}
