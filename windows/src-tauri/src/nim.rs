// NVIDIA NIM chat client — OpenAI-compatible /v1/chat/completions endpoint.
// Mirrors claude.rs but for NIM's API format.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_BASE: &str = "https://integrate.api.nvidia.com/v1";
const MAX_TOKENS: u32 = 4096;
const MAX_INLINE_TEXT: u64 = 200_000;

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

#[derive(Default)]
pub struct NimChat {
    /// Full multi-turn history, including tool_use / tool_result blocks.
    messages: Mutex<Vec<Value>>,
    /// API key for requests
    api_key: Mutex<Option<String>>,
    /// Base URL for requests
    base_url: Mutex<Option<String>>,
}

impl NimChat {
    pub fn new(api_key: String, base_url: String) -> Self {
        let mut chat = Self::default();
        *chat.api_key.lock().unwrap() = Some(api_key);
        *chat.base_url.lock().unwrap() = Some(base_url);
        chat
    }

    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
    }

    fn is_empty(&self) -> bool {
        self.messages.lock().unwrap().is_empty()
    }

    fn push(&self, message: Value) {
        self.messages.lock().unwrap().push(message);
    }

    fn pop(&self) {
        self.messages.lock().unwrap().pop();
    }

    fn snapshot(&self) -> Vec<Value> {
        self.messages.lock().unwrap().clone()
    }

    fn get_credentials(&self) -> (String, String) {
        let key = self.api_key.lock().unwrap().clone().unwrap_or_default();
        let base = self.base_url.lock().unwrap().clone().unwrap_or_else(|| DEFAULT_BASE.to_string());
        (key, base.trim_end_matches('/').to_string())
    }

    /// One chat turn. Returns the assistant's text, or a message the island shows
    /// in the note view.
    pub async fn send(
        &self,
        chat: &crate::claude::Chat,
        model: &str,
        query: String,
        context: Option<crate::claude::ChatContext>,
    ) -> Result<crate::claude::ChatReply, String> {
        let (key, base) = self.get_credentials();
        if key.is_empty() {
            return Err("NIM API key missing. Open settings.".to_string());
        }

        let mut content: Vec<Value> = Vec::new();

        // File / window context rides along with the first message only.
        if self.is_empty() {
            match &context {
                Some(crate::claude::ChatContext::File { name, path }) => {
                    if let Some(block) = file_block(path) {
                        content.push(block);
                    }
                    content.push(json!({ "type": "text", "text": format!("File: {name}") }));
                }
                Some(crate::claude::ChatContext::Window { app_name, title, url }) => {
                    let mut text = format!("Context — App: {app_name}, Window: {title}");
                    if let Some(url) = url {
                        text.push_str(&format!(", URL: {url}"));
                    }
                    content.push(json!({ "type": "text", "text": text }));
                }
                None => {}
            }
        }
        content.push(json!({ "type": "text", "text": query }));

        self.push(json!({ "role": "user", "content": content }));

        // Build OpenAI-compatible request
        let mut tools = vec![];
        // Add web search tool if model supports it (we'll check capabilities)
        // For now, include it — NIM will ignore if not supported
        tools.push(json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for current information",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" }
                    },
                    "required": ["query"]
                }
            }
        }));

        let body = json!({
            "model": model,
            "max_tokens": MAX_TOKENS,
            "messages": self.snapshot(),
            "tools": tools,
            "tool_choice": "auto",
            "stream": false,
        });

        let response = match call(&key, &base, &body).await {
            Ok(v) => v,
            Err(err) => {
                self.pop();
                return Err(err);
            }
        };

        // Handle tool calls
        let choice = response.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first());
        let Some(choice) = choice else {
            self.pop();
            return Err("Unexpected API response: no choices".into());
        };

        let message = choice.get("message");
        let Some(message) = message else {
            self.pop();
            return Err("Unexpected API response: no message".into());
        };

        // Check for tool calls
        if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
            // Execute tool calls and continue conversation
            let mut tool_results = Vec::new();
            for tc in tool_calls {
                if let Some(func) = tc.get("function") {
                    let name = func.get("name").and_then(Value::as_str).unwrap_or("");
                    let args_str = func.get("arguments").and_then(Value::as_str).unwrap_or("{}");
                    if name == "web_search" {
                        if let Ok(args) = serde_json::from_str::<serde_json::Value>(args_str) {
                            let query = args.get("query").and_then(Value::as_str).unwrap_or("");
                            if !query.is_empty() {
                                let result = web_search(query).await;
                                tool_results.push(json!({
                                    "tool_call_id": tc.get("id").and_then(Value::as_str).unwrap_or(""),
                                    "role": "tool",
                                    "content": result,
                                }));
                            }
                        }
                    }
                }
            }

            if !tool_results.is_empty() {
                // Add assistant message with tool calls
                self.push(message.clone());
                // Add tool results
                for tr in tool_results {
                    self.push(tr);
                }
                // Recurse for final answer
                return self.send(chat, model, "Continue.".to_string(), None).await;
            }
        }

        // Regular text response
        let text = message.get("content").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if text.is_empty() {
            self.pop();
            return Err("No response text.".into());
        }

        self.push(json!({ "role": "assistant", "content": text }));
        Ok(crate::claude::ChatReply { text })
    }
}

async fn call(key: &str, base: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(format!("{base}/chat/completions"))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("NIM API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// Simple web search via DuckDuckGo HTML (fallback since NIM may not have built-in search)
async fn web_search(query: &str) -> String {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding::encode(query));
    let response = client.get(&url).send().await;
    let Ok(response) = response else { return "Search unavailable".into() };
    let text = response.text().await.unwrap_or_default();

    // Extract snippets from HTML (very basic)
    let mut results = Vec::new();
    for part in text.split("class=\"result__snippet\"") {
        if let Some(end) = part.find("</a>") {
            let snippet = &part[..end];
            if let Some(start) = snippet.rfind('>') {
                let clean = snippet[start+1..].replace("<b>", "").replace("</b>", "");
                if clean.len() > 20 {
                    results.push(clean.trim().to_string());
                    if results.len() >= 3 { break; }
                }
            }
        }
    }

    if results.is_empty() {
        "No results found".to_string()
    } else {
        results.join("\n\n")
    }
}

/// PDF → document block, image → image block, text/code → inline text.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NimModel {
    pub id: String,
    pub capabilities: Vec<String>,
}

impl NimModel {
    pub fn supports_function_calling(&self) -> bool {
        self.capabilities.iter().any(|c| c == "function_calling")
    }
}