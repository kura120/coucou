// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "upload"
  | "uploading"
  | "choose"
  | "mail"
  | "prompt"
  | "searching"
  | "result"
  | "note"
  | "settings"
  | "greeting"
  | "recap"
  | "wardrobe"
  | "listening";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The window is a fixed 880×800 (widest view: the overview with the music
// card next to the pills; tallest: the chat pulled all the way down — the
// Mac's panel is 720×640); the island is drawn inside it, glued to the top
// edge and horizontally centred.
export const PANEL_W = 880;
export const PANEL_H = 800;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;
/** The music card next to the pills, and the gap before it: what the overview widens by. */
export const MUSIC_CARD_W = 176;
export const MUSIC_CARD_GAP = 10;

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "pills" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  approval: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  question: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "column" },
  upload: { height: 176, botX: 140, botY: 104, botDiameter: 62, agentMode: "column" },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar. The Swift
  // layout says 118 while its own comment says 103; the comment matches the spec.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20, agentMode: "none" },
  choose: { height: 176, botX: 60, botY: 101, botDiameter: 52, agentMode: "column" },
  mail: { height: 240, botX: 56, botY: null, botDiameter: 46, agentMode: "column" },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  searching: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  result: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
  // Mac: 160. The extra 24 hold the two lines with top agent, project, busiest
  // day, longest session, permissions and questions, which the Mac card leaves
  // to the shared image.
  recap: { height: 184, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  wardrobe: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "none" },
  // "OK Coucou": Mochi listening on the left, what he hears on the right.
  listening: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "none" },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — Mochi included — is drawn by src/upload, which
// owns its own constants (USC) straight from UploadSequenceEngine.swift.

/** The question view with options to pick from: room for two rows of them. */
export const QUESTION_PICKER_H = 200;

/** The chat with its provider and model picker open: room to read the list. */
export const CHAT_PICKER_H = 520;

/** How short and how tall the chat can be dragged. */
export const CHAT_MIN_H = 300;
export const CHAT_MAX_H = PANEL_H - 20;
/** The chat as it opens, and how far it grows by itself with the conversation. */
const CHAT_GROWN_H = 400;
const CHAT_GROWTH_PER_MESSAGE = 25;
/** Kept clear under the island on a screen shorter than the window. */
const SCREEN_MARGIN = 40;

/**
 * The tallest the chat can be here: what the window shows, and never past the
 * bottom of a screen that is shorter than the window (a 768 px laptop).
 */
export function chatMaxHeight(): number {
  const screenH = typeof window !== "undefined" ? window.screen?.availHeight : undefined;
  if (!screenH || !Number.isFinite(screenH)) return CHAT_MAX_H;
  return Math.max(CHAT_MIN_H, Math.min(CHAT_MAX_H, screenH - SCREEN_MARGIN));
}

/** A height the user dragged the chat to, kept within what the window can show. */
export function clampChatHeight(h: number): number {
  return Math.round(Math.min(chatMaxHeight(), Math.max(CHAT_MIN_H, h)));
}

/**
 * Chat view grows with the conversation — IslandContainer.chatPromptHeight —
 * until the user drags its lower edge: it then keeps that height (`userHeight`,
 * 0 when not dragged) for as long as the island stays open.
 */
export function chatPromptHeight(messageCount: number, picking = false, userHeight = 0): number {
  if (userHeight > 0) {
    const h = clampChatHeight(userHeight);
    return picking ? Math.max(Math.min(CHAT_PICKER_H, chatMaxHeight()), h) : h;
  }
  if (picking) return Math.min(CHAT_PICKER_H, chatMaxHeight());
  return Math.min(CHAT_GROWN_H, CHAT_MIN_H + messageCount * CHAT_GROWTH_PER_MESSAGE);
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
  chatPicking = false,
  chatUserHeight = 0,
  musicCard = false,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      const h = view === "prompt" ? chatPromptHeight(chatCount, chatPicking, chatUserHeight) : VIEW_LAYOUTS[view].height;
      // Only the overview has the music card, so only it grows for it.
      const w = EXPANDED_W + (musicCard && view === "overview" ? MUSIC_CARD_W + MUSIC_CARD_GAP : 0);
      return { w, h };
    }
  }
}

/**
 * The room the compact island has for what is playing: from after Mochi to
 * before the little Mochis, which take two columns, or three (`columns`). The
 * compact island's own width is used, not the island's as it is drawn: the
 * line is placed while the island is still shrinking to it.
 */
export function nowPlayingRoom(columns: number): { left: number; width: number } {
  const left = 60;
  const gridLeft = COMPACT_W - 40 - 14.5 - (Math.max(2, columns) - 2) * 16;
  return { left, width: Math.max(0, Math.floor(gridLeft - 8 - left)) };
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        return {
          cx: 36 + uploadProgress * 526,
          cy: layout.botY ?? 103,
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Project colours (IslandConst.projectColors)
const PROJECT_COLORS: Record<string, string> = {
  korus: "#FF5A4E",
  "sbe hub": "#2EC4A0",
  "morning ai brief": "#F29B38",
  "publication ig": "#7C5CFF",
  "ig post": "#7C5CFF",
  "louisraille.fr": "#38BDF8",
  louisraille: "#38BDF8",
  "notch buddy": "#EC4899",
  "notch-buddy": "#EC4899",
  notchbuddy: "#EC4899",
};

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
