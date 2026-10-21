// The weekly recap: what it says, and its two switches. Opening it is
// show_view's; clearing its history is not declared.

import type { Capability } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost, RecapOption } from "./host";
import { capability, cut, type Area } from "./shared";

const AREA = "recap";

export function recap(host: AppHost): Area {
  /** One of the recap's switches: read, set, read back. */
  const option = (name: string, which: RecapOption, description: string, label: string): Capability =>
    capability({
      name,
      area: AREA,
      description,
      args: { on: { type: "boolean", description: "True for on, false for off." } },
      tier: "reversible",
      inverse: (args) => (host.recapOptions()[which] === (args.on === true) ? null : { name, arguments: { on: host.recapOptions()[which] } }),
      async run(args) {
        const on = args.on === true;
        if (!(await host.setRecapOption(which, on))) return failed(t("That did not change"), "The recap's preference was not saved.");
        return done(`${label}: ${on ? "on" : "off"}`, host.recapOptions()[which] === on);
      },
    });

  return {
    sources: [],
    capabilities: [
      capability({
        name: "read_recap",
        area: AREA,
        description: "Reads last week's recap — sessions, time coding, the busiest day, the top agent — and how its two switches are set. To see it on screen, it is show_view with the recap.",
        args: {},
        tier: "read",
        async run() {
          const read = await host.recapLines();
          if (!read) return failed(t("Nothing to report"), "The recap cannot be read.");
          const now = host.recapOptions();
          const lines = read.slice(0, 8).map((line) => cut(line, 120));
          return done(lines.length ? cut(lines.join(" · "), 160) : t("No activity last week"), true, {
            lines, opens_on_monday: now.enabled, project_names_hidden: now.hideProjects,
          });
        },
      }),
      option("set_recap_enabled", "enabled", "Turns the weekly recap on or off: whether Peika keeps count of the sessions and shows the recap each Monday.", "Weekly recap"),
      option("set_recap_hide_projects", "hideProjects", "Chooses whether the recap's shared image leaves the project names out.", "Hide project names"),
    ],
  };
}
