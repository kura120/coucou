// The island's own views, and the Settings window. A view is a thing the app
// has, listed here once with the name its tab or menu gives it; how someone
// asks for one is the model's to work out.

import { N_, t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, str, type Area } from "./shared";

const AREA = "views";

/** The views that can be asked for, with the titles the app gives them (English keys, shown with `t()`). */
export const APP_VIEWS: readonly { id: string; title: string; about: string }[] = [
  { id: "overview", title: N_("Overview"), about: "the pills and the session in front" },
  { id: "chat", title: N_("Chat"), about: "the chat with an AI provider or Claude Code" },
  { id: "wardrobe", title: N_("Wardrobe"), about: "Mochi's outfits" },
  { id: "recap", title: N_("Weekly recap"), about: "last week's sessions in numbers" },
  { id: "settings", title: N_("Settings"), about: "Coucou's own Settings window, not the system's" },
];

export function views(host: AppHost): Area {
  return {
    sources: [
      {
        kind: "view",
        description: "Coucou's own views in the island, and its Settings window.",
        list: () => APP_VIEWS.map(({ id, title, about }) => ({ id, label: t(title), hint: about })),
      },
    ],
    capabilities: [
      capability({
        name: "current_view",
        area: AREA,
        description: "Reads which of Coucou's views is on screen, and whether the island is open.",
        args: {},
        tier: "read",
        inSnapshot: true,
        async run() {
          const { view, open } = host.currentView();
          return done(view, true, { view, island_open: open });
        },
      }),
      capability({
        name: "show_view",
        area: AREA,
        description: "Brings up one of Coucou's own views in the island, or opens Coucou's Settings window. Not for applications on the computer, and not for an agent's session.",
        args: { view: { type: "entity", kind: "view", description: "The view to show." } },
        tier: "free",
        async run(args) {
          const view = APP_VIEWS.find((v) => v.id === str(args.view));
          if (!view) return failed(t("That cannot be shown right now"), "Coucou has no view by that name.");
          if (!host.showView(view.id)) return failed(t("That cannot be shown right now"), "A card is waiting for an answer, or Coucou is paused.");
          // The Settings window is the system's to bring; a view in the island reads back.
          return done(t("{0} opened", { 0: t(view.title) }), view.id !== "settings" && host.currentView().view === view.id);
        },
      }),
    ],
  };
}
