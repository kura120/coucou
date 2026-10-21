// Peika itself: its microphone, its pause, quitting, a note on screen — and
// the few capabilities that are about the conversation rather than the app:
// putting the last thing back, doing nothing, handing over to a stronger
// model, and asking to see more of what the app can do.

import type { Registry, RunContext, ToolResult } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "app";

// These two leave nobody to put a mistake right by voice, so they are asked first. The app's own interface is the click already.
async function askedFirst(context: RunContext | undefined, question: string, yes: string, no: string): Promise<ToolResult | null> {
  if (!context || context.origin === "ui") return null;
  const answer = await context.ask({ kind: "yes_no", question, yes, no });
  if (answer.kind === "yes_no" && answer.yes) return null;
  return { ...done(t("OK, leaving it as is"), false), detail: "Nothing was changed: the user did not say yes." };
}

/** `registry`: what `undo` and `more_tools` read. `areas`: the names of every area declared. */
export function system(host: AppHost, registry: Pick<Registry, "undo" | "areas" | "get" | "execute" | "lastChange" | "named" | "all">, areas: readonly string[]): Area {
  return {
    sources: [],
    capabilities: [
      capability({
        name: "stop_listening",
        area: AREA,
        description: "Turns Peika's own voice control off altogether: its microphone closes and nothing said is heard until the user turns it back on in Settings. Only when they ask for Peika's voice, listening or microphone to be off. Never for the music, a song or Spotify — stopping those is pause_music — and never for being done with a request, which is nothing. The user is asked first.",
        args: {},
        // Closing the microphone is never made hard. Opening it again is the user's: there is no inverse.
        tier: "free",
        async check(_args, context) {
          return askedFirst(context, t("Turn voice off?"), t("Turn off"), t("Keep listening"));
        },
        async run() {
          host.stopListening();
          return host.listening() ? failed(t("That did not change"), "Voice is still on.") : done(t("Voice is off"), true);
        },
      }),
      capability({
        name: "pause_peika",
        area: AREA,
        description: "Takes the whole Peika app off duty, as the Pause of its tray menu does: the island hides and the services are no longer asked, until it is resumed. Only when the user names Peika, the app or the island: a pause with nothing named is the music's (pause_music). The user is asked first.",
        args: {},
        tier: "reversible",
        inverse: () => (host.paused() ? null : { name: "resume_peika", arguments: {} }),
        // Asked before it is done, not after: a no leaves nothing to put back.
        async check(_args, context) {
          return askedFirst(context, t("Pause Peika?"), t("Pause"), t("Keep going"));
        },
        async run() {
          host.setPaused(true);
          return host.paused() ? done(t("Paused"), true) : failed(t("That did not change"));
        },
      }),
      capability({
        name: "resume_peika",
        area: AREA,
        description: "Lifts Peika's pause: the island comes back and the services are asked again. Not for resuming the music.",
        args: {},
        tier: "reversible",
        available: () => (host.paused() ? true : t("Peika is not paused")),
        inverse: () => (host.paused() ? { name: "pause_peika", arguments: {} } : null),
        async run() {
          host.setPaused(false);
          return host.paused() ? failed(t("That did not change")) : done(t("Peika is back"), true);
        },
      }),
      capability({
        name: "quit_peika",
        area: AREA,
        description: "Quits Peika: the app closes and nothing is shown or listened for until it is started again. The user must click to confirm. To stop only for a while, it is pause_peika.",
        args: {},
        tier: "confirm",
        describe: () => ({ title: t("Quit Peika?"), change: t("Peika closes until you start it again."), action: t("Quit") }),
        async run() {
          host.quit();
          // The app is going; nothing is left to look.
          return done(t("Quitting"), false);
        },
      }),
      capability({
        name: "notify",
        area: AREA,
        description: "Shows a short note on screen, now. Not a reminder for later: that is set_timer.",
        args: { text: { type: "string", maxLength: 140, description: "The note, in a few words." } },
        tier: "free",
        async run(args) {
          const text = cut(str(args.text), 140);
          if (!text) return failed(t("That cannot be shown right now"), "There is nothing to show.");
          host.notify(text);
          // The note is handed to the system; whether it is on screen is not read.
          return done(text, false);
        },
      }),
      capability({
        name: "undo",
        area: AREA,
        description: "Puts back the last thing that was changed here and can be put back: a pill, a setting, the music, the timer, an outfit.",
        args: {},
        tier: "free",
        run: (_args, context) => registry.undo(context),
      }),
      capability({
        name: "find",
        area: AREA,
        description: "Looks a name up within Peika: what it is — a pill, an app, a service, a setting, a session, a view… or several of them at once — whether it was heard exactly or only nearly, and which capabilities take it. For a name you are not sure of, before acting on it.",
        args: { name: { type: "string", maxLength: 80, description: "The name, as the user said it." } },
        tier: "read",
        async run(args) {
          const name = cut(str(args.name), 80);
          if (!name) return failed(t("Command not recognised"), "A name is needed.");
          const found = await registry.named(name);
          const takers = (kind: string) => registry.all().filter((c) => Object.values(c.args).some((spec) => (spec.type === "entity" || spec.type === "entities") && spec.kind === kind)).map((c) => c.name);
          // One thing with several faces (GitHub is a pill and a service) is said once, with its faces.
          const things = new Map<string, { label: string; as: { kind: string; id: string; takes: string[] }[]; heard_exactly: boolean }>();
          for (const thing of found) {
            const key = thing.label.toLowerCase();
            const entry = things.get(key) ?? { label: thing.label, as: [], heard_exactly: false };
            entry.as.push({ kind: thing.kind, id: thing.id, takes: takers(thing.kind) });
            entry.heard_exactly ||= !thing.near;
            things.set(key, entry);
          }
          return done("", true, { looked_for: name, found: [...things.values()] });
        },
      }),
      capability({
        name: "instead",
        area: AREA,
        description: "Corrects the last change: puts it back and does it again with the thing the user meant instead — for \"no, I meant Resend\", \"no, Vercel\", \"Resend instead\" right after a change. Give the thing as the user said it. To only put the last change back, it is undo.",
        args: { meant: { type: "string", maxLength: 80, description: "The thing meant instead, in the user's words." } },
        tier: "free",
        available: () => (registry.lastChange() ? true : t("There is nothing to put back")),
        async run(args, context) {
          const change = registry.lastChange();
          const meant = cut(str(args.meant), 80);
          if (!change) return failed(t("There is nothing to put back"), "Nothing was changed that can be corrected.");
          if (!meant) return failed(t("Command not recognised"), "Say what was meant instead.");
          // The last change's thing to name, to be named again: one argument that is a thing of the app.
          const named = Object.entries(registry.get(change.call.name)?.args ?? {}).find(([, spec]) => spec.type === "entity" || spec.type === "entities");
          if (!named) return failed(t("That did not change"), "The last change names no thing to replace.");
          const back = await registry.undo(context);
          if (back.status !== "done") return back;
          const [arg, spec] = named;
          // What was meant is what was just put back ("can you add it back" after GitHub was removed): it is only put back.
          const kind = spec.type === "entity" || spec.type === "entities" ? spec.kind : "";
          const before = change.call.arguments[arg];
          const originals = Array.isArray(before) ? before : [before];
          const meantIds = (await registry.named(meant)).filter((thing) => !thing.near && thing.kind === kind).map((thing) => thing.id);
          // Given as a name, or as the id a model read in last_change.
          if (originals.includes(meant) || meantIds.some((id) => originals.includes(id))) return { ...back, data: { put_back: change.call, note: "What was meant is what was put back: it is only put back." } };
          const again = await registry.execute({ name: change.call.name, arguments: { ...change.call.arguments, [arg]: spec.type === "entities" ? [meant] : meant } }, context);
          // Both said: what was put back, and what was done in its place.
          return again.status === "done" ? { ...again, line: [back.line, again.line].filter(Boolean).join(". "), data: { put_back: change.call, then: again.data ?? again.line } } : again;
        },
      }),
      capability({
        name: "nothing",
        area: AREA,
        description: "Does nothing. For when the user changed their mind, is done, only thanked, said not to do something, or when what was heard was said to someone else and is not a request to Peika.",
        args: {},
        tier: "free",
        async run() {
          return done("", true);
        },
      }),
      capability({
        name: "ask_user",
        area: AREA,
        description: "Asks the user a short question on screen and waits for the answer: for when what they meant is not sure — a name that may be misheard, two things it could be. Give the likely answers as options (two to four), or none for a yes or no. What they answer comes back; then do what it says.",
        args: {
          question: { type: "string", maxLength: 160, description: "The question, short, as Peika asks it." },
          option_1: { type: "string", maxLength: 60, optional: true, description: "A likely answer." },
          option_2: { type: "string", maxLength: 60, optional: true, description: "Another likely answer." },
          option_3: { type: "string", maxLength: 60, optional: true, description: "Another." },
          option_4: { type: "string", maxLength: 60, optional: true, description: "Another." },
        },
        tier: "free",
        async run(args, context) {
          const question = cut(str(args.question), 160);
          if (!question) return failed(t("Command not recognised"), "A question is needed.");
          const options = [...new Set([args.option_1, args.option_2, args.option_3, args.option_4].map((o) => cut(str(o), 60)).filter(Boolean))];
          const answer = await context.ask(
            options.length >= 2
              ? { kind: "choice", question, options: options.map((label, i) => ({ id: String(i + 1), label })) }
              : { kind: "yes_no", question },
          );
          // The answer is for the model, which goes on from it; the card shows nothing of its own for asking.
          const said =
            answer.kind === "choice" ? options[Number(answer.id) - 1] ?? ""
            : answer.kind === "yes_no" ? (answer.yes ? "yes" : "no")
            : answer.kind === "text" ? answer.value
            : "";
          return said ? done("", true, { asked: question, answered: said }) : done("", true, { asked: question, answered: null, note: "The user did not answer: do nothing more." });
        },
      }),
      capability({
        name: "escalate",
        area: AREA,
        description: "Hands the request to a stronger model, when it needs more reasoning, more steps or more knowledge than can be given here. Not for what a capability here already does.",
        args: { reason: { type: "string", maxLength: 200, optional: true, description: "What is beyond reach, in a few words." } },
        tier: "free",
        async run(args) {
          // Nothing is done here: the turn reads this and goes to the next tier, when the user allowed one.
          return done("", false, { escalate: true, reason: cut(str(args.reason), 200) });
        },
      }),
      capability({
        name: "more_tools",
        area: AREA,
        description: "Lists what else Peika can do. Without an area: the areas. With one: every capability of that area, to call next. For when none of the capabilities shown does what was asked.",
        args: { area: { type: "string", enum: areas, optional: true, description: "The area to list." } },
        tier: "read",
        async run(args) {
          const all = registry.areas();
          const wanted = str(args.area);
          if (!wanted) return done("", true, { areas: all.map(({ area, names }) => ({ area, capabilities: names })) });
          const found = all.find(({ area }) => area === wanted);
          if (!found) return { ...failed(t("Not found: {0}", { 0: cut(wanted, 40) }), "Peika has no area by that name."), near: all.map(({ area }) => area) };
          return done("", true, {
            area: found.area,
            capabilities: found.names.map((name) => ({ name, description: registry.get(name)?.description ?? "" })),
          });
        },
      }),
    ],
  };
}
