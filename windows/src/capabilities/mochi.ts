// Mochi on the desktop: out of the island to his spot, back home, asleep or
// awake. Where the desktop cannot have him, none of this is available.

import type { ToolResult } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, type Area } from "./shared";

const AREA = "mochi";

export function mochi(host: AppHost): Area {
  const available = (): true | string => (host.mochi().supported ? true : t("Mochi stays in the island on this desktop"));
  const unsupported = (): ToolResult | null => (host.mochi().supported ? null : failed(t("Mochi stays in the island on this desktop")));

  return {
    sources: [],
    capabilities: [
      capability({
        name: "read_mochi",
        area: AREA,
        description: "Reads where Mochi is — in the island or on the desktop — and whether he sleeps.",
        args: {},
        tier: "read",
        async run() {
          const now = host.mochi();
          return done(now.onDesktop ? t("On the desktop") : t("In the island"), true, {
            on_desktop: now.onDesktop, asleep: now.asleep, desktop_possible: now.supported,
          });
        },
      }),
      capability({
        name: "mochi_to_desktop",
        area: AREA,
        description: "Sends Mochi out of the island to his spot on the desktop.",
        args: {},
        tier: "reversible",
        available,
        inverse: () => (host.mochi().onDesktop ? null : { name: "mochi_come_home", arguments: {} }),
        async run() {
          const stopped = unsupported();
          if (stopped) return stopped;
          if (host.mochi().onDesktop) return done(t("On the desktop"), true);
          if (!(await host.mochiFlyOut())) return failed(t("That did not work"), "Mochi has no spot on a connected display.");
          return done(t("On the desktop"), host.mochi().onDesktop);
        },
      }),
      capability({
        name: "mochi_come_home",
        area: AREA,
        description: "Brings Mochi back from the desktop into the island.",
        args: {},
        tier: "reversible",
        available,
        inverse: () => (host.mochi().onDesktop ? { name: "mochi_to_desktop", arguments: {} } : null),
        async run() {
          const stopped = unsupported();
          if (stopped) return stopped;
          if (!host.mochi().onDesktop) return done(t("In the island"), true);
          if (!(await host.mochiFlyHome())) return failed(t("That did not work"), "Mochi did not come home.");
          return done(t("In the island"), !host.mochi().onDesktop);
        },
      }),
      capability({
        name: "set_mochi_asleep",
        area: AREA,
        description: "Puts Mochi to sleep on the desktop, or wakes him. Coucou itself keeps working: to pause Coucou, it is pause_coucou.",
        args: { asleep: { type: "boolean", description: "True to sleep, false to wake." } },
        tier: "reversible",
        available: () => (available() === true ? (host.mochi().onDesktop ? true : t("In the island")) : available()),
        inverse: (args) => (host.mochi().asleep === (args.asleep === true) ? null : { name: "set_mochi_asleep", arguments: { asleep: host.mochi().asleep } }),
        async run(args) {
          const stopped = unsupported();
          if (stopped) return stopped;
          const asleep = args.asleep === true;
          if (!host.mochi().onDesktop) return failed(t("In the island"), "Mochi sleeps on the desktop only: he is in the island.");
          if (!host.setMochiAsleep(asleep)) return failed(t("That did not change"));
          return done(asleep ? t("Asleep") : t("Awake"), host.mochi().asleep === asleep);
        },
      }),
    ],
  };
}
