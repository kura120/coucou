// Weekly recap card and its share panel — port of WeeklyRecapCardView and
// RecapSharePanelView (WeeklyRecapView.swift). The Mac shares from a separate
// panel; here the card flips to a share mode inside the island, because a
// window created after launch comes up blank in WebView2 (see lib.rs).
//
// Nothing animates in this view: the image is drawn once, when share mode
// opens or the privacy toggle changes.

import { h, clear } from "./dom";
import { Bridge } from "../core/bridge";
import { washRGBA } from "../core/layout";
import { Recap } from "../recap/recap";
import { renderShareImage, toPngBlob, toPngDataUrl } from "../recap/share";
import {
  dayKey, formatCount, formatDuration, weekRangeLabel, type WeeklySummary,
} from "../recap/summary";
import type { ViewActions, ViewHost } from "./views";
import { onLanguageChange, t, tl, type Msg } from "../i18n/i18n";

/** User-visible strings, in the current language (src/i18n). */
const T = {
  get title() { return t("Weekly recap"); },
  get noActivity() { return t("No activity last week"); },
  get noActivitySub() { return t("Peika counts your agent sessions as they happen — check back next Monday."); },
  get coding() { return t("coding"); },
  get session() { return t("session"); },
  get sessions() { return t("sessions"); },
  get file() { return t("file"); },
  get files() { return t("files"); },
  get lines() { return t("lines"); },
  get commands() { return t("commands"); },
  get topAgent() { return t("Top agent"); },
  get topProject() { return t("Top project"); },
  get busiestDay() { return t("Busiest day"); },
  get longest() { return t("Longest session"); },
  get permissions() { return t("Permissions"); },
  allowedDenied: (allowed: number, denied: number) => t("{allowed} allowed, {denied} denied", { allowed, denied }),
  get questions() { return t("Questions"); },
  get shareImage() { return t("Share image"); },
  get ok() { return t("OK"); },
  get saving() { return t("Saving…"); },
  savedAs: (name: string) => t("Saved as {name}", { name }),
  get copied() { return t("Copied — paste it anywhere."); },
  get copyUnavailable() { return t("Copying images isn't available here — use Save image."); },
};

function btn(label: string | Msg, kind: "primary" | "secondary", onClick: () => void): HTMLButtonElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));
}

/** One headline number over its label. `wide` is for a value like "+639 / −1". */
function stat(value: (string | Node)[], label: string, wide = false): HTMLElement {
  return h("div", { class: wide ? "recap-stat wide" : "recap-stat" },
    h("div", { class: "v" }, ...value),
    h("div", { class: "l", text: label }),
  );
}

/** A label beside its value, one cell of the facts grid. */
function fact(label: string, value: string): HTMLElement {
  return h("div", { class: "recap-fact" },
    h("span", { class: "k", text: label }),
    h("span", { class: "v", text: value, title: value }),
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function buildRecap(actions: ViewActions): ViewHost {
  const card = h("div", { class: "card wash recap-card" });
  card.style.setProperty("--wash", washRGBA("indigo"));
  const el = h("div", { class: "view" }, card);

  let built = -1;
  let shareCanvas: HTMLCanvasElement | null = null;
  /** Share mode's redraw, while it is open: a language change redraws the image. */
  let redrawShare: (() => void) | null = null;

  // In place: the summary is redrawn in the new language, share mode keeps
  // its state (its labels follow by themselves) and only redraws the image.
  onLanguageChange(() => {
    if (built === -1) return;
    if (redrawShare) redrawShare();
    else showSummary();
  });

  function summaryBody(s: WeeklySummary): HTMLElement {
    const stats = h("div", { class: "recap-stats" },
      stat([formatDuration(s.totalMinutes)], T.coding),
      stat([formatCount(s.sessionCount)], plural(s.sessionCount, T.session, T.sessions)),
      stat([formatCount(s.filesChanged)], plural(s.filesChanged, T.file, T.files)),
    );
    if (s.linesAdded + s.linesRemoved > 0) {
      stats.append(stat([
        h("span", { class: "recap-pos", text: `+${formatCount(s.linesAdded)}` }),
        " / ",
        h("span", { class: "recap-neg", text: `−${formatCount(s.linesRemoved)}` }),
      ], T.lines, true));
    }

    const facts: [string, string][] = [];
    if (s.topAgent) facts.push([T.topAgent, s.topAgent]);
    if (s.topProject) facts.push([T.topProject, s.topProject]);
    if (s.busiestDay) facts.push([T.busiestDay, t(s.busiestDay)]);
    if (s.longestSessionMinutes > 1) facts.push([T.longest, formatDuration(s.longestSessionMinutes)]);
    if (s.permissionsAllowed + s.permissionsDenied > 0) {
      facts.push([T.permissions, T.allowedDenied(s.permissionsAllowed, s.permissionsDenied)]);
    }
    if (s.questions > 0) facts.push([T.questions, formatCount(s.questions)]);
    if (s.commandsRun > 0) facts.push([T.commands, formatCount(s.commandsRun)]);

    return h("div", { class: "stack recap-stack" },
      h("div", { class: "recap-head" },
        h("span", { class: "recap-title", text: T.title }),
        h("span", { class: "recap-range", text: weekRangeLabel(s) }),
        h("span", { class: "grow" }),
        h("div", { class: "actions" },
          btn(T.shareImage, "primary", () => showShare(s)),
          btn(T.ok, "secondary", () => actions.collapse()),
        ),
      ),
      stats,
      facts.length > 0
        ? h("div", { class: "recap-facts" }, ...facts.map(([label, value]) => fact(label, value)))
        : null,
    );
  }

  function emptyBody(): HTMLElement {
    return h("div", { class: "stack recap-stack" },
      h("div", { class: "title", text: T.noActivity }),
      h("div", { class: "sub", text: T.noActivitySub }),
      h("div", { class: "actions" }, btn(T.ok, "secondary", () => actions.collapse())),
    );
  }

  function showSummary() {
    redrawShare = null;
    clear(card);
    card.append(Recap.summary ? summaryBody(Recap.summary) : emptyBody());
  }

  function showShare(s: WeeklySummary) {
    const thumb = h("canvas", { class: "recap-thumb" });
    const status = h("div", { class: "recap-status" });
    const sw = h("button", { class: Recap.prefs.hideProjects ? "switch on" : "switch" });

    const draw = () => {
      shareCanvas = renderShareImage(s, Recap.prefs.hideProjects);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      thumb.width = Math.round(64 * dpr);
      thumb.height = Math.round(114 * dpr);
      const ctx = thumb.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(shareCanvas, 0, 0, thumb.width, thumb.height);
      }
    };

    const say = (text: string, extra?: HTMLElement) => {
      clear(status);
      status.append(h("span", { text }));
      if (extra) status.append(extra);
    };

    sw.addEventListener("click", () => {
      const next = !Recap.prefs.hideProjects;
      sw.classList.toggle("on", next);
      void Recap.setHideProjects(next);
      draw();
      clear(status);
    });

    const save = btn(tl("Save image"), "primary", async () => {
      if (!shareCanvas) return;
      save.disabled = true;
      say(T.saving);
      try {
        const path = await Bridge.recapSavePng(toPngDataUrl(shareCanvas), dayKey(s.weekStart));
        const name = path.split(/[\\/]/).pop() ?? path;
        say(T.savedAs(name), h("button", {
          class: "link-btn recap-link",
          text: tl("Show in folder"),
          onclick: () => void Bridge.recapRevealSaved(),
        }));
      } catch (err) {
        say(String(err).replace(/^Error:\s*/, ""));
      } finally {
        save.disabled = false;
      }
    });

    const copy = btn(tl("Copy"), "secondary", async () => {
      if (!shareCanvas) return;
      say(await copyImage(shareCanvas) ? T.copied : T.copyUnavailable);
    });

    clear(card);
    card.append(h("div", { class: "stack recap-share" },
      thumb,
      h("div", { class: "recap-share-side" },
        h("div", { class: "recap-title", text: tl("Share your week") }),
        h("div", { class: "settings-row" }, sw, h("span", { text: tl("Hide project names") })),
        h("div", { class: "actions" }, save, copy, btn(tl("Back"), "secondary", showSummary)),
        status,
      ),
    ));
    draw();
    redrawShare = draw;
  }

  return {
    el,
    sync() {
      // Rebuilt only when the recap was (re)loaded, never on every state change:
      // that would reset share mode under the user's cursor.
      if (built === Recap.version) return;
      built = Recap.version;
      shareCanvas = null;
      showSummary();
    },
  };
}

/**
 * Puts the PNG on the clipboard through the web Clipboard API — no new
 * dependency. It needs the document focused, and the island never takes focus
 * on its own, so it is lent focus for the duration. WebKitGTK builds without
 * image clipboard support say no, and the caller offers Save instead.
 */
async function copyImage(canvas: HTMLCanvasElement): Promise<boolean> {
  const Item = (window as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (!Item || !navigator.clipboard?.write) return false;
  await Bridge.focusWindow(true);
  try {
    const blob = await toPngBlob(canvas);
    if (!blob) return false;
    await navigator.clipboard.write([new Item({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  } finally {
    void Bridge.focusWindow(false);
  }
}
