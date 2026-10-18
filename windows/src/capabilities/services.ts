// The services shown as pills (GitHub, Vercel, Stripe, plan usage…): what
// each last reported, and asking one again. Their keys are not reachable.

import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "services";

export function services(host: AppHost): Area {
  const find = (id: string) => host.services().find((s) => s.id === id);

  return {
    sources: [
      {
        kind: "service",
        description: "The services shown as pills in the island, each with the last thing it reported.",
        list: () => host.services().map((s) => ({ id: s.id, label: s.name, ...(s.line ? { hint: cut(s.line, 80) } : {}) })),
      },
    ],
    capabilities: [
      capability({
        name: "list_services",
        area: AREA,
        description: "Reads one line for each service shown as a pill: what it last reported.",
        args: {},
        tier: "read",
        async run() {
          const list = host.services().map((s) => ({ service: s.name, report: cut(s.line, 120) }));
          return list.length
            ? done(cut(list.map((s) => s.service).join(", "), 160), true, list)
            : done(t("Nothing to report"), true, []);
        },
      }),
      capability({
        name: "service_report",
        area: AREA,
        description: "Reads what one service's card says now, in a few lines, for a question about it: builds, deployments, payments, emails, plan usage.",
        args: { service: { type: "entity", kind: "service", description: "The service to read." } },
        tier: "read",
        async run(args) {
          const service = find(str(args.service));
          if (!service) return failed(t("Nothing to report"), "That service is not one of the pills shown.");
          const lines = host.serviceInfo(service.id).slice(0, 6).map((line) => cut(line, 160));
          if (!lines.length) return done(t("Nothing to report"), true, { service: service.name, lines: [] });
          return done(cut(lines.join(" · "), 400), true, { service: service.name, lines });
        },
      }),
      capability({
        name: "refresh_service",
        area: AREA,
        description: "Asks one service again now instead of waiting for its next check. Read its report afterwards.",
        args: { service: { type: "entity", kind: "service", description: "The service to ask again." } },
        tier: "free",
        async run(args) {
          const service = find(str(args.service));
          if (!service) return failed(t("Nothing to report"), "That service is not one of the pills shown.");
          if (!(await host.refreshService(service.id))) return failed(t("That did not work"), `${service.name} could not be asked: it is not set up, or Coucou is paused.`);
          // Asked; what it answers arrives later, on its card.
          return done(service.name, false);
        },
      }),
    ],
  };
}
