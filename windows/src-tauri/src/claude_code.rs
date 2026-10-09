// Chat through the Claude Code the user already has — no API key.
//
// Coucou asks the Claude Code CLI itself, the way codex_plan.rs asks Codex:
// `claude -p` is started for one turn, given the question, and read until its
// answer. Coucou reads no credential and calls nothing itself: Claude Code
// answers with its own sign-in (a Claude Pro or Max plan, usually), so a turn
// counts against that plan's limits.
//
// Two ways to run it, picked above the chat box:
//
// * No folder — a plain chat model. Web search is its only tool, no settings
//   file is read (Coucou's own hooks do not fire), nothing is saved to disk,
//   and the earlier turns ride along with each question. (Coucou itself keeps
//   the conversation's text, like any conversation of the list: conversations.rs.)
// * A folder — Claude Code as it runs in a terminal there: its tools, the
//   user's settings and the project's, in the permission mode picked. The
//   conversation is a Claude Code session, resumed turn after turn. Anything
//   that needs a permission is never answered here: with Coucou's hooks in
//   place the request shows in the island like any other session's and waits
//   for a click, and without them it is denied.
//
// The answer is streamed like a local model's: `chat-delta` events carry the
// text so far, and the reply of the command is the finished text. A file
// Claude Code edited on the way goes to the island as a `chat-edit` event —
// the tool's own input, once the tool has succeeded — which the chat shows as
// a pill with its diff.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::i18n::t;
use crate::island::WINDOW_LABEL;
use crate::settings::Settings;
use crate::{claude, platform};

pub const ID: &str = "claudecode";
pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";
/// What Claude Code's `fable`, `opus`, `sonnet` and `haiku` aliases stand for.
const MODELS: &[(&str, &str)] = &[
    ("claude-fable-5-1", "Claude Fable 5.1"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
];
/// `--effort` and `--permission-mode` values the settings may carry. Bypassing
/// permissions is not one of them: nothing is approved without a click.
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const MODES: &[&str] = &["default", "acceptEdits", "plan", "auto"];

/// How long Claude Code may stay silent before the turn is stopped: a chat
/// answer, and a tool at work in a folder (or a request waiting in the island).
const CHAT_QUIET: Duration = Duration::from_secs(300);
const AGENT_QUIET: Duration = Duration::from_secs(900);
/// Once it has answered, Claude Code gets this long to finish on its own (save
/// the session, run its Stop hooks) before it is ended.
const WRAP_UP: Duration = Duration::from_secs(5);
/// How often a waiting turn looks at whether it was stopped.
const TICK: Duration = Duration::from_millis(200);
/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings for what is read: one line (search results come back as one), and the whole answer.
const MAX_LINE: usize = 8 * 1024 * 1024;
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// The tools whose calls are file edits, and how large an edit may be to be
/// shown (the island stops diffing at 200 KB a side anyway).
const EDIT_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write"];
const MAX_EDIT_BYTES: usize = 512 * 1024;

/// Mochi's voice on top of Claude Code's own instructions, when it works in a folder.
const AGENT_PROMPT: &str = "You are answering as Mochi, in Coucou's small chat window at the top of the user's screen. \
Respond in the user's language. Keep answers short and use light Markdown: short paragraphs, bullet lists, \
**bold**, `inline code` and fenced code blocks. Avoid tables and big headings.";

/// Bumped by `stop`: a running turn that sees it change ends there.
static STOPS: AtomicU64 = AtomicU64::new(0);

/// "Stop" in the chat view: ends the turn that is running, if any.
pub fn stop() {
    STOPS.fetch_add(1, Ordering::Relaxed);
}

fn exe() -> Result<PathBuf, String> {
    platform::claude_candidates().into_iter().next().ok_or_else(|| {
        t("Claude Code isn't installed. Install it and sign in with your Claude account, then try again.")
    })
}

/// The models of the picker. Claude Code has no list to ask for.
pub fn models() -> Result<Vec<ModelInfo>, String> {
    exe()?;
    Ok(MODELS.iter().map(|(id, label)| ModelInfo { id: id.to_string(), label: label.to_string() }).collect())
}

/// What the settings ask of Claude Code, checked: only known values reach its command line.
#[derive(Debug, PartialEq)]
struct Options {
    /// The folder it works in; None for the plain chat.
    dir: Option<PathBuf>,
    effort: Option<&'static str>,
    mode: &'static str,
}

fn options(settings: &Settings) -> Result<Options, String> {
    let known = |list: &[&'static str], value: &str| list.iter().copied().find(|v| *v == value);
    let dir = settings.claude_code_dir.trim();
    let dir = if dir.is_empty() {
        None
    } else {
        let path = PathBuf::from(dir);
        if !path.is_absolute() || !path.is_dir() {
            return Err(t("The folder picked for Claude Code is gone. Pick another one above the chat box."));
        }
        Some(path)
    };
    Ok(Options {
        dir,
        effort: known(EFFORTS, &settings.claude_code_effort),
        mode: known(MODES, &settings.claude_code_mode).unwrap_or(MODES[0]),
    })
}

fn args(model: &str, options: &Options, resume: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut add = |more: &[&str]| args.extend(more.iter().map(|a| a.to_string()));
    add(&[
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", model,
        // Nothing is ever approved from here: a hook (Coucou's) answers, or nobody.
        "--permission-prompts", "none",
    ]);
    if let Some(effort) = options.effort {
        add(&["--effort", effort]);
    }
    if options.dir.is_some() {
        add(&["--append-system-prompt", AGENT_PROMPT, "--permission-mode", options.mode]);
        if let Some(session) = resume {
            add(&["--resume", session]);
        }
    } else {
        add(&[
            "--system-prompt", &chat::system_prompt(true),
            "--tools", "WebSearch",
            "--allowedTools", "WebSearch",
            "--strict-mcp-config",
            "--setting-sources", "",
            "--no-session-persistence",
            "--disable-slash-commands",
        ]);
    }
    args
}

/// The Claude Code session the conversation lives in, when its last turn was
/// one of ours in this same folder (a session belongs to the folder it began in).
fn session_of(history: &[Value], dir: &Path) -> Option<String> {
    let last = history.iter().rev().find(|m| m.get("role").and_then(Value::as_str) == Some("user"))?;
    let same = last.get("dir").and_then(Value::as_str) == Some(dir.to_string_lossy().as_ref());
    last.get("session").and_then(Value::as_str).filter(|_| same).map(str::to_string)
}

/// The session of the conversation's last turn, whatever its folder — what a
/// saved conversation keeps (conversations.rs).
pub fn session_in(history: &[Value]) -> Option<String> {
    let last = history.iter().rev().find(|m| m.get("role").and_then(Value::as_str) == Some("user"))?;
    last.get("session").and_then(Value::as_str).map(str::to_string)
}

/// A saved conversation's turns as this module keeps them: the last question
/// carries the session and its folder again, so the next turn resumes it.
pub fn resumed(turns: &[Value], session: &str, dir: &str) -> Vec<Value> {
    let mut history = turns.to_vec();
    if let Some(Value::Object(last)) =
        history.iter_mut().rev().find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
    {
        last.insert("session".into(), json!(session));
        last.insert("dir".into(), json!(dir));
    }
    history
}

/// The one line Claude Code reads: a single user message. Turns it does not
/// already hold in a session come first in that message, each under who said
/// it (a dropped file keeps its place in the turn it came with).
fn input_line(history: &[Value], content: &[Value]) -> String {
    let text = |s: &str| json!({ "type": "text", "text": s });
    let mut blocks = Vec::new();
    if !history.is_empty() {
        blocks.push(text("The conversation so far, for context. Answer only the new message at the end."));
        for turn in history {
            let mochi = turn.get("role").and_then(Value::as_str) == Some("assistant");
            blocks.push(text(if mochi { "Mochi:" } else { "User:" }));
            match turn.get("content") {
                Some(Value::String(s)) => blocks.push(text(s)),
                Some(Value::Array(parts)) => blocks.extend(parts.iter().cloned()),
                _ => {}
            }
        }
        blocks.push(text("The new message:"));
    }
    blocks.extend(content.iter().cloned());
    json!({ "type": "user", "message": { "role": "user", "content": blocks } }).to_string()
}

/// What one line of Claude Code's output means for the chat.
#[derive(Debug, PartialEq)]
enum Event {
    /// The session this turn belongs to.
    Session(String),
    /// More of the answer's text.
    Delta(String),
    /// Another message begins (after a tool ran): its text starts a new paragraph.
    NewMessage,
    /// Claude Code is about to edit files: `(tool use id, tool, input)`.
    Edits(Vec<(String, String, Value)>),
    /// Tools finished: `(tool use id, it succeeded)`.
    ToolResults(Vec<(String, bool)>),
    /// The turn is over: the final text, or what went wrong.
    Done(Result<String, String>),
    /// Anything else: Claude Code is at work.
    Other,
}

fn parse_line(line: &str) -> Event {
    let Ok(json) = serde_json::from_str::<Value>(line) else { return Event::Other };
    let kind = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    match kind(&json, "type").as_str() {
        "system" if kind(&json, "subtype") == "init" => match json.get("session_id").and_then(Value::as_str) {
            Some(id) => Event::Session(id.to_string()),
            None => Event::Other,
        },
        // A subagent's own text is not the answer.
        "stream_event" if json.get("parent_tool_use_id").is_none_or(Value::is_null) => {
            let event = json.get("event").unwrap_or(&Value::Null);
            match kind(event, "type").as_str() {
                "message_start" => Event::NewMessage,
                "content_block_delta" if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") => {
                    match event.pointer("/delta/text").and_then(Value::as_str) {
                        Some(text) => Event::Delta(text.to_string()),
                        None => Event::Other,
                    }
                }
                _ => Event::Other,
            }
        }
        // Whole messages, not deltas: a tool call arrives complete here.
        "assistant" | "user" if json.get("parent_tool_use_id").is_none_or(Value::is_null) => {
            let blocks = json.pointer("/message/content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            let of = |kind: &'static str| {
                blocks.iter().filter(move |b| b.get("type").and_then(Value::as_str) == Some(kind))
            };
            let edits: Vec<_> = of("tool_use")
                .filter_map(|b| {
                    let tool = b.get("name")?.as_str().filter(|n| EDIT_TOOLS.contains(n))?;
                    let input = b.get("input").filter(|i| i.is_object())?;
                    Some((b.get("id")?.as_str()?.to_string(), tool.to_string(), input.clone()))
                })
                .collect();
            let results: Vec<_> = of("tool_result")
                .filter_map(|b| {
                    let failed = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    Some((b.get("tool_use_id")?.as_str()?.to_string(), !failed))
                })
                .collect();
            match (edits.is_empty(), results.is_empty()) {
                (false, _) => Event::Edits(edits),
                (true, false) => Event::ToolResults(results),
                (true, true) => Event::Other,
            }
        }
        "result" => {
            let text = json.get("result").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let failed = json.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            Event::Done(if failed { Err(text) } else { Ok(text) })
        }
        _ => Event::Other,
    }
}

/// One chat turn with Claude Code.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let exe = exe()?;
    let options = options(settings)?;
    let turn = chat.begin(ID);
    let content = claude::user_content(turn.first, context.as_ref(), &query);
    let resume = options.dir.as_deref().and_then(|dir| session_of(&turn.history, dir));
    let line = input_line(if resume.is_some() { &[] } else { &turn.history }, &content);
    let args = args(model, &options, resume.as_deref());
    // The plain chat runs in a folder of nobody's: nothing of a project to pick up.
    let cwd = options.dir.clone().unwrap_or_else(std::env::temp_dir);
    let quiet = if options.dir.is_some() { AGENT_QUIET } else { CHAT_QUIET };

    let island = app.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        run(&exe, &args, &cwd, &line, quiet, |update| {
            let _ = match update {
                Update::Text(visible) => island.emit_to(WINDOW_LABEL, "chat-delta", visible),
                Update::Edit { tool, input } => {
                    island.emit_to(WINDOW_LABEL, "chat-edit", json!({ "tool": tool, "input": input }))
                }
            };
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    // In a folder the session holds the turn; the plain chat keeps it here, file included.
    let user = match (&options.dir, &answer.session) {
        (Some(dir), Some(session)) => {
            json!({ "role": "user", "content": plain, "session": session, "dir": dir.to_string_lossy() })
        }
        _ => json!({ "role": "user", "content": content }),
    };
    chat.commit(&turn, user, json!({ "role": "assistant", "content": answer.text }), &plain, &answer.text);
    Ok(ChatReply { text: answer.text })
}

#[derive(Debug, PartialEq)]
struct Answer {
    text: String,
    session: Option<String>,
}

/// What a running turn has to show.
#[derive(Debug, PartialEq)]
enum Update {
    /// The visible text so far.
    Text(String),
    /// A file edit that went through: the tool and its input.
    Edit { tool: String, input: Value },
}

/// Starts Claude Code in `cwd`, hands it the question and reads its answer.
/// `on_update` gets the visible text at most 15 times a second, and each file
/// edit once its tool has succeeded. Blocking.
fn run(
    exe: &Path,
    args: &[String],
    cwd: &Path,
    input: &str,
    quiet: Duration,
    mut on_update: impl FnMut(Update),
) -> Result<Answer, String> {
    let no_answer = || t("Claude Code gave no answer. Run claude in a terminal to check that it is signed in.");
    let stops = STOPS.load(Ordering::Relaxed);

    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    // An npm install is a script calling node: its own folder first on PATH, as for Codex.
    if let Some(dir) = exe.parent() {
        let mut dirs = vec![dir.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| no_answer())?;

    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        end(&mut child, Duration::ZERO);
        return Err(no_answer());
    };
    // Written from its own thread: a dropped image is larger than the pipe's
    // buffer. Closing the input is how Claude Code learns the turn is whole.
    let input = format!("{input}\n");
    std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || read_events(BufReader::new(stdout), tx));

    let mut text = String::new();
    let mut session = None;
    // Edits asked for, until their tool says whether it went through (a
    // permission refused in the island is an error here, and shows nothing).
    let mut pending: HashMap<String, (String, Value)> = HashMap::new();
    let mut stopped = false;
    let mut finished = false;
    let mut heard = Instant::now();
    let mut last = Instant::now().checked_sub(DELTA_INTERVAL).unwrap_or_else(Instant::now);
    let outcome = loop {
        if STOPS.load(Ordering::Relaxed) != stops {
            stopped = true;
            break Ok(String::new());
        }
        let event = match rx.recv_timeout(TICK) {
            Ok(Ok(event)) => event,
            Ok(Err(message)) => break Err(message),
            Err(mpsc::RecvTimeoutError::Timeout) if heard.elapsed() < quiet => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => break Err(t("Claude Code took too long to answer.")),
            // It stopped without a result: not signed in, or it could not start.
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err(String::new()),
        };
        heard = Instant::now();
        match event {
            Event::Session(id) => session = Some(id),
            Event::Delta(delta) => {
                text.push_str(&delta);
                if text.len() > MAX_ANSWER {
                    break Err(t("The server's answer is too large."));
                }
                if last.elapsed() >= DELTA_INTERVAL {
                    last = Instant::now();
                    on_update(Update::Text(text.trim().to_string()));
                }
            }
            Event::Edits(edits) => {
                for (id, tool, input) in edits {
                    if input.to_string().len() <= MAX_EDIT_BYTES {
                        pending.insert(id, (tool, input));
                    }
                }
            }
            Event::ToolResults(results) => {
                for (id, succeeded) in results {
                    if let (Some((tool, input)), true) = (pending.remove(&id), succeeded) {
                        on_update(Update::Edit { tool, input });
                    }
                }
            }
            Event::NewMessage => {
                if !text.trim().is_empty() && !text.ends_with("\n\n") {
                    text.push_str("\n\n");
                }
            }
            Event::Done(result) => {
                finished = true;
                break result;
            }
            Event::Other => {}
        }
    };
    end(&mut child, if finished { WRAP_UP } else { Duration::ZERO });

    match outcome {
        // The streamed text is what the user watched arrive; the result's own
        // text (the last message only) stands in when nothing was streamed.
        Ok(result) => {
            let answer = if text.trim().is_empty() { result } else { text.trim().to_string() };
            if answer.is_empty() {
                return Err(if stopped { t("Stopped.") } else { no_answer() });
            }
            on_update(Update::Text(answer.clone()));
            Ok(Answer { text: answer, session })
        }
        Err(message) if message.is_empty() => Err(no_answer()),
        Err(message) => Err(message),
    }
}

/// Reads the output line by line and passes on what it says, until the turn is
/// over or a line is far too long for what we expect.
fn read_events(mut reader: impl BufRead, tx: mpsc::Sender<Result<Event, String>>) {
    let mut line = Vec::new();
    loop {
        line.clear();
        match (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) if line.len() > MAX_LINE => {
                let _ = tx.send(Err(t("The server's answer is too large.")));
                return;
            }
            Ok(_) => {}
        }
        let event = parse_line(String::from_utf8_lossy(&line).trim_end());
        let done = matches!(event, Event::Done(_));
        if tx.send(Ok(event)).is_err() || done {
            return;
        }
    }
}

/// Stops Claude Code if it is still running once `grace` has passed. An npm
/// install runs `claude.cmd`: killing cmd.exe alone would leave node under it,
/// so the whole tree goes — and with it whatever command Claude Code was
/// running in the folder.
fn end(child: &mut Child, grace: Duration) {
    let deadline = Instant::now() + grace;
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if matches!(child.try_wait(), Ok(None)) {
        #[cfg(windows)]
        {
            let mut kill = Command::new("taskkill");
            kill.args(["/T", "/F", "/PID", &child.id().to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
            platform::no_console(&mut kill);
            let _ = kill.status();
        }
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(dir: Option<&str>, effort: Option<&'static str>, mode: &'static str) -> Options {
        Options { dir: dir.map(PathBuf::from), effort, mode }
    }

    fn after<'a>(a: &'a [String], flag: &str) -> Option<&'a str> {
        a.iter().position(|x| x == flag).map(|i| a[i + 1].as_str())
    }

    #[test]
    fn without_a_folder_claude_code_is_a_chat_model_with_web_search_and_nothing_else() {
        let a = args("claude-opus-5-5", &opts(None, None, "default"), None);
        assert_eq!(after(&a, "--model"), Some("claude-opus-5-5"));
        assert_eq!(after(&a, "--tools"), Some("WebSearch"));
        assert_eq!(after(&a, "--permission-prompts"), Some("none"));
        // No settings file: Coucou's own hooks never see the chat.
        assert_eq!(after(&a, "--setting-sources"), Some(""));
        assert!(a.contains(&"--no-session-persistence".to_string()));
        assert!(a.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(after(&a, "--effort"), None);
        assert_eq!(after(&a, "--permission-mode"), None);
    }

    #[test]
    fn in_a_folder_it_is_claude_code_itself_and_still_approves_nothing_alone() {
        let a = args("m", &opts(Some("/work"), Some("high"), "plan"), Some("abc"));
        assert_eq!(after(&a, "--permission-mode"), Some("plan"));
        assert_eq!(after(&a, "--effort"), Some("high"));
        assert_eq!(after(&a, "--resume"), Some("abc"));
        assert_eq!(after(&a, "--permission-prompts"), Some("none"));
        assert_eq!(after(&a, "--append-system-prompt"), Some(AGENT_PROMPT));
        for flag in ["--tools", "--setting-sources", "--no-session-persistence", "--system-prompt"] {
            assert_eq!(after(&a, flag), None, "{flag}");
        }
        assert!(a.iter().all(|x| !x.to_lowercase().contains("bypass") && !x.contains("dangerously")));
    }

    #[test]
    fn only_known_values_reach_the_command_line() {
        let here = std::env::temp_dir();
        let mut s = Settings::default();
        assert_eq!(options(&s).unwrap(), opts(None, None, "default"));
        s.claude_code_dir = here.to_string_lossy().to_string();
        s.claude_code_effort = "xhigh".into();
        s.claude_code_mode = "acceptEdits".into();
        assert_eq!(options(&s).unwrap(), Options { dir: Some(here.clone()), effort: Some("xhigh"), mode: "acceptEdits" });
        s.claude_code_effort = "--dangerously-skip-permissions".into();
        s.claude_code_mode = "bypassPermissions".into();
        assert_eq!(options(&s).unwrap(), Options { dir: Some(here.clone()), effort: None, mode: "default" });
        s.claude_code_dir = here.join("coucou-no-such-folder").to_string_lossy().to_string();
        assert!(options(&s).is_err());
        s.claude_code_dir = "relative/folder".into();
        assert!(options(&s).is_err());
    }

    #[test]
    fn a_session_is_resumed_only_in_the_folder_it_began_in() {
        let ours = json!({"role":"user","content":"q","session":"s1","dir":"/work"});
        let reply = json!({"role":"assistant","content":"a"});
        assert_eq!(session_of(&[ours.clone(), reply.clone()], Path::new("/work")).as_deref(), Some("s1"));
        assert_eq!(session_of(&[ours.clone(), reply.clone()], Path::new("/other")), None);
        // A later turn answered elsewhere (another provider, or the plain chat) is not in it.
        let plain = json!({"role":"user","content":"q2"});
        assert_eq!(session_of(&[ours, reply.clone(), plain, reply], Path::new("/work")), None);
        assert_eq!(session_of(&[], Path::new("/work")), None);
    }

    #[test]
    fn a_saved_conversation_resumes_its_session_in_its_folder() {
        let turns = vec![
            json!({"role":"user","content":"q1"}),
            json!({"role":"assistant","content":"a1"}),
            json!({"role":"user","content":"q2"}),
            json!({"role":"assistant","content":"a2"}),
        ];
        let history = resumed(&turns, "s1", "/work");
        assert_eq!(session_in(&history).as_deref(), Some("s1"));
        assert_eq!(session_of(&history, Path::new("/work")).as_deref(), Some("s1"));
        assert_eq!(session_of(&history, Path::new("/elsewhere")), None);
        // Only the last question carries it, and the text is untouched.
        assert!(history[0].get("session").is_none());
        assert_eq!(history[2]["content"], "q2");
        assert_eq!(session_in(&turns), None);
    }

    #[test]
    fn earlier_turns_ride_in_the_one_message_each_under_who_said_it() {
        let new = vec![json!({"type":"text","text":"and now?"})];
        let first: Value = serde_json::from_str(&input_line(&[], &new)).unwrap();
        assert_eq!(first["type"], "user");
        assert_eq!(first["message"]["content"], json!(new));

        let history = vec![
            json!({"role":"user","content":[{"type":"image","source":{}},{"type":"text","text":"what is this?"}]}),
            json!({"role":"assistant","content":"A cat."}),
        ];
        let line = input_line(&history, &new);
        assert!(!line.contains('\n'));
        let next: Value = serde_json::from_str(&line).unwrap();
        let blocks = next["message"]["content"].as_array().unwrap();
        let shown: Vec<&str> = blocks.iter().map(|b| b["text"].as_str().unwrap_or("<image>")).collect();
        assert_eq!(
            shown[1..],
            ["User:", "<image>", "what is this?", "Mochi:", "A cat.", "The new message:", "and now?"]
        );
    }

    #[test]
    fn only_the_answer_s_text_the_session_and_the_result_are_taken_from_the_output() {
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}},"parent_tool_use_id":null}"#;
        assert_eq!(parse_line(delta), Event::Delta("Hi".into()));
        let sub = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}},"parent_tool_use_id":"toolu_1"}"#;
        assert_eq!(parse_line(sub), Event::Other);
        let thinking = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}"#;
        assert_eq!(parse_line(thinking), Event::Other);
        assert_eq!(parse_line(r#"{"type":"stream_event","event":{"type":"message_start"}}"#), Event::NewMessage);
        assert_eq!(parse_line(r#"{"type":"system","subtype":"init","session_id":"s1"}"#), Event::Session("s1".into()));
        assert_eq!(parse_line(r#"{"type":"system","subtype":"status","session_id":"s1"}"#), Event::Other);
        assert_eq!(parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}"#), Event::Other);
        assert_eq!(parse_line("not json"), Event::Other);
    }

    #[test]
    fn a_file_edit_is_told_once_its_tool_has_succeeded() {
        let asked = r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[
            {"type":"text","text":"On it."},
            {"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/w/a.rs","old_string":"a","new_string":"b"}},
            {"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"}},
            {"type":"tool_use","id":"t3","name":"Write","input":{"file_path":"/w/b.rs","content":"x"}}]}}"#
            .replace('\n', "");
        let Event::Edits(edits) = parse_line(&asked) else { panic!("not edits") };
        assert_eq!(edits.iter().map(|(id, tool, _)| (id.as_str(), tool.as_str())).collect::<Vec<_>>(), [("t1", "Edit"), ("t3", "Write")]);
        assert_eq!(edits[0].2["new_string"], "b");

        let done = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"t1","content":"ok"},
            {"type":"tool_result","tool_use_id":"t3","is_error":true,"content":"denied"}]}}"#
            .replace('\n', "");
        assert_eq!(parse_line(&done), Event::ToolResults(vec![("t1".into(), true), ("t3".into(), false)]));
        // A subagent's edits are its own business.
        let sub = asked.replace(r#""parent_tool_use_id":null"#, r#""parent_tool_use_id":"toolu_9""#);
        assert_eq!(parse_line(&sub), Event::Other);
        assert_eq!(
            parse_line(r#"{"type":"result","is_error":false,"result":" Hi there. "}"#),
            Event::Done(Ok("Hi there.".into()))
        );
        assert_eq!(
            parse_line(r#"{"type":"result","is_error":true,"result":"Not logged in"}"#),
            Event::Done(Err("Not logged in".into()))
        );
    }

    fn events(lines: &str) -> Vec<Result<Event, String>> {
        let (tx, rx) = mpsc::channel();
        read_events(lines.as_bytes(), tx);
        rx.into_iter().collect()
    }

    #[test]
    fn reading_stops_at_the_result_and_at_an_endless_line() {
        let out = concat!(
            r#"{"type":"system","subtype":"init","session_id":"s1"}"#, "\r\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}}"#, "\n",
            r#"{"type":"result","is_error":false,"result":"a"}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"late"}}}"#, "\n",
        );
        assert_eq!(
            events(out),
            vec![Ok(Event::Session("s1".into())), Ok(Event::Delta("a".into())), Ok(Event::Done(Ok("a".into())))]
        );
        let long = "x".repeat(MAX_LINE + 10);
        assert_eq!(events(&long), vec![Err("The server's answer is too large.".to_string())]);
    }

    #[test]
    fn the_default_model_is_one_the_picker_offers() {
        assert!(MODELS.iter().any(|(id, _)| *id == DEFAULT_MODEL));
    }
}
