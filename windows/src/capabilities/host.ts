// What the capabilities need of the running app, as plain methods. They touch
// Coucou only through this, so the tests run them against a fake; the island
// has the real one. Each method does what a click in the app would do.
//
// What is not here cannot be reached by the assistant: nothing approves a
// permission, installs or removes hooks or the status line, reads or writes a
// key, switches the phone link, or changes an address, a folder or a shortcut.

/** A value now, or one that has to be asked for. */
export type Awaitable<T> = T | Promise<T>;

/** One value a setting may take, as Settings shows it. */
export interface Option {
  value: string;
  label: string;
  /** Other names it goes by, when the platform gives some (a language's name in English). */
  spoken?: readonly string[];
}

// ── Music ─────────────────────────────────────────────────────────────────────

export interface MusicNow {
  /** Spotify is switched on in Settings: Coucou follows it and may drive it. */
  enabled: boolean;
  running: boolean;
  playing: boolean;
  shuffle: boolean;
  repeat: boolean;
  /** 0…100, or null where the player's volume cannot be read (Windows). */
  volume: number | null;
  /** Seconds into the track. */
  position: number;
  track: { title: string; artist: string; album: string; duration: number } | null;
}

/** `value`: seconds for seek, 0 or 1 for shuffle and repeat, 0…100 for volume. */
export type MusicAction = "playPause" | "next" | "previous" | "seek" | "shuffle" | "repeat" | "volume";

// ── Pills, sessions, cards ────────────────────────────────────────────────────

export interface PillInfo {
  id: string;
  name: string;
  /** "workspace", "agent", "ai" or "service", as the catalog says. */
  category: string;
  /** Other ways the catalog writes it, when it has some. */
  spoken?: readonly string[];
}

export interface SessionInfo {
  /** Its pill's id. */
  id: string;
  name: string;
  /** "working", "idle", "error"… */
  state: string;
  /** What it is doing, in a few words. */
  doing: string;
}

export interface AgentQuestion {
  agent: string;
  questions: { question: string; options: { label: string; description: string }[]; multiSelect: boolean }[];
}

export interface ServiceInfo {
  id: string;
  name: string;
  /** What it last reported, in a line; empty when it said nothing. */
  line: string;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export interface ChatNow {
  provider: string;
  model: string;
  /** A turn is running. */
  busy: boolean;
  /** What the field holds, unsent. */
  draft: string;
  /** The saved conversation it is in; null for one that is not saved. */
  conversationId: string | null;
  /** How many messages are on screen. */
  messages: number;
}

export interface ChatModel {
  provider: string;
  /** The provider's name, as the picker shows it. */
  providerName: string;
  id: string;
  label: string;
}

export interface ConversationInfo {
  id: string;
  title: string;
  /** The folder it works in; empty for a plain chat. */
  dir: string;
  /** Seconds since 1970, at its last answer. */
  updated: number;
}

// ── The rest ──────────────────────────────────────────────────────────────────

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface RecapOptions {
  /** Sessions are counted, and the recap opens on its own each Monday. */
  enabled: boolean;
  /** Project names are left out of the shared image. */
  hideProjects: boolean;
}

export type RecapOption = "enabled" | "hideProjects";

export interface MochiNow {
  /** False where the desktop Mochi's window cannot be placed. */
  supported: boolean;
  onDesktop: boolean;
  asleep: boolean;
}

export interface AppHost {
  // ── Music (Spotify) ──
  music(): MusicNow;
  /** True when the player took it. */
  musicControl(action: MusicAction, value?: number): Promise<boolean>;
  /** Starts Spotify, or brings it forward. */
  openMusic(): Promise<boolean>;

  // ── Pills ──
  /** The pills this build offers. */
  pillCatalog(): readonly PillInfo[];
  /** The declared pills, without the main one, and the main one. */
  pills(): { active: string[]; main: string };
  /** Whether one more pill fits. What has a card of its own takes no slot. */
  pillFits(id: string): boolean;
  pillLimit(): number;
  /** Shows a pill that is hidden, hides one that is shown; saved. */
  togglePill(id: string): void;
  setMainPill(id: string): void;

  // ── Sessions ──
  /** The pills with something going on. */
  sessions(): SessionInfo[];
  /** Brings a session and its terminal to the front. False when the pill has none. */
  openSession(id: string): boolean;
  /** A session's last steps and its last message, oldest first, at most `lines`. */
  sessionOutput(id: string, lines: number): string[];

  // ── The card that waits ──
  /** The permission request waiting for an answer, if one is. */
  permission(): { agent: string; request: string } | null;
  /** The question an agent is waiting on, if one is. */
  agentQuestion(): AgentQuestion | null;
  /** Brings the waiting card up, answering nothing. False when none waits or it cannot be shown. */
  showWaitingCard(): boolean;
  /** Declines the waiting permission, as a click on Deny does. */
  declinePermission(): boolean;
  /** Answers the waiting question: question text → the label chosen, or the labels. */
  answerAgentQuestion(answers: Record<string, string | string[]>): boolean;

  // ── Timer ──
  timer(): { label: string; minutesLeft: number } | null;
  setTimer(minutes: number, label: string): void;
  cancelTimer(): boolean;

  // ── Apps, folders, addresses ──
  /** The installed apps' names. */
  apps(): Promise<readonly string[]>;
  /** The installed apps nearest a name, nearest first, each with how near (0…1). Opens nothing. */
  appsNear(said: string): Promise<readonly { name: string; score: number }[]>;
  /** Starts an installed app: its name and whether a window of it was seen to come, or null. */
  openApp(name: string): Promise<{ name: string; seen: boolean } | null>;
  /** The user's own folders that can be opened. */
  folders(): Awaitable<readonly { id: string; label: string; hint?: string }[]>;
  /** Opens one of them; its name, or null. */
  openFolder(id: string): Promise<string | null>;
  /** Opens an http(s) address in the browser. */
  openUrl(url: string): Awaitable<boolean>;

  // ── Views ──
  /**
   * The island's view and whether the island is open on it. A view `showView`
   * takes is named as it takes it ("chat"); any other by the island's own name.
   */
  currentView(): { view: string; open: boolean };
  /** Brings a view up, or the Settings window. False when it cannot be shown now. */
  showView(view: string): boolean;

  // ── Settings ──
  /** A setting's value now, by its key ("voice.followUp"). */
  setting(key: string): unknown;
  /** Changes it, saves, and reads it back: true when it now has that value. */
  setSetting(key: string, value: unknown): Promise<boolean>;
  /** The interface languages, each in its own name; "" is the system's. */
  languages(): Awaitable<readonly Option[]>;
  /** The displays the island can live on. */
  monitors(): Awaitable<readonly Option[]>;
  /** The models the bundled engine can hear with. */
  hearingModels(): Awaitable<readonly Option[]>;
  /** The embedding models of the server chosen for voice; "" is none. */
  embedModels(): Awaitable<readonly Option[]>;

  // ── Chat ──
  chat(): ChatNow;
  /** Opens the chat with this in its field, for the user to read. False when the chat cannot open. */
  prepareChat(message: string): boolean;
  /** Sends what the field holds, as its button does. True when it left. */
  sendChat(): Promise<boolean>;
  /** Ends the turn that is running. False when none is. */
  stopChat(): boolean;
  /** Starts a new conversation. */
  resetChat(): Promise<boolean>;
  /** The models the picker offers now, for every provider it shows. */
  chatModels(): Promise<readonly ChatModel[]>;
  /** Picks a provider and a model, saves, and reads it back. */
  setChatModel(provider: string, model: string): Promise<boolean>;
  /** The saved conversations, newest first. */
  conversations(): Promise<readonly ConversationInfo[]>;
  /** Opens one in the chat. */
  openConversation(id: string): Promise<boolean>;

  // ── Wardrobe ──
  /** Every outfit, "auto" and "none" included, in the wardrobe's order. */
  outfits(): readonly { id: string; label: string }[];
  /** What is picked now. */
  outfit(): string;
  /** Keeps an outfit, as a click in the wardrobe does. */
  wearOutfit(id: string): boolean;

  // ── Recap ──
  /** Its two switches, as they are now. */
  recapOptions(): RecapOptions;
  /** Last week in a few lines; empty when there was no activity. Null when it cannot be read. */
  recapLines(): Promise<readonly string[] | null>;
  /** Sets one switch and saves; true when it was saved. */
  setRecapOption(option: RecapOption, on: boolean): Promise<boolean>;

  // ── Mochi on the desktop ──
  mochi(): MochiNow;
  /** From the island to his spot on the desktop. False when he has none. */
  mochiFlyOut(): Promise<boolean>;
  /** Back into the island. */
  mochiFlyHome(): Promise<boolean>;
  setMochiAsleep(asleep: boolean): boolean;

  // ── Services ──
  /** The services shown as pills, each with what it last reported. */
  services(): ServiceInfo[];
  /** What a service's card says now, a line each. */
  serviceInfo(id: string): string[];
  /** Asks a service again now. False when it has nothing to ask with. */
  refreshService(id: string): Promise<boolean>;

  // ── The web ──
  /** Results for a search; `error` when the search could not be made (no key, no network). */
  webSearch(query: string): Promise<{ results: readonly WebResult[] } | { error: string }>;
  /** Opens the browser on a search, with the engine the user chose. */
  openWebSearch(query: string): Awaitable<boolean>;

  // ── Coucou itself ──
  /** Voice is on: the microphone may open. */
  listening(): boolean;
  /** Turns voice off (the microphone closes) and shows the way back on. */
  stopListening(): void;
  paused(): boolean;
  /** Pauses Coucou or lifts the pause, as the tray does. */
  setPaused(paused: boolean): void;
  quit(): void;
  /** A short note on screen. */
  notify(title: string, text?: string): void;
}
