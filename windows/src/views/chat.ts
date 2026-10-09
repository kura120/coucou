// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model and Claude Code
// stream their answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker: provider chips, then the
// models of the chosen provider, asked for only once it is picked. Claude Code
// has options of its own under its models: the folder it works in, its effort
// and its permission mode (src-tauri/src/claude_code.rs).
//
// A provider whose conversations are saved (core/providers.ts) has their list
// behind the title on the left of the model: grouped by the folder they work
// in, newest first. Opening one puts it back in the chat, on both sides. The
// sessions Claude Code holds itself (a terminal, the Claude app) are in the
// list too; those are Claude Code's to delete, not Coucou's.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import {
  Bridge, onEvent, type ChatContext, type ConversationSummary, type ModelInfo,
} from "../core/bridge";
import {
  activeModel, pickModel, providerDef, visibleProviders, withModel, type ProviderDef,
} from "../core/providers";
import { CHAT_MIN_H, chatPromptHeight, clampChatHeight } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { N_, dayMonth, t, tl } from "../i18n/i18n";

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
  switchModel: N_("Switch provider or model"),
  noModel: N_("Choose a model"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  openSettings: N_("Open Settings"),
  stop: N_("Stop answering"),
  folder: N_("Folder"),
  noFolder: N_("None: chat only"),
  choose: N_("Choose…"),
  clear: N_("Clear"),
  effort: N_("Effort"),
  permissions: N_("Permissions"),
  chatOnly: N_("Without a folder, Claude Code only chats and searches the web."),
  inFolder: N_("Claude Code can read, edit and run commands in this folder. What it must ask for shows in the island."),
  conversations: N_("Conversations"),
  newChat: N_("New chat"),
  newChatHere: N_("New chat in this folder"),
  anyFolder: N_("No folder"),
  noConversations: N_("No conversations yet."),
  deleteConversation: N_("Delete this conversation"),
};

/** Claude Code's `--effort` levels; "" leaves it to Claude Code. */
const EFFORTS: readonly [string, string][] = [
  ["", N_("Default")], ["low", N_("Low")], ["medium", N_("Medium")],
  ["high", N_("High")], ["xhigh", N_("Very high")], ["max", N_("Max")],
];
/** Its `--permission-mode`s. Bypassing permissions is deliberately not offered. */
const MODES: readonly [string, string][] = [
  ["default", N_("Ask")], ["acceptEdits", N_("Accept edits")], ["plan", N_("Plan")], ["auto", N_("Auto")],
];
/** A long path keeps its end: the folder's own name. */
const PATH_CHARS = 44;

function shortPath(path: string): string {
  return path.length > PATH_CHARS ? `…${path.slice(-(PATH_CHARS - 1))}` : path;
}

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Provider chips, then the chosen provider's models — ModelPickerView. */
function buildPicker(onChange: () => void): Picker {
  const chips = h("div", { class: "picker-chips" });
  const list = h("div", { class: "picker-list" });
  const opts = h("div", { class: "picker-opts" });
  const el = h("div", { class: "picker" }, chips, h("div", { class: "picker-rule" }), list, opts);

  /** Models already asked for, by provider; a model server is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings)) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { text: t(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        Sound.play("pop");
        drawChips();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function set(patch: Partial<typeof State.settings>) {
    State.settings = { ...State.settings, ...patch };
    saveSettings();
    Sound.play("blip");
    drawOptions();
  }

  function segments(choices: readonly [string, string][], current: string, pick: (value: string) => void) {
    return h(
      "div",
      { class: "seg" },
      ...choices.map(([value, label]) =>
        h("button", { class: value === current ? "on" : "", text: t(label), onclick: () => pick(value) }),
      ),
    );
  }

  /** Claude Code's folder, effort and permission mode; nothing for any other provider. */
  function drawOptions() {
    clear(opts);
    const s = State.settings;
    opts.style.display = s.chatProvider === "claudecode" ? "" : "none";
    if (s.chatProvider !== "claudecode") return;
    const dir = s.claudeCodeDir;
    const folder = h(
      "div",
      { class: "picker-opt" },
      h("span", { class: "picker-opt-label", text: t(STRINGS.folder) }),
      h("span", { class: "picker-path", title: dir, text: dir ? shortPath(dir) : t(STRINGS.noFolder) }),
      h("button", {
        class: "picker-link",
        text: t(STRINGS.choose),
        onclick: async () => {
          const picked = await Bridge.pickFolder();
          if (picked) set({ claudeCodeDir: picked });
        },
      }),
      dir ? h("button", { class: "picker-link", text: t(STRINGS.clear), onclick: () => set({ claudeCodeDir: "" }) }) : null,
    );
    opts.append(
      folder,
      h(
        "div",
        { class: "picker-opt" },
        h("span", { class: "picker-opt-label", text: t(STRINGS.effort) }),
        segments(EFFORTS, s.claudeCodeEffort, (claudeCodeEffort) => set({ claudeCodeEffort })),
      ),
      h(
        "div",
        // Without a folder nothing can ask for a permission.
        { class: dir ? "picker-opt" : "picker-opt off" },
        h("span", { class: "picker-opt-label", text: t(STRINGS.permissions) }),
        segments(MODES, s.claudeCodeMode, (claudeCodeMode) => set({ claudeCodeMode })),
      ),
      h("div", { class: "picker-hint", text: t(dir ? STRINGS.inFolder : STRINGS.chatOnly) }),
    );
  }

  function status(text: string, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => void Bridge.openSettingsWindow(),
        }),
      );
    }
    list.append(line);
  }

  function drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(list);
    const current = activeModel(State.settings);
    for (const m of models) {
      const on = m.id === current;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: m.id },
        h("span", { class: "picker-model-name", text: m.label }),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        State.settings = withModel(State.settings, p.id, m.id);
        saveSettings();
        Sound.play("blip");
        close();
      });
      list.append(row);
    }
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  async function loadModels() {
    drawOptions();
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const cached = p.urlField ? undefined : cache.get(p.id);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet.
    if (p.key && !(await Bridge.secretPresent(p.key))) {
      if (ticket === request) status(t(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(t(STRINGS.loading));
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket !== request) return;
      if (!p.urlField) cache.set(p.id, models);
      const keep = pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    drawChips();
    onChange();
    void loadModels();
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── Conversations ─────────────────────────────────────────────────────────────

/** A folder's own name: the last part of its path. */
export function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** The list's groups: one per folder, in the order of their newest conversation. */
export function groupByFolder(list: ConversationSummary[]): { dir: string; items: ConversationSummary[] }[] {
  const groups = new Map<string, ConversationSummary[]>();
  for (const c of list) {
    if (!groups.has(c.dir)) groups.set(c.dir, []);
    groups.get(c.dir)!.push(c);
  }
  return [...groups].map(([dir, items]) => ({ dir, items }));
}

/** The time of a conversation's last answer today, its day before that. */
function when(updated: number): string {
  const date = new Date(updated * 1000);
  const now = new Date();
  const today =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (!today) return dayMonth(date.getMonth(), date.getDate());
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface ConversationList {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * The saved conversations, by folder. `pick` opens one; `start` begins a new
 * one in a folder ("" for none).
 */
function buildConversations(
  onChange: () => void,
  pick: (id: string) => void,
  start: (dir: string) => void,
): ConversationList {
  const el = h("div", { class: "convos" });
  let isOpen = false;
  let request = 0;

  function heading(dir: string): HTMLElement {
    return h(
      "div",
      { class: "convo-group", title: dir },
      h("span", { text: dir ? folderName(dir) : t(STRINGS.anyFolder) }),
      h(
        "button",
        { class: "convo-icon", title: tl(dir ? STRINGS.newChatHere : STRINGS.newChat), onclick: () => start(dir) },
        svg(ICONS.plus, 11),
      ),
    );
  }

  function row(c: ConversationSummary): HTMLElement {
    const remove = h(
      "button",
      { class: "convo-icon", title: tl(STRINGS.deleteConversation) },
      svg(ICONS.xmark, 10),
    );
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      await Bridge.conversationDelete(c.id);
      if (State.conversationId === c.id) State.conversationId = null;
      void load();
    });
    const el = h(
      "div",
      { class: c.id === State.conversationId ? "convo-row on" : "convo-row", title: c.title },
      h("i", { class: "model-dot", style: `background:${providerDef(c.provider).accent}` }),
      h("span", { class: "convo-title", text: c.title }),
      h("span", { class: "convo-when", text: when(c.updated) }),
      c.external ? null : remove,
    );
    el.addEventListener("click", () => pick(c.id));
    return el;
  }

  async function load() {
    const ticket = ++request;
    const list = (await Bridge.conversationsList()) ?? [];
    if (ticket !== request) return;
    clear(el);
    const groups = groupByFolder(list);
    // The folder in use is always there to start a chat in, even with nothing saved in it yet.
    const current = State.settings.claudeCodeDir;
    if (!groups.some((g) => g.dir === current)) groups.unshift({ dir: current, items: [] });
    for (const group of groups) {
      el.append(heading(group.dir));
      for (const c of group.items) el.append(row(c));
    }
    if (list.length === 0) el.append(h("div", { class: "picker-status", text: t(STRINGS.noConversations) }));
  }

  return {
    el,
    open() {
      isOpen = true;
      clear(el);
      onChange();
      void load();
    },
    close() {
      isOpen = false;
      request++;
      onChange();
    },
    get isOpen() {
      return isOpen;
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: t(STRINGS.placeholderFirst),
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const modelDot = h("i", { class: "model-dot" });
  const modelName = h("span", { class: "model-name" });
  const modelBtn = h(
    "button",
    { class: "model-btn", title: tl(STRINGS.switchModel) },
    modelDot,
    modelName,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  // The conversation's title, left of the model: opens the list of the saved ones.
  const convoName = h("span", { class: "convo-name" });
  const convoBtn = h(
    "button",
    { class: "convo-btn", title: tl(STRINGS.conversations) },
    svg(ICONS.bubble, 9),
    convoName,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  const modelRow = h("div", { class: "model-row" }, convoBtn, modelBtn);

  const body = h("div", { class: "chat-body" });
  /** The picker or the list is open: the island is taller, and the log gives way. */
  const panelChanged = () => {
    body.classList.toggle("picking", picker.isOpen);
    body.classList.toggle("listing", convos.isOpen);
    drawModelButton();
    const open = picker.isOpen || convos.isOpen;
    if (State.chatPicking !== open) {
      State.chatPicking = open;
      State.notify();
      onHeightChange();
    }
  };
  const picker = buildPicker(panelChanged);
  const convos = buildConversations(panelChanged, (id) => void openConversation(id), startIn);
  body.append(chipRow, log, picker.el, convos.el, modelRow, bar);

  // The card's lower edge: drag it to make the chat taller or shorter, double-
  // click to let it follow the conversation again.
  const grip = h("div", { class: "chat-grip" });
  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, body, grip));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  // Claude Code is answering: the send button stops it.
  let stoppable = false;
  let renderedCount = -1;
  // A local model answers token by token: where its text so far is shown.
  let live: HTMLElement | null = null;

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    modelName.textContent = activeModel(State.settings) || t(STRINGS.noModel);
    modelBtn.classList.toggle("open", picker.isOpen);
    modelBtn.disabled = sending;
    // Only a provider whose conversations are saved has the list.
    convoBtn.style.display = p.conversations || convos.isOpen ? "" : "none";
    convoBtn.classList.toggle("open", convos.isOpen);
    convoBtn.disabled = sending;
    const first = State.conversationId ? State.chatHistory.find((m) => m.role === "user") : undefined;
    convoName.textContent = first ? first.content.replace(/\s+/g, " ").trim() : t(STRINGS.conversations);
    send.classList.toggle("stop", stoppable);
    send.title = t(stoppable ? STRINGS.stop : STRINGS.send);
  }

  function setHeight(chatHeight: number) {
    if (chatHeight === State.settings.chatHeight) return;
    State.settings = { ...State.settings, chatHeight };
    State.notify();
    onHeightChange();
  }

  let drag: { y: number; height: number } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent;
    if (p.button !== 0) return;
    const height = chatPromptHeight(State.chatHistory.length, State.chatPicking, State.settings.chatHeight);
    drag = { y: p.clientY, height };
    State.chatResizing = true;
    grip.setPointerCapture?.(p.pointerId);
    p.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag) return;
    setHeight(clampChatHeight(Math.max(CHAT_MIN_H, drag.height + (e as PointerEvent).clientY - drag.y)));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    State.chatResizing = false;
    saveSettings();
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("dblclick", () => {
    setHeight(0);
    saveSettings();
  });

  // While the field has the keyboard the island does not fold (island.ts).
  // Told a moment later: a blur can come from inside a sync.
  const typing = (on: boolean) => {
    if (State.chatTyping === on) return;
    State.chatTyping = on;
    queueMicrotask(() => State.notify());
  };
  input.addEventListener("focus", () => typing(true));
  input.addEventListener("blur", () => typing(false));

  modelBtn.addEventListener("click", () => {
    if (sending) return;
    if (convos.isOpen) convos.close();
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  convoBtn.addEventListener("click", () => {
    if (sending) return;
    if (picker.isOpen) picker.close();
    if (convos.isOpen) convos.close();
    else convos.open();
  });

  /** The chat shows another conversation (or none): redraw, and back to the field. */
  function showConversation() {
    State.droppedFile = null;
    State.promptContext = null;
    saveSettings();
    renderedCount = -1;
    if (convos.isOpen) convos.close();
    State.notify();
    onHeightChange();
    input.focus();
  }

  async function openConversation(id: string) {
    if (sending) return;
    let saved;
    try {
      saved = await Bridge.conversationOpen(id);
    } catch (err) {
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      State.notify();
      return;
    }
    State.chatHistory = saved.turns.map((turn) => ({
      id: nextId++,
      role: turn.role === "assistant" ? "assistant" : "user",
      content: String(turn.content),
    }));
    State.conversationId = saved.id;
    // The conversation comes back with who answered it, and where it worked.
    const provider = providerDef(saved.provider);
    let settings = { ...State.settings, chatProvider: provider.id };
    if (saved.model) settings = withModel(settings, provider.id, saved.model);
    if (provider.id === "claudecode") settings.claudeCodeDir = saved.dir;
    State.settings = settings;
    Sound.play("blip");
    showConversation();
  }

  /** A new conversation in `dir` ("" for a plain chat). */
  function startIn(dir: string) {
    if (sending) return;
    State.chatHistory = [];
    State.conversationId = null;
    void Bridge.chatReset();
    State.settings = { ...State.settings, claudeCodeDir: dir };
    Sound.play("blip");
    showConversation();
  }

  void onEvent<string>("chat-delta", (text) => {
    if (!sending || !text) return; // nothing visible yet: the dots stay
    if (!live) {
      live = h("div", { class: "reply" });
      log.querySelector(".typing")?.parentElement?.remove();
      log.append(h("div", { class: "chat-row" }, live));
    }
    renderMarkdown(live, text);
    log.scrollTop = log.scrollHeight;
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (picker.isOpen) picker.close();
    if (convos.isOpen) convos.close();
    input.value = "";
    sending = true;
    stoppable = State.settings.chatProvider === "claudecode";
    drawModelButton();
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      if (reply.conversationId) State.conversationId = reply.conversationId;
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      stoppable = false;
      live = null;
      renderedCount = -1; // the finished answer replaces the streamed one
      drawModelButton();
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => {
    if (stoppable) void Bridge.chatStop();
    else void submit();
  });
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (key === "Escape" && (picker.isOpen || convos.isOpen)) {
      e.preventDefault();
      if (picker.isOpen) picker.close();
      if (convos.isOpen) convos.close();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount && !live) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      // Leaving the chat folds the picker and the list away.
      if (State.view !== "prompt" && picker.isOpen) picker.close();
      if (State.view !== "prompt" && convos.isOpen) convos.close();
      // A chat emptied elsewhere (the new-chat shortcut, a dropped file) is a new conversation.
      if (State.chatHistory.length === 0 && !sending) State.conversationId = null;
      drawModelButton();

      input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
