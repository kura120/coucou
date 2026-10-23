// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import {
  BRAVE_SEARCH_KEY, Bridge, onEvent, type HookPreview, type HookStatus, type ShortcutsReport, type VoiceEnginePart, type VoiceStatus,
} from "../core/bridge";
import { CUSTOM_SERVER_KEY, providerDef, urlExposure } from "../core/providers";
import {
  ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective,
  recordPress, type Binding,
} from "../core/shortcuts";
import { DEFAULT_SETTINGS, type Settings, type WebSearchChoice } from "../core/state";
import { SOUND_NAMES } from "../core/sound";
import {
  MAX_DECLARED, PILL_CATEGORIES, availablePills, chooseMainPill, isComingSoon, mainPillChoices, slotsUsed, takesSlot,
  sanitizeDeclared, toggleDeclared, type PillDefinition,
} from "../core/pills";
import { h, clear } from "../views/dom";
import { installContextMenu } from "../views/menu";
import { agentsSection } from "./agents";
import { colorDot } from "./colors";
import { initMotion } from "./motion";
import { mountBand } from "./band";
import { renderDiff, statusDot } from "./parts";
import { SEARCH_ENGINES } from "./search";
import {
  LANGUAGES, N_, isRtl, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t, tn,
} from "../i18n/i18n";

/** Where secrets.rs keeps the keys on this OS. */
const KEY_STORE = navigator.userAgent.includes("Windows")
  ? "Windows Credential Manager"
  : "Secret Service (GNOME Keyring, KWallet)";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

/** A colour was picked for a pill's Peika (see ./colors.ts): the island follows. */
function pickColor(next: Record<string, string>) {
  settings.pillColors = next;
  void save();
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

// ── Changes to Claude Code's settings.json ────────────────────────────────────

/** One kind of change to ~/.claude/settings.json, with the words that go with it. */
interface Change {
  preview: (install: boolean) => Promise<HookPreview | null>;
  apply: (install: boolean, fingerprint: string) => Promise<string | null>;
  installText: string;
  removeText: string;
  installButton: string;
  removeButton: string;
  /** The note once written; `backup` is "" when there was no file to back up. */
  done: (backup: string) => string;
}

const HOOKS_CHANGE: Change = {
  preview: Bridge.hooksPreview,
  apply: Bridge.hooksApply,
  get installText() { return t("This is exactly what will change in your settings.json. Your own hooks are left untouched."); },
  get removeText() { return t("This removes Peika's entries only. Your own hooks are left untouched."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.", { backup })
    : t("Done. Open a new Claude Code session to pick the hooks up."),
};

const STATUS_LINE_CHANGE: Change = {
  preview: Bridge.statusLinePreview,
  apply: Bridge.statusLineApply,
  get installText() { return t("This is exactly what will change: only the status line. If you already have one it keeps working, Peika's relay runs it for you."); },
  get removeText() { return t("This puts your previous status line back, or removes the entry if there was none."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. The numbers appear after the next reply of a Claude Code session.", { backup })
    : t("Done. The numbers appear after the next reply of a Claude Code session."),
};

/**
 * Shows the diff of a change in `body` and writes it only after an explicit
 * click, and only if settings.json still matches the diff that was shown.
 * `back` redraws the section; `applied` runs a moment after a successful write.
 */
async function reviewChange(
  body: HTMLElement,
  change: Change,
  install: boolean,
  back: () => void,
  applied: () => void,
) {
  let preview;
  try {
    preview = await change.preview(install);
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(body);
    body.append(
      h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
      h("div", { class: "row" }, h("button", { text: t("Back"), onclick: back })),
    );
    return;
  }
  if (!preview) return;
  clear(body);
  body.append(
    h("div", { class: "hint", text: install ? change.installText : change.removeText }),
    renderDiff(preview.diff),
    h("div", { class: "row" },
      h("span", {
        class: "path",
        text: preview.backup
          ? t("Backup → {path}", { path: preview.backup })
          : t("No settings.json yet — nothing to back up."),
      }),
    ),
  );
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? change.installButton : change.removeButton,
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await change.apply(install, preview.fingerprint);
      clear(body);
      body.append(h("div", { class: "notice ok", text: change.done(backup ?? "") }));
      window.setTimeout(applied, 2600);
    } catch (err) {
      confirm.disabled = false;
      body.append(h("div", { class: "notice err", text: t("Could not write: {error}", { error: String(err) }) }));
    }
  });
  body.append(h("div", { class: "row" }, confirm, h("button", { text: t("Cancel"), onclick: back })));
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    redraw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? t("Peika is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.")
          : t("Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing."),
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: t("peika-hook.exe is not in place yet. Restart Peika; if it still fails, build it with `cargo build -p peika-hook`."),
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("Reinstall hooks…") : t("Install hooks…"),
      onclick: () => void reviewChange(body, HOOKS_CHANGE, true, redraw, () => void rebuild()),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("The relay isn't installed yet.");
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: t("Uninstall hooks…"),
        onclick: () => void reviewChange(body, HOOKS_CHANGE, false, redraw, () => void rebuild()),
      }));
    }
    body.append(actions);
  }

  draw();
  return section;
}

// ── Plan usage section ────────────────────────────────────────────────────────

/**
 * The 5-hour and weekly limits in the island's header. They come from Claude
 * Code's status line, so the relay has to be the status line first: turning the
 * switch on without it starts the install, and the switch only stays on once
 * that has been confirmed. A status line the user had keeps working.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan usage (5-hour and weekly limits) in the island's header. Peika adds a status line relay in ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only."); },
  get claudeCli() { return t("The numbers come from the Claude Code command-line tool. The Claude desktop app does not report them, so the gauge stays empty if you only use the desktop app."); },
  get showClaude() { return t("Show in notch"); },
  get codex() { return t("Shows your Codex plan usage (weekly limit and free resets left) in the island's header. Peika asks the Codex CLI (codex app-server) when the pill shows; nothing is installed. Codex must be signed in with ChatGPT."); },
  get showCodex() { return t("Show Codex plan in the notch"); },
};

function planSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h("section", {}, h("h2", {}, h("span", { text: t("Plan usage") })), body);

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    settings.planRelayInstalled = status.planRelayInstalled;
    // Cancelled or failed: a switch that was waiting for the install falls back.
    if (!status.planRelayInstalled) settings.showPlanInNotch = false;
    redraw();
  };

  function draw() {
    // The switch shows "on" while the install it asked for is being reviewed.
    const sw = toggle(settings.showPlanInNotch, (on) => {
      if (!on) {
        settings.showPlanInNotch = false;
        void save();
      } else if (status.planRelayInstalled) {
        settings.showPlanInNotch = true;
        void save();
      } else {
        // Turned on before the relay is in: install it first; it stays on once confirmed.
        void reviewChange(body, STATUS_LINE_CHANGE, true, () => void rebuild(), () => {
          settings.planRelayInstalled = true;
          settings.showPlanInNotch = true;
          void save().then(rebuild);
        });
      }
    });
    body.append(
      h("div", {
        class: "hint",
        text: PLAN_SETTINGS_TEXT.claude,
      }),
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.claudeCli }),
      h("div", { class: "row" }, h("label", { text: PLAN_SETTINGS_TEXT.showClaude }), sw),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        statusDot(status.planRelayInstalled),
        h("span", { class: "hint", text: status.planRelayInstalled ? t("installed") : t("not installed") }),
        status.planRelayInstalled
          ? h("button", {
              class: "danger",
              text: t("Uninstall relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, false, redraw, () => void rebuild()),
            })
          : h("button", {
              class: "primary",
              text: t("Install relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, true, redraw, () => void rebuild()),
            }),
      ),
      // Codex: nothing to install, Peika asks the Codex CLI when the pill shows.
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.codex }),
      h("div", { class: "row" },
        h("label", { text: PLAN_SETTINGS_TEXT.showCodex }),
        toggle(settings.showCodexPlanInNotch, (on) => {
          settings.showCodexPlanInNotch = on;
          void save();
        }),
      ),
    );
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? t("Key saved in the {store}.", { store: KEY_STORE }) : t("No key yet — the chat needs one.") });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: t("Save key") });
  const clearBtn = h("button", { class: "danger", text: t("Remove") });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? t("Key saved in the {store}.", { store: KEY_STORE })
      : t("No key yet — the chat needs one.");
    field.placeholder = present ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: t("Saved. It never touches disk.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not save: {error}", { error: String(err) }) }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: t("Key removed.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not remove: {error}", { error: String(err) }) }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: t("API key") }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: t("Model") }), model),
    feedback,
  );
}

// ── Active pills section ──────────────────────────────────────────────────────

/**
 * The tools you use (Mac 0.1.1–0.1.2): pick the main workspace tool, which is
 * always on and takes no slot, and declare the agents and chat providers you
 * want as pills. Services are declared in Integrations below, next to their keys.
 */
function activePillsSection(connected: Record<string, boolean>): HTMLElement {
  const slots = h("div", { class: "hint" });
  const main = h("select", {}) as HTMLSelectElement;
  for (const def of mainPillChoices()) main.append(h("option", { value: def.id, text: def.name }));
  main.addEventListener("change", () => {
    const next = chooseMainPill(settings, main.value);
    if (!next) return;
    settings.mainPill = next.mainPill;
    settings.activeIntegrations = next.activeIntegrations;
    declaredChanged();
  });
  const groups = h("div", { style: "display:flex;flex-direction:column;gap:12px" });

  /** Why a pill would show nothing yet, as on the Mac's row. */
  function hint(def: PillDefinition): string | null {
    if (isComingSoon(def.id)) return t("Coming soon");
    if (def.connect.kind === "hooks" && !connected[def.id]) return t("Hooks not installed");
    if (def.connect.kind === "key" && !connected[def.id]) return t("Key not configured");
    if (def.connect.kind === "server" && !settings[def.connect.field]) return t("Not connected");
    return null;
  }

  function row(def: PillDefinition): HTMLElement {
    const isMain = def.id === settings.mainPill;
    const on = settings.activeIntegrations.includes(def.id);
    const full = !isMain && !on && takesSlot(def.id) && slotsUsed(settings.activeIntegrations) >= MAX_ACTIVE;
    const el = h("div", { class: full ? "pill-row full" : "pill-row" },
      colorDot(def, "width:10px;height:10px", () => settings.pillColors, pickColor),
      h("span", { class: "name", text: def.name }),
    );
    if (isMain) {
      el.append(h("span", { class: "state", text: t("Main") }));
      return el;
    }
    const why = hint(def);
    el.append(h("span", { class: "state", text: why ?? "" }));
    const sw = h("button", { class: on ? "switch on" : "switch" }) as HTMLButtonElement;
    sw.disabled = full;
    sw.addEventListener("click", () => {
      const next = toggleDeclared(settings, def.id);
      if (!next) return;
      settings.activeIntegrations = next;
      declaredChanged();
    });
    el.append(sw);
    return el;
  }

  function draw() {
    const used = slotsUsed(settings.activeIntegrations);
    slots.textContent = t("{used}/{max} slots in use — the main tool doesn't take one.", { used, max: MAX_ACTIVE });
    slots.classList.toggle("full", used >= MAX_ACTIVE);
    main.value = settings.mainPill;
    clear(groups);
    for (const cat of PILL_CATEGORIES) {
      if (cat.id === "service") continue;
      const pills = availablePills().filter((p) => p.category === cat.id);
      if (pills.length === 0) continue;
      groups.append(h("div", { class: "pill-group" }, h("h3", { text: t(cat.title) }), ...pills.map(row)));
    }
  }
  declaredViews.push(draw);
  draw();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Active pills") })),
    h("div", { class: "hint", text: t("Choose the tools you use. Peika only shows what you declare here.") }),
    slots,
    h("div", { class: "row" }, h("label", { text: t("Main tool") }), main),
    groups,
  );
}

// ── Chat providers section ────────────────────────────────────────────────────

const CHAT_STRINGS = {
  get providersTitle() { return t("Chat providers"); },
  get providersHint() { return t("Chat with Google AI, OpenAI, OpenRouter or NVIDIA NIM instead of Claude: add a key here, then click the model name above the chat box to switch provider and model. Keys stay in the system keychain. These providers get no web search and no tools: they can answer, never act on this computer."); },
  get stored() { return `••••••••  ${t("(stored)")}`; },
  get save() { return t("Save"); },
  get remove() { return t("Remove"); },
  get localTitle() { return t("Local models"); },
  get localHint() { return t("Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp. Once connected, pick it above the chat box."); },
  get connect() { return t("Connect"); },
  get connecting() { return t("Connecting…"); },
  get disconnect() { return t("Disconnect"); },
  get useInChat() { return t("Use in chat"); },
  get inUse() { return t("In use"); },
  get keyOptional() { return t("API key (optional)"); },
  get localOnly() { return t("Nothing leaves your PC: the server runs on this computer."); },
  get remote() { return t("This address is another machine: what you ask is sent to it."); },
  get remoteHttp() { return t("This address is another machine, over plain http: what you ask travels unencrypted."); },
  get keyOverHttp() { return t("Warning: the key would be sent unencrypted (http://) to another machine. Use https://, or a server on this computer."); },
  get invalid() { return t("Not a valid http:// or https:// address."); },
  noModels: (name: string) => t("No models yet. Download one in {name} first.", { name }),
  models: (n: number) => tn("{count} model", "{count} models", n),
};

interface CloudDef {
  id: "google" | "openai" | "openrouter" | "nvidia";
  name: string;
  placeholder: string;
  where: string;
}

const CLOUD: CloudDef[] = [
  { id: "google", name: "Google AI", placeholder: "AIza…", where: "aistudio.google.com" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…", where: "platform.openai.com" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-…", where: "openrouter.ai/keys" },
  { id: "nvidia", name: "NVIDIA NIM", placeholder: "nvapi-…", where: "build.nvidia.com" },
];

function chatProvidersSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  for (const def of CLOUD) {
    const p = providerDef(def.id);
    const key = p.key!;
    const input = h("input", {
      type: "password",
      placeholder: present[key] ? CHAT_STRINGS.stored : def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    const saveBtn = h("button", { text: CHAT_STRINGS.save });
    const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
    const refresh = () => {
      input.placeholder = present[key] ? CHAT_STRINGS.stored : def.placeholder;
      dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
      removeBtn.style.display = present[key] ? "" : "none";
    };
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        await Bridge.secretSet(key, value);
        present[key] = true;
        input.value = "";
        keyChanged(key, true);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    removeBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
        present[key] = false;
        keyChanged(key, false);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    refresh();
    list.append(
      h("div", { class: "row" },
        h("label", {},
          h("i", { class: "dot spaced", style: `background:${p.accent}` }),
          h("span", { text: def.name }),
        ),
        input, saveBtn, removeBtn, dotEl,
      ),
      h("div", { class: "hint key-hint", text: t("Key from {site}", { site: def.where }) }),
    );
  }
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.providersTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.providersHint }),
    list,
  );
}

// ── Local models section ──────────────────────────────────────────────────────

type LocalId = "ollama" | "lmstudio" | "custom";

/** Redraws the local models section after a change made elsewhere (the island). */
let localRedraw: (() => void) | null = null;

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
  // No usual address: any server that speaks the OpenAI API.
  custom: { name: N_("OpenAI-compatible"), usual: "" },
};

/** What an address means for the user's data, as a hint line. */
function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return h("div", { class: "hint", text: CHAT_STRINGS.localOnly });
    case "remote":
      return h("div", { class: "hint", text: CHAT_STRINGS.remote });
    case "remote-http":
      return withKey
        ? h("div", { class: "notice warn", text: CHAT_STRINGS.keyOverHttp })
        : h("div", { class: "hint", text: CHAT_STRINGS.remoteHttp });
    case "invalid":
      return url.trim() ? h("div", { class: "notice err", text: CHAT_STRINGS.invalid }) : null;
  }
}

function localSection(customKey: boolean): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.localTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.localHint }),
    body,
  );
  const redraw = () => {
    clear(body);
    for (const id of Object.keys(LOCAL) as LocalId[]) body.append(serverBlock(id));
  };

  function serverBlock(id: LocalId): HTMLElement {
    const def = LOCAL[id];
    const p = providerDef(id);
    const field = p.urlField!;
    const connected = settings[field] !== "";
    const status = h("div", {});
    const exposure = h("div", {});
    const label = h("label", {},
      h("i", { class: "dot spaced", style: `background:${p.accent}` }),
      h("span", { text: t(def.name) }),
    );
    const block = h("div", { style: "display:flex;flex-direction:column;gap:6px" });

    if (connected) {
      const inUse = settings.chatProvider === id;
      const use = h("button", { class: inUse ? "" : "primary", text: inUse ? CHAT_STRINGS.inUse : CHAT_STRINGS.useInChat });
      use.disabled = inUse;
      use.addEventListener("click", () => {
        settings.chatProvider = id;
        void save().then(redraw);
      });
      const disconnect = h("button", { class: "danger", text: CHAT_STRINGS.disconnect });
      disconnect.addEventListener("click", async () => {
        settings[field] = "";
        voiceServersRedraw?.();
        if (settings.chatProvider === id) settings.chatProvider = "anthropic";
        if (id === "custom") {
          await Bridge.secretClear(CUSTOM_SERVER_KEY).catch(() => {});
          customKey = false;
        }
        await save();
        redraw();
      });
      block.append(
        h("div", { class: "row" }, label, h("span", { class: "path", text: settings[field] }), statusDot(true), use, disconnect),
        status,
      );
      exposure.append(exposureNotice(settings[field], id === "custom" && customKey) ?? "");
      block.append(exposure);
      return block;
    }

    const input = h("input", {
      type: "text",
      placeholder: def.usual || "https://llm.example.com",
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    // A custom server may want a key; it goes to the keychain, never to settings.json.
    const key = h("input", {
      type: "password",
      placeholder: customKey ? CHAT_STRINGS.stored : CHAT_STRINGS.keyOptional,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect });

    const showExposure = () => {
      clear(exposure);
      const withKey = id === "custom" && (customKey || key.value.trim() !== "");
      const notice = exposureNotice(input.value || def.usual, withKey);
      if (notice) exposure.append(notice);
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);

    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      status.append(h("div", { class: "hint", text: CHAT_STRINGS.connecting }));
      try {
        if (id === "custom" && key.value.trim()) {
          // Stored with this address: the key is only ever sent there.
          await Bridge.localSetKey(input.value || def.usual, key.value.trim());
          key.value = "";
          customKey = true;
        }
        const server = await Bridge.localConnect(id, input.value);
        if (!server.models.length) {
          clear(status);
          status.append(h("div", { class: "notice err", text: CHAT_STRINGS.noModels(t(def.name)) }));
        } else {
          settings[field] = server.url;
          voiceServersRedraw?.();
          if (!server.models.includes(settings.chatModels[id] ?? "")) {
            settings.chatModels = { ...settings.chatModels, [id]: server.models[0] };
          }
          await save();
          redraw();
          return;
        }
      } catch (err) {
        clear(status);
        status.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      }
      connect.disabled = false;
    });

    block.append(h("div", { class: "row" }, label, input, connect));
    if (id === "custom") block.append(h("div", { class: "row" }, h("label", { text: "" }), key));
    block.append(status, exposure);
    showExposure();
    return block;
  }

  redraw();
  localRedraw = redraw;
  return section;
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** What the key needs, shown under its field. */
  hint?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: N_("Secret key"), placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: N_("Token"), placeholder: "ghp_…", secret: true }],
    hint: N_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.") },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: N_("Token"), placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: N_("Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: N_("API key"), placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: N_("API key"), placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: N_("Integration token"), placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: N_("API key"), placeholder: "cal_…", secret: true }] },
  // Not a key: the exchange, the currency and the coins are plain settings (cryptoRows).
  { id: "integration_crypto", name: "Crypto", color: "#F7931A", fields: [],
    hint: N_("Public prices from the exchange you pick. No account or key.") },
  // Nothing to enter: Spotify is read from the system (see core/pills.ts).
  { id: "integration_spotify", name: "Spotify", color: "#1DB954", fields: [] },
];

/** The Crypto pill's settings: the exchange, the currency and the coins, saved as settings (no key). */
function cryptoRows(): HTMLElement[] {
  const exchange = h("select", {}) as HTMLSelectElement;
  exchange.append(h("option", { value: "coinbase", text: "Coinbase" }), h("option", { value: "okx", text: "OKX" }));
  exchange.value = settings.cryptoExchange;
  exchange.addEventListener("change", () => {
    settings.cryptoExchange = exchange.value as Settings["cryptoExchange"];
    void save();
  });

  const currency = h("select", {}) as HTMLSelectElement;
  currency.append(h("option", { value: "USD", text: "USD" }), h("option", { value: "EUR", text: "EUR" }));
  currency.value = settings.cryptoCurrency;
  currency.addEventListener("change", () => {
    settings.cryptoCurrency = currency.value as Settings["cryptoCurrency"];
    void save();
  });

  const coins = h("input", {
    type: "text",
    placeholder: "BTC, ETH, SOL",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  coins.value = settings.cryptoCoins;
  coins.addEventListener("change", () => {
    settings.cryptoCoins = coins.value.trim();
    void save();
  });

  return [
    h("div", { class: "row" }, h("label", { style: "min-width:104px", text: t("Exchange") }), exchange),
    h("div", { class: "row" }, h("label", { style: "min-width:104px", text: t("Currency") }), currency),
    h("div", { class: "row" }, h("label", { style: "min-width:104px", text: t("Coins") }), coins),
  ];
}

const MAX_ACTIVE = MAX_DECLARED;

/** Everything that shows the declared pills, redrawn when any of them changes. */
const declaredViews: (() => void)[] = [];

function declaredChanged() {
  for (const redraw of declaredViews) redraw();
  void save();
}

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = slotsUsed(settings.activeIntegrations);
    note.textContent = t("Pick up to {max} pills to show next to Peika — {used}/{max} in use. Keys are stored in the {store}, never on disk.", { max: MAX_ACTIVE, used, store: KEY_STORE });
  }
  declaredViews.push(updateNote);

  const offered = new Set(availablePills().map((p) => p.id));
  for (const def of INTEGRATIONS.filter((d) => offered.has(d.id))) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        // Spotify is a card of its own, not a pill: it takes no slot.
        if (takesSlot(def.id) && slotsUsed(settings.activeIntegrations) >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      declaredChanged();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? CHAT_STRINGS.stored : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("Save") });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? CHAT_STRINGS.stored : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: t(field.label) }),
          input, saveBtn, dotEl,
        ),
      );
    }

    if (def.id === "integration_crypto") rows.append(...cryptoRows());
    if (def.hint) rows.append(h("div", { class: "hint", text: t(def.hint) }));
    if (def.id === "integration_spotify") {
      // As on the Mac's row: said only when there is no Spotify to launch.
      const hint = h("div", { class: "hint", style: "padding-top:5px" });
      rows.append(hint);
      void Bridge.spotifyInstalled().then((ok) => {
        hint.textContent = ok === false ? t("Not installed") : "";
      });
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          colorDot(def, "", () => settings.pillColors, pickColor),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: t("Integrations") })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  // Your own sounds: the folder, a reload, and how many are replaced.
  const customCount = h("span", { class: "hint" });
  const countCustom = () =>
    void Bridge.customSounds(SOUND_NAMES).then((own) => {
      const n = own?.length ?? 0;
      customCount.textContent = n > 0 ? t("{0} custom", { 0: n }) : "";
    });
  countCustom();
  const soundsFolder = h("button", { text: t("Open sounds folder"), onclick: () => void Bridge.revealSoundsFolder() });
  const reloadSounds = h("button", {
    text: t("Reload sounds"),
    onclick: () => void Bridge.reloadSounds().then(() => window.setTimeout(countCustom, 300)),
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("Main display") }),
    h("option", { value: "cursor", text: t("Display under the cursor") }),
  );
  screen.value = settings.screen;
  void Bridge.listMonitors().then((list) => {
    for (const m of list ?? []) screen.append(h("option", { value: m.key, text: m.label }));
    // Set again now the option exists. A display saved under an older key (moved,
    // resized, or saved before names were kept) is shown by its place or its
    // name; one that is gone shows as the main one.
    const saved = settings.screen;
    const [place, name] = saved.split("|");
    const keys = (list ?? []).map((m) => m.key);
    screen.value =
      keys.find((k) => k === saved) ??
      (saved.startsWith("at:") ? keys.find((k) => k.split("|")[0] === place) : undefined) ??
      (name ? keys.find((k) => k.split("|")[1] === name) : undefined) ??
      saved;
    if (!screen.value) screen.value = "primary";
  });
  screen.addEventListener("change", () => {
    settings.screen = screen.value;
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("General") })),
    h("div", { class: "row" },
      h("label", { text: t("Sound") }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" }, soundsFolder, reloadSounds, customCount),
    h("div", { class: "hint", text: t("Drop a file named like one of Peika's sounds (finish.wav, approval.mp3, greet.m4a…) in the sounds folder to replace it, then Reload.") }),
    h("div", { class: "row" },
      h("label", { text: t("Open on hover") }),
      toggle(settings.openOnHover, (v) => { settings.openOnHover = v; void save(); }),
    ),
    h("div", { class: "hint", text: t("Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.") }),
    h("div", { class: "row" },
      h("label", { text: t("Quiet over fullscreen apps") }),
      toggle(settings.quietWhenBusy, (v) => { settings.quietWhenBusy = v; void save(); }),
    ),
    h("div", { class: "hint", text: t("While a game, a video or a presentation is fullscreen, a finished or failed session only badges its pill, without a sound. Permission requests and questions still come up.") }),
    h("div", { class: "row" },
      h("label", { text: t("Auto-close") }),
      autoClose,
      h("span", { class: "hint", text: t("seconds after you leave the island") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Island lives on") }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Launch at startup") }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    ...recapRows(),
    languageRow(),
  );
}

/**
 * Settings → General → Language, as on the Mac: "System" follows the
 * system's language when Peika has it (else English), or one of the ten.
 * Both windows and the tray switch in place, without a restart.
 */
function languageRow(): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(h("option", { value: "", text: t("System") }));
  for (const { code, name } of LANGUAGES) select.append(h("option", { value: code, text: name, lang: code }));
  select.value = LANGUAGES.some((l) => l.code === settings.language) ? settings.language : "";
  select.addEventListener("change", () => {
    settings.language = select.value;
    void save();
    applyLanguage();
  });
  return h("div", { class: "row" }, h("label", { text: t("Language") }), select);
}

// ── Shortcuts section ─────────────────────────────────────────────────────────

const SHORTCUTS_UI = {
  get title() { return t("Shortcuts"); },
  get hint() { return t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it."); },
  get global() { return t("From anywhere"); },
  get island() { return t("In the open island"); },
  get recording() { return t("Press keys…"); },
  get none() { return t("None"); },
  get reset() { return t("Reset to defaults"); },
  get inUse() { return t("In use by another app"); },
  get duplicate() { return t("Used twice"); },
  get invalid() { return t("Not a valid shortcut"); },
  get unavailable() { return t("Not available"); },
  types: (ch: string) => t("Types “{char}”", { char: ch }),
  typesNote: (keys: string, ch: string) =>
    t("{keys} types “{char}” on your keyboard, so it can't be a shortcut. Pick another key.", { keys, char: ch }),
  get needsModifier() { return t("Hold Ctrl, Alt or the Windows key with it."); },
  get unsupportedKey() { return t("That key can't be used in a shortcut."); },
  get wayland() {
    return t("Your Wayland desktop doesn't let apps listen for keys outside their own windows. Add the shortcuts in your system's keyboard settings instead, with these commands:");
  },
  get noDisplay() { return t("No display server was found, so global shortcuts are off."); },
  get portalPending() {
    return t("Asking your desktop to register the shortcuts. It may show its own window to confirm them.");
  },
  get portalActive() {
    return t("These shortcuts are registered with your desktop. It may ask you to confirm them or to pick other keys; when it says which keys it uses, they show next to each shortcut.");
  },
  get portalFallback() {
    return t("If one doesn't work, you can also add it in your system's keyboard settings with these commands:");
  },
  desktopKeys: (keys: string) => t("Desktop: {keys}", { keys }),
  get refused() { return t("Not set by your desktop"); },
};

/** Settings → Voice: off by default; off means the microphone is closed. */
function voiceSection(): HTMLElement {
  const status = h("span", { class: "hint" });
  const problem = h("div", { class: "hint" });
  const show = (s: VoiceStatus | null) => {
    status.textContent =
      s === "listening" ? t("Listening…")
      : s === "paused" ? t("Paused")
      : s === "shortcut" ? t("Waiting for the shortcut")
      : s === "error" ? t("Microphone unavailable")
      : "";
    problem.textContent =
      s === "noRecogniser" ? t("No English speech recognition is installed. Add it in Windows Settings → Time & language → Speech.")
      : s === "microphone" ? t("No microphone, or Windows refuses it. Check Windows Settings → Privacy & security → Microphone.")
      : s === "unsupported" ? t("Voice is not on Linux yet.")
      : "";
    problem.style.display = problem.textContent ? "" : "none";
  };
  show(null);
  void Bridge.voiceStatus().then(show);
  voiceListener = show;

  // What voice needs to understand a command: a line, and a notice while the
  // model server, its model, its embedding model or the speech engine is missing.
  const needs = h("div", { class: "hint" });
  /** Whether the hearing part is on this machine, once Rust has said. */
  let engineHere = false;
  const drawNeeds = () => {
    const missing: string[] = [];
    if (!server.value || !settings.voice.brainModel) {
      missing.push(t("No model server and model are chosen yet: see “{row}” below.", { row: t("Understand free speech with") }));
    }
    if (server.value && settings.voice.brainModel && !settings.voice.embedModel) {
      missing.push(t("No embedding model is chosen yet: see “{row}” below.", { row: t("Embedding model") }));
    }
    if (!engineHere || settings.voice.engine !== "bundled") {
      missing.push(t("The speech engine is not downloaded or not turned on yet: see “{row}” below.", { row: t("Hear free speech") }));
    }
    needs.className = missing.length ? "notice warn" : "hint";
    needs.textContent = [
      t("To understand a command, voice needs a model server with a model and an embedding model, and the downloaded speech engine."),
      ...missing,
    ].join(" ");
  };
  const change = (patch: Partial<Settings["voice"]>) => {
    settings.voice = { ...settings.voice, ...patch };
    drawNeeds();
    return save();
  };

  // The model that is asked what a sentence means: one of the servers
  // connected in Local models, and one of its models.
  const server = h("select", {}) as HTMLSelectElement;
  const model = h("select", {}) as HTMLSelectElement;
  /** The servers connected right now; redrawn when one is connected or let go. */
  const fillServers = () => {
    const connected = (Object.keys(LOCAL) as LocalId[]).filter((id) => settings[providerDef(id).urlField!]);
    const shown = [...server.options].map((o) => o.value).join("|");
    if (shown === ["", ...connected].join("|")) return;
    clear(server);
    server.append(h("option", { value: "", text: t("None") }));
    for (const id of connected) server.append(h("option", { value: id, text: t(LOCAL[id].name) }));
    server.value = connected.includes(settings.voice.brain as LocalId) ? settings.voice.brain : "";
    void fillModels();
    void fillEmbed();
  };
  const fillModels = async () => {
    clear(model);
    model.style.display = server.value ? "" : "none";
    if (!server.value) return;
    const wanted = settings.voice.brainModel;
    let ids: string[] = [];
    try {
      ids = (await Bridge.chatModels(server.value)).map((m) => m.id);
    } catch {
      // The server is not running: the model already chosen stays in the list.
    }
    if (wanted && !ids.includes(wanted)) ids.unshift(wanted);
    for (const id of ids) model.append(h("option", { value: id, text: id }));
    model.value = ids.includes(wanted) ? wanted : (ids[0] ?? "");
    if (model.value !== wanted) change({ brainModel: model.value });
    drawNeeds();
  };

  // The embedding model capabilities are ranked with: one the same server
  // has. Peika installs none; without one, voice is slower to choose.
  const embed = h("select", {}) as HTMLSelectElement;
  const embedRow = h("div", { class: "row" }, h("label", { text: t("Embedding model") }), embed);
  const embedAbout = h("div", { class: "hint", text: t("Finds which of Peika's commands a sentence is closest to, before any model is asked. It runs on the server chosen above.") });
  const embedNone = h("div", { class: "hint", text: t("This server has no embedding model. You install one on your server yourself: Peika downloads nothing here.") });
  const embedWithout = h("div", { class: "hint", text: t("Voice needs an embedding model: it is what finds which of Peika's commands a sentence is about. mxbai-embed-large chose best in our measurements.") });
  const fillEmbed = async () => {
    const chosen = server.value !== "";
    for (const el of [embedRow, embedAbout, embedNone, embedWithout]) el.style.display = "none";
    if (!chosen) return;
    // Rust answers for the server the settings name: asked once they are saved.
    const ids = (await Bridge.voiceEmbedModels()) ?? [];
    const wanted = settings.voice.embedModel;
    // The server is not running: the model already chosen stays in the list.
    if (wanted && !ids.includes(wanted)) ids.unshift(wanted);
    clear(embed);
    embed.append(h("option", { value: "", text: t("None") }));
    for (const id of ids) embed.append(h("option", { value: id, text: id }));
    embed.value = wanted;
    embedAbout.style.display = "";
    embedRow.style.display = ids.length ? "" : "none";
    embedNone.style.display = ids.length ? "none" : "";
    embedWithout.style.display = embed.value ? "none" : "";
  };
  // Nothing to show until a server is chosen.
  void fillEmbed();
  embed.addEventListener("change", () => {
    embedWithout.style.display = embed.value ? "none" : "";
    change({ embedModel: embed.value });
  });

  server.addEventListener("change", () => {
    // Another server has other models: neither choice is carried over.
    void change({ brain: server.value, brainModel: "", embedModel: "" }).then(fillEmbed);
    void fillModels();
  });
  model.addEventListener("change", () => change({ brainModel: model.value }));
  fillServers();
  // Every save comes back here: which server and model are chosen decides
  // whether the model server may be the speech model.
  voiceServersRedraw = () => {
    fillServers();
    void fillHearing();
    cloudHint.textContent = cloudText();
  };

  // The bundled engine's two parts, each downloaded when asked for: a row with
  // its switch once it is here, a Download button until then.
  const enginePart = (part: VoiceEnginePart, label: string, isOn: () => boolean, turn: (on: boolean) => void, extra?: HTMLElement) => {
    const row = h("div", { class: "row" });
    const draw = (installed: boolean, available: boolean, megabytes: number, note = "", downloading = false) => {
      clear(row);
      row.append(h("label", { text: label }));
      if (installed) {
        row.append(toggle(isOn(), turn));
        if (extra) row.append(extra);
        row.append(h("button", {
          text: t("Remove"),
          onclick: () => {
            turn(false);
            void Bridge.voiceEngineRemove(part).then(() => refresh());
          },
        }));
      } else if (available) {
        const download = h("button", {
          text: t("Download ({0} MB)", { 0: megabytes }),
          onclick: () => {
            download.setAttribute("disabled", "");
            void Bridge.voiceEngineInstall(part);
          },
        });
        // Already on its way — asked for before this window was opened, or
        // before the row was drawn again: a second download is not offered.
        if (downloading) download.setAttribute("disabled", "");
        row.append(download);
      }
      if (note) row.append(h("span", { class: "hint", text: note }));
    };
    const refresh = (note = "") =>
      void Bridge.voiceEngineStatus(part).then((s) => {
        if (s) draw(s.installed, s.available, Math.round(s.downloadBytes / 1_000_000), note, s.downloading);
        if (part === "hearing") {
          engineHere = s?.installed ?? false;
          drawNeeds();
        }
      });
    draw(false, false, 0);
    refresh();
    voiceEngineRedraw[part] = () => refresh();
    voiceEngineListeners[part] = (p) => {
      if (p.installed) {
        // Downloaded to be used: it is turned on at once.
        turn(true);
        refresh();
      } else if (p.error) {
        refresh(t("The download failed. Try again."));
      } else {
        const note = row.querySelector(".hint") ?? row.appendChild(h("span", { class: "hint" }));
        note.textContent = t("Downloading… {0} %", { 0: Math.round(p.done * 100) });
      }
    };
    return row;
  };

  const free = enginePart(
    "hearing", t("Hear free speech"),
    () => settings.voice.engine === "bundled",
    (on) => change({ engine: on ? "bundled" : "system" }),
  );

  // Which model hears: the row above then shows that one's switch, or its
  // Download button when it is not on this machine yet.
  // The last choice is not a download: the model chosen below hears, when its
  // server is on this computer. Rust says whether it may (voice/hear.rs), and
  // for any other server the choice is not there.
  const hearing = h("select", {}) as HTMLSelectElement;
  const hearingHint = h("div", { class: "hint", text: t("The sound of each sentence is sent to this model's server, on this computer, and nowhere else. It must be a model that takes audio, such as Gemma 4. When it does not answer in time, a downloaded model hears instead.") });
  const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);
  const fillHearing = async () => {
    const models = (await Bridge.voiceHearingModels()) ?? [];
    const serverName = LOCAL[settings.voice.brain as LocalId]?.name;
    const label = (m: (typeof models)[number]) =>
      m.server ? `${m.name} · ${serverName ? t(serverName) : ""}` : `${m.name} · ${megabytes(m.downloadBytes)} MB`;
    const wanted = models.map((m) => `${m.id}|${label(m)}`).join("\n");
    if (hearing.dataset.shown !== wanted) {
      hearing.dataset.shown = wanted;
      clear(hearing);
      for (const m of models) hearing.append(h("option", { value: m.id, text: label(m) }));
      // The row above answers for the model server too.
      voiceEngineRedraw.hearing?.();
    }
    hearing.value = settings.voice.hearingModel;
    // A model this build does not know is the first one, as Rust takes it.
    if (hearing.selectedIndex < 0) hearing.selectedIndex = 0;
    hearingHint.style.display = hearing.value === SERVER_HEARS ? "" : "none";
  };
  hearingHint.style.display = "none";
  void fillHearing();
  hearing.addEventListener("change", () => {
    hearingHint.style.display = hearing.value === SERVER_HEARS ? "" : "none";
    // Saved first: Rust answers for the model the settings name.
    void Promise.resolve(change({ hearingModel: hearing.value })).then(() => voiceEngineRedraw.hearing?.());
  });

  const speaker = h("select", {}) as HTMLSelectElement;
  speaker.append(h("option", { value: "female", text: t("Female voice") }), h("option", { value: "male", text: t("Male voice") }));
  speaker.value = settings.voice.speaker === "male" ? "male" : "female";
  speaker.addEventListener("change", () => change({ speaker: speaker.value }));
  const spoken = enginePart(
    "speaking", t("Peika answers out loud"),
    () => settings.voice.speak,
    (on) => change({ speak: on }),
    speaker,
  );

  const followUp = h("select", {}) as HTMLSelectElement;
  followUp.append(h("option", { value: "0", text: t("None") }));
  for (const seconds of [5, 8, 15]) followUp.append(h("option", { value: String(seconds), text: `${seconds} s` }));
  if (![0, 5, 8, 15].includes(settings.voice.followUp)) {
    followUp.append(h("option", { value: String(settings.voice.followUp), text: `${settings.voice.followUp} s` }));
  }
  followUp.value = String(settings.voice.followUp);
  followUp.addEventListener("change", () => change({ followUp: Number(followUp.value) }));

  // The cloud tier: off unless asked for, and the line says what it sends.
  const cloudText = () =>
    t("When the local model cannot handle a request, the sentence and a description of Peika's state are sent to the provider chosen for chat ({provider}). It counts against your plan or key with that provider. Off: nothing is sent to it.", {
      provider: t(providerDef(settings.chatProvider).name),
    });
  const cloudHint = h("div", { class: "hint", text: cloudText() });

  // Web answers: who is asked, the key when it is Brave Search, and where the
  // browser opens. The key goes to the keychain and is never read back.
  const WEB_CHOICES: [WebSearchChoice, string][] = [
    ["browser", t("Nobody: the browser opens")],
    ["brave", "Brave Search"],
    ["anthropic", "Anthropic"],
  ];
  const WEB_HINTS: Record<WebSearchChoice, string> = {
    browser: t("Peika sends nothing: your browser opens on the search."),
    brave: t("What you ask is sent to Brave Search with your own key, and the results are read on this computer. Peika keeps nothing."),
    anthropic: t("What you ask and the last few turns are sent to Anthropic, which searches the web. It counts against your Claude plan or key. Peika keeps nothing."),
  };
  const webSearch = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of WEB_CHOICES) webSearch.append(h("option", { value: id, text: label }));
  // A value this build does not know is the browser, as Rust takes it.
  webSearch.value = WEB_CHOICES.some(([id]) => id === settings.voice.webSearch) ? settings.voice.webSearch : "browser";
  const webHint = h("div", { class: "hint" });

  let braveKey = false;
  const braveField = h("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const braveFeedback = h("div", {});
  const braveSave = h("button", { text: CHAT_STRINGS.save });
  const braveRemove = h("button", { class: "danger", text: CHAT_STRINGS.remove });
  const braveRefresh = () => {
    braveField.placeholder = braveKey ? CHAT_STRINGS.stored : "BSA…";
    braveRemove.style.display = braveKey ? "" : "none";
    drawWeb();
  };
  braveSave.addEventListener("click", async () => {
    const value = braveField.value.trim();
    if (!value) return;
    clear(braveFeedback);
    try {
      await Bridge.secretSet(BRAVE_SEARCH_KEY, value);
      braveKey = true;
      braveField.value = "";
      braveFeedback.append(h("div", { class: "notice ok", text: t("Saved. It never touches disk.") }));
    } catch (err) {
      braveFeedback.append(h("div", { class: "notice err", text: t("Could not save: {error}", { error: String(err) }) }));
    }
    braveRefresh();
  });
  braveRemove.addEventListener("click", async () => {
    clear(braveFeedback);
    try {
      await Bridge.secretClear(BRAVE_SEARCH_KEY);
      braveKey = false;
      braveFeedback.append(h("div", { class: "notice ok", text: t("Key removed.") }));
    } catch (err) {
      braveFeedback.append(h("div", { class: "notice err", text: t("Could not remove: {error}", { error: String(err) }) }));
    }
    braveRefresh();
  });
  const braveRow = h("div", { class: "row" },
    h("label", { text: t("Brave Search key") }),
    braveField, braveSave, braveRemove,
  );
  const braveWhere = h("div", { class: "hint", text: t("Key from {site}", { site: "brave.com/search/api" }) });

  const drawWeb = () => {
    const choice = webSearch.value as WebSearchChoice;
    webHint.textContent = WEB_HINTS[choice];
    braveRow.style.display = braveWhere.style.display = choice === "brave" ? "" : "none";
    // Empty, it would still take a gap of the section.
    braveFeedback.style.display = choice === "brave" && braveFeedback.childElementCount ? "" : "none";
  };
  braveRefresh();
  void Bridge.secretPresent(BRAVE_SEARCH_KEY).then((present) => {
    braveKey = present ?? false;
    braveRefresh();
  });
  webSearch.addEventListener("change", () => {
    drawWeb();
    change({ webSearch: webSearch.value as WebSearchChoice });
  });

  const engine = h("select", {}) as HTMLSelectElement;
  for (const { id, name } of SEARCH_ENGINES) engine.append(h("option", { value: id, text: name }));
  // One written by hand in the settings file stays, shown as it is written.
  if (!SEARCH_ENGINES.some((e) => e.id === settings.searchEngine)) {
    engine.append(h("option", { value: settings.searchEngine, text: settings.searchEngine }));
  }
  engine.value = settings.searchEngine;
  engine.addEventListener("change", () => {
    settings.searchEngine = engine.value;
    void save();
  });

  drawNeeds();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Voice") })),
    h("div", { class: "row" },
      h("label", { text: t("Enable voice command") }),
      toggle(settings.voice.enabled, (v) => change({ enabled: v })),
      status,
    ),
    problem,
    needs,
    h("div", { class: "hint", text: t("Say « OK Peika », then your command. Peika listens on this computer only: nothing is recorded and no audio leaves it. English only for now.") }),
    h("div", { class: "row" },
      h("label", { text: t("Listen for « OK Peika »") }),
      toggle(settings.voice.wake, (v) => change({ wake: v })),
    ),
    h("div", { class: "hint", text: t("Off: the microphone opens only for the “Talk to Peika” shortcut. While it listens, Windows shows a microphone in the taskbar.") }),
    free,
    h("div", { class: "hint", text: t("Lets a command be said in your own words, not only the sentences Windows was given. The engine and its English model (sherpa-onnx and Moonshine) are downloaded from GitHub when you ask, checked, and run on this computer. The wake phrase stays Windows' own.") }),
    h("div", { class: "row" }, h("label", { text: t("Speech model") }), hearing),
    hearingHint,
    h("div", { class: "hint", text: t("A larger model hears names and accents better, and takes a little longer to write a sentence down. Each is downloaded from GitHub when you ask for it. Parakeet is NVIDIA's (CC BY 4.0).") }),
    h("div", { class: "row" }, h("label", { text: t("Keep listening after a command") }), followUp),
    h("div", { class: "hint", text: t("For a few seconds after a command, another can be said without « OK Peika ». Only with free speech.") }),
    h("div", { class: "row" }, h("label", { text: t("Understand free speech with") }), server, model),
    h("div", { class: "hint", text: t("A sentence Peika does not know is put to this model, with the tools Peika offers. The model proposes; Peika checks before acting, and never approves a permission. Connect a server in Local models first.") }),
    embedRow,
    embedAbout,
    embedNone,
    embedWithout,
    h("div", { class: "row" },
      h("label", { text: t("Use the cloud when needed") }),
      toggle(settings.voice.cloud, (v) => change({ cloud: v })),
    ),
    cloudHint,
    spoken,
    h("div", { class: "hint", text: t("Peika says what a command did, in a calm voice made on this computer (Supertonic, downloaded from GitHub when you ask). In English, and quiet when Sound is off.") }),
    h("div", { class: "subhead", text: t("Web answers") }),
    h("div", { class: "row" }, h("label", { text: t("Answered by") }), webSearch),
    webHint,
    braveRow,
    braveFeedback,
    braveWhere,
    h("div", { class: "row" },
      h("label", { text: t("Answer questions from the web") }),
      toggle(settings.voice.webAnswers, (v) => change({ webAnswers: v })),
    ),
    h("div", { class: "hint", text: t("A question alone is answered from the web, without being asked to search. Off: the web is used only when you ask for a search.") }),
    h("div", { class: "row" }, h("label", { text: t("Search engine") }), engine),
    h("div", { class: "hint", text: t("Where your browser opens when a search is opened in it.") }),
    h("div", { class: "subhead", text: t("Debugging") }),
    h("div", { class: "row" },
      h("label", { text: t("Keep a voice debug log") }),
      toggle(settings.voice.debugLog, (v) => {
        // Off deletes what was written: what was said is kept only while this is on.
        if (!v) void Bridge.voiceDebugClear();
        return change({ debugLog: v });
      }),
    ),
    h("div", { class: "hint", text: t("Writes what you say and everything voice does with it — what it ranked, what the models were asked and answered, what ran — to voice-debug.log on this computer, to find what went wrong. Nothing is sent anywhere. Turning it off deletes the file.") }),
    h("div", { class: "row" }, h("button", { text: t("Open the log's folder"), onclick: () => void Bridge.voiceDebugReveal() })),
  );
}

let voiceListener: ((s: VoiceStatus | null) => void) | null = null;
/** `voice.hearingModel` when the model server hears (src-tauri/src/voice/hear.rs `ID`). */
const SERVER_HEARS = "server";
/** Redraws the voice section's list of model servers. */
let voiceServersRedraw: (() => void) | null = null;
type EngineProgress = { part: VoiceEnginePart; done: number; installed: boolean; error: string | null };
const voiceEngineListeners: Partial<Record<VoiceEnginePart, (p: EngineProgress) => void>> = {};
/** Asks Rust again what a part's row shows: the hearing model changed. */
const voiceEngineRedraw: Partial<Record<VoiceEnginePart, () => void>> = {};

function shortcutsSection(initial: ShortcutsReport | null): HTMLElement {
  let report = initial;
  const list = h("div", { class: "shortcut-list" });
  const feedback = h("div", {});
  const blockedNote = h("div", {});

  let stopRecording: (() => void) | null = null;

  function store(id: string, binding: Binding) {
    settings.shortcuts = { ...settings.shortcuts, [id]: binding };
    void save();
  }

  function tagFor(id: string, dups: Set<string>): HTMLElement | null {
    if (dups.has(id)) return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
    const st = report?.actions.find((a) => a.id === id);
    switch (st?.status) {
      case "inUse": return h("span", { class: "tag warn", text: SHORTCUTS_UI.inUse });
      case "duplicate": return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
      case "invalid": return h("span", { class: "tag err", text: SHORTCUTS_UI.invalid });
      case "typesCharacter": return h("span", { class: "tag warn", text: SHORTCUTS_UI.types(st.typed ?? "?") });
      case "unsupported": return h("span", { class: "tag", text: SHORTCUTS_UI.unavailable });
      case "refused": return h("span", { class: "tag warn", text: SHORTCUTS_UI.refused });
      // Wayland: the desktop may run it on other keys than the ones asked for.
      case "active": return st.trigger ? h("span", { class: "tag", text: SHORTCUTS_UI.desktopKeys(st.trigger) }) : null;
      default: return null;
    }
  }

  function record(id: string, binding: Binding, button: HTMLButtonElement) {
    stopRecording?.();
    clear(feedback);
    button.classList.add("recording");
    button.textContent = SHORTCUTS_UI.recording;
    void Bridge.shortcutsSuspend(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = recordPress(e);
      switch (result.kind) {
        case "pending":
          return;
        case "keys":
          finish();
          store(id, { keys: result.keys, enabled: true });
          return;
        case "clear":
          finish();
          store(id, { keys: "", enabled: binding.enabled });
          return;
        case "typesCharacter":
          finish();
          feedback.append(h("div", {
            class: "notice warn",
            text: SHORTCUTS_UI.typesNote(displayKeys(result.keys), result.typed),
          }));
          return;
        case "needsModifier":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.needsModifier }));
          return;
        case "unsupported":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.unsupportedKey }));
          return;
        case "cancel":
          finish();
          return;
      }
    };
    const onBlur = () => finish();

    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      stopRecording = null;
      // Takes the global shortcuts back, from what is saved by now.
      void Bridge.shortcutsSuspend(false);
      draw();
    }
    stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  }

  function draw() {
    clear(list);
    const dups = duplicates(activeKeys(settings.shortcuts));
    for (const d of SHORTCUTS) {
      if (!d.ported) continue;
      const binding = effective(d, settings.shortcuts);
      const keycap = h("button", {
        class: "keycap",
        text: binding.keys ? displayKeys(binding.keys) : SHORTCUTS_UI.none,
      }) as HTMLButtonElement;
      keycap.disabled = !binding.enabled;
      keycap.addEventListener("click", () => record(d.id, binding, keycap));
      const sw = toggle(binding.enabled, (on) => store(d.id, { keys: binding.keys, enabled: on }));
      const tag = binding.enabled ? tagFor(d.id, dups) : null;
      list.append(h("div", { class: binding.enabled ? "row shortcut" : "row shortcut off" },
        sw,
        h("span", { class: "shortcut-name", text: t(SHORTCUT_TEXT[d.id]) }),
        ...(tag ? [tag] : []),
        keycap,
      ));
    }

    clear(blockedNote);
    const commands = (command: string) => {
      const list = h("div", { class: "diff" });
      for (const d of SHORTCUTS) {
        if (d.ported) list.append(h("div", { class: "ctx", text: `${command} ${d.id}` }));
      }
      return list;
    };
    if (report?.portal) {
      // Wayland, through the desktop's GlobalShortcuts portal; the commands
      // stay as a way around a shortcut the desktop didn't take.
      const active = report.portal === "active";
      blockedNote.append(
        h("div", {
          class: active ? "notice ok" : "notice",
          text: active ? SHORTCUTS_UI.portalActive : SHORTCUTS_UI.portalPending,
        }),
        h("div", { class: "hint", text: SHORTCUTS_UI.portalFallback }),
        commands(report.command),
      );
    } else if (report?.blocked === "wayland") {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.wayland }), commands(report.command));
    } else if (report?.blocked) {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.noDisplay }));
    }
  }

  const islandList = h("div", { class: "shortcut-list" });
  for (const row of ISLAND_SHORTCUTS) {
    islandList.append(h("div", { class: "row shortcut" },
      h("span", { class: "shortcut-name", text: t(row.description) }),
      h("span", { class: "keycap static", text: row.keys }),
    ));
  }

  const reset = h("button", {
    text: SHORTCUTS_UI.reset,
    onclick: () => {
      stopRecording?.();
      settings.shortcuts = {};
      clear(feedback);
      void save();
      draw();
    },
  });

  // The events are listened to once (see main); only the section on screen redraws.
  shortcutsListener = {
    report(fresh) {
      report = fresh;
      if (!stopRecording) draw();
    },
    settingsChanged() {
      if (!stopRecording) draw();
    },
  };

  draw();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: SHORTCUTS_UI.title })),
    h("div", { class: "hint", text: SHORTCUTS_UI.hint }),
    h("div", { class: "subhead", text: SHORTCUTS_UI.global }),
    list,
    blockedNote,
    feedback,
    h("div", { class: "row" }, reset),
    h("div", { class: "subhead", text: SHORTCUTS_UI.island }),
    islandList,
  );
}

/** Settings → General → Weekly recap. The prefs live with the history in Rust. */
function recapRows(): HTMLElement[] {
  const T = {
    label: t("Weekly recap"),
    keep: t("Keep a history of my coding sessions"),
    clear: t("Clear history"),
    cleared: t("History cleared."),
    about: t("Counts and project names only — never commands, files or prompts. Kept on this computer for 12 weeks."),
  };
  const feedback = h("span", { class: "hint" });
  const sw = toggle(true, (v) => { void Bridge.recapSetEnabled(v); });
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) sw.classList.toggle("on", prefs.enabled);
  });
  const clearBtn = h("button", {
    class: "danger",
    text: T.clear,
    onclick: async () => {
      clearBtn.disabled = true;
      await Bridge.recapClear();
      feedback.textContent = T.cleared;
      window.setTimeout(() => {
        clearBtn.disabled = false;
        feedback.textContent = "";
      }, 2400);
    },
  }) as HTMLButtonElement;
  return [
    h("div", { class: "row" },
      h("label", { text: T.label }),
      sw,
      h("span", { class: "hint", text: T.keep }),
    ),
    h("div", { class: "row" },
      h("label", {}),
      clearBtn,
      feedback,
    ),
    h("div", { class: "row" },
      h("label", {}),
      h("span", { class: "hint", style: "flex:1 1 0;min-width:0", text: T.about }),
    ),
  ];
}

// ── Language ──────────────────────────────────────────────────────────────────

/** The shortcuts section on screen, told about the events listened to once in main. */
let shortcutsListener: { report(fresh: ShortcutsReport): void; settingsChanged(): void } | null = null;

/**
 * Shows the language Settings asks for. A change redraws the window in place,
 * where it was scrolled to: nothing reloads, nothing is written.
 */
function applyLanguage() {
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
}

function applyDirection() {
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = "Peika";
}

let rendering: Promise<void> | null = null;
let renderAgain = false;

/** Redraws every section from fresh state, keeping the scroll position. */
async function rerender() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  const scroll = paneEl?.scrollTop ?? 0;
  rendering = render();
  try {
    await rendering;
  } finally {
    rendering = null;
  }
  if (paneEl) paneEl.scrollTop = scroll;
  if (renderAgain) {
    renderAgain = false;
    await rerender();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  // First, so the page is already waiting in its hidden state when shown.
  initMotion(root);
  // Opened on a page (the tray, the island): `select` falls back to General for
  // an id it does not know, and a page asked before the first draw is kept in
  // `current` for it.
  void onEvent<string>("peika-page", (id) => {
    current = id;
    showPage?.(id);
  });
  // A window made just now to open on a page missed that event: it asks.
  const first = await Bridge.settingsFirstPage();
  if (first) current = first;
  // Peika's right-click menu here too: Cut, Copy, Paste in the fields, and
  // never the webview's own.
  installContextMenu(document.body, { clipboardText: () => Bridge.clipboardText() });
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  applyDirection();
  onLanguageChange(() => {
    applyDirection();
    void rerender();
  });
  await render();

  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => shortcutsListener?.report(fresh));
  void onEvent<VoiceStatus>("voice-status", (s) => voiceListener?.(s));
  void onEvent<EngineProgress>("voice-engine", (p) => voiceEngineListeners[p.part]?.(p));
  void onEvent<Settings>("settings-changed", (s) => {
    const before = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    settings = { ...settings, ...s };
    shortcutsListener?.settingsChanged();
    for (const redraw of declaredViews) redraw();
    const after = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    if (before !== after) localRedraw?.();
    // A server connected in Local models can be chosen for voice at once.
    voiceServersRedraw?.();
    applyLanguage();
  });
}

/** Reads what the sections show and draws them all. */
async function render() {
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const agents = await Bridge.agentHooksList();

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const shortcutReport = await Bridge.shortcutsStatus();

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  // A main pill this build can run, and no pill declared twice.
  settings = { ...settings, ...sanitizeDeclared(settings) };
  const connected: Record<string, boolean> = { ...((await Bridge.agentHooksStatus()) ?? {}) };
  for (const def of availablePills()) {
    if (def.connect.kind === "key") {
      connected[def.id] = present[def.connect.key] ?? (await Bridge.secretPresent(def.connect.key)) ?? false;
    }
  }
  /** A chat provider's key was saved or removed: its pill's row says so at once. */
  const keyChanged = (key: string, on: boolean) => {
    for (const def of availablePills()) {
      if (def.connect.kind === "key" && def.connect.key === key) connected[def.id] = on;
    }
    for (const redraw of declaredViews) redraw();
  };
  const chatKeys: Record<string, boolean> = {};
  for (const def of CLOUD) {
    const key = providerDef(def.id).key!;
    chatKeys[key] = (await Bridge.secretPresent(key)) ?? false;
  }
  const customKey = (await Bridge.secretPresent(CUSTOM_SERVER_KEY)) ?? false;

  declaredViews.length = 0;
  localRedraw = null;
  shortcutsListener = null;
  // Built first: each is cut into pages at its sub-headings (splitAtSubheads).
  const [voiceMain, voiceWeb, voiceDebug] = splitAtSubheads(voiceSection());
  const [shortcutsGlobal, shortcutsIsland] = splitAtSubheads(shortcutsSection(shortcutReport));
  // One page per leaf of the tree; only the one picked is shown (drawShell).
  const pages: Record<string, HTMLElement> = {
    "general": page(generalSection()),
    "claude-code": page(claudeSection(status)),
    "agents": page(agentsSection(agents)),
    "plan-usage": page(planSection(status)),
    "claude-api": page(apiSection(hasKey)),
    "chat-providers": page(chatProvidersSection(chatKeys, keyChanged)),
    "local-models": page(localSection(customKey)),
    "pills": page(activePillsSection(connected)),
    "integrations": page(integrationsSection(present)),
    "voice": page(voiceMain),
    "voice-web": page(voiceWeb),
    "voice-debug": page(voiceDebug),
    "shortcuts": page(shortcutsGlobal),
    "shortcuts-island": page(shortcutsIsland),
    "about": page(
      h("section", {}, h("h2", {}, h("span", { text: "Peika" }), h("span", { class: "version", text: version }))),
      h("div", {
        class: "hint",
        text: t("No telemetry. Network requests only go to the services you configure yourself."),
      }),
    ),
  };
  drawShell(pages);
}

function page(...children: HTMLElement[]): HTMLElement {
  return h("div", { class: "page" }, ...children);
}

/** The tree on the left: each group and the pages under it. */
const TREE: [string, [string, string][]][] = [
  [N_("General"), [["general", N_("General")]]],
  // Product names stay as they are in every language, like the Claude Code section's heading.
  ["Claude", [["claude-code", "Claude Code"], ["agents", N_("Agents")], ["plan-usage", N_("Plan usage")], ["claude-api", "Claude API"]]],
  [N_("AI models"), [["chat-providers", N_("Chat providers")], ["local-models", N_("Local models")]]],
  [N_("Pills & integrations"), [["pills", N_("Active pills")], ["integrations", N_("Integrations")]]],
  [N_("Voice"), [["voice", N_("Voice")], ["voice-web", N_("Web answers")], ["voice-debug", N_("Debugging")]]],
  [N_("Shortcuts"), [["shortcuts", N_("From anywhere")], ["shortcuts-island", N_("In the open island")]]],
  [N_("About"), [["about", N_("About")]]],
];

/**
 * A section cut at its sub-headings (`.subhead`) into one section per part.
 * The nodes are moved, not rebuilt, so their listeners and live state stay.
 * A part keeps the section's own heading when the section starts with
 * controls; when it starts with hints only, the hints go with the first
 * sub-heading's part instead, and that sub-heading becomes its heading.
 */
function splitAtSubheads(section: HTMLElement): HTMLElement[] {
  const heading = section.querySelector("h2");
  const segments: { title: string; nodes: Element[] }[] = [{ title: heading?.textContent ?? "", nodes: [] }];
  for (const child of [...section.children]) {
    if (child === heading) continue;
    if (child.classList.contains("subhead")) {
      segments.push({ title: child.textContent ?? "", nodes: [] });
      child.remove();
      continue;
    }
    segments[segments.length - 1].nodes.push(child);
  }
  if (segments.length === 1) return [section];

  const [preamble, ...parts] = segments;
  const hasControls = preamble.nodes.some((n) => !n.classList.contains("hint"));
  const made = (title: string, nodes: Element[]) => {
    const part = h("section", {}, h("h2", {}, h("span", { text: title })));
    part.append(...nodes);
    return part;
  };
  if (hasControls) {
    return [section, ...parts.map((p) => made(p.title, p.nodes))];
  }
  return parts.map((p, i) => made(p.title, i === 0 ? [...preamble.nodes, ...p.nodes] : p.nodes));
}

/** The page picked in the tree, kept across redraws. */
let current = "general";
let paneEl: HTMLElement | null = null;
/** The tree's `select` of the window on screen, for a page asked from outside. */
let showPage: ((id: string) => void) | null = null;

/** Draws the title bar, the tree and the pane around the pages. */
function drawShell(pages: Record<string, HTMLElement>) {
  const leafButtons = new Map<string, HTMLElement>();
  const groupOf: Record<string, string> = {};
  const heading = h("h1", {});
  const pane = h("main", { id: "pane" }, mountBand(), heading, ...Object.values(pages));
  const tree = h("nav", { id: "tree", "aria-label": t("Settings") });

  for (const [group, leaves] of TREE) {
    tree.append(h("div", { class: "group", text: t(group) }));
    for (const [id, label] of leaves) {
      groupOf[id] = group;
      const button = h("button", { class: "leaf", text: t(label), onclick: () => select(id) });
      leafButtons.set(id, button);
      tree.append(button);
    }
  }

  const select = (id: string) => {
    current = id in pages ? id : "general";
    for (const [key, el] of Object.entries(pages)) el.hidden = key !== current;
    for (const [key, button] of leafButtons) button.classList.toggle("on", key === current);
    heading.textContent = t(groupOf[current]);
    pane.scrollTop = 0;
  };

  const winButton = (label: string, cls: string, glyph: string, onClick: () => void) =>
    h("button", { class: `win-btn ${cls}`, title: label, "aria-label": label, onclick: onClick, text: glyph });

  const bar = h("header", {
    id: "titlebar",
    onmousedown: (e: Event) => {
      const m = e as MouseEvent;
      if (m.button === 0 && !(m.target as HTMLElement).closest("button")) void Bridge.dragSettingsWindow();
    },
    ondblclick: (e: Event) => {
      if (!(e.target as HTMLElement).closest("button")) void Bridge.toggleMaximizeSettingsWindow();
    },
  },
    h("span", { class: "title", text: "Peika" }),
    winButton(t("Minimize"), "min", "–", () => void Bridge.minimizeSettingsWindow()),
    winButton(t("Maximize"), "max", "□", () => void Bridge.toggleMaximizeSettingsWindow()),
    winButton(t("Close"), "close", "✕", () => void Bridge.closeSettingsWindow()),
  );

  clear(root);
  root.append(bar, h("div", { id: "frame" }, tree, pane));
  paneEl = pane;
  showPage = select;
  select(current);
}

void main();
