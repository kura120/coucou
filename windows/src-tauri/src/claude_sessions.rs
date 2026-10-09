// Claude Code's own sessions, read where Claude Code keeps them:
// ~/.claude/projects/<folder>/<session id>.jsonl, one JSON line per event.
//
// This is what lets the chat's list show the conversations held in a terminal
// or in the Claude app next to Coucou's own (conversations.rs), and open one:
// its text comes from the transcript, and the next question resumes the
// session itself. Reading is all that happens here — nothing of Claude Code's
// is ever written, moved or deleted.
//
// The other way round needs no code: a conversation Coucou holds in a folder
// is a Claude Code session from its first turn (claude_code.rs), so it is in
// this same store for `claude --resume` to find.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use crate::platform;

/// How much of a transcript's beginning is read to list it: its folder, its
/// first question and its title are all there.
const HEAD_BYTES: u64 = 256 * 1024;
/// A transcript larger than this is not opened.
const MAX_TRANSCRIPT: u64 = 64 * 1024 * 1024;
/// The newest sessions listed.
pub const MAX_LISTED: usize = 100;
const MAX_TITLE_CHARS: usize = 60;

/// A session as the list shows it.
#[derive(Debug, PartialEq)]
pub struct Found {
    pub session: String,
    pub title: String,
    /// The folder it runs in.
    pub dir: String,
    /// Seconds since 1970, when its transcript last changed.
    pub updated: u64,
}

/// A session opened: the same, with its conversation as plain turns.
#[derive(Debug, PartialEq)]
pub struct Transcript {
    pub found: Found,
    pub turns: Vec<Value>,
}

/// Where Claude Code keeps its sessions: under CLAUDE_CONFIG_DIR when the user
/// moved its folder, ~/.claude otherwise.
fn projects_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| platform::home_dir().join(".claude"))
        .join("projects")
}

/// A session id is a UUID. Anything else is not looked for: the id comes back
/// from the page, and names a file.
fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn modified(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Every session transcript, newest first: `<projects>/<folder>/<id>.jsonl`.
/// A session's subagents live one level deeper and are not conversations.
fn transcripts(projects: &Path) -> Vec<(PathBuf, u64)> {
    let mut files = Vec::new();
    for project in std::fs::read_dir(projects).into_iter().flatten().flatten() {
        for entry in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let path = entry.path();
            let named = path.file_stem().and_then(|s| s.to_str()).is_some_and(is_session_id);
            if named && path.extension().and_then(|e| e.to_str()) == Some("jsonl") && path.is_file() {
                let at = modified(&path);
                files.push((path, at));
            }
        }
    }
    files.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
    files
}

/// What a person typed, from a `user` line; None for everything else such a
/// line can be (a tool's result, a command's output, a reminder).
fn user_text(line: &Value) -> Option<String> {
    let flag = |key: &str| line.get(key).and_then(Value::as_bool).unwrap_or(false);
    if flag("isMeta") || flag("isSidechain") || line.get("toolUseResult").is_some() {
        return None;
    }
    let text = match line.pointer("/message/content")? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim();
    // Claude Code's own wrappers (<command-name>, <local-command-stdout>, …).
    (!text.is_empty() && !text.starts_with('<')).then(|| text.to_string())
}

/// The text of an `assistant` line; None when it only calls a tool or thinks.
fn assistant_text(line: &Value) -> Option<String> {
    if line.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let blocks = line.pointer("/message/content")?.as_array()?;
    crate::claude::response_text(blocks)
}

fn one_line(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title: String = line.chars().take(MAX_TITLE_CHARS).collect();
    if title.chars().count() < line.chars().count() {
        title.push('…');
    }
    title
}

/// What the lines of a transcript say, gathered as they are read.
#[derive(Default)]
struct Reading {
    dir: Option<String>,
    /// The name the session was given, the last one winning.
    named: Option<String>,
    first_question: Option<String>,
    turns: Vec<Value>,
}

impl Reading {
    /// `keep_turns` is off for the list, which needs no conversation.
    fn line(&mut self, raw: &[u8], keep_turns: bool) {
        let Ok(line) = serde_json::from_slice::<Value>(raw) else { return };
        if self.dir.is_none() {
            self.dir = line.get("cwd").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_string);
        }
        match line.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(title) = line.get("customTitle").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                    self.named = Some(title.trim().to_string());
                }
            }
            Some("user") => {
                let Some(text) = user_text(&line) else { return };
                if self.first_question.is_none() {
                    self.first_question = Some(text.clone());
                }
                if keep_turns {
                    self.turns.push(json!({ "role": "user", "content": text }));
                }
            }
            Some("assistant") if keep_turns => {
                let Some(text) = assistant_text(&line) else { return };
                // Between two tools Claude speaks in several messages: one answer.
                match self.turns.last_mut() {
                    Some(last) if last["role"] == "assistant" => {
                        let so_far = last["content"].as_str().unwrap_or("").to_string();
                        last["content"] = json!(format!("{so_far}\n\n{text}"));
                    }
                    Some(_) => self.turns.push(json!({ "role": "assistant", "content": text })),
                    // An answer before any question is not shown.
                    None => {}
                }
            }
            _ => {}
        }
    }

    /// None for a file that is not a conversation: no folder, or nothing asked.
    fn found(&self, session: &str, updated: u64) -> Option<Found> {
        let dir = self.dir.clone()?;
        let title = self.named.clone().or_else(|| self.first_question.clone())?;
        Some(Found { session: session.to_string(), title: one_line(&title), dir, updated })
    }
}

/// Reads up to `limit` bytes of `path`, whole lines only.
fn read_lines(path: &Path, limit: u64, mut each: impl FnMut(&[u8])) {
    let Ok(file) = std::fs::File::open(path) else { return };
    let mut reader = BufReader::new(file.take(limit));
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            // The limit fell inside this line: it is not a whole one.
            Ok(_) if line.last() != Some(&b'\n') && reader.get_ref().limit() == 0 => return,
            Ok(_) => each(&line),
        }
    }
}

fn session_of(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

/// The newest sessions, for the list.
pub fn list() -> Vec<Found> {
    list_in(&projects_dir())
}

fn list_in(projects: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    for (path, updated) in transcripts(projects) {
        let mut reading = Reading::default();
        read_lines(&path, HEAD_BYTES, |line| reading.line(line, false));
        if let Some(found) = reading.found(&session_of(&path), updated) {
            out.push(found);
            if out.len() == MAX_LISTED {
                break;
            }
        }
    }
    out
}

/// One session with its conversation, or None when it is not there (any more).
pub fn read(session: &str) -> Option<Transcript> {
    read_in(&projects_dir(), session)
}

fn read_in(projects: &Path, session: &str) -> Option<Transcript> {
    if !is_session_id(session) {
        return None;
    }
    let (path, updated) = transcripts(projects).into_iter().find(|(path, _)| session_of(path) == session)?;
    if std::fs::metadata(&path).ok()?.len() > MAX_TRANSCRIPT {
        return None;
    }
    let mut reading = Reading::default();
    read_lines(&path, MAX_TRANSCRIPT, |line| reading.line(line, true));
    let found = reading.found(session, updated)?;
    Some(Transcript { found, turns: reading.turns })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0a1b2c3d-0000-4000-8000-000000000001";

    fn store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-sessions-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("C--work-app")).unwrap();
        dir
    }

    fn transcript() -> String {
        [
            json!({"type":"queue-operation","operation":"enqueue","sessionId":ID}),
            json!({"type":"user","isMeta":true,"cwd":"C:\\work\\app","message":{"role":"user","content":"Caveat: generated"}}),
            json!({"type":"user","cwd":"C:\\work\\app","message":{"role":"user","content":"<command-name>/clear</command-name>"}}),
            json!({"type":"user","cwd":"C:\\work\\app","message":{"role":"user","content":"fix the\nlogin bug"}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"Looking."}]}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}),
            json!({"type":"user","toolUseResult":{"x":1},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file text"}]}}),
            json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixed."}]}}),
            json!({"type":"custom-title","customTitle":"Login bug","sessionId":ID}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"thanks"}]}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Welcome."}]}}),
        ]
        .iter()
        .map(|l| format!("{l}\n"))
        .collect()
    }

    #[test]
    fn a_session_is_listed_with_its_folder_and_its_name_or_first_question() {
        let projects = store("list");
        std::fs::write(projects.join("C--work-app").join(format!("{ID}.jsonl")), transcript()).unwrap();
        // Not conversations: a subagent's file, a file that is not a session, one with nothing asked.
        std::fs::create_dir_all(projects.join("C--work-app").join(ID).join("subagents")).unwrap();
        std::fs::write(projects.join("C--work-app").join(ID).join("subagents").join("agent-1.jsonl"), transcript()).unwrap();
        std::fs::write(projects.join("C--work-app").join("notes.jsonl"), transcript()).unwrap();
        let empty = "0a1b2c3d-0000-4000-8000-000000000002";
        std::fs::write(
            projects.join("C--work-app").join(format!("{empty}.jsonl")),
            format!("{}\n", json!({"type":"user","isMeta":true,"cwd":"C:\\work\\app","message":{"content":"x"}})),
        )
        .unwrap();

        let found = list_in(&projects);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].session.as_str(), found[0].title.as_str(), found[0].dir.as_str()), (ID, "Login bug", "C:\\work\\app"));
        assert!(found[0].updated > 0);

        // Without a name, the first thing a person typed, on one line.
        let unnamed: String = transcript().lines().filter(|l| !l.contains("custom-title")).map(|l| format!("{l}\n")).collect();
        std::fs::write(projects.join("C--work-app").join(format!("{ID}.jsonl")), unnamed).unwrap();
        assert_eq!(list_in(&projects)[0].title, "fix the login bug");
        assert!(list_in(&projects.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn a_session_opens_as_what_was_said_without_the_tools_or_the_wrappers() {
        let projects = store("read");
        std::fs::write(projects.join("C--work-app").join(format!("{ID}.jsonl")), transcript()).unwrap();
        let t = read_in(&projects, ID).unwrap();
        assert_eq!(t.found.title, "Login bug");
        assert_eq!(
            t.turns,
            vec![
                json!({"role":"user","content":"fix the\nlogin bug"}),
                json!({"role":"assistant","content":"Looking.\n\nFixed."}),
                json!({"role":"user","content":"thanks"}),
                json!({"role":"assistant","content":"Welcome."}),
            ]
        );
        assert!(read_in(&projects, "0a1b2c3d-0000-4000-8000-00000000ffff").is_none());
        // An id is never a path.
        assert!(read_in(&projects, "../C--work-app/x").is_none());
        assert!(read_in(&projects, "").is_none());
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn only_whole_lines_are_read_from_the_beginning_of_a_long_transcript() {
        let projects = store("head");
        let path = projects.join("C--work-app").join(format!("{ID}.jsonl"));
        let first = format!("{}\n", json!({"type":"user","cwd":"/w","message":{"content":"hello"}}));
        let long = format!("{}\n", json!({"type":"user","cwd":"/w","message":{"content":"y".repeat(500)}}));
        std::fs::write(&path, format!("{first}{long}")).unwrap();
        let mut seen = 0;
        read_lines(&path, first.len() as u64 + 40, |_| seen += 1);
        assert_eq!(seen, 1);
        seen = 0;
        read_lines(&path, u64::MAX, |_| seen += 1);
        assert_eq!(seen, 2);
        let _ = std::fs::remove_dir_all(&projects);
    }
}
