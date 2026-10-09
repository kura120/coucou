// The chat's saved conversations: what the list above the chat box shows, and
// what "open" puts back into the chat.
//
// One file, conversations.json under platform::local_dir(), rewritten after
// each finished turn. A conversation keeps its turns as plain text (a dropped
// file by name only, never its bytes), the provider and model that answered,
// the folder it worked in, and — for a provider that has one — its own handle
// on the conversation: Claude Code's session id, so opening a conversation
// resumes that session with everything its tools did.
//
// Only Claude Code's conversations are saved today. Nothing else here is about
// Claude Code, though. To save another provider's:
//   1. add its id to SAVED (and `conversations: true` to its entry in
//      src/core/providers.ts, which shows the list in the chat);
//   2. if it keeps a conversation of its own that can be picked up again, give
//      `handle_of` and `native_for` an arm for it. Without one, an opened
//      conversation is simply sent again as plain text, which every provider
//      understands (see chat.rs).

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat::{Chat, Snapshot};
use crate::settings::Settings;
use crate::{claude_code, platform};

/// The providers whose conversations are kept.
const SAVED: &[&str] = &[claude_code::ID];
/// The oldest conversations go once there are more than this.
const MAX_CONVERSATIONS: usize = 100;
const MAX_TITLE_CHARS: usize = 60;

pub fn supports(provider: &str) -> bool {
    SAVED.contains(&provider)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    pub id: String,
    /// The first question, on one line.
    pub title: String,
    pub provider: String,
    pub model: String,
    /// The folder the conversation works in; empty for a plain chat.
    pub dir: String,
    /// The provider's own handle on the conversation (Claude Code: its session id).
    pub handle: Option<String>,
    /// Seconds since 1970, at the last answer.
    pub updated: u64,
    /// `{"role", "content": text}` turns.
    pub turns: Vec<Value>,
}

/// A row of the list: everything but the turns.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub dir: String,
    pub updated: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Store {
    conversations: Vec<Saved>,
}

/// One reader or writer of the file at a time.
static FILE: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    platform::local_dir().join("conversations.json")
}

/// A file that is missing or not ours to read is an empty list: the chat works
/// without its history, and the next answer writes a good file.
fn load(path: &Path) -> Store {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// Whole file to a temporary sibling, flushed, then renamed over the old one.
fn write(path: &Path, store: &Store) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        platform::ensure_private_dir(dir)?;
    }
    let json = serde_json::to_vec(store).map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(&json)?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:x}-{:x}-{:x}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// The first question on one line, cut to fit a row of the list.
fn title_of(turns: &[Value]) -> String {
    let first = turns
        .iter()
        .find(|t| t.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|t| t.get("content").and_then(Value::as_str))
        .unwrap_or("");
    let line = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title: String = line.chars().take(MAX_TITLE_CHARS).collect();
    if title.chars().count() < line.chars().count() {
        title.push('…');
    }
    title
}

/// The provider's own handle on the conversation, read from its history.
fn handle_of(provider: &str, native: &[Value]) -> Option<String> {
    match provider {
        claude_code::ID => claude_code::session_in(native),
        _ => None,
    }
}

/// The history a provider picks a saved conversation up from; None when the
/// plain turns are all it needs.
fn native_for(saved: &Saved) -> Option<Vec<Value>> {
    let handle = saved.handle.as_deref()?;
    match saved.provider.as_str() {
        claude_code::ID => Some(claude_code::resumed(&saved.turns, handle, &saved.dir)),
        _ => None,
    }
}

/// What a chat looks like saved: None when there is nothing to keep (no turn
/// yet, or a provider whose conversations are not saved).
fn saved_from(snapshot: &Snapshot, id: String, provider: &str, model: &str, dir: &str, updated: u64) -> Option<Saved> {
    if !supports(provider) || snapshot.plain.is_empty() {
        return None;
    }
    let handle = if snapshot.owner.as_deref() == Some(provider) { handle_of(provider, &snapshot.native) } else { None };
    Some(Saved {
        id,
        title: title_of(&snapshot.plain),
        provider: provider.to_string(),
        model: model.to_string(),
        dir: dir.to_string(),
        handle,
        updated,
        turns: snapshot.plain.clone(),
    })
}

/// Puts `saved` in the store, in place of its earlier version, newest first.
fn upsert(store: &mut Store, saved: Saved) {
    store.conversations.retain(|c| c.id != saved.id);
    store.conversations.insert(0, saved);
    store.conversations.truncate(MAX_CONVERSATIONS);
}

/// After an answer: saves the chat as it now stands and returns the id of its
/// conversation, or None when it is not one that is kept.
pub fn record(chat: &Chat, settings: &Settings, provider: &str, model: &str) -> Option<String> {
    if !supports(provider) {
        return None;
    }
    let snapshot = chat.snapshot(new_id);
    let dir = if provider == claude_code::ID { settings.claude_code_dir.trim() } else { "" };
    let saved = saved_from(&snapshot, snapshot.id.clone(), provider, model, dir, now())?;
    let _file = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let path = path();
    let mut store = load(&path);
    upsert(&mut store, saved);
    if let Err(err) = write(&path, &store) {
        crate::log::line(format!("conversations: could not be saved: {err}"));
    }
    Some(snapshot.id)
}

/// The list, newest first.
pub fn list() -> Vec<Summary> {
    let _file = FILE.lock().unwrap_or_else(|e| e.into_inner());
    summaries(&load(&path()))
}

fn summaries(store: &Store) -> Vec<Summary> {
    let mut rows: Vec<Summary> = store
        .conversations
        .iter()
        .filter(|c| supports(&c.provider))
        .map(|c| Summary {
            id: c.id.clone(),
            title: c.title.clone(),
            provider: c.provider.clone(),
            dir: c.dir.clone(),
            updated: c.updated,
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.updated));
    rows
}

/// Opens a saved conversation: the chat carries on from it, and the island
/// gets it back to show.
pub fn open(chat: &Chat, id: &str) -> Result<Saved, String> {
    let saved = {
        let _file = FILE.lock().unwrap_or_else(|e| e.into_inner());
        load(&path()).conversations.into_iter().find(|c| c.id == id && supports(&c.provider))
    }
    .ok_or_else(|| crate::i18n::t("This conversation is gone."))?;
    match native_for(&saved) {
        Some(native) => chat.restore(&saved.id, Some(&saved.provider), native, saved.turns.clone()),
        None => chat.restore(&saved.id, None, Vec::new(), saved.turns.clone()),
    }
    Ok(saved)
}

/// Forgets a conversation. Coucou's record only: a Claude Code session stays
/// where Claude Code keeps it.
pub fn delete(chat: &Chat, id: &str) {
    chat.detach(id);
    let _file = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let path = path();
    let mut store = load(&path);
    let before = store.conversations.len();
    store.conversations.retain(|c| c.id != id);
    if store.conversations.len() != before {
        if let Err(err) = write(&path, &store) {
            crate::log::line(format!("conversations: could not be saved: {err}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turns() -> Vec<Value> {
        vec![json!({"role":"user","content":"review the\n  local branch"}), json!({"role":"assistant","content":"Done."})]
    }

    fn snapshot(owner: Option<&str>, native: Vec<Value>) -> Snapshot {
        Snapshot { id: "c1".into(), owner: owner.map(str::to_string), native, plain: turns() }
    }

    #[test]
    fn the_title_is_the_first_question_on_one_line_cut_to_fit() {
        assert_eq!(title_of(&turns()), "review the local branch");
        let long = vec![json!({"role":"user","content":"é".repeat(200)})];
        let title = title_of(&long);
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS + 1);
        assert!(title.ends_with('…'));
        assert_eq!(title_of(&[]), "");
    }

    #[test]
    fn only_a_saved_provider_s_chat_with_a_turn_is_kept() {
        let s = snapshot(Some("claudecode"), vec![]);
        assert!(saved_from(&s, "c1".into(), "openai", "gpt", "", 1).is_none());
        let empty = Snapshot { plain: vec![], ..snapshot(None, vec![]) };
        assert!(saved_from(&empty, "c1".into(), "claudecode", "m", "", 1).is_none());
        let saved = saved_from(&s, "c1".into(), "claudecode", "m", "/work", 7).unwrap();
        assert_eq!((saved.title.as_str(), saved.dir.as_str(), saved.updated), ("review the local branch", "/work", 7));
        assert_eq!(saved.handle, None);
        assert_eq!(saved.turns, turns());
    }

    #[test]
    fn claude_code_s_session_is_kept_and_comes_back_when_the_conversation_is_opened() {
        let native = vec![
            json!({"role":"user","content":"review the\n  local branch","session":"s1","dir":"/work"}),
            json!({"role":"assistant","content":"Done."}),
        ];
        let saved = saved_from(&snapshot(Some("claudecode"), native), "c1".into(), "claudecode", "m", "/work", 1).unwrap();
        assert_eq!(saved.handle.as_deref(), Some("s1"));
        let back = native_for(&saved).unwrap();
        assert_eq!(claude_code::session_in(&back).as_deref(), Some("s1"));
        assert_eq!(back.len(), 2);
        // Another provider answered last: its history says nothing of a session.
        let other = saved_from(&snapshot(Some("openai"), vec![]), "c1".into(), "claudecode", "m", "", 1).unwrap();
        assert_eq!(other.handle, None);
        assert!(native_for(&other).is_none());
    }

    #[test]
    fn the_store_keeps_one_version_of_each_newest_first_and_drops_the_oldest() {
        let mut store = Store::default();
        let one = |id: &str, updated: u64| Saved { id: id.into(), provider: "claudecode".into(), updated, ..Saved::default() };
        upsert(&mut store, one("a", 1));
        upsert(&mut store, one("b", 2));
        upsert(&mut store, one("a", 3));
        assert_eq!(summaries(&store).iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        for n in 0..MAX_CONVERSATIONS + 5 {
            upsert(&mut store, one(&format!("n{n}"), 10 + n as u64));
        }
        assert_eq!(store.conversations.len(), MAX_CONVERSATIONS);
        assert!(store.conversations.iter().all(|c| c.id != "a" && c.id != "b"));
        // A provider that is no longer saved does not show.
        upsert(&mut store, Saved { id: "x".into(), provider: "gone".into(), updated: 9999, ..Saved::default() });
        assert!(summaries(&store).iter().all(|s| s.id != "x"));
    }

    #[test]
    fn the_file_round_trips_and_a_broken_one_is_an_empty_list() {
        let dir = std::env::temp_dir().join(format!("coucou-conversations-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("conversations.json");
        assert!(load(&path).conversations.is_empty());
        let mut store = Store::default();
        upsert(&mut store, Saved { id: "a".into(), title: "t".into(), provider: "claudecode".into(), turns: turns(), ..Saved::default() });
        write(&path, &store).unwrap();
        assert_eq!(load(&path).conversations, store.conversations);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).conversations.is_empty());
        // A file from a build with fewer fields still loads.
        std::fs::write(&path, br#"{"conversations":[{"id":"old","turns":[]}]}"#).unwrap();
        assert_eq!(load(&path).conversations[0].id, "old");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_are_not_reused() {
        assert_ne!(new_id(), new_id());
    }
}
