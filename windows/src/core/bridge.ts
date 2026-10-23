// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { SavedEdit } from "./diff";
import type { Settings } from "./state";
import type { RecapHistory, RecapPrefs } from "../recap/summary";
import type { SpotifyState } from "./spotify";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[peika] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

/** The bundled engine's parts (src-tauri/src/speech/engine.rs): what hears free speech, and Peika's voice. */
export type VoiceEnginePart = "hearing" | "speaking";

/** src-tauri/src/voice/mod.rs `Status`. */
export type VoiceStatus =
  | "off" | "listening" | "shortcut" | "paused" | "noRecogniser" | "microphone" | "unsupported" | "noEngine" | "error";
export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  /** The system's languages as the webview sees them, for Rust's own texts (i18n.rs). */
  setSystemLanguages: (languages: string[]) => call<void>("set_system_languages", { languages }),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  /**
   * Seconds since the keyboard or mouse was last used; null where the system
   * cannot say (Linux). Asked on a slow timer, only while something is waiting
   * to be told (island/away.ts).
   */
  idleSeconds: () => call<number | null>("idle_seconds"),

  /** Displays the island can be pinned to: `key` is what `settings.screen` stores. */
  listMonitors: () => call<{ key: string; label: string }[]>("list_monitors"),

  /**
   * A fullscreen app or a presentation is in front (Windows; never on Linux).
   * Asked when an alert is about to open the island; not busy when the system
   * cannot say.
   */
  userBusy: async () => (await call<boolean>("user_busy")) === true,

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** Which of these sounds have a file of the user's own in the sounds folder. */
  customSounds: (names: readonly string[]) => call<string[]>("custom_sounds", { names }),
  /** The user's file for one sound, as raw bytes. */
  customSound: (name: string) => call<ArrayBuffer>("custom_sound", { name }),
  revealSoundsFolder: () => call<void>("reveal_sounds_folder"),
  /** Tells the island to read the sounds folder again ("sounds-changed"). */
  reloadSounds: () => call<void>("reload_sounds"),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * "Open terminal": the window the session runs in when Rust found it
   * (Windows; Linux on X11 and KDE Plasma), else the folder in VS Code.
   */
  openSession: (sessionId: string | null, path: string | null) =>
    call<boolean>("open_session", { sessionId, path }),

  /** The Claude desktop app, for the Claude Desktop pill (Windows only). */
  openClaudeDesktop: () => call<boolean>("open_claude_desktop"),

  /** The diff card's ↗: an existing file, in VS Code; never launched by its type. */
  openFileInVSCode: (path: string) => call<boolean>("open_file_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  /**
   * Starts writing down what is said (src-tauri/src/speech/dictate.rs): its id, which the
   * `dictation` event carries. Fails when one is running or the speech engine is not installed.
   */
  dictationBegin: () => callOrThrow<number>("dictation_begin"),
  /** The button was pressed again: what is left is written down, then "final" comes. */
  dictationFinish: (id: number) => call<void>("dictation_finish", { id }),
  /** Esc: nothing more is written down. */
  dictationCancel: (id: number) => call<void>("dictation_cancel", { id }),

  /** The Peika window (the settings window), on a page of its tree if given. */
  openSettingsWindow: (page?: string) => call<void>("open_settings_window", { page }),
  /** The settings page finished its closing motion: hide its window. */
  hideSettingsWindow: () => call<void>("hide_settings_window"),
  /** A Peika window made just now: the page it was opened on, if any. */
  settingsFirstPage: () => call<string | null>("settings_first_page"),
  /** The settings page's own title bar: close, minimize, maximize, drag. */
  closeSettingsWindow: () => call<void>("close_settings_window"),
  minimizeSettingsWindow: () => call<void>("minimize_settings_window"),
  toggleMaximizeSettingsWindow: () => call<void>("toggle_maximize_settings_window"),
  dragSettingsWindow: () => call<void>("drag_settings_window"),

  /** Writes to %LOCALAPPDATA%\Peika\peika.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Pill ID → whether that agent's hooks reach Peika (read-only, Mac #183). */
  agentHooksStatus: () => call<Record<string, boolean>>("agent_hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── Other agents (Gemini CLI, Codex, Cursor…) ─────────────────────────────
  agentHooksList: () => call<AgentHookStatus[]>("agent_hooks_list"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  agentHooksPreview: (agent: string, install: boolean) =>
    callOrThrow<AgentHookPlan>("agent_hooks_preview", { agent, install }),
  /**
   * Writes the agent's config — only ever after an explicit click, and only when
   * it still matches the preview the user looked at. Returns the backups taken.
   */
  agentHooksApply: (agent: string, install: boolean, fingerprint: string) =>
    callOrThrow<string>("agent_hooks_apply", { agent, install, fingerprint }),
  // ── Plan usage: the status line relay, installed apart from the hooks ──────
  /** Diff of the status line change. `install: false` previews taking the relay out. */
  statusLinePreview: (install: boolean) => callOrThrow<HookPreview>("status_line_preview", { install }),
  /** Same rules as hooksApply: an explicit click, and only for the diff that was shown. */
  statusLineApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("status_line_apply", { install, fingerprint }),
  /**
   * Asks the Codex CLI (`codex app-server`) for its plan limits, as Codex's
   * /status does. The raw `account/rateLimits/read` result, or null when Codex
   * is missing, not signed in or slow (15 s).
   */
  codexPlanUsage: () => call<unknown>("codex_plan_usage"),

  approvalDecision: (requestId: string, decision: "allow" | "deny" | "always") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** Answers a question Claude Code asked: question text → chosen label. */
  approvalAnswer: (requestId: string, answers: Record<string, string | string[]>) =>
    call<void>("approval_answer", { requestId, answers }),

  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string; conversationId?: string | null }>("chat_send", { query, context }),
  /** The saved conversations, newest first. */
  conversationsList: () => call<ConversationSummary[]>("conversations_list"),
  /** Opens a saved conversation: the Rust side carries on from it. */
  conversationOpen: (id: string) => callOrThrow<SavedConversation>("conversation_open", { id }),
  conversationDelete: (id: string) => call<void>("conversation_delete", { id }),
  /** The pull requests of the folder Claude Code works in (git and the GitHub CLI). */
  repoPulls: () => callOrThrow<RepoPulls>("repo_pulls"),
  chatReset: () => call<void>("chat_reset"),
  /** Ends the Claude Code turn that is running. */
  chatStop: () => call<void>("chat_stop"),
  /** The system's folder dialog; null when cancelled. */
  pickFolder: () => call<string | null>("pick_folder"),

  /** The clipboard's text, for Paste in the right-click menu; null when Rust has none to give. */
  clipboardText: () => call<string | null>("clipboard_text"),
  /**
   * The models a provider offers, for the picker in the chat view. Rust asks
   * the provider only when it has a key (or a server address).
   */
  chatModels: (provider: string) => callOrThrow<ModelInfo[]>("chat_models", { provider }),
  /** Settings → Local models → Connect: does the server answer, and with which models? */
  /** The custom server's key, bound to the address it is entered for. */
  localSetKey: (url: string, key: string) => call<void>("local_set_key", { url, key }),

  localConnect: (provider: "ollama" | "lmstudio" | "custom", url: string) =>
    callOrThrow<LocalServer>("local_connect", { provider, url }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** The screen capture card's Copy: puts the picture (a PNG file) on the clipboard. */
  captureCopy: (path: string) => call<void>("capture_copy", { path }),
  /** The capture card's Paste: pastes the picture into the window that was in front before the capture. */
  capturePaste: (path: string) => call<void>("capture_paste", { path }),
  /** The capture card's Draw on it: opens the picture in Paint. */
  captureOpen: (path: string) => call<void>("capture_open", { path }),
  /** The capture is done, or replaced: deletes its file. */
  captureDiscard: (path: string) => call<void>("capture_discard", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** The GitHub card is on screen: refetch that part if it is stale. */
  githubRefresh: (section: "pulse" | "activity") => call<void>("github_refresh", { section }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Global shortcuts ──────────────────────────────────────────────────────
  /** How each global shortcut went when Rust last registered them. */
  shortcutsStatus: () => call<ShortcutsReport>("shortcuts_status"),
  /** Lets go of every global shortcut while Settings records a new one. */
  shortcutsSuspend: (suspended: boolean) => call<void>("shortcuts_suspend", { suspended }),

  // ── Weekly recap ──────────────────────────────────────────────────────────
  /** Turns and decisions from `since` (Unix seconds) on, plus the recap prefs. */
  recapHistory: (since: number) => call<RecapHistory>("recap_history", { since: Math.floor(since) }),
  recapPrefs: () => call<RecapPrefs>("recap_prefs"),
  recapSetEnabled: (enabled: boolean) => call<void>("recap_set_enabled", { enabled }),
  recapSetHideProjects: (hide: boolean) => call<void>("recap_set_hide_projects", { hide }),
  /** `week` is the Monday (YYYY-MM-DD) the recap opened on its own for. */
  recapMarkShown: (week: string) => call<void>("recap_mark_shown", { week }),
  recapClear: () => call<void>("recap_clear"),
  /** Writes the PNG (a data URL) into Pictures or Downloads; returns its path. */
  recapSavePng: (data: string, week: string) => callOrThrow<string>("recap_save_png", { data, week }),
  /** Opens the folder of the image saved last. */
  recapRevealSaved: () => call<void>("recap_reveal_saved"),

  // ── Peika on the desktop (src-tauri/src/desktop.rs) ───────────────────────
  desktopInfo: () => call<DesktopInfo>("desktop_peika_info"),
  /** Dragged out of the island: (x, y) is the pointer in island-window coordinates. */
  desktopPickUp: (x: number, y: number) => call<boolean>("desktop_peika_pick_up", { x, y }),
  /** Linux: the pointer moved during that drag (Windows carries him from Rust). */
  desktopCarry: (x: number, y: number) => call<void>("desktop_peika_carry", { x, y }),
  desktopCarryEnd: (x: number, y: number) => call<void>("desktop_peika_carry_end", { x, y }),
  /** A drag started on the desktop Peika; resolves to his top-left corner. */
  desktopDragBegin: () => call<[number, number] | null>("desktop_peika_drag_begin"),
  /** X11: top-left corner, physical pixels. */
  desktopDragMove: (x: number, y: number) => call<void>("desktop_peika_drag_move", { x, y }),
  desktopDragEnd: (x: number, y: number) => call<void>("desktop_peika_drag_end", { x, y }),
  /** From the island to his spot. False: no spot on any connected display.
   *  `anywhere`: the first-visit corner then, rather than staying home. */
  desktopFlyOut: (anywhere = false) => call<boolean>("desktop_peika_fly_out", { anywhere }),
  /** To the island, then hidden. `forget`: he lives in the island again. */
  desktopFlyHome: (forget: boolean) => call<boolean>("desktop_peika_fly_home", { forget }),
  /** Asleep, the cursor poll stops. */
  desktopSetAsleep: (asleep: boolean) => call<void>("desktop_peika_set_asleep", { asleep }),

  // ── Spotify (src-tauri/src/spotify.rs) ────────────────────────────────────
  /** Reads the player again (the card came on screen) and reports it. */
  spotifyRefresh: () => call<SpotifyState | null>("spotify_refresh"),
  /** True when Spotify took it. `value`: seconds for seek, 0/1 for shuffle and repeat, 0…100 for volume. */
  spotifyControl: (action: SpotifyAction, value?: number) =>
    call<boolean>("spotify_control", { action, value: value ?? null }),
  /** Brings Spotify forward or starts it; without it, its download page. */
  spotifyOpen: () => call<boolean>("spotify_open"),
  /** Whether there is a Spotify to launch (Settings). */
  spotifyInstalled: () => call<boolean>("spotify_installed"),

  // ── Voice ─────────────────────────────────────────────────────────────────
  /** Whether "OK Peika" is listening, and why not (Settings). */
  voiceStatus: () => call<VoiceStatus>("voice_status"),
  /** The island left the listening view itself: the command is not waited for. */
  voiceCancel: () => call<void>("voice_cancel"),
  /** What was said without the wake phrase was a command: another may follow it. */
  voiceFollowed: () => call<void>("voice_followed"),
  /**
   * The models the bundled engine can hear with, and which are on this machine;
   * and, last and with `server`, the model of the server chosen for voice when
   * that server is on this computer (src-tauri/src/voice/hear.rs).
   */
  voiceHearingModels: () =>
    call<{ id: string; name: string; downloadBytes: number; installed: boolean; server: boolean }[]>("voice_hearing_models"),
  /** Listens for a command without the wake phrase: the answer to a question. */
  voiceTalk: () => call<void>("voice_talk"),
  /**
   * What a sentence means, asked of the model server chosen for voice: the
   * tool calls it proposes, or its answer. Null when it cannot be asked.
   */
  voiceBrain: (
    system: string,
    said: string,
    tools: unknown[],
    /** The turns so far, oldest first: each sentence, what was done for it and what came of it. */
    history: { said: string; calls: { name: string; arguments: Record<string, unknown> }[]; result: string }[] = [],
    /** This turn's rounds so far: the calls the model made and what each gave back. */
    steps: { calls: { name: string; arguments: Record<string, unknown> }[]; results: string[] }[] = [],
  ) =>
    call<{ calls: { name: string; arguments: Record<string, unknown> }[]; text: string }>(
      "voice_brain", { system, said, tools, history, steps },
    ),
  /**
   * Each text as a vector, from the embedding model (`voice.embedModel`) of the
   * server chosen for voice, in the texts' order. Null when there is no such
   * model, it did not answer, or more than 256 texts were given at once.
   */
  voiceEmbed: (texts: string[]) => call<number[][] | null>("voice_embed", { texts }),
  /** The embedding models the server chosen for voice has, by name (Settings). */
  voiceEmbedModels: () => call<string[]>("voice_embed_models"),
  /**
   * Searches the web with Brave Search and the user's key: eight results at
   * most, as plain text. Throws what went wrong, in words to show; and always
   * unless `voice.webSearch` is "brave".
   */
  webSearch: (query: string) => callOrThrow<WebResult[]>("web_search", { query }),
  /**
   * The capabilities a cloud model may ask for, as tools (core/capabilities
   * `Registry.schema`): what the MCP endpoint lists. Sent when they change.
   */
  capabilityPublish: (tools: unknown[]) => call<void>("capability_publish", { tools }),
  /** What a `capability-call` came to, as the text a model is given back (voice/result.ts `forModel`). */
  capabilityResult: (id: string, result: string) => call<void>("capability_result", { id, result }),
  /**
   * The turn the local model handed up, put to the provider chosen for chat
   * (`voice.cloud` on): it reaches the capabilities through the MCP endpoint,
   * each call arriving here as a `capability-call`. Its last words, or null
   * when it cannot be asked or did not answer.
   */
  voiceCloud: (
    system: string,
    said: string,
    history: { said: string; calls: { name: string; arguments: Record<string, unknown> }[]; result: string }[] = [],
  ) => call<{ text: string }>("voice_cloud", { system, said, history }),
  /** A turn's lines for voice-debug.log; written only while `voice.debugLog` is on (src-tauri/src/voice/debug.rs). */
  voiceDebugLog: (lines: string[]) => call<void>("voice_debug_log", { lines }),
  /** Deletes the voice debug log. */
  voiceDebugClear: () => call<void>("voice_debug_clear"),
  /** Opens the folder that holds the voice debug log. */
  voiceDebugReveal: () => call<void>("voice_debug_reveal"),
  /** The user's own folders voice may open, by name (src-tauri/src/voice/apps.rs `folder`). */
  voiceFolders: () => call<string[]>("voice_folders"),
  /** Whether a part of the bundled engine is on this machine, and what getting it costs. */
  voiceEngineStatus: (part: VoiceEnginePart) =>
    call<{ installed: boolean; downloadBytes: number; available: boolean; downloading: boolean }>("voice_engine_status", { part }),
  /** Downloads that part; progress arrives as `voice-engine` events. */
  voiceEngineInstall: (part: VoiceEnginePart) => call<void>("voice_engine_install", { part }),
  voiceEngineRemove: (part: VoiceEnginePart) => call<void>("voice_engine_remove", { part }),
  /** Peika says this out loud, when speaking is on and his voice is installed. */
  voiceSay: (text: string) => call<void>("voice_say", { text }),
  /** Opens the mail app on a draft, for the user to read and send. False when the recipient is not one address. */
  openMailDraft: (to: string, subject: string, body: string) => call<boolean>("open_mail_draft", { to, subject, body }),
  /** The user is done talking: nothing more is listened for until the wake phrase. */
  voiceRest: () => call<void>("voice_rest"),
  /** Holds Ctrl+Shift+1…`numbers` and, for a text field, Ctrl+Shift+Enter while a question is on screen; 0 and false lets go. */
  voiceAskKeys: (numbers: number, enter: boolean) => call<void>("voice_ask_keys", { numbers, enter }),
  /** Starts the installed app that name means: its name and whether a window of it was seen to come, or null. */
  voiceOpenApp: (name: string) => call<{ name: string; seen: boolean } | null>("voice_open_app", { name }),
  /** The installed apps nearest to what was heard, for "Open Spotify?": opens nothing. */
  voiceAppsNear: (said: string) => call<{ found: string | null; names: string[]; scores: number[]; clear: boolean }>("voice_apps_near", { said }),
  /** Opens one of the user's own folders; its name, or null. */
  voiceOpenFolder: (name: string) => call<string | null>("voice_open_folder", { name }),
};

export type SpotifyAction = "playPause" | "play" | "pause" | "next" | "previous" | "seek" | "shuffle" | "repeat" | "volume";

export type ShortcutStatus =
  | "active" | "off" | "inUse" | "duplicate" | "invalid"
  | "typesCharacter" | "unsupported" | "notPorted"
  /** Wayland: handed to the desktop's portal, no answer yet / left out by it. */
  | "pending" | "refused";

export interface ShortcutsReport {
  /** `trigger`: on Wayland, the keys the desktop says run it, in its words. */
  actions: { id: string; status: ShortcutStatus; typed?: string; trigger?: string }[];
  /** "wayland" or "no-display" when no key grab can be made. */
  blocked: string | null;
  /** `<executable> --shortcut`: append an action id for a desktop shortcut. */
  command: string;
  /** Wayland: the shortcuts went to the desktop's GlobalShortcuts portal. */
  portal?: "pending" | "active" | null;
}

/** How the desktop Peika's window works here (platform::DesktopMode). */
export type DesktopMode = "poll" | "window" | "layer" | "off";

export interface DesktopInfo {
  mode: DesktopMode;
  /** He was on the desktop when the app last quit. */
  onDesktop: boolean;
}

/** An event for one window only (island ⇄ desktop Peika). Never throws. */
export async function emitToWindow(label: string, event: string, payload?: unknown) {
  if (!IS_TAURI) return;
  try {
    await emitTo(label, event, payload);
  } catch (err) {
    console.error(`[peika] emit ${event} failed`, err);
  }
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface ModelInfo {
  id: string;
  label: string;
}

/** A row of the chat's conversation list (conversations.rs). */
export interface ConversationSummary {
  id: string;
  title: string;
  provider: string;
  /** The folder it works in; empty for a plain chat. */
  dir: string;
  /** Seconds since 1970, at the last answer. */
  updated: number;
  /** A session of Claude Code's own (a terminal, the Claude app): Peika has no record to delete. */
  external?: boolean;
}

/** repo_pulls.rs: the open pull requests on GitHub, and the local branches without one. */
export interface RepoPulls {
  repo: string | null;
  remote: { number: number; title: string; branch: string; url: string; draft: boolean }[];
  local: { branch: string; ahead: number; pushed: boolean; current: boolean }[];
  /** Why the GitHub half is empty, when it is not simply that there are none. */
  note: string | null;
}

/** A file edit Claude Code made while answering: the tool and its input (`chat-edit`). */
export interface ChatEdit {
  tool: string;
  input: Record<string, unknown>;
}

export interface SavedConversation extends ConversationSummary {
  model: string;
  /** An answer during which Claude Code edited files carries them (core/diff.ts, diffOfSaved). */
  turns: { role: string; content: string; edits?: SavedEdit[] }[];
}

export interface LocalServer {
  /** The address as it is stored. */
  url: string;
  models: string[];
  /** The address is this machine. */
  loopback: boolean;
}

/**
 * The `capability-call` event: a cloud model asked for a capability through
 * the MCP endpoint (src-tauri/src/voice/mcp.rs). The island runs it through
 * the registry, origin "cloud", and answers with `capabilityResult` by `id`.
 */
export interface CapabilityCallEvent {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One web search result (src-tauri/src/web_search.rs): text only, the address http(s). */
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/** Credential store entry of the user's Brave Search key, for `secretSet` / `secretPresent`. */
export const BRAVE_SEARCH_KEY = "brave-search-api-key";

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  /** Peika's status line relay (plan usage) is the status line in settings.json. */
  planRelayInstalled: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

/** One agent other than Claude Code, as agents.rs reports it. */
export interface AgentHookStatus {
  /** The `--agent` name; its pill is `agent_<id>`. */
  id: string;
  name: string;
  installed: boolean;
  /** The file (or files, one per line) Peika writes. */
  path: string;
  hookReady: boolean;
  /** The island can allow or deny this agent's permission requests. */
  approvals: boolean;
  /** What to do once it is written. */
  note: string;
}

export interface AgentHookPlan {
  diff: string;
  /** Where each existing file is copied first, one per line; "" when none. */
  backup: string;
  path: string;
  fingerprint: string;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Peika");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

/** The `dictation` event: `level` is how loud (0…1), `text` the words so far, or why it failed. */
export interface DictationEvent {
  id: number;
  phase: "level" | "partial" | "final" | "cancelled" | "failed";
  text: string;
  level: number;
}

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 *
 * On Windows WebView2 takes the drop itself, as in Edge — Tauri's drop handling
 * never sees drags from the classic Explorer folder view (see
 * src-tauri/src/webview_drop.rs). Enter/over/leave come straight from the page;
 * the drop hands the File objects to Rust, which answers with their real paths
 * as a `file-drag` event. Elsewhere (Linux) Tauri's own drag events still do it.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) {
    return getCurrentWebview().onDragDropEvent((event) => {
      handler(event.payload as DragDropPayload);
    });
  }
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  // dragenter/dragleave fire for every element crossed; only the outermost pair counts.
  let depth = 0;

  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) handler({ type: "enter" });
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    // Without this WebView2 refuses the drop — or navigates to the file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    handler({ type: "over" });
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e) || depth === 0) return;
    if (--depth === 0) handler({ type: "leave" });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      handler({ type: "drop", paths: [] });
      return;
    }
    webview.postMessageWithAdditionalObjects("peika-file-drop", files);
  };

  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  const unlisten = await listen<DragDropPayload>("file-drag", (e) => handler(e.payload));
  return () => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
    unlisten();
  };
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}

/**
 * Whether the console hooks for trying things by hand (peikaVoice, peikaAsk,
 * peikaPreview…) are installed: in a plain browser, and in a development
 * build of the app — never in a release.
 */
export const CONSOLE_HOOKS = !IS_TAURI || Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
