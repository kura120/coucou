// The pills shown in the island, as Settings → Active pills changes them: same
// rules (the main one is always there, a limit on the others), then saved.
// Every change here can be put back.

import type { Call, Entity, ToolResult } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost, PillInfo } from "./host";
import { capability, ids, str, unknownArgument, type Area } from "./shared";

const AREA = "pills";

export function pills(host: AppHost): Area {
  const name = (id: string) => host.pillCatalog().find((p) => p.id === id)?.name ?? id;
  const known = (id: string) => host.pillCatalog().some((p) => p.id === id);
  const shown = (id: string) => id === host.pills().main || host.pills().active.includes(id);
  const names = (list: readonly string[]) => list.map(name).join(", ");

  const entity = (pill: PillInfo): Entity => ({
    id: pill.id,
    label: pill.name,
    ...(pill.spoken?.length ? { spoken: pill.spoken } : {}),
    hint: [pill.category, pill.id === host.pills().main ? "main" : host.pills().active.includes(pill.id) ? "shown" : "hidden"].join(", "),
  });

  /** The call that shows exactly the pills shown now, whatever is done meanwhile. */
  const backToNow = (): Call => ({ name: "keep_only_pills", arguments: { pills: [host.pills().main, ...host.pills().active] } });

  /** Hides what is not kept, then shows what is, as far as there is room. */
  function keepOnly(keep: readonly string[]) {
    const wanted = keep.filter((id) => id !== host.pills().main);
    for (const id of host.pills().active) if (!wanted.includes(id)) host.togglePill(id);
    for (const id of wanted) if (!host.pills().active.includes(id) && host.pillFits(id)) host.togglePill(id);
  }

  return {
    sources: [
      {
        kind: "pill",
        description: "The pills the island can show: workspace tools, agents, AI providers and services. Each says whether it is shown, hidden or the main one.",
        list: () => host.pillCatalog().map(entity),
      },
      {
        kind: "workspace_pill",
        description: "The workspace tools one of which is the main pill, always shown.",
        list: () => host.pillCatalog().filter((p) => p.category === "workspace").map(entity),
      },
    ],
    capabilities: [
      capability({
        name: "list_pills",
        area: AREA,
        description: "Reads which pills are shown in the island and which one is the main workspace tool.",
        args: {},
        tier: "read",
        inSnapshot: true,
        async run() {
          const { active, main } = host.pills();
          return done(names([main, ...active]), true, { main: name(main), shown: active.map(name), at_most: host.pillLimit() });
        },
      }),
      capability({
        name: "add_pills",
        area: AREA,
        description: "Adds pills to the island, beside those already there. To show these and hide all the others, it is keep_only_pills; to open an application of the same name, it is open_app.",
        args: { pills: { type: "entities", kind: "pill", max: 6, description: "The pills to show." } },
        tier: "reversible",
        inverse: (args) => {
          const added = ids(args.pills).filter((id) => known(id) && !shown(id));
          return added.length ? { name: "remove_pills", arguments: { pills: added } } : null;
        },
        async run(args): Promise<ToolResult> {
          const wanted = ids(args.pills).filter(known);
          if (!wanted.length) return unknownArgument(args, "pills");
          const added: string[] = [];
          const full: string[] = [];
          const stuck: string[] = [];
          for (const id of wanted) {
            if (shown(id)) continue;
            if (!host.pillFits(id)) {
              full.push(id);
              continue;
            }
            host.togglePill(id);
            (shown(id) ? added : stuck).push(id);
          }
          if (added.length) {
            return {
              ...done(t("{0} added", { 0: names(added) }), true),
              ...(full.length ? { detail: `Added ${names(added)}. No room for ${names(full)}: at most ${host.pillLimit()} pills are shown.` } : {}),
            };
          }
          if (stuck.length) return failed(t("That did not change"), `${names(stuck)} could not be shown.`);
          if (full.length) {
            return failed(
              t("Nothing to add: they are already there, or there is no room"),
              `No room for ${names(full)}: ${host.pillLimit()} pills are shown already (${names(host.pills().active)}). One has to be removed first, or replace_pill used.`,
            );
          }
          return done(t("{0} is already there", { 0: names(wanted) }), true);
        },
      }),
      capability({
        name: "remove_pills",
        area: AREA,
        description: "Hides pills from the island. The main pill cannot be hidden: another is made the main one with set_main_pill.",
        args: { pills: { type: "entities", kind: "pill", max: 6, description: "The pills to hide." } },
        tier: "reversible",
        inverse: (args) => {
          const removed = ids(args.pills).filter((id) => host.pills().active.includes(id));
          return removed.length ? { name: "add_pills", arguments: { pills: removed } } : null;
        },
        async run(args) {
          const wanted = ids(args.pills).filter(known);
          if (!wanted.length) return unknownArgument(args, "pills");
          const removed: string[] = [];
          const stuck: string[] = [];
          for (const id of wanted) {
            if (!host.pills().active.includes(id)) continue;
            host.togglePill(id);
            (host.pills().active.includes(id) ? stuck : removed).push(id);
          }
          if (removed.length) return done(t("{0} removed", { 0: names(removed) }), true);
          if (stuck.length) return failed(t("That did not change"), `${names(stuck)} could not be hidden.`);
          return wanted.length === 1
            ? failed(t("{0} is not one of your pills", { 0: name(wanted[0]) }))
            : failed(t("None of those are in your pills"));
        },
      }),
      capability({
        name: "replace_pill",
        area: AREA,
        description: "Hides one pill and shows another in its place. The way to show a pill when the island is full.",
        args: {
          remove: { type: "entity", kind: "pill", description: "The pill to hide." },
          add: { type: "entity", kind: "pill", description: "The pill to show in its place." },
        },
        tier: "reversible",
        inverse: backToNow,
        async run(args) {
          const old = str(args.remove);
          const next = str(args.add);
          if (!known(old)) return unknownArgument(args, "remove");
          if (!known(next)) return unknownArgument(args, "add");
          if (host.pills().active.includes(old)) host.togglePill(old);
          if (!shown(next) && host.pillFits(next)) host.togglePill(next);
          if (!shown(next)) return failed(t("That did not change"), `${name(next)} could not be shown.`);
          return done(t("{0} → {1}", { 0: name(old), 1: name(next) }), !host.pills().active.includes(old));
        },
      }),
      capability({
        name: "keep_only_pills",
        area: AREA,
        description: "Keeps only these pills in the island and hides every other one, the main pill aside. Only when all the others are meant to go: to add to what is there, it is add_pills.",
        args: { pills: { type: "entities", kind: "pill", max: 7, description: "The pills that stay." } },
        tier: "reversible",
        inverse: backToNow,
        async run(args) {
          const keep = ids(args.pills).filter(known);
          if (!keep.length) return unknownArgument(args, "pills");
          keepOnly(keep);
          const kept = keep.filter(shown);
          const others = host.pills().active.filter((id) => !keep.includes(id));
          if (!kept.length || others.length) return failed(t("That did not change"), kept.length ? `${names(others)} could not be hidden.` : "None of them could be shown.");
          // Some may not have fitted: what is shown is said, and that it is not all of it.
          return kept.length === keep.length
            ? done(t("Only: {0}", { 0: names(kept) }), true)
            : { ...done(t("Only: {0}", { 0: names(kept) }), false), detail: `Shown: ${names(kept)}. No room for the others.` };
        },
      }),
      capability({
        name: "set_main_pill",
        area: AREA,
        description: "Chooses the main workspace tool, the pill that is always shown. Not for bringing a session to the front: that is open_session.",
        args: { pill: { type: "entity", kind: "workspace_pill", description: "The workspace tool to make the main one." } },
        tier: "reversible",
        inverse: (args) => (str(args.pill) === host.pills().main ? null : { name: "set_main_pill", arguments: { pill: host.pills().main } }),
        async run(args) {
          const id = str(args.pill);
          if (!host.pillCatalog().some((p) => p.id === id && p.category === "workspace")) return unknownArgument(args, "pill");
          host.setMainPill(id);
          return host.pills().main === id
            ? done(t("Main: {0}", { 0: name(id) }), true)
            : failed(t("That did not change"), `${name(id)} could not be made the main pill.`);
        },
      }),
    ],
  };
}
