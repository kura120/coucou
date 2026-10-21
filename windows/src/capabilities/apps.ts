// Opening what is on the computer: an installed app, one of the user's own
// folders, an http(s) address. A name is looked up among what exists and never
// run: the executor resolves it to an app or a folder before anything opens.

import { t } from "../i18n/i18n";
import { done, failed, notFoundResult } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "apps";

/** An http(s) address from what was given, or null. "github.com" gets https. */
export function webAddress(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.split(/\s/).length > 1) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function apps(host: AppHost): Area {
  return {
    sources: [
      {
        kind: "app",
        description: "The applications installed on this computer, by the names the Start menu gives them.",
        list: async () => (await host.apps()).map((name) => ({ id: name, label: name })),
        near: async (said) => (await host.appsNear(said)).map(({ name, score }) => ({ id: name, label: name, score })),
      },
      {
        kind: "folder",
        description: "The user's own folders that can be opened: Downloads, Desktop, Documents and the like.",
        list: async () => (await host.folders()).map(({ id, label, hint }) => ({ id, label, ...(hint ? { hint } : {}) })),
      },
    ],
    capabilities: [
      capability({
        name: "open_app",
        area: AREA,
        description: "Opens an application installed on this computer, even when a pill has the same name. Only opens it: not for installing anything or doing something inside it. Not for one of Peika's own views, and not for an agent's session.",
        args: { app: { type: "entity", kind: "app", description: "The application, by its name." } },
        tier: "free",
        async run(args, context) {
          const name = str(args.app);
          context.working(t("Opening {0}…", { 0: cut(name, 40) }));
          const opened = await host.openApp(name);
          if (!opened) return notFoundResult(t("Not found: {0}", { 0: cut(name, 40) }));
          // "Opened" is for a window that was seen to come; else it was asked for, no more.
          return opened.seen
            ? done(t("{0} opened", { 0: opened.name }), true)
            : done(t("Asked Windows to open {0}", { 0: opened.name }), false);
        },
      }),
      capability({
        name: "open_folder",
        area: AREA,
        description: "Opens one of the user's own folders in the file manager.",
        args: { folder: { type: "entity", kind: "folder", description: "The folder, by its name." } },
        tier: "free",
        async run(args) {
          const id = str(args.folder);
          const name = await host.openFolder(id);
          // The file manager was asked; its window is not looked for.
          return name ? done(t("{0} opened", { 0: name }), false) : notFoundResult(t("Not found: {0}", { 0: cut(id, 40) }));
        },
      }),
      capability({
        name: "open_url",
        area: AREA,
        description: "Opens a web address in the browser, when the user said one with its dot and ending, such as github.com. Only http and https. Never for a name said without an address: an application is open_app, a pill add_pills; to look something up, it is a web search.",
        args: { url: { type: "string", maxLength: 2000, said: true, description: "The address as the user said it: 'github.com', 'https://example.org/page'." } },
        tier: "free",
        async run(args) {
          const url = webAddress(str(args.url));
          if (!url) return failed(t("Not found: {0}", { 0: cut(str(args.url), 40) }), "That is not an http or https address.");
          if (!(await host.openUrl(url))) return failed(t("That did not work"), "The browser could not be asked.");
          return done(t("{0} opened", { 0: new URL(url).hostname }), false);
        },
      }),
    ],
  };
}
