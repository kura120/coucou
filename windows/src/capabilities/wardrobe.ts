// Mochi's wardrobe: what he wears, picked as a click in the wardrobe picks it.

import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "wardrobe";

export function wardrobe(host: AppHost): Area {
  const label = (id: string) => host.outfits().find((o) => o.id === id)?.label ?? id;

  return {
    sources: [
      {
        kind: "outfit",
        description: "What Mochi can wear, with the one that follows the seasons and none at all.",
        list: () => host.outfits().map(({ id, label }) => ({ id, label, ...(id === host.outfit() ? { hint: "worn now" } : {}) })),
      },
    ],
    capabilities: [
      capability({
        name: "list_outfits",
        area: AREA,
        description: "Reads what Mochi can wear and what he wears now.",
        args: {},
        tier: "read",
        async run() {
          return done(label(host.outfit()), true, { wearing: label(host.outfit()), outfits: host.outfits().map((o) => o.label) });
        },
      }),
      capability({
        name: "wear_outfit",
        area: AREA,
        description: "Dresses Mochi in one of his outfits, or in none, or lets him follow the seasons. To look at the outfits instead, it is show_view with the wardrobe.",
        args: { outfit: { type: "entity", kind: "outfit", description: "The outfit to wear." } },
        tier: "reversible",
        inverse: (args) => (host.outfit() === str(args.outfit) ? null : { name: "wear_outfit", arguments: { outfit: host.outfit() } }),
        async run(args) {
          const id = str(args.outfit);
          if (!host.outfits().some((o) => o.id === id)) return failed(t("Not found: {0}", { 0: cut(id, 40) }), "Mochi has no outfit by that name.");
          if (!host.wearOutfit(id)) return failed(t("That did not change"), "The outfit was not kept.");
          return done(label(id), host.outfit() === id);
        },
      }),
    ],
  };
}
