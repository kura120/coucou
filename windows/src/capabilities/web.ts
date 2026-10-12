// The web: a search whose results come back to be read, and one that opens
// the browser. Which service answers the first, and with whose key, is the
// user's choice in Settings and the host's business.

import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "web";

/** How many results a model is given. */
const MOST_RESULTS = 5;

export function web(host: AppHost): Area {
  return {
    sources: [],
    capabilities: [
      capability({
        name: "web_search",
        area: AREA,
        description: "Searches the web and gives back the first results — title, address, a few words — to answer a question from. Nothing opens. When it cannot search, open_web_search shows the results in the browser instead.",
        args: { query: { type: "string", maxLength: 200, description: "What to look up, as a search query." } },
        tier: "read",
        async run(args, context) {
          const query = cut(str(args.query), 200);
          if (!query) return failed(t("Couldn't search the web."), "There is nothing to search for.");
          context.working(t("Searching the web…"));
          const found = await host.webSearch(query);
          if ("error" in found) return failed(t("Couldn't search the web."), found.error);
          const results = found.results.slice(0, MOST_RESULTS).map((r) => ({ title: cut(r.title, 120), url: r.url, snippet: cut(r.snippet, 300) }));
          if (!results.length) return done(t("Nothing found for this search."), true, []);
          return done(results[0].title, true, results);
        },
      }),
      capability({
        name: "open_web_search",
        area: AREA,
        description: "Opens the browser on a web search, for the user to read the results themselves. For an address they gave, it is open_url.",
        args: { query: { type: "string", maxLength: 200, description: "What to look up, as a search query." } },
        tier: "free",
        async run(args) {
          const query = cut(str(args.query), 200);
          if (!query) return failed(t("Couldn't search the web."), "There is nothing to search for.");
          if (!(await host.openWebSearch(query))) return failed(t("Couldn't search the web."), "The browser could not be asked.");
          return done(t("Searching the web for « {0} »", { 0: cut(query, 60) }), false);
        },
      }),
    ],
  };
}
