//! `peika-hook --mcp` — the relay as a stdio MCP server, for the cloud model
//! of a voice turn.
//!
//! Peika starts Claude Code for one turn of "OK Peika" and names this as its
//! only MCP server (the app's voice/cloud.rs). Claude Code speaks MCP on our
//! stdin and stdout, one JSON-RPC message a line; each line is passed to the
//! app over the pipe the hooks use, and the app's answer is written back. The
//! protocol itself is the app's (voice/mcp.rs): nothing is decided here, and
//! nothing is kept or logged.
//!
//! Why the relay and not a socket: the pipe is already there, it is reached
//! only by this user's processes, and we already check that the server on the
//! other end is ours before sending anything. No port is opened.
//!
//! With every line goes the turn's secret, which the app put in our
//! environment through the configuration it gave Claude Code: the app answers
//! only the relay of the turn that is running.

use std::io::{BufRead, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// Where the turn's secret is. Must match the app's voice/mcp.rs.
const TURN_ENV: &str = "PEIKA_MCP_TURN";
/// The key that tells the app this line is an MCP message. Must match too.
const PIPE_KEY: &str = "peika_mcp";
/// The longest message passed on. A tool call is a name and a few arguments;
/// the app's own bound on arguments is far under this.
const MAX_LINE: usize = 256 * 1024;
/// How long the app has to answer one message: its own wait for the island
/// (60 s for a tool call) and a little more. Past it the model gets an error.
const ANSWER_BUDGET: Duration = Duration::from_secs(75);

/// JSON-RPC's "parse error", and a server error of ours.
const PARSE_ERROR: i64 = -32700;
const NOT_ANSWERED: i64 = -32000;

pub fn run() -> ! {
    let turn = std::env::var(TURN_ENV).unwrap_or_default();
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    // Until Claude Code closes our input: the turn is over.
    while let Some(line) = read_line(&mut input, MAX_LINE) {
        let asked = line.and_then(|line| wrap(&line, &turn));
        let (line, id) = match asked {
            Some(asked) => asked,
            None => {
                print(&out, &error(&Value::Null, PARSE_ERROR, "Parse error"));
                continue;
            }
        };
        // Each message on its own thread: a call waiting for a click on the
        // island does not hold up the next one.
        let out = out.clone();
        std::thread::spawn(move || {
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(crate::talk(&line, true));
            });
            match rx.recv_timeout(ANSWER_BUDGET).ok().flatten() {
                Some(answer) => print(&out, &answer),
                // Peika is closed or did not answer: a request is told so,
                // a notification expects nothing.
                None => {
                    if let Some(id) = id {
                        print(&out, &error(&id, NOT_ANSWERED, "Peika did not answer."));
                    }
                }
            }
        });
    }
    std::process::exit(0);
}

fn print(out: &Mutex<std::io::Stdout>, line: &str) {
    if let Ok(mut out) = out.lock() {
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

fn error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// The next line of input, without its end: None when the input is closed,
/// `Some(None)` for a line longer than `max` (read to its end and dropped).
/// Blank lines are skipped.
fn read_line(input: &mut impl BufRead, max: usize) -> Option<Option<String>> {
    loop {
        let mut line = Vec::new();
        let read = input.by_ref().take(max as u64 + 1).read_until(b'\n', &mut line).ok()?;
        if read == 0 {
            return None;
        }
        if line.len() > max && !line.ends_with(b"\n") {
            // Too long: the rest of it is read and thrown away, a piece at a time.
            loop {
                line.clear();
                let more = input.by_ref().take(max as u64).read_until(b'\n', &mut line).ok()?;
                if more == 0 || line.ends_with(b"\n") {
                    return Some(None);
                }
            }
        }
        let text = String::from_utf8_lossy(&line).trim().to_string();
        if !text.is_empty() {
            return Some(Some(text));
        }
    }
}

/// One MCP message as the line the app reads, and the id to answer under if
/// the app does not (None for a notification). None when it is not JSON.
fn wrap(line: &str, turn: &str) -> Option<(String, Option<Value>)> {
    let message: Value = serde_json::from_str(line).ok()?;
    let id = message.get("id").filter(|id| !id.is_null()).cloned();
    let mut line = json!({ PIPE_KEY: { "turn": turn, "message": message } }).to_string();
    line.push('\n');
    Some((line, id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_goes_to_the_app_whole_with_the_turns_secret() {
        let call = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"music_next","arguments":{}}}"#;
        let (line, id) = wrap(call, "s3cret").unwrap();
        assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
        let sent: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(sent[PIPE_KEY]["turn"], "s3cret");
        assert_eq!(sent[PIPE_KEY]["message"], serde_json::from_str::<Value>(call).unwrap());
        // Not a hook event: the app must not take it for one.
        assert!(sent.get("hook_event_name").is_none());
        assert_eq!(id, Some(json!(3)));
        // A notification has nobody to tell when the app is silent.
        let (_, id) = wrap(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, "s").unwrap();
        assert_eq!(id, None);
        assert_eq!(wrap(r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#, "s").unwrap().1, Some(json!("a")));
        assert!(wrap("not json", "s").is_none());
    }

    #[test]
    fn lines_are_read_one_at_a_time_and_an_endless_one_is_dropped() {
        let long = "x".repeat(50);
        let text = format!("{{\"a\":1}}\r\n\n  \n{long}\nlast");
        let mut input = text.as_bytes();
        assert_eq!(read_line(&mut input, 20), Some(Some("{\"a\":1}".to_string())));
        // Too long: dropped whole, and what follows it is read as usual.
        assert_eq!(read_line(&mut input, 20), Some(None));
        assert_eq!(read_line(&mut input, 20), Some(Some("last".to_string())));
        assert_eq!(read_line(&mut input, 20), None);
        // A line of exactly the most allowed is kept.
        let mut exact = "12345\nnext\n".as_bytes();
        assert_eq!(read_line(&mut exact, 5), Some(Some("12345".to_string())));
        assert_eq!(read_line(&mut exact, 5), Some(Some("next".to_string())));
    }

    #[test]
    fn an_unanswered_request_is_told_so_in_json_rpc() {
        let told: Value = serde_json::from_str(&error(&json!(7), NOT_ANSWERED, "Peika did not answer.")).unwrap();
        assert_eq!(told, json!({ "jsonrpc": "2.0", "id": 7, "error": { "code": NOT_ANSWERED, "message": "Peika did not answer." } }));
        assert!(!error(&Value::Null, PARSE_ERROR, "Parse error").contains('\n'));
    }
}
