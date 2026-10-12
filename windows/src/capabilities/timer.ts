// The timer: one at a time, which says "Time's up" in a note when it ends.

import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "timer";
const DAY = 24 * 60;

export function timer(host: AppHost): Area {
  /** The call that puts the running timer back as it is now. */
  const backToNow = () => {
    const running = host.timer();
    return running && running.minutesLeft > 0
      ? { name: "set_timer", arguments: { minutes: running.minutesLeft, label: running.label } }
      : null;
  };

  return {
    sources: [],
    capabilities: [
      capability({
        name: "read_timer",
        area: AREA,
        description: "Reads the timer: how many minutes are left and what it is for, or that none runs.",
        args: {},
        tier: "read",
        inSnapshot: true,
        async run() {
          const running = host.timer();
          if (!running) return done(t("No timer is running"), true, null);
          return done(`${running.minutesLeft} min${running.label ? ` · ${running.label}` : ""}`, true, {
            minutes_left: running.minutesLeft, label: running.label,
          });
        },
      }),
      capability({
        name: "set_timer",
        area: AREA,
        description: "Starts a timer or a reminder for a number of minutes, in place of the one that runs. Hours are given in minutes.",
        args: {
          minutes: { type: "number", min: 0.1, max: DAY, description: "How long, in minutes." },
          label: { type: "string", maxLength: 80, optional: true, description: "What to remind about, when they said." },
        },
        tier: "reversible",
        inverse: () => backToNow() ?? { name: "cancel_timer", arguments: {} },
        async run(args) {
          const minutes = Number(args.minutes);
          if (!Number.isFinite(minutes) || minutes <= 0 || minutes > DAY) {
            return failed(t("That did not change"), "A timer runs for more than 0 minutes and at most 24 hours.");
          }
          host.setTimer(minutes, cut(str(args.label), 80));
          if (!host.timer()) return failed(t("That did not change"), "The timer did not start.");
          return done(t("Timer set: {0} min", { 0: Math.round(minutes * 10) / 10 }), true);
        },
      }),
      capability({
        name: "cancel_timer",
        area: AREA,
        description: "Cancels the timer that runs.",
        args: {},
        tier: "reversible",
        available: () => (host.timer() ? true : t("No timer is running")),
        inverse: backToNow,
        async run() {
          if (!host.cancelTimer()) return failed(t("No timer is running"));
          return done(t("Timer cancelled"), host.timer() == null);
        },
      }),
    ],
  };
}
