// The chat: getting a message ready, stopping a turn, starting over, picking
// the model, going back to a saved conversation. Sending is the one thing
// here that leaves the machine for an agent or a provider: the exact words
// are shown, and only a click sends them.

import type { Call } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "chat";

/** A model as an entity's id: its provider, then its own id (which may hold a slash). */
const modelId = (provider: string, model: string) => `${provider}/${model}`;

export function chat(host: AppHost): Area {
  return {
    sources: [
      {
        kind: "chat_model",
        description: "The models the chat's picker offers now, each with its provider.",
        list: async () => (await host.chatModels()).map((m) => ({ id: modelId(m.provider, m.id), label: m.label, hint: m.providerName })),
      },
      {
        kind: "conversation",
        description: "The saved conversations of the chat, newest first, each with the folder it works in.",
        list: async () => (await host.conversations()).map((c) => ({ id: c.id, label: c.title, ...(c.dir ? { hint: c.dir } : {}) })),
      },
    ],
    capabilities: [
      capability({
        name: "read_chat",
        area: AREA,
        description: "Reads the chat's state: which provider and model it talks to, whether an answer is being written, and what its field holds unsent.",
        args: {},
        tier: "read",
        async run() {
          const now = host.chat();
          return done(`${now.provider} · ${now.model}`, true, {
            provider: now.provider, model: now.model, answering: now.busy, unsent: cut(now.draft, 300), messages: now.messages,
          });
        },
      }),
      capability({
        name: "prepare_chat_message",
        area: AREA,
        description: "Tells an agent such as Claude Code or Codex to do something — run, fix, change, explain — by writing the instruction in the chat's field, for the user to read and send themselves; nothing is sent. The instruction is written in the words it should be sent with.",
        args: { message: { type: "string", maxLength: 1000, description: "The message, in the words it should be sent with." } },
        tier: "free",
        async run(args) {
          const message = str(args.message).slice(0, 1000);
          if (!message) return failed(t("That cannot be shown right now"), "There is no message to prepare.");
          if (!host.prepareChat(message)) return failed(t("That cannot be shown right now"), "The chat cannot open now: a card is waiting, or Coucou is paused.");
          return done(t("It is in the chat: read it and send it yourself"), host.chat().draft === message);
        },
      }),
      capability({
        name: "send_chat_message",
        area: AREA,
        description: "Sends the message that is in the chat's field to the agent or the provider the chat talks to. The user is shown the exact words and must click to send. Use prepare_chat_message first to write the message.",
        args: {},
        tier: "confirm",
        available: () => (host.chat().draft.trim() ? (host.chat().busy ? t("The chat is still answering") : true) : t("The chat has no message to send")),
        describe() {
          const now = host.chat();
          return { title: t("Send this message?"), change: `${now.provider} · ${now.model}: ${cut(now.draft, 300)}`, action: t("Send") };
        },
        async run() {
          const now = host.chat();
          if (!now.draft.trim()) return failed(t("The chat has no message to send"));
          if (now.busy) return failed(t("The chat is still answering"));
          if (!(await host.sendChat())) return failed(t("That did not work"), "The message was not sent.");
          return done(t("Sent"), host.chat().draft === "");
        },
      }),
      capability({
        name: "stop_chat",
        area: AREA,
        description: "Stops the answer the chat is writing now. Not for the music, and not for the microphone.",
        args: {},
        tier: "free",
        available: () => (host.chat().busy ? true : t("The chat is not answering")),
        async run() {
          if (!host.stopChat()) return failed(t("The chat is not answering"));
          return done(t("Stopped"), !host.chat().busy);
        },
      }),
      capability({
        name: "new_chat",
        area: AREA,
        description: "Starts a new conversation in the chat. A saved conversation can be opened again; one that is not saved is asked about first, because it is lost.",
        args: {},
        tier: "reversible",
        inverse: (): Call | null => {
          const id = host.chat().conversationId;
          return id ? { name: "open_conversation", arguments: { conversation: id } } : null;
        },
        async run(_args, context) {
          const now = host.chat();
          if (now.busy) return failed(t("The chat is still answering"));
          if (now.messages > 0 && !now.conversationId) {
            const answer = await context.ask({ kind: "yes_no", question: t("Start a new chat? This one is not saved.") });
            if (answer.kind !== "yes_no" || !answer.yes) return done(t("OK, leaving it as is"), true);
          }
          if (!(await host.resetChat())) return failed(t("That did not work"), "The chat could not be started over.");
          return done(t("New chat"), host.chat().messages === 0);
        },
      }),
      capability({
        name: "pick_chat_model",
        area: AREA,
        description: "Picks the provider and the model the chat talks to, among those its picker offers. Not the model voice itself uses.",
        args: { model: { type: "entity", kind: "chat_model", description: "The model to use." } },
        tier: "reversible",
        inverse: (args) => {
          const now = host.chat();
          const before = modelId(now.provider, now.model);
          return before === str(args.model) ? null : { name: "pick_chat_model", arguments: { model: before } };
        },
        async run(args) {
          const id = str(args.model);
          const model = (await host.chatModels()).find((m) => modelId(m.provider, m.id) === id);
          if (!model) return failed(t("Not found: {0}", { 0: cut(id, 40) }), "The chat's picker does not offer that model now.");
          if (!(await host.setChatModel(model.provider, model.id))) return failed(t("That did not change"), "The model was not saved.");
          const now = host.chat();
          return done(`${model.providerName} · ${model.label}`, now.provider === model.provider && now.model === model.id);
        },
      }),
      capability({
        name: "list_conversations",
        area: AREA,
        description: "Reads the chat's saved conversations, newest first: their titles and the folders they work in.",
        args: {},
        tier: "read",
        async run() {
          const list = (await host.conversations()).slice(0, 20);
          if (!list.length) return done(t("No conversations yet"), true, []);
          return done(cut(list.map((c) => c.title).join(" · "), 160), true, list.map((c) => ({
            title: cut(c.title, 80), folder: c.dir, last_answer: new Date(c.updated * 1000).toISOString().slice(0, 10),
          })));
        },
      }),
      capability({
        name: "open_conversation",
        area: AREA,
        description: "Opens one of the chat's saved conversations, to read it or carry on from it.",
        args: { conversation: { type: "entity", kind: "conversation", description: "The conversation, by its title." } },
        tier: "free",
        async run(args) {
          const id = str(args.conversation);
          const found = (await host.conversations()).find((c) => c.id === id);
          if (!found) return failed(t("Not found: {0}", { 0: cut(id, 40) }), "No saved conversation by that name.");
          if (host.chat().busy) return failed(t("The chat is still answering"));
          if (!(await host.openConversation(id))) return failed(t("That cannot be shown right now"), "The conversation could not be opened.");
          return done(cut(found.title, 80), host.chat().conversationId === id);
        },
      }),
    ],
  };
}
