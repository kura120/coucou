// The card that waits for the user: an agent's permission request, or a
// question it asked. Reading and showing are free. Declining and answering
// cannot be put back, so each shows the exact change and takes a click.
//
// Approving a permission is not here, and is nowhere: it takes a click on the
// card itself.

import type { Entity } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AgentQuestion, AppHost } from "./host";
import { capability, cut, ids, type Area } from "./shared";

const AREA = "permissions";

/** An option of the waiting question, as an entity's id: which question, which option. */
const optionId = (question: number, option: number) => `${question + 1}.${option + 1}`;

export function permissions(host: AppHost): Area {
  const options = (asked: AgentQuestion | null): (Entity & { question: number; option: number })[] =>
    (asked?.questions ?? []).flatMap((q, question) =>
      q.options.map((o, option) => ({
        id: optionId(question, option), label: o.label, hint: cut(q.question, 80), question, option,
      })));

  /** The answers a list of chosen options means, or why it is not an answer. */
  function answersOf(asked: AgentQuestion, chosen: readonly string[]): { answers: Record<string, string | string[]> } | { why: string } {
    const all = options(asked);
    const picked = chosen.map((id) => all.find((o) => o.id === id));
    if (!picked.length || picked.some((o) => !o)) return { why: "An option given is not one of the question's." };
    const answers: Record<string, string | string[]> = {};
    for (const [index, q] of asked.questions.entries()) {
      const labels = picked.filter((o) => o!.question === index).map((o) => o!.label);
      if (!labels.length) return { why: `No option was chosen for: ${cut(q.question, 120)}` };
      if (labels.length > 1 && !q.multiSelect) return { why: `Only one option may be chosen for: ${cut(q.question, 120)}` };
      answers[q.question] = q.multiSelect ? labels : labels[0];
    }
    return { answers };
  }

  const answerLine = (answers: Record<string, string | string[]>) =>
    Object.values(answers).map((a) => (Array.isArray(a) ? a.join(", ") : a)).join(" · ");

  return {
    sources: [
      {
        kind: "question_option",
        description: "The options of the question an agent is waiting on, each with the question it answers.",
        list: () => options(host.agentQuestion()).map(({ id, label, hint }) => ({ id, label, hint })),
      },
    ],
    capabilities: [
      capability({
        name: "read_permission_request",
        area: AREA,
        description: "Reads the permission request that is waiting for an answer: which agent asks, and for what.",
        args: {},
        tier: "read",
        inSnapshot: true,
        async run() {
          const waiting = host.permission();
          if (!waiting) return done(t("No request is waiting"), true, null);
          return done(cut(`${waiting.agent}: ${waiting.request}`, 160), true, { agent: waiting.agent, request: cut(waiting.request, 160) });
        },
      }),
      capability({
        name: "show_waiting_card",
        area: AREA,
        description: "Brings up the card that waits for the user — a permission request or an agent's question — for them to read, and to allow, approve or answer it with their own click. The right one when they ask to approve or allow a request: approving takes their click on the card.",
        args: {},
        tier: "free",
        available: () => (host.permission() || host.agentQuestion() ? true : t("No request is waiting")),
        async run() {
          if (!host.permission() && !host.agentQuestion()) return failed(t("No request is waiting"));
          return host.showWaitingCard() ? done("", false) : failed(t("That cannot be shown right now"));
        },
      }),
      capability({
        // The name a model reaches for when it is asked to allow a request (measured: it called one that did
        // not exist). It approves nothing: it brings the card up, and only the user's click on Allow approves.
        name: "approve_permission_request",
        area: AREA,
        description: "What to call when the user asks to allow, approve or accept the permission request that waits (\"yeah allow it\", \"approve it\", \"go ahead\"). Voice cannot approve: this brings the request's card up, and the user clicks Allow on it themselves. Never decline_permission for this.",
        args: {},
        tier: "free",
        available: () => (host.permission() ? true : t("No request is waiting")),
        async run() {
          if (!host.permission()) return failed(t("No request is waiting"));
          return host.showWaitingCard() ? done(t("Click Allow on the card to approve it"), true) : failed(t("That cannot be shown right now"));
        },
      }),
      capability({
        name: "decline_permission",
        area: AREA,
        description: "Declines the permission request that is waiting: the agent is told no. Only when the user clearly wants it refused. There is no way to approve a request from here.",
        args: {},
        tier: "confirm",
        available: () => (host.permission() ? true : t("No request is waiting")),
        describe() {
          const waiting = host.permission();
          return {
            title: t("Decline this request?"),
            change: waiting ? cut(`${waiting.agent}: ${waiting.request}`, 160) : t("No request is waiting"),
            action: t("Deny"),
          };
        },
        async run() {
          if (!host.permission()) return failed(t("No request is waiting"));
          if (!host.declinePermission()) return failed(t("That did not change"), "The request could not be declined.");
          return done(t("Denied"), host.permission() == null);
        },
      }),
      capability({
        name: "read_agent_question",
        area: AREA,
        description: "Reads the question an agent asked and is waiting on, with the options it offers.",
        args: {},
        tier: "read",
        inSnapshot: true,
        async run() {
          const asked = host.agentQuestion();
          if (!asked) return done(t("No request is waiting"), true, null);
          return done(cut(asked.questions[0]?.question ?? "", 160), true, {
            agent: asked.agent,
            questions: asked.questions.map((q) => ({
              question: cut(q.question, 200),
              options: q.options.map((o) => cut(o.label, 80)),
              several_allowed: q.multiSelect,
            })),
          });
        },
      }),
      capability({
        name: "answer_agent_question",
        area: AREA,
        description: "Answers the question an agent is waiting on with the options the user chose, one for each question unless it allows several. The answer is sent to the agent once the user clicks.",
        args: { options: { type: "entities", kind: "question_option", max: 12, description: "The options chosen, among those the question offers." } },
        tier: "confirm",
        available: () => (host.agentQuestion() ? true : t("No request is waiting")),
        describe(args) {
          const asked = host.agentQuestion();
          const made = asked ? answersOf(asked, ids(args.options)) : null;
          return {
            title: t("Send this answer?"),
            change: made && "answers" in made
              ? cut(`${asked!.agent}: ${answerLine(made.answers)}`, 200)
              : t("No request is waiting"),
            action: t("Send"),
          };
        },
        async run(args) {
          const asked = host.agentQuestion();
          if (!asked) return failed(t("No request is waiting"));
          const made = answersOf(asked, ids(args.options));
          if ("why" in made) return failed(t("That did not change"), made.why);
          if (!host.answerAgentQuestion(made.answers)) return failed(t("That did not change"), "The answer could not be sent.");
          return done(cut(answerLine(made.answers), 120), host.agentQuestion() == null);
        },
      }),
    ],
  };
}
