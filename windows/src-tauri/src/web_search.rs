// A web search, for the assistant to answer from: Brave Search's web search
// API, with the user's own key from the credential store.
//
// Only the query leaves the machine, and only to api.search.brave.com, and
// only when the user chose Brave for web answers in Settings and gave a key.
// What comes back is titles, addresses and snippets as plain text: nothing is
// fetched from the pages, no link is followed, nothing is kept. The key goes
// in a header and never into an address, a log line or an error.
//
// The API, read on 2026-10-11 (api-dashboard.search.brave.com → Documentation
// → Web search): GET https://api.search.brave.com/res/v1/web/search, the key
// in `X-Subscription-Token`, `q` (at most 400 characters and 50 words),
// `count` (at most 20), `text_decorations` (highlight markup in the snippets);
// the answer holds `web.results[]`, each with `title`, `url`, `description`.

use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::i18n::{t, tf};
use crate::{net, secrets};

/// Credential store entry of the user's Brave Search key.
pub const KEY: &str = "brave-search-api-key";

const NAME: &str = "Brave Search";
const ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
/// A search is waited for by someone who asked out loud.
const TIMEOUT: Duration = Duration::from_secs(8);
/// What Brave takes for a query; longer is cut, at a word.
const MAX_QUERY_CHARS: usize = 400;
const MAX_QUERY_WORDS: usize = 50;
/// What a small model can read and a card can show.
const MAX_RESULTS: usize = 8;
const MAX_TITLE: usize = 160;
const MAX_SNIPPET: usize = 400;
const MAX_URL: usize = 2048;
/// A page of results is some tens of kilobytes; this is far above one.
const MAX_ANSWER: usize = 1024 * 1024;

/// One result, as text: a title, where it is, and the lines the search shows of it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WebResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// The query as it is sent: one line, single spaces, within what Brave takes.
/// None when there is nothing to search for.
pub fn query(said: &str) -> Option<String> {
    let mut query = String::new();
    for word in said.split_whitespace().take(MAX_QUERY_WORDS) {
        let longer = query.chars().count() + word.chars().count() + usize::from(!query.is_empty());
        if longer > MAX_QUERY_CHARS {
            break;
        }
        if !query.is_empty() {
            query.push(' ');
        }
        query.push_str(word);
    }
    // One word longer than a whole query: its beginning.
    if query.is_empty() {
        query = said.split_whitespace().next()?.chars().take(MAX_QUERY_CHARS).collect();
    }
    Some(query)
}

/// Where a query is asked. The key is not part of it.
pub fn address(query: &str) -> Url {
    let mut url = Url::parse(ENDPOINT).expect("the endpoint is an address");
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", &MAX_RESULTS.to_string())
        // No <strong> around the words that matched: the snippets are read as text.
        .append_pair("text_decorations", "false")
        // Only web pages: no news, videos or places, which nothing here reads.
        .append_pair("result_filter", "web");
    url
}

/// Text from a search answer as plain text: markup taken out (some snippets
/// carry <strong> whatever was asked), the usual entities read, on one line,
/// and no longer than `most` characters.
fn plain(text: &str, most: usize) -> String {
    let mut bare = String::with_capacity(text.len());
    let mut rest = text;
    // A "<" that starts a tag, up to its ">"; one that does not is a character.
    while let Some(open) = rest.find('<') {
        bare.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let tag = after.starts_with(|c: char| c.is_ascii_alphabetic() || c == '/' || c == '!');
        match after.find('>').filter(|_| tag) {
            Some(close) => {
                // <strong> sits inside a sentence, and may sit inside a word;
                // a line break or a paragraph stood between two words.
                let name = after[..close].trim_start_matches('/').to_ascii_lowercase();
                let name = name.split(|c: char| !c.is_ascii_alphanumeric()).next().unwrap_or_default();
                if matches!(name, "br" | "p" | "div" | "li") {
                    bare.push(' ');
                }
                rest = &after[close + 1..];
            }
            None => {
                bare.push('<');
                rest = after;
            }
        }
    }
    bare.push_str(rest);
    let read = entities(&bare);
    let line = read.split(|c: char| c.is_whitespace() || c.is_control()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    if line.chars().count() <= most {
        return line;
    }
    let cut: String = line.chars().take(most.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// `&amp;`, `&#39;`, `&#x27;` and the few names a snippet has, as their
/// characters. Read once: "&amp;lt;" is the text "&lt;", not a "<".
fn entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let named = after.find(';').filter(|end| *end <= 8).and_then(|end| {
            let name = &after[..end];
            let character = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => {
                    let code = match name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => name.strip_prefix('#').and_then(|decimal| decimal.parse().ok()),
                    };
                    code.and_then(char::from_u32).filter(|c| !c.is_control())
                }
            };
            character.map(|c| (c, end))
        });
        match named {
            Some((character, end)) => {
                out.push(character);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// An address that may be shown and opened: http or https, with a host, and
/// nobody's user name in it.
fn web_address(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.len() > MAX_URL {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let fine = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none();
    fine.then(|| url.to_string())
}

/// The web results of an answer, best first, eight at most. A result without
/// an address that can be opened is left out; one without a title is named by
/// its site. None when the answer is not a search answer at all.
pub fn results(answer: &Value) -> Option<Vec<WebResult>> {
    if !answer.is_object() {
        return None;
    }
    // A search that found nothing has no `web` at all: that is an answer too.
    let Some(web) = answer.get("web") else {
        return answer.get("query").or_else(|| answer.get("type")).map(|_| Vec::new());
    };
    let list = web.get("results")?.as_array()?;
    Some(
        list.iter()
            .filter_map(|result| {
                let url = web_address(result.get("url")?.as_str()?)?;
                let text = |field: &str, most: usize| plain(result.get(field).and_then(Value::as_str).unwrap_or_default(), most);
                let mut title = text("title", MAX_TITLE);
                if title.is_empty() {
                    title = Url::parse(&url).ok()?.host_str()?.to_string();
                }
                Some(WebResult { title, url, snippet: text("description", MAX_SNIPPET) })
            })
            .take(MAX_RESULTS)
            .collect(),
    )
}

/// What Brave says went wrong, when it says: `error.detail` in its error body.
fn detail(body: &[u8]) -> String {
    let said = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/detail").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| net::error_detail(body));
    plain(&said, 200)
}

/// A refusal in words a person can act on: the key, the quota, or the rest.
fn status_error(status: u16, detail: &str) -> String {
    match status {
        401 | 403 => tf("{name} rejected the API key ({status}). Check it in Settings.", &[("name", NAME), ("status", &status.to_string())]),
        429 => tf("{name} rate limit reached (429): {detail}", &[("name", NAME), ("detail", detail)]),
        _ if detail.is_empty() => format!("{NAME} {status}"),
        _ => format!("{NAME} {status}: {detail}"),
    }
}

/// Whatever went wrong, the key is not in what is said about it.
fn without_key(message: String, key: &str) -> String {
    if key.is_empty() { message } else { message.replace(key, "…") }
}

async fn search(said: &str) -> Result<Vec<WebResult>, String> {
    // Not a string of the interface yet: the card that shows it comes later.
    let query = query(said).ok_or("Nothing to search for.")?;
    let key = secrets::get(KEY).ok_or_else(|| tf("{name} API key missing. Add it in Settings.", &[("name", NAME)]))?;
    let url = address(&query);
    let reply = net::client(&url, TIMEOUT)?
        .get(url)
        .header("X-Subscription-Token", key.trim())
        .header("Accept", "application/json")
        .send()
        .await
        // Without its address: the query is in it.
        .map_err(|e| without_key(tf("Network error: {error}", &[("error", &e.without_url().to_string())]), &key))?;
    let status = reply.status();
    if !status.is_success() {
        let body = net::read_capped(reply, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(without_key(status_error(status.as_u16(), &detail(&body)), &key));
    }
    let bytes = net::read_capped(reply, MAX_ANSWER).await?;
    let answer: Value = serde_json::from_slice(&bytes).map_err(|_| t("Unexpected API response."))?;
    results(&answer).ok_or_else(|| t("Unexpected API response."))
}

/// Searches the web for `query` and gives back what was found, as text. Only
/// when the user chose Brave Search for web answers: with any other choice
/// nothing is sent, whoever asks.
#[tauri::command]
pub async fn web_search(app: AppHandle, query: String) -> Result<Vec<WebResult>, String> {
    let chosen = app
        .try_state::<crate::Shared>()
        .and_then(|shared| shared.settings.lock().ok().map(|settings| settings.voice.searches_with()));
    if chosen != Some("brave") {
        // Not a string of the interface yet either.
        return Err("Brave Search is not chosen for web answers.".into());
    }
    let found = search(&query).await;
    // That it was asked and how it went; never the query.
    crate::log::line(match &found {
        Ok(found) => format!("web search: {} results", found.len()),
        Err(_) => "web search: failed".to_string(),
    });
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// An answer in the shape Brave's documentation gives, written by hand:
    /// more fields than are read, markup and entities in the texts, and the
    /// results a careless reader would let through.
    const ANSWER: &str = r#"{
      "type": "search",
      "query": { "original": "how tall is mount everest", "more_results_available": true, "spellcheck_off": false },
      "mixed": { "type": "mixed", "main": [{ "type": "web", "index": 0, "all": false }] },
      "videos": { "type": "videos", "results": [{ "type": "video_result", "url": "https://video.example/watch?v=1", "title": "Everest" }] },
      "web": {
        "type": "search",
        "family_friendly": true,
        "results": [
          {
            "type": "search_result",
            "subtype": "generic",
            "title": "Mount Everest - Wikipedia",
            "url": "https://en.wikipedia.org/wiki/Mount_Everest",
            "description": "Its elevation of <strong>8,848.86 m</strong> (29,031 ft 8&#x27;&#x27;) was most recently\n established in 2020 by the Chinese &amp; Nepali authorities.",
            "age": "2 weeks ago",
            "language": "en",
            "profile": { "name": "Wikipedia", "url": "https://en.wikipedia.org/wiki/Mount_Everest", "img": "https://imgs.search.brave.com/x" },
            "meta_url": { "scheme": "https", "netloc": "en.wikipedia.org", "hostname": "en.wikipedia.org", "path": "› wiki › Mount_Everest" },
            "extra_snippets": ["Mount Everest is Earth's highest mountain above sea level."]
          },
          {
            "type": "search_result",
            "title": "How tall is <b>Everest</b>? | Britannica &quot;Quick Facts&quot;",
            "url": "https://www.britannica.com/place/Mount-Everest",
            "description": "Mount Everest, mountain on the crest of the Great Himalayas."
          },
          { "type": "search_result", "title": "Run me", "url": "javascript:alert(1)", "description": "Not a page." },
          { "type": "search_result", "title": "A file", "url": "file:///C:/Users/me/secrets.txt", "description": "Not a page either." },
          { "type": "search_result", "title": "Someone's login", "url": "https://user:pw@example.com/", "description": "" },
          { "type": "search_result", "title": "No address" },
          { "type": "search_result", "title": "  ", "url": "https://example.org/untitled", "description": 12 }
        ]
      }
    }"#;

    #[test]
    fn results_are_read_as_text_and_what_cannot_be_opened_is_left_out() {
        let found = results(&serde_json::from_str(ANSWER).unwrap()).unwrap();
        assert_eq!(
            found,
            vec![
                WebResult {
                    title: "Mount Everest - Wikipedia".into(),
                    url: "https://en.wikipedia.org/wiki/Mount_Everest".into(),
                    snippet: "Its elevation of 8,848.86 m (29,031 ft 8'') was most recently established in 2020 by the Chinese & Nepali authorities.".into(),
                },
                WebResult {
                    title: "How tall is Everest? | Britannica \"Quick Facts\"".into(),
                    url: "https://www.britannica.com/place/Mount-Everest".into(),
                    snippet: "Mount Everest, mountain on the crest of the Great Himalayas.".into(),
                },
                // No title: its site. A description that is not text: none.
                WebResult { title: "example.org".into(), url: "https://example.org/untitled".into(), snippet: String::new() },
            ]
        );
        // As the island gets them.
        assert_eq!(
            serde_json::to_value(&found[2]).unwrap(),
            json!({ "title": "example.org", "url": "https://example.org/untitled", "snippet": "" })
        );
    }

    #[test]
    fn at_most_eight_results_each_within_its_bounds() {
        let many: Vec<Value> = (0..20)
            .map(|i| json!({ "title": "t".repeat(500), "url": format!("https://example.com/{i}"), "description": "word ".repeat(300) }))
            .collect();
        let found = results(&json!({ "web": { "results": many } })).unwrap();
        assert_eq!(found.len(), MAX_RESULTS);
        assert_eq!(found[0].url, "https://example.com/0");
        for result in &found {
            assert_eq!(result.title.chars().count(), MAX_TITLE);
            assert!(result.title.ends_with('…'));
            assert!(result.snippet.chars().count() <= MAX_SNIPPET);
            assert!(result.snippet.ends_with("word…"), "{}", result.snippet);
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL));
        assert_eq!(results(&json!({ "web": { "results": [{ "title": "x", "url": long }] } })).unwrap(), vec![]);
    }

    #[test]
    fn nothing_found_is_an_empty_list_and_what_is_not_an_answer_is_none() {
        let nothing = json!({ "type": "search", "query": { "original": "qzxv", "more_results_available": false } });
        assert_eq!(results(&nothing).unwrap(), vec![]);
        assert_eq!(results(&json!({ "web": { "results": [] } })).unwrap(), vec![]);
        for odd in [json!({}), json!([1, 2]), json!("search"), json!({ "web": {} }), json!({ "web": { "results": "none" } }), json!({ "error": "x" })] {
            assert!(results(&odd).is_none(), "{odd}");
        }
    }

    #[test]
    fn markup_goes_entities_are_read_once_and_a_lone_bracket_stays() {
        assert_eq!(plain("a <strong>b</strong> c, Ever<strong>est</strong>", 100), "a b c, Everest");
        assert_eq!(plain("one<br/>two<p class=\"x\">three</p>four", 100), "one two three four");
        assert_eq!(plain("<script>alert(1)</script>", 100), "alert(1)");
        assert_eq!(plain("1 < 2 and 3 > 2", 100), "1 < 2 and 3 > 2");
        assert_eq!(plain("x <3 y", 100), "x <3 y");
        assert_eq!(plain("Tom &amp; Jerry&#39;s &quot;best&quot; &#8212; caf&#xE9;&nbsp;!", 100), "Tom & Jerry's \"best\" — café !");
        // Text that spells a tag is text: it is not read a second time into one.
        assert_eq!(plain("&lt;b&gt;bold&lt;/b&gt; and &amp;lt;", 100), "<b>bold</b> and &lt;");
        assert_eq!(plain("AT&T; R&D &unknown; &#0; &#xD800; &", 100), "AT&T; R&D &unknown; &#0; &#xD800; &");
        assert_eq!(plain(" line\r\none\n\ttwo\u{0007} ", 100), "line one two");
        assert_eq!(plain("", 10), "");
        assert_eq!(plain("abcdefghij", 10), "abcdefghij");
        assert_eq!(plain("abcdefghijk", 10), "abcdefghi…");
    }

    #[test]
    fn the_query_is_one_line_within_what_brave_takes() {
        assert_eq!(query("  how tall\n is   mount everest ").as_deref(), Some("how tall is mount everest"));
        assert_eq!(query(""), None);
        assert_eq!(query(" \n\t "), None);
        let wordy = "word ".repeat(80);
        assert_eq!(query(&wordy).unwrap().split(' ').count(), MAX_QUERY_WORDS);
        let long = "abcdefghi ".repeat(60);
        let cut = query(&long).unwrap();
        assert!(cut.chars().count() <= MAX_QUERY_CHARS);
        assert!(cut.ends_with("abcdefghi"), "cut at a word");
        assert_eq!(query(&"é".repeat(900)).unwrap().chars().count(), MAX_QUERY_CHARS);
    }

    #[test]
    fn the_request_asks_brave_for_web_results_and_carries_no_key() {
        let url = address("c++ & rust: what's new?");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("api.search.brave.com"));
        assert_eq!(url.path(), "/res/v1/web/search");
        let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(
            pairs,
            [("q", "c++ & rust: what's new?"), ("count", "8"), ("text_decorations", "false"), ("result_filter", "web")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
        );
        // The query is escaped: it cannot add a parameter of its own.
        assert!(url.as_str().contains("q=c%2B%2B+%26+rust"), "{url}");
    }

    #[test]
    fn a_refusal_says_what_to_do_about_it_and_never_the_key() {
        assert_eq!(status_error(401, ""), "Brave Search rejected the API key (401). Check it in Settings.");
        assert!(status_error(403, "x").contains("rejected the API key (403)"));
        let limited = br#"{"type":"ErrorResponse","error":{"id":"1","status":429,"code":"RATE_LIMITED","detail":"Request rate limit exceeded for plan.","meta":{"plan":"Free"}}}"#;
        assert_eq!(status_error(429, &detail(limited)), "Brave Search rate limit reached (429): Request rate limit exceeded for plan.");
        assert_eq!(status_error(500, &detail(b"")), "Brave Search 500");
        assert_eq!(status_error(422, &detail(br#"{"error":{"detail":"Unable to <b>validate</b> request parameter(s)"}}"#)), "Brave Search 422: Unable to validate request parameter(s)");
        assert_eq!(detail("x".repeat(900).as_bytes()).chars().count(), 200);
        // A server that sent the key back in its complaint does not get it shown.
        assert_eq!(without_key("Brave Search 400: bad token BSA-secret-1".into(), "BSA-secret-1"), "Brave Search 400: bad token …");
        assert_eq!(without_key("plain".into(), ""), "plain");
    }
}
