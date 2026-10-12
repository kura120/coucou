// The MCP endpoint: how the cloud model of a voice turn (cloud.rs) reaches
// the app's capabilities. It lists the tools the island published and, on a
// call, hands it to the island (`capability-call`) and waits for what came of
// it (`capability_result`). It carries calls and nothing more: the island's
// registry still decides what runs, with a click where its tier asks for one.
//
// Transport: Claude Code starts `coucou-hook --mcp` as a stdio MCP server, and
// that relay passes each message here over the pipe the hooks already use
// (pipe.rs). So there is no listening socket, no port and no token on the
// network, and the pipe keeps its own promise: only this user's processes
// reach it. All of the protocol is here; the relay only carries lines.
//
// What keeps it narrow:
// - It answers only while a voice turn is running, and only to the relay that
//   turn started: each message carries the turn's secret, made when the turn
//   begins and forgotten when it ends.
// - Only names in the published list are forwarded.
// - Arguments, results, the list itself and the calls of one turn are bounded.
// - A call nobody answers in time is an error result, never a hang.
// - Nothing of a call is logged: not its name, its arguments or its result.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::island::WINDOW_LABEL;

/// The server's name in Claude Code's configuration: its tools are
/// `mcp__coucou__<capability>` there.
pub const SERVER: &str = "coucou";
/// The relay's argument for this mode (hook/src/mcp.rs).
pub const RELAY_FLAG: &str = "--mcp";
/// Where the relay finds the turn's secret: its own environment, set in the
/// configuration Claude Code is given. Must match hook/src/mcp.rs.
pub const TURN_ENV: &str = "COUCOU_MCP_TURN";
/// The key of a pipe line that is an MCP message and not a hook event:
/// `{"coucou_mcp":{"turn":"…","message":{…}}}`. Must match hook/src/mcp.rs.
pub const PIPE_KEY: &str = "coucou_mcp";
const CALL_EVENT: &str = "capability-call";

/// What the island may publish: a tool list, not a document.
const MAX_TOOLS: usize = 128;
const MAX_TOOLS_BYTES: usize = 256 * 1024;
const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 2000;
/// What one call may carry in, and what the island may give back for it.
const MAX_ARGUMENTS: usize = 16 * 1024;
const MAX_RESULT: usize = 8 * 1024;
/// The calls of one turn. The island's turn has five rounds of a few calls.
const MAX_CALLS: usize = 24;
/// How long the island has to answer a call: long enough for a click on a
/// confirmation, short enough that the model is told rather than left waiting.
pub const CALL_WAIT: Duration = Duration::from_secs(60);

/// The protocol versions whose tools part is what is spoken here, newest first.
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// JSON-RPC's own error codes, and one of ours.
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const NO_TURN: i64 = -32001;

/// A capability as MCP lists it.
#[derive(Debug, Clone, PartialEq)]
struct Tool {
    name: String,
    description: String,
    schema: Value,
}

/// The `capability-call` event (src/core/bridge.ts `CapabilityCallEvent`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

struct Turn {
    secret: String,
    calls: usize,
}

#[derive(Default)]
struct State {
    /// The latest list the island published.
    tools: Vec<Tool>,
    /// The voice turn that is running, if one is.
    turn: Option<Turn>,
    /// The calls handed to the island and not answered yet.
    waiting: HashMap<String, oneshot::Sender<String>>,
    next: u64,
}

/// The endpoint's memory. One for the app (`endpoint`); the tests make their own.
#[derive(Default)]
pub struct Endpoint(Mutex<State>);

/// A voice turn, for as long as this is held: the endpoint answers its
/// secret, and stops when it is dropped.
pub struct Running<'a> {
    endpoint: &'a Endpoint,
    pub secret: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let mut state = self.endpoint.state();
        state.turn = None;
        // Calls still waiting learn that the turn is over.
        state.waiting.clear();
    }
}

pub fn endpoint() -> &'static Endpoint {
    static ENDPOINT: OnceLock<Endpoint> = OnceLock::new();
    ENDPOINT.get_or_init(Endpoint::default)
}

/// A secret nobody can guess, for one turn.
fn secret() -> Option<String> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn is_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// One published tool (the OpenAI function format, core/capabilities
/// `schemaOf`) as MCP lists it, or None when it is not one.
fn tool(published: &Value) -> Option<Tool> {
    let function = published.get("function")?;
    let name = function.get("name")?.as_str().filter(|name| is_name(name))?;
    let description: String = function.get("description").and_then(Value::as_str).unwrap_or("").chars().take(MAX_DESCRIPTION).collect();
    let schema = match function.get("parameters") {
        Some(schema) if schema.get("type").and_then(Value::as_str) == Some("object") => schema.clone(),
        _ => json!({ "type": "object", "properties": {} }),
    };
    Some(Tool { name: name.to_string(), description, schema })
}

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// What a tool call gave, as MCP says it: text, and whether it is an error
/// the model should read and go on from.
fn said(id: &Value, text: &str, failed: bool) -> Value {
    reply(id, json!({ "content": [{ "type": "text", "text": text }], "isError": failed }))
}

impl Endpoint {
    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Keeps the island's list in place of the one before, and says how many
    /// tools it holds. What is not a tool, a name said twice and whatever
    /// passes the bounds are left out.
    pub fn publish(&self, tools: &Value) -> usize {
        let mut kept: Vec<Tool> = Vec::new();
        let mut bytes = 0;
        for published in tools.as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let Some(tool) = tool(published) else { continue };
            bytes += tool.name.len() + tool.description.len() + tool.schema.to_string().len();
            if kept.len() >= MAX_TOOLS || bytes > MAX_TOOLS_BYTES {
                break;
            }
            if !kept.iter().any(|other| other.name == tool.name) {
                kept.push(tool);
            }
        }
        let count = kept.len();
        self.state().tools = kept;
        count
    }

    /// A voice turn begins. None while another is running: one at a time.
    pub fn begin(&self) -> Option<Running<'_>> {
        let secret = secret()?;
        let mut state = self.state();
        if state.turn.is_some() {
            return None;
        }
        state.turn = Some(Turn { secret: secret.clone(), calls: 0 });
        Some(Running { endpoint: self, secret })
    }

    /// What the island made of a call. False when no call waits under that
    /// id: it was answered already, it timed out, or its turn is over.
    pub fn result(&self, id: &str, result: String) -> bool {
        match self.state().waiting.remove(id) {
            Some(waiting) => waiting.send(result).is_ok(),
            None => false,
        }
    }

    /// One MCP message from the relay, and the answer to write back: None for
    /// a notification. `secret` is what the relay sent with it, `emit` hands
    /// a call to the island, `wait` is how long the island has to answer.
    pub async fn answer(&self, secret: &str, message: &Value, wait: Duration, emit: impl Fn(Call)) -> Option<Value> {
        let id = message.get("id").filter(|id| !id.is_null());
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            // Not a request: a batch, a response, or nothing JSON-RPC knows.
            return Some(error(id.unwrap_or(&Value::Null), INVALID_REQUEST, "Invalid request"));
        };
        // Outside a turn, or from another turn's relay, there is nothing here.
        if !self.state().turn.as_ref().is_some_and(|turn| !secret.is_empty() && turn.secret == secret) {
            return id.map(|id| error(id, NO_TURN, "No voice turn is running."));
        }
        // A notification is never answered.
        let id = id?;
        Some(match method {
            "initialize" => {
                let asked = message.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = PROTOCOLS.iter().find(|known| **known == asked).unwrap_or(&PROTOCOLS[0]);
                reply(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
                    }),
                )
            }
            "ping" => reply(id, json!({})),
            "tools/list" => {
                let tools: Vec<Value> = self
                    .state()
                    .tools
                    .iter()
                    .map(|tool| json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.schema }))
                    .collect();
                reply(id, json!({ "tools": tools }))
            }
            "tools/call" => self.call(id, message.get("params").unwrap_or(&Value::Null), wait, emit).await,
            _ => error(id, METHOD_NOT_FOUND, "Method not found"),
        })
    }

    /// A tool call: checked, handed to the island, and waited for.
    async fn call(&self, id: &Value, params: &Value, wait: Duration, emit: impl Fn(Call)) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => json!({}),
            Some(arguments) if arguments.is_object() => arguments.clone(),
            Some(_) => return error(id, INVALID_PARAMS, "Arguments must be an object"),
        };
        let (call_id, answered) = {
            let mut state = self.state();
            // Only what the island published exists.
            if !state.tools.iter().any(|tool| tool.name == name) {
                return error(id, INVALID_PARAMS, "Unknown tool");
            }
            if arguments.to_string().len() > MAX_ARGUMENTS {
                return said(id, "The arguments are too large.", true);
            }
            let Some(turn) = state.turn.as_mut() else { return error(id, NO_TURN, "No voice turn is running.") };
            if turn.calls >= MAX_CALLS {
                return said(id, "Too many calls in one turn. Say what was done and stop.", true);
            }
            turn.calls += 1;
            state.next += 1;
            let call_id = format!("call-{}", state.next);
            let (tx, rx) = oneshot::channel();
            state.waiting.insert(call_id.clone(), tx);
            (call_id, rx)
        };
        emit(Call { id: call_id.clone(), name: name.to_string(), arguments });
        match tokio::time::timeout(wait, answered).await {
            Ok(Ok(result)) => said(id, &result.chars().take(MAX_RESULT).collect::<String>(), false),
            // The turn ended (stopped, or out of time) while the island was at it.
            Ok(Err(_)) => said(id, "The turn ended before Coucou answered.", true),
            Err(_) => {
                self.state().waiting.remove(&call_id);
                said(id, "Coucou did not answer in time.", true)
            }
        }
    }
}

/// One line from the relay, as pipe.rs read it under `PIPE_KEY`, and the line
/// to write back: the answer, or nothing for a notification.
pub async fn over_pipe(app: &AppHandle, asked: &Value) -> String {
    let secret = asked.get("turn").and_then(Value::as_str).unwrap_or("");
    let message = asked.get("message").unwrap_or(&Value::Null);
    let island = app.clone();
    let answer = endpoint()
        .answer(secret, message, CALL_WAIT, move |call| {
            // That a call was made, never which or with what.
            crate::log::line("voice: cloud: a capability is asked for");
            let _ = island.emit_to(WINDOW_LABEL, CALL_EVENT, call);
        })
        .await;
    answer.map(|answer| answer.to_string()).unwrap_or_default()
}

/// The capabilities a cloud model may ask for, as the island declares them
/// (OpenAI-format function tools). The latest list replaces the one before.
#[tauri::command]
pub fn capability_publish(tools: Value) {
    let given = tools.as_array().map(Vec::len).unwrap_or(0);
    let kept = endpoint().publish(&tools);
    if kept != given {
        crate::log::line(format!("voice: cloud: {kept} of {given} published capabilities kept"));
    }
}

/// What a `capability-call` came to, as the text the model is given back.
#[tauri::command]
pub fn capability_result(id: String, result: String) {
    if !endpoint().result(&id, result) {
        crate::log::line("voice: cloud: a result came for a call that no longer waits");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const SOON: Duration = Duration::from_millis(40);

    fn published() -> Value {
        json!([
            { "type": "function", "function": {
                "name": "music_next", "description": "Skips to the next track.",
                "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } } },
            { "type": "function", "function": {
                "name": "open_app", "description": "Opens an installed app.",
                "parameters": { "type": "object", "properties": { "app": { "type": "string" } }, "required": ["app"], "additionalProperties": false } } },
        ])
    }

    fn request(id: u64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    /// An endpoint with the two tools published, and what its calls are handed to.
    fn ready() -> (Endpoint, Arc<Mutex<Vec<Call>>>) {
        let endpoint = Endpoint::default();
        assert_eq!(endpoint.publish(&published()), 2);
        (endpoint, Arc::new(Mutex::new(Vec::new())))
    }

    fn emit_to(calls: &Arc<Mutex<Vec<Call>>>) -> impl Fn(Call) {
        let calls = calls.clone();
        move |call| calls.lock().unwrap().push(call)
    }

    fn text(answer: &Value) -> (&str, bool) {
        (answer["result"]["content"][0]["text"].as_str().unwrap_or(""), answer["result"]["isError"].as_bool().unwrap_or(false))
    }

    #[tokio::test]
    async fn it_introduces_itself_and_speaks_the_version_asked_for() {
        let (endpoint, calls) = ready();
        let turn = endpoint.begin().unwrap();
        let hello = request(1, "initialize", json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "claude-code" } }));
        let answer = endpoint.answer(&turn.secret, &hello, SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(answer["id"], 1);
        assert_eq!(answer["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(answer["result"]["serverInfo"]["name"], SERVER);
        assert!(answer["result"]["capabilities"]["tools"].is_object());
        // A version it does not know is answered with the newest it does.
        let later = request(2, "initialize", json!({ "protocolVersion": "2099-01-01" }));
        let answer = endpoint.answer(&turn.secret, &later, SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(answer["result"]["protocolVersion"], PROTOCOLS[0]);
        // Notifications get nothing; a ping gets an empty answer.
        let ready = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(endpoint.answer(&turn.secret, &ready, SOON, emit_to(&calls)).await, None);
        let ping = endpoint.answer(&turn.secret, &request(9, "ping", json!({})), SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(ping["result"], json!({}));
        // What it does not speak is said so.
        let other = endpoint.answer(&turn.secret, &request(3, "resources/list", json!({})), SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(other["error"]["code"], METHOD_NOT_FOUND);
        let batch = endpoint.answer(&turn.secret, &json!([hello]), SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(batch["error"]["code"], INVALID_REQUEST);
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_tools_listed_are_the_ones_published_last() {
        let (endpoint, calls) = ready();
        let turn = endpoint.begin().unwrap();
        let listed = endpoint.answer(&turn.secret, &request(1, "tools/list", json!({})), SOON, emit_to(&calls)).await.unwrap();
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.iter().map(|tool| tool["name"].as_str().unwrap()).collect::<Vec<_>>(), ["music_next", "open_app"]);
        assert_eq!(tools[1]["description"], "Opens an installed app.");
        assert_eq!(tools[1]["inputSchema"]["required"], json!(["app"]));
        // A new list replaces the old one whole, an empty one too.
        assert_eq!(endpoint.publish(&json!([published()[0]])), 1);
        let listed = endpoint.answer(&turn.secret, &request(2, "tools/list", json!({})), SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(endpoint.publish(&json!([])), 0);
        let listed = endpoint.answer(&turn.secret, &request(3, "tools/list", json!({})), SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(listed["result"]["tools"], json!([]));
    }

    #[test]
    fn what_is_published_is_checked_and_bounded() {
        let endpoint = Endpoint::default();
        let named = |name: &str| json!({ "type": "function", "function": { "name": name, "description": "d" } });
        // Not a list, not tools, names that are not names, and a name said twice.
        assert_eq!(endpoint.publish(&json!({ "tools": [] })), 0);
        let odd = json!([named("ok_one"), named(""), named("has space"), named("../up"), named(&"n".repeat(MAX_NAME + 1)), 7, { "function": {} }, named("ok_one"), named("ok-two")]);
        assert_eq!(endpoint.publish(&odd), 2);
        // A tool without a schema takes no arguments.
        assert_eq!(tool(&named("plain")).unwrap().schema, json!({ "type": "object", "properties": {} }));
        assert_eq!(tool(&json!({ "function": { "name": "odd", "parameters": "anything" } })).unwrap().schema["type"], "object");
        // No more than it is given room for, in number and in weight.
        let many: Vec<Value> = (0..MAX_TOOLS + 50).map(|i| named(&format!("tool_{i}"))).collect();
        assert_eq!(endpoint.publish(&json!(many)), MAX_TOOLS);
        let heavy: Vec<Value> = (0..40)
            .map(|i| json!({ "function": { "name": format!("heavy_{i}"), "parameters": { "type": "object", "description": "x".repeat(20_000) } } }))
            .collect();
        assert!(endpoint.publish(&json!(heavy)) < 14);
        let long = tool(&json!({ "function": { "name": "long", "description": "d".repeat(MAX_DESCRIPTION * 2) } })).unwrap();
        assert_eq!(long.description.len(), MAX_DESCRIPTION);
    }

    #[tokio::test]
    async fn a_call_goes_to_the_island_and_its_result_comes_back_as_text() {
        let (endpoint, calls) = ready();
        let endpoint = Arc::new(endpoint);
        let turn = endpoint.begin().unwrap();
        let secret = turn.secret.clone();
        let asking = {
            let (endpoint, calls) = (endpoint.clone(), calls.clone());
            tokio::spawn(async move {
                let call = request(7, "tools/call", json!({ "name": "open_app", "arguments": { "app": "Figma" } }));
                endpoint.answer(&secret, &call, Duration::from_secs(5), emit_to(&calls)).await
            })
        };
        // The island is told, with an id to answer by.
        let told = loop {
            if let Some(call) = calls.lock().unwrap().first().cloned() {
                break call;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        };
        assert_eq!((told.name.as_str(), &told.arguments), ("open_app", &json!({ "app": "Figma" })));
        assert_eq!(serde_json::to_value(&told).unwrap(), json!({ "id": told.id, "name": "open_app", "arguments": { "app": "Figma" } }));
        assert!(endpoint.result(&told.id, "done: Figma is open.".into()));
        let answer = asking.await.unwrap().unwrap();
        assert_eq!(answer["id"], 7);
        assert_eq!(text(&answer), ("done: Figma is open.", false));
        // Answered once: the same id again is nobody's.
        assert!(!endpoint.result(&told.id, "again".into()));
    }

    #[tokio::test]
    async fn only_published_names_are_forwarded_and_arguments_are_bounded() {
        let (endpoint, calls) = ready();
        let turn = endpoint.begin().unwrap();
        for name in ["approve_permission", "Bash", "", "music_next; rm"] {
            let call = request(1, "tools/call", json!({ "name": name, "arguments": {} }));
            let answer = endpoint.answer(&turn.secret, &call, SOON, emit_to(&calls)).await.unwrap();
            assert_eq!(answer["error"]["code"], INVALID_PARAMS, "{name}");
        }
        let not_an_object = request(2, "tools/call", json!({ "name": "open_app", "arguments": "Figma" }));
        assert_eq!(endpoint.answer(&turn.secret, &not_an_object, SOON, emit_to(&calls)).await.unwrap()["error"]["code"], INVALID_PARAMS);
        let large = request(3, "tools/call", json!({ "name": "open_app", "arguments": { "app": "x".repeat(MAX_ARGUMENTS) } }));
        let answer = endpoint.answer(&turn.secret, &large, SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(text(&answer), ("The arguments are too large.", true));
        // None of it reached the island.
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_call_nobody_answers_is_an_error_result_and_a_late_answer_is_dropped() {
        let (endpoint, calls) = ready();
        let turn = endpoint.begin().unwrap();
        // No arguments at all is an empty object.
        let call = request(1, "tools/call", json!({ "name": "music_next" }));
        let answer = endpoint.answer(&turn.secret, &call, SOON, emit_to(&calls)).await.unwrap();
        assert_eq!(text(&answer), ("Coucou did not answer in time.", true));
        let told = calls.lock().unwrap()[0].clone();
        assert_eq!(told.arguments, json!({}));
        // The island's answer comes after all: there is nobody to give it to.
        assert!(!endpoint.result(&told.id, "done".into()));
        assert!(!endpoint.result("call-999", "done".into()));
    }

    #[tokio::test]
    async fn a_result_is_cut_to_what_a_model_is_given() {
        let (endpoint, calls) = ready();
        let endpoint = Arc::new(endpoint);
        let turn = endpoint.begin().unwrap();
        let secret = turn.secret.clone();
        let asking = {
            let (endpoint, calls) = (endpoint.clone(), calls.clone());
            tokio::spawn(async move {
                endpoint.answer(&secret, &request(1, "tools/call", json!({ "name": "music_next" })), Duration::from_secs(5), emit_to(&calls)).await
            })
        };
        while calls.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let id = calls.lock().unwrap()[0].id.clone();
        endpoint.result(&id, "é".repeat(MAX_RESULT * 3));
        let answer = asking.await.unwrap().unwrap();
        assert_eq!(text(&answer).0.chars().count(), MAX_RESULT);
    }

    #[tokio::test]
    async fn outside_a_turn_or_with_another_turns_secret_nothing_answers() {
        let (endpoint, calls) = ready();
        let list = request(1, "tools/list", json!({}));
        let call = request(2, "tools/call", json!({ "name": "music_next" }));
        // Before any turn.
        for message in [&list, &call] {
            let answer = endpoint.answer("anything", message, SOON, emit_to(&calls)).await.unwrap();
            assert_eq!(answer["error"]["code"], NO_TURN);
        }
        let turn = endpoint.begin().unwrap();
        assert_eq!(turn.secret.len(), 64);
        // One turn at a time.
        assert!(endpoint.begin().is_none());
        // The wrong secret, or none.
        for secret in ["", "0000", &turn.secret[1..]] {
            let answer = endpoint.answer(secret, &call, SOON, emit_to(&calls)).await.unwrap();
            assert_eq!(answer["error"]["code"], NO_TURN, "{secret:?}");
        }
        let quiet = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(endpoint.answer("", &quiet, SOON, emit_to(&calls)).await, None);
        // Once the turn is over its secret opens nothing, and the next turn has another.
        let old = turn.secret.clone();
        drop(turn);
        assert_eq!(endpoint.answer(&old, &call, SOON, emit_to(&calls)).await.unwrap()["error"]["code"], NO_TURN);
        let next = endpoint.begin().unwrap();
        assert_ne!(next.secret, old);
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_call_still_waiting_when_the_turn_ends_is_told_so() {
        let (endpoint, calls) = ready();
        let endpoint = Arc::new(endpoint);
        let turn = endpoint.begin().unwrap();
        let secret = turn.secret.clone();
        let asking = {
            let (endpoint, calls) = (endpoint.clone(), calls.clone());
            tokio::spawn(async move {
                endpoint.answer(&secret, &request(1, "tools/call", json!({ "name": "music_next" })), Duration::from_secs(5), emit_to(&calls)).await
            })
        };
        while calls.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        drop(turn);
        let answer = asking.await.unwrap().unwrap();
        assert_eq!(text(&answer), ("The turn ended before Coucou answered.", true));
    }

    #[tokio::test]
    async fn a_turn_has_only_so_many_calls() {
        let (endpoint, calls) = ready();
        let turn = endpoint.begin().unwrap();
        let call = request(1, "tools/call", json!({ "name": "music_next" }));
        for _ in 0..MAX_CALLS {
            endpoint.answer(&turn.secret, &call, Duration::ZERO, emit_to(&calls)).await;
        }
        let answer = endpoint.answer(&turn.secret, &call, Duration::ZERO, emit_to(&calls)).await.unwrap();
        assert!(text(&answer).1 && text(&answer).0.starts_with("Too many calls"));
        assert_eq!(calls.lock().unwrap().len(), MAX_CALLS);
    }
}
