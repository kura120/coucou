// Texts turned into vectors, by an embedding model on the model server chosen
// for voice: what the island ranks the app's capabilities against a sentence
// with (src/voice/rank.ts). This side only asks and reads the numbers; what
// they mean is the island's.
//
// The texts — a sentence, the capabilities' descriptions — go to that server
// and nowhere else, under the rule brain.rs has: a server that is not this
// machine was chosen by the user, and the same toast says so, once per
// address. Nothing of the texts is kept or logged here.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::brain;
use crate::local_chat;
use crate::settings::Settings;

/// A sentence is ranked before anything is done about it: a loaded model
/// answers in a few hundredths of a second, and one the server has to load
/// first (a second or two for an embedding model) still makes it.
const TIMEOUT: Duration = Duration::from_secs(12);
/// The most texts one request carries: every capability the app declares, at
/// once, with room. More is not cut — a list cut short would no longer line up
/// with what was asked — it is refused.
const MAX_TEXTS: usize = 256;
/// A text is a sentence or a description, not a document: longer is cut.
const MAX_TEXT: usize = 2000;
/// No embedding model has more numbers to a vector than this.
const MAX_DIMENSIONS: usize = 8192;

/// The request for these texts, or None when it may not be made: no model, or
/// too many texts. Each text is cut to what a description may weigh; one that
/// is blank goes as a space, which every server takes where some refuse "".
pub fn request(model: &str, texts: &[String]) -> Option<Value> {
    let model = model.trim();
    if model.is_empty() || texts.len() > MAX_TEXTS {
        return None;
    }
    let input: Vec<String> = texts
        .iter()
        .map(|text| {
            let cut: String = text.trim().chars().take(MAX_TEXT).collect();
            if cut.is_empty() { " ".to_string() } else { cut }
        })
        .collect();
    Some(json!({ "model": model, "input": input }))
}

/// The vectors of an OpenAI-style answer, in the order the texts were given
/// (`index` says which is which; most servers send them in order anyway).
/// None unless there is exactly one for each text, all of one length and all
/// of them numbers: a list with a hole in it would rank the wrong capability.
pub fn read(answer: &Value, count: usize) -> Option<Vec<Vec<f32>>> {
    let data = answer.get("data")?.as_array()?;
    if data.len() != count {
        return None;
    }
    let mut vectors: Vec<Option<Vec<f32>>> = vec![None; count];
    for (at, item) in data.iter().enumerate() {
        let index = match item.get("index") {
            Some(index) => usize::try_from(index.as_u64()?).ok()?,
            None => at,
        };
        let numbers = item.get("embedding")?.as_array()?;
        if numbers.is_empty() || numbers.len() > MAX_DIMENSIONS {
            return None;
        }
        let vector: Vec<f32> = numbers.iter().map(|n| n.as_f64().map(|n| n as f32)).collect::<Option<_>>()?;
        if vector.iter().any(|n| !n.is_finite()) {
            return None;
        }
        // Two answers for one text, or one for a text that was not asked.
        let slot = vectors.get_mut(index)?;
        if slot.is_some() {
            return None;
        }
        *slot = Some(vector);
    }
    let vectors: Vec<Vec<f32>> = vectors.into_iter().collect::<Option<_>>()?;
    let dimensions = vectors.first().map(Vec::len);
    vectors.iter().all(|v| Some(v.len()) == dimensions).then_some(vectors)
}

/// The embedding of each text, or None: no server or no embedding model is
/// chosen, the server did not answer in time, or what it sent cannot be read.
pub async fn embed(app: &AppHandle, settings: &Settings, texts: &[String]) -> Option<Vec<Vec<f32>>> {
    let server = local_chat::server(settings, &settings.voice.brain)?;
    let body = request(&settings.voice.embed_model, texts)?;
    if texts.is_empty() {
        return Some(Vec::new());
    }
    brain::tell_if_elsewhere(app, &server);
    // Why not is said without the server's own words: an error may quote what it was sent.
    let Ok(answer) = local_chat::embeddings(&server, &body, TIMEOUT).await else {
        crate::log::line("voice: embedding: the model server did not answer");
        return None;
    };
    let vectors = read(&answer, texts.len());
    if vectors.is_none() {
        crate::log::line("voice: embedding: the answer cannot be read");
    }
    vectors
}

fn settings_of(app: &AppHandle) -> Option<Settings> {
    Some(app.try_state::<crate::Shared>()?.settings.lock().ok()?.clone())
}

/// The island's side of `embed` (src/voice/rank.ts's `Embed`).
#[tauri::command]
pub async fn voice_embed(app: AppHandle, texts: Vec<String>) -> Option<Vec<Vec<f32>>> {
    let settings = settings_of(&app)?;
    embed(&app, &settings, &texts).await
}

/// The embedding models the server chosen for voice has, by name, for
/// Settings → Voice. Empty when no server is chosen, it does not answer, or it
/// has none.
#[tauri::command]
pub async fn voice_embed_models(app: AppHandle) -> Vec<String> {
    let Some(settings) = settings_of(&app) else { return Vec::new() };
    let Some(server) = local_chat::server(&settings, &settings.voice.brain) else { return Vec::new() };
    local_chat::embedding_models(&server).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(list: &[&str]) -> Vec<String> {
        list.iter().map(|text| text.to_string()).collect()
    }

    #[test]
    fn the_request_names_the_model_and_carries_every_text_in_order() {
        let body = request(" nomic-embed-text ", &texts(&["pause the music", "  open the chat  "])).unwrap();
        assert_eq!(body, json!({ "model": "nomic-embed-text", "input": ["pause the music", "open the chat"] }));
        // No texts is still a request that may be made: `embed` answers it itself.
        assert_eq!(request("m", &[]).unwrap()["input"], json!([]));
    }

    #[test]
    fn no_model_or_too_many_texts_is_no_request() {
        assert!(request("", &texts(&["a"])).is_none());
        assert!(request("   ", &texts(&["a"])).is_none());
        let many = vec!["a".to_string(); MAX_TEXTS + 1];
        assert!(request("m", &many).is_none());
        assert!(request("m", &many[..MAX_TEXTS]).is_some());
    }

    #[test]
    fn a_long_text_is_cut_and_a_blank_one_still_has_its_place() {
        let long = "é".repeat(MAX_TEXT + 50);
        let body = request("m", &[long, "   ".to_string(), "ok".to_string()]).unwrap();
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[0].as_str().unwrap().chars().count(), MAX_TEXT);
        assert_eq!(input[1], " ");
        assert_eq!(input[2], "ok");
    }

    #[test]
    fn vectors_come_back_in_the_order_of_the_texts_whatever_order_they_were_sent_in() {
        let answer = json!({ "object": "list", "model": "m", "data": [
            { "object": "embedding", "index": 1, "embedding": [0.0, 1.0, 0.5] },
            { "object": "embedding", "index": 0, "embedding": [1, 0, -0.25] },
        ], "usage": { "prompt_tokens": 6 } });
        assert_eq!(read(&answer, 2).unwrap(), vec![vec![1.0, 0.0, -0.25], vec![0.0, 1.0, 0.5]]);
        // A server that leaves `index` out sends them in order.
        let plain = json!({ "data": [{ "embedding": [1.0] }, { "embedding": [2.0] }] });
        assert_eq!(read(&plain, 2).unwrap(), vec![vec![1.0], vec![2.0]]);
        assert_eq!(read(&json!({ "data": [] }), 0).unwrap(), Vec::<Vec<f32>>::new());
    }

    #[test]
    fn an_answer_that_does_not_line_up_with_the_texts_is_none() {
        let one = json!({ "data": [{ "index": 0, "embedding": [1.0, 2.0] }] });
        assert!(read(&one, 1).is_some());
        // Fewer or more than asked.
        assert!(read(&one, 2).is_none());
        assert!(read(&one, 0).is_none());
        for odd in [
            json!({}),
            json!({ "error": { "message": "model not found" } }),
            json!({ "data": "no" }),
            // The same text twice, and a text nobody asked.
            json!({ "data": [{ "index": 0, "embedding": [1.0] }, { "index": 0, "embedding": [1.0] }] }),
            json!({ "data": [{ "index": 0, "embedding": [1.0] }, { "index": 5, "embedding": [1.0] }] }),
            json!({ "data": [{ "index": 0, "embedding": [1.0] }, { "index": -1, "embedding": [1.0] }] }),
            // Vectors of two lengths, an empty one, and what is not a number.
            json!({ "data": [{ "index": 0, "embedding": [1.0] }, { "index": 1, "embedding": [1.0, 2.0] }] }),
            json!({ "data": [{ "index": 0, "embedding": [] }, { "index": 1, "embedding": [] }] }),
            json!({ "data": [{ "index": 0, "embedding": [1.0] }, { "index": 1, "embedding": ["x"] }] }),
            json!({ "data": [{ "index": 0, "embedding": [1.0] }, { "index": 1, "embedding": [null] }] }),
            json!({ "data": [{ "index": 0, "embedding": [1.0] }, { "index": 1 }] }),
            // Base64, which was not asked for.
            json!({ "data": [{ "index": 0, "embedding": "AACAPw==" }, { "index": 1, "embedding": "AACAPw==" }] }),
        ] {
            assert!(read(&odd, 2).is_none(), "{odd}");
        }
        // A number no f32 holds is not a number to rank with.
        let huge = json!({ "data": [{ "index": 0, "embedding": [1e300] }] });
        assert!(read(&huge, 1).is_none());
        let wide = json!({ "data": [{ "index": 0, "embedding": vec![0.5; MAX_DIMENSIONS + 1] }] });
        assert!(read(&wide, 1).is_none());
    }
}
