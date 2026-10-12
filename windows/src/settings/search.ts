// The search engines the browser can be opened on (Settings → Voice → Web
// answers). `searchEngine` in the settings holds an id from this list.

export interface SearchEngine {
  /** What the settings file holds. Never renamed: "google" is the default. */
  id: string;
  name: string;
  /** The address a search opens on, the encoded words put at its end. */
  url: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  { id: "brave", name: "Brave Search", url: "https://search.brave.com/search?q=" },
  { id: "ecosia", name: "Ecosia", url: "https://www.ecosia.org/search?q=" },
  { id: "qwant", name: "Qwant", url: "https://www.qwant.com/?q=" },
];
