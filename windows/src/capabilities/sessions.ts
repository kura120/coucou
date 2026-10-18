// The agents' sessions: what each is doing, its recent output, and bringing
// one and its terminal to the front. Nothing here writes to a session.

import { sessionSubtitle } from "../core/pills";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "sessions";

/** How many lines of a session's output a model is given at most. */
const MOST_LINES = 20;

export function sessions(host: AppHost): Area {
  const find = (id: string) => host.sessions().find((s) => s.id === id);
  /** The agent a session runs, as its card names it ("Claude Code" in the VS Code pill); null when the card says only "Agent". */
  const agentOf = (id: string, name: string): string | null => {
    const agent = sessionSubtitle(id);
    return agent === sessionSubtitle("") || agent === name ? null : agent;
  };

  return {
    sources: [
      {
        kind: "session",
        description: "The agents' sessions with something going on, each by its pill's name and the agent it runs, with its state.",
        list: () => host.sessions().map((s) => {
          const agent = agentOf(s.id, s.name);
          return { id: s.id, label: s.name, ...(agent ? { spoken: [agent] } : {}), hint: cut(`${agent ? `${agent}, ` : ""}${s.state}${s.doing ? `: ${s.doing}` : ""}`, 80) };
        }),
      },
    ],
    capabilities: [
      capability({
        name: "list_sessions",
        area: AREA,
        description: "Reads the agents' sessions: which are running, each one's state and what it is doing in a few words.",
        args: {},
        tier: "read",
        inSnapshot: true,
        async run() {
          const list = host.sessions().map(({ id, name, state, doing }) => {
            const agent = agentOf(id, name);
            return { name, ...(agent ? { agent } : {}), state, doing: cut(doing, 120) };
          });
          return list.length
            ? done(list.map((s) => s.name).join(", "), true, list)
            : done(t("Nothing running right now."), true, []);
        },
      }),
      capability({
        name: "read_session_output",
        area: AREA,
        description: "Reads the last steps and the last message of one agent's session, for a question about what it did or said. list_sessions gives only a few words each.",
        args: {
          session: { type: "entity", kind: "session", description: "The session to read." },
          lines: { type: "number", min: 1, max: MOST_LINES, optional: true, description: "How many of its last lines; 8 when not given." },
        },
        tier: "read",
        async run(args) {
          const session = find(str(args.session));
          if (!session) return failed(t("Nothing running right now."), "That session is not running.");
          const most = Math.round(Math.max(1, Math.min(MOST_LINES, Number(args.lines) || 8)));
          const lines = host.sessionOutput(session.id, most).slice(-most).map((line) => cut(line, 300));
          if (!lines.length) return done(t("Nothing to report"), true, { session: session.name, state: session.state, lines: [] });
          return done(cut(lines[lines.length - 1], 160), true, { session: session.name, state: session.state, lines });
        },
      }),
      capability({
        name: "open_session",
        area: AREA,
        description: "Brings an agent's session and its terminal window to the front, to look at it. Not for starting an application, and not for switching the main workspace tool.",
        args: { session: { type: "entity", kind: "session", description: "The session to bring forward." } },
        tier: "free",
        async run(args) {
          const session = find(str(args.session));
          if (!session || !host.openSession(session.id)) return failed(t("Nothing running right now."), "That session is not running.");
          // The pill comes to the front here; whether its terminal's window came is the system's.
          return done(session.name, false);
        },
      }),
    ],
  };
}
