// Peika on the desktop: out of the island to his spot, back home, asleep or
// awake. Where the desktop cannot have him, none of this is available.

import type { ToolResult } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, type Area } from "./shared";

const AREA = "peika";

export function peika(host: AppHost): Area {
  const available = (): true | string => (host.peika().supported ? true : t("Peika stays in the island on this desktop"));
  const unsupported = (): ToolResult | null => (host.peika().supported ? null : failed(t("Peika stays in the island on this desktop")));

  return {
    sources: [],
    capabilities: [
      capability({
        name: "read_peika",
        area: AREA,
        description: "Reads where Peika is — in the island or on the desktop — and whether he sleeps.",
        args: {},
        tier: "read",
        async run() {
          const now = host.peika();
          return done(now.onDesktop ? t("On the desktop") : t("In the island"), true, {
            on_desktop: now.onDesktop, asleep: now.asleep, desktop_possible: now.supported,
          });
        },
      }),
      capability({
        name: "peika_to_desktop",
        area: AREA,
        description: "Sends Peika out of the island to his spot on the desktop.",
        args: {},
        tier: "reversible",
        available,
        inverse: () => (host.peika().onDesktop ? null : { name: "peika_come_home", arguments: {} }),
        async run() {
          const stopped = unsupported();
          if (stopped) return stopped;
          if (host.peika().onDesktop) return done(t("On the desktop"), true);
          if (!(await host.peikaFlyOut())) return failed(t("That did not work"), "Peika has no spot on a connected display.");
          return done(t("On the desktop"), host.peika().onDesktop);
        },
      }),
      capability({
        name: "peika_come_home",
        area: AREA,
        description: "Brings Peika back from the desktop into the island.",
        args: {},
        tier: "reversible",
        available,
        inverse: () => (host.peika().onDesktop ? { name: "peika_to_desktop", arguments: {} } : null),
        async run() {
          const stopped = unsupported();
          if (stopped) return stopped;
          if (!host.peika().onDesktop) return done(t("In the island"), true);
          if (!(await host.peikaFlyHome())) return failed(t("That did not work"), "Peika did not come home.");
          return done(t("In the island"), !host.peika().onDesktop);
        },
      }),
      capability({
        name: "set_peika_asleep",
        area: AREA,
        description: "Puts Peika to sleep on the desktop, or wakes him. Peika itself keeps working: to pause Peika, it is pause_peika.",
        args: { asleep: { type: "boolean", description: "True to sleep, false to wake." } },
        tier: "reversible",
        available: () => (available() === true ? (host.peika().onDesktop ? true : t("In the island")) : available()),
        inverse: (args) => (host.peika().asleep === (args.asleep === true) ? null : { name: "set_peika_asleep", arguments: { asleep: host.peika().asleep } }),
        async run(args) {
          const stopped = unsupported();
          if (stopped) return stopped;
          const asleep = args.asleep === true;
          if (!host.peika().onDesktop) return failed(t("In the island"), "Peika sleeps on the desktop only: he is in the island.");
          if (!host.setPeikaAsleep(asleep)) return failed(t("That did not change"));
          return done(asleep ? t("Asleep") : t("Awake"), host.peika().asleep === asleep);
        },
      }),
    ],
  };
}
