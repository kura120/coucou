// The app behind the declarations (capabilities/host.ts): each method here
// does what a click in Coucou would do, on the real island. The capabilities
// reach the app through this and nothing else; the registry they are declared
// on is made here, once, with its guard — a click on a toast — and the lines
// the executor shows.
//
// What is not here cannot be reached: nothing approves a permission, installs
// hooks, reads a key or switches the phone link.

import { registerApp } from "../capabilities/index";
import type { AppHost, ChatModel, Option } from "../capabilities/host";
import { createRegistry, type Words } from "../core/capabilities/registry";
import type { GuardHost, Registry, ScreenContext } from "../core/capabilities/types";
import { Bridge } from "../core/bridge";
import { lastTextStep } from "../core/diff";
import type { IslandViewName } from "../core/layout";
import {
  MAX_DECLARED, availablePills, chooseMainPill, pillDefinition, sanitizeDeclared, slotsUsed, takesSlot,
} from "../core/pills";
import { activeModel, providerDef, visibleProviders, withModel } from "../core/providers";
import { searchUrl } from "../core/search";
import { Sound } from "../core/sound";
import { SPOTIFY_ID, Spotify, spotifyPosition } from "../core/spotify";
import { State, type Settings } from "../core/state";
import { LANGUAGES, t } from "../i18n/i18n";
import { OUTFIT_KEYS, OUTFIT_SELECTIONS, parseOutfit, type OutfitSelection } from "../mochi/wardrobe";
import { Recap } from "../recap/recap";
import { formatDuration } from "../recap/summary";
import { askToast, showToast } from "../toast/api";
import { ChatControls } from "../views/chat";
import type { DesktopLink } from "./desktop";

const CLAUDE_DESKTOP_ID = "agent_claude-desktop";

/** The island's views a capability may ask for, by the name `show_view` takes (capabilities/views.ts). */
const VIEW_OF: Readonly<Record<string, IslandViewName>> = { chat: "prompt", wardrobe: "wardrobe", recap: "recap" };

/** What the host needs of the island itself. */
export interface IslandPorts {
  /** Mochi on the desktop. */
  desktop(): DesktopLink;
  /** The island's view under the listening one, and whether the island was open on it. */
  place(): { view: IslandViewName; open: boolean };
  /**
   * Opens the island on a view — when the turn that asked for it ends, so the
   * listening view is not pulled from under it; at once when no turn runs.
   * `after`: what to do once it is up.
   */
  goTo(view: IslandViewName, after?: () => void): void;
  /** Brings the waiting card up, answering nothing. */
  showWaitingCard(): boolean;
  /** Declines the waiting permission, as a click on Deny does. */
  declineWaiting(): boolean;
  /** Answers the waiting question, as a click on its card does. */
  answerWaiting(answers: Record<string, string | string[]>): boolean;
  /** Writes this in the chat's field, unsent. False when the chat has no field to write in. */
  prefillChat(message: string): boolean;
  /** Keeps an outfit, as a click in the wardrobe does. */
  wearOutfit(selection: OutfitSelection): void;
  /** The settings changed under the island: it follows, as it does for the Settings window. */
  settingsChanged(): void;
  /** The tray's Pause, and its way back. */
  setPaused(paused: boolean): void;
  /** What the view on screen shows. */
  screen(): ScreenContext | null;
  /** A web search came back: its card may show it when the turn ends. */
  webSearched(query: string, results: readonly { title: string; url: string; snippet: string }[]): void;
}

const declared = () => sanitizeDeclared(State.settings, State.os);
const pillName = (id: string) => pillDefinition(id)?.name ?? id;

/** A setting by its path: "soundEnabled", "voice.followUp". */
export function readSetting(settings: Settings, key: string): unknown {
  let at: unknown = settings;
  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** The settings with one of them changed; nothing else is touched. */
export function withSetting(settings: Settings, key: string, value: unknown): Settings {
  const parts = key.split(".");
  const out = { ...settings } as Record<string, unknown>;
  let at = out;
  for (const part of parts.slice(0, -1)) {
    const inner = { ...((at[part] as Record<string, unknown> | undefined) ?? {}) };
    at[part] = inner;
    at = inner;
  }
  at[parts[parts.length - 1]] = value;
  return out as unknown as Settings;
}

/** The exact change, on a toast: only a click on its button is a yes. */
export const guardHost: GuardHost = {
  confirm: async ({ title, change, action }) =>
    (await askToast({ kind: "warning", title, text: change, actions: { yes: action, no: t("Cancel") } })) === "yes",
};

/** The executor's own lines, in the interface's language. */
export const registryWords: Words = {
  refused: () => t("I can't do that"),
  unavailable: () => t("That isn't possible right now"),
  failed: () => t("That did not work"),
  notFound: (said) => t("Not found: {0}", { 0: said.slice(0, 40) }),
  unchanged: () => t("OK, leaving it as is"),
  nothingToUndo: () => t("There is nothing to put back"),
  one: (label) => t("Did you mean {0}?", { 0: label }),
  which: (labels) =>
    labels.length === 2 ? t("{0} or {1}?", { 0: labels[0], 1: labels[1] }) : t("{0}, {1} or {2}?", { 0: labels[0], 1: labels[1], 2: labels[2] }),
};

let timer: { label: string; endsAt: number; handle: number } | null = null;

function stopTimer(): boolean {
  if (!timer) return false;
  window.clearTimeout(timer.handle);
  timer = null;
  return true;
}

export function createAppHost(island: IslandPorts): AppHost {
  const save = () => void Bridge.saveSettings(State.settings);

  const setSetting = async (key: string, value: unknown) => {
    State.settings = withSetting(State.settings, key, value);
    await Bridge.saveSettings(State.settings);
    island.settingsChanged();
    State.notify();
    return readSetting(State.settings, key) === value;
  };

  /** The models of each provider the picker shows, kept while the app runs: a provider is asked once. */
  const models = new Map<string, ChatModel[]>();
  /** Whether the desktop Mochi was put to sleep from here: nothing else reads it back. */
  let asleep = false;
  // The recap's switches are Rust's; read once so that they are known without waiting.
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) Recap.prefs = { ...Recap.prefs, ...prefs };
  });

  return {
    // ── Music ──
    music() {
      const s = Spotify.state;
      return {
        enabled: declared().activeIntegrations.includes(SPOTIFY_ID),
        running: s.running,
        playing: s.playing,
        shuffle: s.shuffle,
        repeat: s.repeat,
        volume: s.volumeKnown === false ? null : s.volume,
        position: Math.round(spotifyPosition(s, Date.now())),
        track: s.track ? { title: s.track.title, artist: s.track.artist, album: s.track.album, duration: s.track.duration } : null,
      };
    },
    musicControl: async (action, value) => (await Bridge.spotifyControl(action, value)) === true,
    openMusic: async () => (await Bridge.spotifyOpen()) === true,

    // ── Pills ──
    pillCatalog: () => availablePills(State.os).map(({ id, name, category }) => ({ id, name, category })),
    pills: () => ({ active: declared().activeIntegrations, main: declared().mainPill }),
    pillFits: (id) => !takesSlot(id) || slotsUsed(declared().activeIntegrations) < MAX_DECLARED,
    pillLimit: () => MAX_DECLARED,
    togglePill(id) {
      State.toggleIntegration(id);
      save();
      State.notify();
    },
    setMainPill(id) {
      const next = chooseMainPill(declared(), id, State.os);
      if (!next) return;
      State.settings.mainPill = next.mainPill;
      State.settings.activeIntegrations = next.activeIntegrations;
      State.loadIntegrationTasks();
      // A new main tool comes to the front, as when it is picked in Settings.
      State.setFocus(State.mainPillId);
      save();
      State.notify();
    },

    // ── Sessions ──
    sessions: () =>
      State.tasks
        .filter((task) => !task.isIntegration && (task.state !== "idle" || task.steps.length > 0))
        .map((task) => ({
          id: task.id,
          name: pillName(task.id),
          state: task.state,
          doing: (task.finalLine || lastTextStep(task.steps) || "").slice(0, 120),
        })),
    openSession(id) {
      const task = State.tasks.find((x) => x.id === id);
      if (!task) return false;
      State.setFocus(id);
      if (id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
      else void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
      return true;
    },
    sessionOutput(id, lines) {
      const task = State.tasks.find((x) => x.id === id);
      if (!task) return [];
      const steps = task.steps.filter((step) => lastTextStep([step]) !== undefined);
      return [...steps, ...(task.finalLine ? [task.finalLine] : [])].slice(-Math.max(1, lines));
    },

    // ── The card that waits ──
    permission() {
      const pending = State.pendingApproval;
      if (!pending || pending.questions) return null;
      return { agent: pillName(pending.pillId), request: `${pending.tool}: ${pending.command}` };
    },
    agentQuestion() {
      const pending = State.pendingApproval;
      if (!pending?.questions) return null;
      return { agent: pillName(pending.pillId), questions: pending.questions };
    },
    showWaitingCard: () => island.showWaitingCard(),
    declinePermission: () => island.declineWaiting(),
    answerAgentQuestion: (answers) => island.answerWaiting(answers),

    // ── Timer ──
    timer: () => (timer ? { label: timer.label, minutesLeft: Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 60_000)) } : null),
    setTimer(minutes, label) {
      stopTimer();
      const ms = minutes * 60_000;
      const handle = window.setTimeout(() => {
        timer = null;
        Sound.play("finish");
        void showToast({ kind: "info", title: t("Time's up"), text: label || undefined, durationMs: 15_000 });
      }, ms);
      timer = { label, endsAt: Date.now() + ms, handle };
    },
    cancelTimer: stopTimer,

    // ── Apps, folders, addresses ──
    // Too many to hand over: Rust ranks them against a name (`appsNear`), and nothing is listed.
    apps: async () => [],
    async appsNear(said) {
      const near = await Bridge.voiceAppsNear(said);
      if (!near) return [];
      const ranked = near.names.map((name, i) => ({ name, score: near.scores[i] ?? 0 }));
      // The one Rust found by its name or its sound comes first, whatever its letters scored.
      if (!near.found) return ranked;
      return [{ name: near.found, score: 1 }, ...ranked.filter((app) => app.name !== near.found)];
    },
    openApp: async (name) => (await Bridge.voiceOpenApp(name)) ?? null,
    folders: async () => ((await Bridge.voiceFolders()) ?? []).map((name) => ({ id: name, label: name })),
    openFolder: async (id) => (await Bridge.voiceOpenFolder(id)) ?? null,
    openUrl(url) {
      void Bridge.openUrl(url);
      return true;
    },

    // ── Views ──
    currentView() {
      const { view, open } = island.place();
      const named = Object.entries(VIEW_OF).find(([, own]) => own === view)?.[0];
      return { view: named ?? (view === "empty" ? "overview" : view), open };
    },
    showView(view) {
      if (State.paused || State.pendingApproval) return false;
      if (view === "settings") {
        void Bridge.openSettingsWindow();
        return true;
      }
      if (view === "recap") island.goTo("recap", () => void Recap.load().then(() => State.notify()));
      else island.goTo(VIEW_OF[view] ?? State.defaultView());
      return true;
    },

    // ── Settings ──
    setting: (key) => readSetting(State.settings, key),
    setSetting,
    languages: () => [{ value: "", label: t("System") }, ...LANGUAGES.map(({ code, name }) => ({ value: code, label: name }))],
    async monitors(): Promise<Option[]> {
      const list = (await Bridge.listMonitors()) ?? [];
      return [
        { value: "primary", label: t("Main display") },
        { value: "cursor", label: t("Display under the cursor") },
        ...list.map((m) => ({ value: m.key, label: m.label })),
      ];
    },
    // Only what is on this machine can be heard with.
    hearingModels: async () =>
      ((await Bridge.voiceHearingModels()) ?? []).filter((m) => m.installed || m.server).map((m) => ({ value: m.id, label: m.name })),
    embedModels: async () => [{ value: "", label: t("None") }, ...((await Bridge.voiceEmbedModels()) ?? []).map((name) => ({ value: name, label: name }))],

    // ── Chat ──
    chat() {
      const provider = providerDef(State.settings.chatProvider);
      return {
        provider: provider.id,
        model: activeModel(State.settings),
        busy: ChatControls.busy(),
        draft: ChatControls.draft(),
        conversationId: State.conversationId,
        messages: State.chatHistory.length,
      };
    },
    prepareChat(message) {
      if (State.paused || State.pendingApproval) return false;
      // In its field at once, so that it reads back; the chat itself comes up when the turn ends.
      if (!island.prefillChat(message)) return false;
      island.goTo("prompt");
      return true;
    },
    sendChat: async () => ChatControls.send(),
    stopChat: () => ChatControls.stop(),
    async resetChat() {
      if (!ChatControls.startNew()) return false;
      island.goTo("prompt");
      return true;
    },
    async chatModels() {
      const out: ChatModel[] = [];
      for (const provider of visibleProviders(State.settings)) {
        let list = models.get(provider.id);
        if (!list) {
          // A provider with no key yet is asked nothing.
          if (provider.key && !(await Bridge.secretPresent(provider.key))) continue;
          try {
            list = (await Bridge.chatModels(provider.id)).map((m) => ({
              provider: provider.id, providerName: t(provider.name), id: m.id, label: m.label || m.id,
            }));
          } catch {
            continue;
          }
          // A model server's list changes as models are pulled: it is asked each time.
          if (!provider.urlField) models.set(provider.id, list);
        }
        out.push(...list);
      }
      return out;
    },
    async setChatModel(provider, model) {
      const def = providerDef(provider);
      if (def.id !== provider) return false;
      State.settings = withModel({ ...State.settings, chatProvider: def.id }, def.id, model);
      await Bridge.saveSettings(State.settings);
      State.notify();
      return State.settings.chatProvider === def.id && activeModel(State.settings) === model;
    },
    conversations: async () => ((await Bridge.conversationsList()) ?? []).map(({ id, title, dir, updated }) => ({ id, title, dir, updated })),
    async openConversation(id) {
      if (!(await ChatControls.open(id))) return false;
      island.goTo("prompt");
      return true;
    },

    // ── Wardrobe ──
    outfits: () => OUTFIT_SELECTIONS.map((id) => ({ id, label: t(OUTFIT_KEYS[id]) })),
    outfit: () => parseOutfit(State.settings.mochiOutfit),
    wearOutfit(id) {
      const selection = OUTFIT_SELECTIONS.find((o) => o === id);
      if (!selection) return false;
      island.wearOutfit(selection);
      return parseOutfit(State.settings.mochiOutfit) === selection;
    },

    // ── Recap ──
    recapOptions: () => ({ enabled: Recap.prefs.enabled, hideProjects: Recap.prefs.hideProjects }),
    async recapLines() {
      let week;
      try {
        week = await Recap.load();
      } catch {
        return null;
      }
      if (!week) return [];
      const lines = [
        `${week.sessionCount} sessions`,
        `${formatDuration(week.totalMinutes)} coding`,
        `${week.filesChanged} files changed, +${week.linesAdded} −${week.linesRemoved} lines`,
        `${week.commandsRun} commands run`,
        `${week.permissionsAllowed} permissions allowed, ${week.permissionsDenied} denied`,
      ];
      if (week.busiestDay) lines.push(`busiest day: ${week.busiestDay}`);
      if (week.topAgent) lines.push(`top agent: ${week.topAgent}`);
      if (week.topProject && !Recap.prefs.hideProjects) lines.push(`top project: ${week.topProject}`);
      return lines;
    },
    async setRecapOption(option, on) {
      if (option === "enabled") {
        await Bridge.recapSetEnabled(on);
        Recap.prefs.enabled = on;
      } else {
        await Recap.setHideProjects(on);
      }
      const saved = await Bridge.recapPrefs();
      if (saved) Recap.prefs = { ...Recap.prefs, ...saved };
      return Recap.prefs[option] === on;
    },

    // ── Mochi on the desktop ──
    mochi: () => ({ supported: island.desktop().supported, onDesktop: State.mochiOnDesktop, asleep: asleep && State.mochiOnDesktop }),
    async mochiFlyOut() {
      const { supported, controller } = island.desktop();
      // The desktop shortcut's own way out; in flight or away for an alert, nothing.
      if (!supported || controller.phase !== "home") return false;
      await controller.flyOutOrHome();
      return State.mochiOnDesktop;
    },
    async mochiFlyHome() {
      await island.desktop().controller.flyHome();
      asleep = false;
      return !State.mochiOnDesktop;
    },
    setMochiAsleep(next) {
      if (!State.mochiOnDesktop) return false;
      asleep = next;
      void Bridge.desktopSetAsleep(next);
      return true;
    },

    // ── Services ──
    services: () =>
      State.tasks
        .filter((task) => task.isIntegration && pillDefinition(task.id)?.category === "service")
        .map((task) => ({ id: task.id, name: pillName(task.id), line: (lastTextStep(task.steps) ?? "").slice(0, 160) })),
    serviceInfo(id) {
      const task = State.tasks.find((x) => x.id === id);
      if (!task) return [];
      return [task.finalLine, ...task.steps.slice(-5)]
        .filter((line): line is string => typeof line === "string" && line.trim() !== "" && lastTextStep([line]) !== undefined)
        .map((line) => line.slice(0, 160));
    },
    async refreshService(id) {
      if (State.paused || !State.integrations[id]?.configured) return false;
      await Bridge.refreshIntegration(id);
      return true;
    },

    // ── The web ──
    async webSearch(query) {
      // A question is answered from the web only when the user said it may be (Settings → Voice).
      if (!State.settings.voice.webAnswers) return { error: "Answering from the web is turned off in Settings. open_web_search shows the results in the browser instead." };
      try {
        const results = await Bridge.webSearch(query);
        island.webSearched(query, results);
        return { results };
      } catch (error) {
        return { error: String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, "") };
      }
    },
    openWebSearch(query) {
      void Bridge.openUrl(searchUrl(query, State.settings.searchEngine));
      return true;
    },

    // ── Coucou itself ──
    listening: () => State.settings.voice.enabled,
    stopListening() {
      void setSetting("voice.enabled", false);
      // Closing the microphone is never made hard; the way back is on screen for a while.
      void askToast({
        kind: "info", title: t("Voice is off"), text: t("Coucou no longer listens. Turn it back on here, or in Settings."),
        actions: { yes: t("Turn back on"), no: t("OK") }, durationMs: 20_000,
      }).then((answer) => {
        if (answer === "yes") void setSetting("voice.enabled", true);
      });
    },
    paused: () => State.paused,
    setPaused: (paused) => island.setPaused(paused),
    quit: () => void Bridge.quit(),
    notify: (title, text) => void showToast({ kind: "info", title, text: text || undefined }),
  };
}

/** The registry of the running app: every capability declared, behind the guard. Made once. */
export function createAppRegistry(island: IslandPorts): Registry {
  const registry = createRegistry({ guard: guardHost, words: registryWords });
  registerApp(registry, createAppHost(island));
  registry.screen(() => island.screen());
  return registry;
}
