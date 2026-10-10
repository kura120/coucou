// What a sentence means when the parser does not know: the question is put to
// the model server the user connected (Ollama, LM Studio or their own), with
// the tools Coucou offers. The model proposes — tool calls, or a short answer —
// and the island decides what is done with them (src/voice/tools.ts). Nothing
// here acts.
//
// The sentence and what the island says about the app's state go to that
// server and nowhere else. A server that is not this machine was chosen by
// the user; a toast says so the first time, once per address.

use std::collections::BTreeSet;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
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

/// Addresses the "not on this machine" toast was shown for, this run.
static WARNED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

pub async fn ask(app: &AppHandle, settings: &Settings, system: &str, said: &str, tools: &Value) -> Result<Reply, String> {
    let server = local_chat::server(settings, &settings.voice.brain).ok_or("no model server is chosen for voice")?;
    let model = settings.voice.brain_model.trim();
    if model.is_empty() {
        return Err("no model is chosen for voice".into());
    }
    let tools_size = serde_json::to_string(tools).map(|s| s.len()).unwrap_or(usize::MAX);
    if system.len() > MAX_SYSTEM || said.len() > MAX_SAID || tools_size > MAX_TOOLS || !tools.is_array() {
        return Err("voice: request refused".into());
    }
    if let Ok(url) = net::normalise_server_url(&server.url) {
        if !net::is_loopback_url(&url) {
            let address = url.as_str().trim_end_matches('/').to_string();
            if WARNED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(address.clone()) {
                toast::warn(
                    app,
                    t("What you say goes to another computer"),
                    Some(tf("Voice asks the model server at {url}, which is not this machine.", &[("url", &address)])),
                );
            }
        }
    }
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": said },
        ],
        "tools": tools,
        "temperature": 0,
        "stream": false,
    });
    let answer = local_chat::complete(&server, &body, TIMEOUT).await?;
    Ok(read(&answer))
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
    Reply { calls, text: text.chars().take(400).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

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
