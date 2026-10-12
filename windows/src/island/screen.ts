// What each view shows, in the terms the app's capabilities use
// (core/capabilities/types.ts `ScreenContext`): the things it is about, the
// most prominent first, and a line or two of what is written on it. This is
// what "this", "that one" and "what does it say" mean to the assistant.
//
// Read from the same state the views draw from; nothing here draws. Each
// view is given its entry when the views are built (views/views.ts).

import type { ScreenContext } from "../core/capabilities/types";
import { lastTextStep } from "../core/diff";
import type { IslandViewName } from "../core/layout";
import { pillDefinition } from "../core/pills";
import { activeModel, providerDef } from "../core/providers";
import { SPOTIFY_ID, Spotify } from "../core/spotify";
import { State, type AgentTask } from "../core/state";
import { t } from "../i18n/i18n";
import { OUTFIT_KEYS, parseOutfit } from "../mochi/wardrobe";
import { Recap } from "../recap/recap";
import { weekRangeLabel } from "../recap/summary";
import { ChatControls } from "../views/chat";
import { WebCard } from "../views/websearch";

/** What a view says of itself; the island adds its name. */
export type Shown = Omit<ScreenContext, "view">;

type Subject = ScreenContext["subjects"][number];

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** A pill as the kind of thing it is here: a session when it has one going, a service, else a pill. */
function subjectOf(task: AgentTask): Subject {
  const category = pillDefinition(task.id)?.category;
  const kind = !task.isIntegration ? "session" : category === "service" ? "service" : "pill";
  return { kind, id: task.id, label: task.name };
}

/** The pill in front and what it last said. */
function focused(): Shown {
  const task = State.focusTask;
  if (!task) return { subjects: [] };
  const line = task.finalLine || lastTextStep(task.steps) || "";
  return { subjects: [subjectOf(task)], summary: cut(`${task.name} (${task.state})${line ? `: ${line}` : ""}`, 300) };
}

/** The card that waits: who asks, and for what. */
function waiting(): Shown {
  const pending = State.pendingApproval;
  if (!pending) return { subjects: [] };
  const name = pillDefinition(pending.pillId)?.name ?? pending.pillId;
  const subjects: Subject[] = [{ kind: "session", id: pending.pillId, label: name }];
  if (!pending.questions) return { subjects, summary: cut(`${name} asks permission for ${pending.tool}: ${pending.command}`, 300) };
  const first = pending.questions[0];
  return { subjects, summary: cut(`${name} asks: ${first?.question ?? ""} (${(first?.options ?? []).map((o) => o.label).join(", ")})`, 300) };
}

export const VIEW_SCREENS: Partial<Record<IslandViewName, () => Shown>> = {
  overview() {
    const front = focused();
    const others = State.tasks.filter((task) => task.id !== State.focusTask?.id).map(subjectOf);
    const playing = State.focusTask?.id === SPOTIFY_ID && Spotify.state.track
      ? `${Spotify.state.track.title} — ${Spotify.state.track.artist}` : "";
    return { subjects: [...front.subjects, ...others], summary: playing ? cut(playing, 300) : front.summary };
  },
  approval: waiting,
  question: waiting,
  finished: focused,
  error: focused,
  prompt() {
    const provider = providerDef(State.settings.chatProvider);
    const model = activeModel(State.settings);
    const subjects: Subject[] = [{ kind: "chat_model", id: `${provider.id}/${model}`, label: model }];
    const first = State.chatHistory.find((m) => m.role === "user");
    if (State.conversationId && first) subjects.push({ kind: "conversation", id: State.conversationId, label: cut(first.content, 60) });
    const last = State.chatHistory[State.chatHistory.length - 1];
    const parts = [`${t(provider.name)} · ${model}`, `${State.chatHistory.length} messages`];
    if (ChatControls.busy()) parts.push("an answer is being written");
    if (ChatControls.draft().trim()) parts.push(`unsent in the field: ${cut(ChatControls.draft().trim(), 120)}`);
    if (last?.role === "assistant" && last.content) parts.push(`last answer: ${cut(last.content.replace(/\s+/g, " "), 160)}`);
    return { subjects, summary: parts.join("; ") };
  },
  wardrobe() {
    const worn = parseOutfit(State.settings.mochiOutfit);
    return { subjects: [{ kind: "outfit", id: worn, label: t(OUTFIT_KEYS[worn]) }] };
  },
  recap() {
    const week = Recap.summary;
    return { subjects: [], ...(week ? { summary: `${weekRangeLabel(week)}: ${week.sessionCount} sessions` } : {}) };
  },
  webAnswer() {
    const card = WebCard.state;
    if (card.phase !== "done") return { subjects: [] };
    return { subjects: [], summary: cut(`${card.data.question}: ${card.data.answer}`, 300) };
  },
};
