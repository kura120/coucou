// Coucou itself: its microphone, its pause, quitting, a note on screen — and
// the few capabilities that are about the conversation rather than the app:
// putting the last thing back, doing nothing, handing over to a stronger
// model, and asking to see more of what the app can do.

import type { Registry } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "coucou";

/** `registry`: what `undo` and `more_tools` read. `areas`: the names of every area declared. */
export function system(host: AppHost, registry: Pick<Registry, "undo" | "areas" | "get">, areas: readonly string[]): Area {
  return {
    sources: [],
    capabilities: [
      capability({
        name: "stop_listening",
        area: AREA,
        description: "Turns voice off altogether: the microphone closes until the user turns it back on. Only when they ask for the voice or the microphone to be off — being done with a request is 'nothing', and stopping the music is pause_music.",
        args: {},
        // Closing the microphone is never made hard. Opening it again is the user's: there is no inverse.
        tier: "free",
        async run() {
          host.stopListening();
          return host.listening() ? failed(t("That did not change"), "Voice is still on.") : done(t("Voice is off"), true);
        },
      }),
      capability({
        name: "pause_coucou",
        area: AREA,
        description: "Takes the whole Coucou app off duty, as the Pause of its tray menu does: the island hides and the services are no longer asked, until it is resumed. Only when the user names Coucou, the app or the island: a pause with nothing named is the music's (pause_music).",
        args: {},
        tier: "reversible",
        inverse: () => (host.paused() ? null : { name: "resume_coucou", arguments: {} }),
        async run() {
          host.setPaused(true);
          return host.paused() ? done(t("Paused"), true) : failed(t("That did not change"));
        },
      }),
      capability({
        name: "resume_coucou",
        area: AREA,
        description: "Lifts Coucou's pause: the island comes back and the services are asked again. Not for resuming the music.",
        args: {},
        tier: "reversible",
        available: () => (host.paused() ? true : t("Coucou is not paused")),
        inverse: () => (host.paused() ? { name: "pause_coucou", arguments: {} } : null),
        async run() {
          host.setPaused(false);
          return host.paused() ? failed(t("That did not change")) : done(t("Coucou is back"), true);
        },
      }),
      capability({
        name: "quit_coucou",
        area: AREA,
        description: "Quits Coucou: the app closes and nothing is shown or listened for until it is started again. The user must click to confirm. To stop only for a while, it is pause_coucou.",
        args: {},
        tier: "confirm",
        describe: () => ({ title: t("Quit Coucou?"), change: t("Coucou closes until you start it again."), action: t("Quit") }),
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
        name: "nothing",
        area: AREA,
        description: "Does nothing. For when the user changed their mind, is done, only thanked, said not to do something, or when what was heard was said to someone else and is not a request to Coucou.",
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
          question: { type: "string", maxLength: 160, description: "The question, short, as Coucou asks it." },
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
        description: "Lists what else Coucou can do. Without an area: the areas. With one: every capability of that area, to call next. For when none of the capabilities shown does what was asked.",
        args: { area: { type: "string", enum: areas, optional: true, description: "The area to list." } },
        tier: "read",
        async run(args) {
          const all = registry.areas();
          const wanted = str(args.area);
          if (!wanted) return done("", true, { areas: all.map(({ area, names }) => ({ area, capabilities: names })) });
          const found = all.find(({ area }) => area === wanted);
          if (!found) return { ...failed(t("Not found: {0}", { 0: cut(wanted, 40) }), "Coucou has no area by that name."), near: all.map(({ area }) => area) };
          return done("", true, {
            area: found.area,
            capabilities: found.names.map((name) => ({ name, description: registry.get(name)?.description ?? "" })),
          });
        },
      }),
    ],
  };
}
