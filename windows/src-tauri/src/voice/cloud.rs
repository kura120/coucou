// The cloud tier: a voice turn the local model handed up, put to the provider
// the user chose for chat. Off unless `voice.cloud` is on in Settings.
//
// Version one is Claude Code only — the provider that answers with the
// user's own Claude plan, with no key of Coucou's (claude_code.rs). For any
// other chat provider nothing is asked, and the log says it is not supported
// yet. A turn counts against the plan's limits like a chat turn does.
//
// The model gets what the island wrote for it — what the app is and shows,
// the last turns, the sentence — and reaches the app only through the MCP
// endpoint (mcp.rs): Claude Code is started with that one server and nothing
// else. No tool of its own (no file, shell or web tool), no settings read (so
// Coucou's hooks do not fire for it), nothing saved to disk, and only that
// server's tools allowed without a prompt. The island still guards every
// call; a `confirm` capability still takes its click.
//
// The turn has a time limit, and ends at once when the island leaves the
// listening view (`voice_cancel`). Either way Claude Code is killed with what
// it started, the relay included.
//
// Nothing of what was said is logged: only that a turn began and how it ended.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use super::{brain, mcp};
use crate::settings::Settings;
use crate::{chat, claude_code};

/// The whole turn, tool calls and clicks included. Past it the turn is killed.
const TURN_LIMIT: Duration = Duration::from_secs(150);
/// How long Claude Code may say nothing: longer than a call may wait for the
/// island (mcp.rs `CALL_WAIT`), so a click being waited for is not silence.
const QUIET: Duration = Duration::from_secs(90);
/// What the island may send: a briefing and a sentence, not a document.
const MAX_SYSTEM: usize = 32 * 1024;
const MAX_SAID: usize = 600;
/// The turns before this one, as brain.rs bounds them for the local model.
const MAX_TURNS: usize = 6;
const MAX_TURN_CALLS: usize = 3;
const MAX_RESULT: usize = 240;
const MAX_CALL: usize = 400;
/// The model's last words are said out loud: a few sentences at most.
const MAX_ANSWER: usize = 2000;

/// Bumped by `cancel`: a running turn that sees it change ends there.
static CANCELS: AtomicU64 = AtomicU64::new(0);

/// The island left the listening view: a turn that is running is stopped.
pub fn cancel() {
    CANCELS.fetch_add(1, Ordering::Relaxed);
}

/// The model's last words (src/core/bridge.ts `voiceCloud`).
#[derive(Debug, Serialize, PartialEq)]
pub struct Said {
    pub text: String,
}

/// Why a turn is not put to the cloud model, from the settings and the
/// request alone; None when it may be.
fn refused(settings: &Settings, system: &str, said: &str) -> Option<&'static str> {
    if !settings.voice.enabled || !settings.voice.cloud {
        return Some("the cloud tier is off in Settings");
    }
    if settings.chat_provider != claude_code::ID {
        return Some("the provider chosen for chat is not supported yet (Claude Code only)");
    }
    if said.trim().is_empty() || said.len() > MAX_SAID || system.len() > MAX_SYSTEM {
        return Some("the request is empty or too large");
    }
    None
}

/// The one MCP server Claude Code is given: the relay in its MCP mode, with
/// the turn's secret in its environment. Forward slashes: the path is then
/// the same text in JSON and on a command line.
fn mcp_config(relay: &Path, secret: &str) -> String {
    json!({
        "mcpServers": {
            mcp::SERVER: {
                "type": "stdio",
                "command": relay.to_string_lossy().replace('\\', "/"),
                "args": [mcp::RELAY_FLAG],
                "env": { mcp::TURN_ENV: secret },
            }
        }
    })
    .to_string()
}

/// What Claude Code reads, part by part: the island's briefing, the turns so
/// far (each sentence, what was done for it and what came of it), and the
/// sentence. The oldest turns go first when there are too many.
fn message(system: &str, history: &[brain::Turn], said: &str) -> Vec<String> {
    let cut = |text: &str, most: usize| text.chars().take(most).collect::<String>();
    let mut parts = vec![format!("Coucou's briefing:\n{}", system.trim())];
    let turns: Vec<&brain::Turn> = history[history.len().saturating_sub(MAX_TURNS)..].iter().filter(|turn| !turn.said.trim().is_empty()).collect();
    if !turns.is_empty() {
        let mut earlier = String::from("Earlier in this conversation, oldest first:");
        for turn in turns {
            earlier.push_str(&format!("\nUser: {}", cut(turn.said.trim(), MAX_SAID)));
            for call in turn.calls.iter().filter(|call| !call.name.trim().is_empty()).take(MAX_TURN_CALLS) {
                let arguments = if call.arguments.is_object() { call.arguments.to_string() } else { "{}".to_string() };
                earlier.push_str(&format!("\nCoucou called: {}", cut(&format!("{} {arguments}", call.name.trim()), MAX_CALL)));
            }
            if !turn.result.trim().is_empty() {
                earlier.push_str(&format!("\nCoucou: {}", cut(turn.result.trim(), MAX_RESULT)));
            }
        }
        parts.push(earlier);
    }
    parts.push(format!("The user now says:\n{}", said.trim()));
    parts
}

/// The turn itself: Claude Code is started with the endpoint's relay as its
/// only server, and read until its last words or until `stopped` or the time
/// limit. Blocking.
fn turn(
    exe: &Path,
    relay: &Path,
    model: &str,
    secret: &str,
    parts: &[String],
    stopped: &dyn Fn() -> bool,
) -> Result<String, String> {
    let args = claude_code::voice_args(model, &mcp_config(relay, secret), mcp::SERVER);
    let limits = claude_code::Limits { stopped, deadline: Some(Instant::now() + TURN_LIMIT) };
    claude_code::voice_turn(exe, &args, &claude_code::voice_line(parts), QUIET, limits)
}

/// The turn the local model handed up, put to the provider chosen for chat.
/// Its last words, or nothing when it cannot be asked or did not answer: the
/// log says which, never what was said.
#[tauri::command]
pub async fn voice_cloud(
    _app: AppHandle,
    shared: State<'_, crate::Shared>,
    system: String,
    said: String,
    history: Option<Vec<brain::Turn>>,
) -> Result<Option<Said>, String> {
    let settings = shared.settings.lock().unwrap().clone();
    let nothing = |why: &str| {
        crate::log::line(format!("voice: cloud: not asked: {why}"));
        Ok(None)
    };
    if let Some(why) = refused(&settings, &system, &said) {
        return nothing(why);
    }
    let Some(exe) = claude_code::installed() else { return nothing("Claude Code is not installed") };
    let relay = crate::settings::hook_exe_path();
    if !relay.is_file() {
        return nothing("the relay is not installed");
    }
    // From here the endpoint answers, and only this turn's relay.
    let Some(running) = mcp::endpoint().begin() else { return nothing("a turn is already running") };
    let model = chat::model_for(&settings, claude_code::ID);
    let parts = message(&system, &history.unwrap_or_default(), &said);
    let secret = running.secret.clone();
    let cancels = CANCELS.load(Ordering::Relaxed);
    crate::log::line("voice: cloud: asked");
    let started = Instant::now();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        turn(&exe, &relay, &model, &secret, &parts, &|| CANCELS.load(Ordering::Relaxed) != cancels)
    })
    .await;
    // The turn is over: the endpoint stops answering, whatever came of it.
    drop(running);
    let cancelled = CANCELS.load(Ordering::Relaxed) != cancels;
    Ok(match answer {
        Ok(Ok(text)) if !cancelled && !text.trim().is_empty() => {
            crate::log::line("voice: cloud: answered");
            Some(Said { text: text.trim().chars().take(MAX_ANSWER).collect() })
        }
        _ => {
            // Why, by what is known here: Claude Code's own message may hold the model's words.
            let why = if cancelled {
                "stopped"
            } else if started.elapsed() >= TURN_LIMIT {
                "out of time"
            } else {
                "no answer"
            };
            crate::log::line(format!("voice: cloud: {why}"));
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn on() -> Settings {
        let mut settings = Settings::default();
        settings.voice.enabled = true;
        settings.voice.cloud = true;
        settings.chat_provider = claude_code::ID.into();
        settings
    }

    #[test]
    fn nothing_is_asked_unless_the_user_turned_it_on_for_claude_code() {
        assert_eq!(refused(&on(), "briefing", "what is on my screen"), None);
        // Off by default, whatever the provider.
        assert!(refused(&Settings::default(), "s", "hello").is_some());
        let mut settings = on();
        settings.voice.cloud = false;
        assert_eq!(refused(&settings, "s", "hello"), Some("the cloud tier is off in Settings"));
        let mut settings = on();
        settings.voice.enabled = false;
        assert!(refused(&settings, "s", "hello").is_some());
        // Any other chat provider: not yet.
        for provider in [chat::ANTHROPIC, "openai", "ollama", ""] {
            let mut settings = on();
            settings.chat_provider = provider.into();
            assert_eq!(refused(&settings, "s", "hello"), Some("the provider chosen for chat is not supported yet (Claude Code only)"), "{provider}");
        }
        // A sentence, not a document.
        assert!(refused(&on(), "s", "  ").is_some());
        assert!(refused(&on(), "s", &"x".repeat(MAX_SAID + 1)).is_some());
        assert!(refused(&on(), &"x".repeat(MAX_SYSTEM + 1), "hello").is_some());
    }

    #[test]
    fn claude_code_is_given_the_relay_as_its_one_server_with_the_turns_secret() {
        let config: Value = serde_json::from_str(&mcp_config(Path::new(r"C:\Users\Jane O'Neil\AppData\Local\Coucou\bin\coucou-hook.exe"), "abc123")).unwrap();
        let servers = config["mcpServers"].as_object().unwrap();
        assert_eq!(servers.keys().collect::<Vec<_>>(), ["coucou"]);
        let server = &servers["coucou"];
        assert_eq!(server["type"], "stdio");
        assert_eq!(server["command"], "C:/Users/Jane O'Neil/AppData/Local/Coucou/bin/coucou-hook.exe");
        assert_eq!(server["args"], json!(["--mcp"]));
        assert_eq!(server["env"], json!({ "COUCOU_MCP_TURN": "abc123" }));
        // One line, and nothing a `.cmd` cannot carry.
        let text = mcp_config(Path::new(r"C:\x\coucou-hook.exe"), "abc123");
        assert!(!text.contains(['\n', '\r', '%', '\\']));
        // The whole command line names that server and allows its tools alone.
        let args = claude_code::voice_args("m", &text, mcp::SERVER);
        assert!(args.contains(&text) && args.contains(&"mcp__coucou".to_string()));
    }

    #[test]
    fn the_message_is_the_briefing_the_turns_so_far_and_the_sentence() {
        let alone = message(" You are in Coucou. ", &[], " pause the music ");
        assert_eq!(alone, ["Coucou's briefing:\nYou are in Coucou.", "The user now says:\npause the music"]);

        let history: Vec<brain::Turn> = serde_json::from_value(json!([
            { "said": "open figma", "calls": [{ "name": "open_app", "arguments": { "app": "Figma" } }], "result": "Opened Figma." },
            { "said": "  ", "calls": [], "result": "nothing was said" },
            { "said": "what time is it", "result": "It is four." },
        ]))
        .unwrap();
        let parts = message("b", &history, "and spotify");
        assert_eq!(parts.len(), 3);
        assert_eq!(
            parts[1],
            "Earlier in this conversation, oldest first:\n\
             User: open figma\nCoucou called: open_app {\"app\":\"Figma\"}\nCoucou: Opened Figma.\n\
             User: what time is it\nCoucou: It is four."
        );
        assert_eq!(parts[2], "The user now says:\nand spotify");
    }

    #[test]
    fn the_turns_so_far_are_bounded() {
        let long: Vec<brain::Turn> = (0..40)
            .map(|i| {
                serde_json::from_value(json!({
                    "said": format!("sentence {i} {}", "x".repeat(2000)),
                    "calls": (0..9).map(|c| json!({ "name": format!("tool_{c}"), "arguments": { "text": "y".repeat(5000) } })).collect::<Vec<_>>(),
                    "result": "z".repeat(5000),
                }))
                .unwrap()
            })
            .collect();
        let parts = message("b", &long, "now");
        let earlier = &parts[1];
        // The last six, three calls each, every piece cut.
        assert_eq!(earlier.matches("\nUser: ").count(), MAX_TURNS);
        assert!(earlier.contains("sentence 39") && !earlier.contains("sentence 33 "));
        assert_eq!(earlier.matches("\nCoucou called: ").count(), MAX_TURNS * MAX_TURN_CALLS);
        assert!(earlier.len() < MAX_TURNS * (MAX_SAID + MAX_TURN_CALLS * MAX_CALL + MAX_RESULT + 100));
    }

    #[test]
    fn leaving_the_listening_view_stops_a_turn_and_only_one_that_is_running() {
        let before = CANCELS.load(Ordering::Relaxed);
        let stopped = || CANCELS.load(Ordering::Relaxed) != before;
        assert!(!stopped());
        cancel();
        assert!(stopped());
        // A turn that starts afterwards is not stopped by what came before it.
        let later = CANCELS.load(Ordering::Relaxed);
        assert!(CANCELS.load(Ordering::Relaxed) == later);
    }

    /// The real thing: one turn of Claude Code, on the plan it is signed in
    /// with, started exactly as `voice_cloud` starts it. It counts against
    /// that plan, so it runs only when asked for:
    ///
    ///   cargo build --release -p coucou-hook
    ///   cargo test -p coucou voice::cloud::tests::claude_code_answers_a_voice_turn -- --ignored --nocapture
    ///
    /// What it shows: Claude Code takes the command line (the MCP server as
    /// its only configuration, no tool of its own, no settings) and answers
    /// in words. What it cannot show: a tool call. The relay it starts talks
    /// to whichever Coucou is running, not to this test, and that Coucou has
    /// no turn with this test's secret: it answers "no voice turn is running"
    /// (or nothing at all, if it is an older build, which takes the line for
    /// a hook event it does not know). So the model is offered no tool here
    /// and is asked for words only. A tool call is to be tried in the app
    /// built from this code: turn on the cloud switch in Settings → Voice,
    /// choose Claude Code for chat, and say something the local model hands up.
    #[test]
    #[ignore = "starts Claude Code: a turn on the user's plan"]
    fn claude_code_answers_a_voice_turn() {
        let exe = claude_code::installed().expect("Claude Code is not installed");
        let relay = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/release").join(crate::platform::HOOK_EXE);
        assert!(relay.is_file(), "build the relay first: cargo build --release -p coucou-hook");
        let running = mcp::endpoint().begin().expect("a turn");
        let parts = message("You are being tested. Call no tool.", &[], "Answer with the single word: ready");
        let started = Instant::now();
        let answer = turn(&exe, &relay, claude_code::DEFAULT_MODEL, &running.secret, &parts, &|| false);
        println!("answered in {:?}: {answer:?}", started.elapsed());
        let text = answer.expect("Claude Code gave no answer");
        assert!(text.to_lowercase().contains("ready"), "{text:?}");
    }
}
