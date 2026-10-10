// The right-click menu — Coucou's own, in place of the webview's.
//
// Nothing is listed here: an element says what it offers with provideMenu(),
// and a right-click gathers what the element under the pointer and each of its
// ancestors offer, nearest first, one section each. A new button with
// something to offer calls provideMenu() and nothing else changes. Two things
// are offered by the menu itself: Cut, Copy, Paste and Select all in a text
// field, and Copy on selected text.
//
// One installContextMenu() per window (the island, Settings). Where nothing is
// offered, a right-click shows nothing at all — never the webview's menu.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { N_, t } from "../i18n/i18n";

const STRINGS = {
  cut: N_("Cut"),
  copy: N_("Copy"),
  paste: N_("Paste"),
  selectAll: N_("Select all"),
};

export interface MenuItem {
  /** Already in the interface language. */
  label: string;
  /** An ICONS path, drawn filled. */
  icon?: string;
  /** Shown in red: it deletes something. */
  danger?: boolean;
  disabled?: boolean;
  action(): void;
}

/** What an element offers for a right-click on it; null or empty for nothing. */
export type MenuProvider = (event: MouseEvent) => MenuItem[] | null | undefined;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MenuHost {
  /** True where a right-click is someone else's (Mochi's is the wardrobe). */
  skip?(event: MouseEvent): boolean;
  /** The clipboard's text, for Paste: the page may not read it itself. */
  clipboardText?(): Promise<string | null>;
  /** The menu came up at `rect` (window coordinates), or went (null). */
  onRect?(rect: Rect | null): void;
}

export interface ContextMenu {
  close(): void;
  /** Where the menu is while it is open. */
  readonly rect: Rect | null;
}

const providers = new WeakMap<Element, MenuProvider[]>();

/** `el` offers these items when it, or anything inside it, is right-clicked. */
export function provideMenu(el: Element, provider: MenuProvider) {
  providers.set(el, [...(providers.get(el) ?? []), provider]);
}

type Field = HTMLInputElement | HTMLTextAreaElement;

function fieldOf(target: Element | null): Field | null {
  const tag = target?.tagName;
  if (tag === "TEXTAREA") return target as HTMLTextAreaElement;
  if (tag !== "INPUT") return null;
  const type = (target as HTMLInputElement).type;
  return ["text", "search", "url", "email", "password", "number", "tel", ""].includes(type)
    ? (target as HTMLInputElement)
    : null;
}

/** Puts `text` in the field in place of its selection, as typing would. */
export function insertText(field: Field, text: string) {
  // A one-line field takes a pasted paragraph on one line.
  const clean = field.tagName === "INPUT" ? text.replace(/\s*[\r\n]+\s*/g, " ") : text;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(clean, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function fieldItems(field: Field, host: MenuHost): MenuItem[] {
  const selected = (field.selectionEnd ?? 0) > (field.selectionStart ?? 0);
  const locked = field.disabled || field.readOnly;
  // A password is never copied out of its field.
  const secret = field.type === "password";
  const run = (command: string) => () => {
    field.focus();
    document.execCommand(command);
  };
  return [
    { label: t(STRINGS.cut), disabled: !selected || locked || secret, action: run("cut") },
    { label: t(STRINGS.copy), icon: ICONS.copy, disabled: !selected || secret, action: run("copy") },
    {
      label: t(STRINGS.paste),
      disabled: locked,
      action: () => {
        field.focus();
        const read = host.clipboardText?.() ?? navigator.clipboard?.readText?.() ?? Promise.resolve(null);
        void read.then((text) => text && insertText(field, text)).catch(() => {});
      },
    },
    { label: t(STRINGS.selectAll), disabled: field.value === "", action: () => field.select() },
  ];
}

/** Copy, when the right-click lands on selected text. */
function selectionItems(root: Element): MenuItem[] {
  const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return [];
  if (selection.anchorNode && !root.contains(selection.anchorNode)) return [];
  return [{ label: t(STRINGS.copy), icon: ICONS.copy, action: () => void document.execCommand("copy") }];
}

/**
 * What a right-click on `target` offers: the menu's own items first, then each
 * contributor's from `target` up to `root`. Empty sections are left out.
 */
export function collectMenu(target: Element | null, root: Element, event: MouseEvent, host: MenuHost = {}): MenuItem[][] {
  const sections: MenuItem[][] = [];
  const field = fieldOf(target);
  sections.push(field ? fieldItems(field, host) : selectionItems(root));
  for (let el: Element | null = target; el; el = el === root ? null : el.parentElement) {
    for (const provider of providers.get(el) ?? []) sections.push(provider(event) ?? []);
  }
  return sections.filter((section) => section.length > 0);
}

/** Room kept between the menu and the window's edges. */
const EDGE = 6;

/** The menu's corner for a click at (x, y): at the pointer, pulled back inside the window. */
export function placeMenu(x: number, y: number, w: number, h: number, viewW: number, viewH: number): { x: number; y: number } {
  const fit = (at: number, size: number, room: number) =>
    Number.isFinite(room) ? Math.max(EDGE, Math.min(at, room - size - EDGE)) : at;
  return { x: fit(x, w, viewW), y: fit(y, h, viewH) };
}

/** Coucou's menu on `root`'s right-clicks, and never the webview's. */
export function installContextMenu(root: HTMLElement, host: MenuHost = {}): ContextMenu {
  let el: HTMLElement | null = null;
  let rect: Rect | null = null;

  function close() {
    if (!el) return;
    el.remove();
    el = null;
    rect = null;
    host.onRect?.(null);
  }

  function open(sections: MenuItem[][], x: number, y: number) {
    close();
    const menu = h("div", { class: "ctx-menu", role: "menu" });
    for (const section of sections) {
      const group = h("div", { class: "ctx-section" });
      for (const item of section) {
        const row = h(
          "button",
          { class: item.danger ? "ctx-item danger" : "ctx-item", role: "menuitem" },
          item.icon ? svg(item.icon, 11) : h("i", { class: "ctx-gap" }),
          h("span", { text: item.label }),
        );
        if (item.disabled) row.disabled = true;
        row.addEventListener("click", () => {
          close();
          item.action();
        });
        group.append(row);
      }
      menu.append(group);
    }
    // The click that picks an item must not take the keyboard from the field
    // the menu is about.
    menu.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.append(menu);
    const size = menu.getBoundingClientRect();
    const at = placeMenu(x, y, size.width, size.height, window.innerWidth, window.innerHeight);
    menu.style.left = `${at.x}px`;
    menu.style.top = `${at.y}px`;
    el = menu;
    rect = { x: at.x, y: at.y, w: size.width, h: size.height };
    host.onRect?.(rect);
  }

  /** Up and down walk the items that can be picked; Enter is the focused button's own click. */
  function step(delta: number) {
    if (!el) return;
    const rows = [...el.querySelectorAll<HTMLButtonElement>(".ctx-item:not(:disabled)")];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + delta + rows.length) % rows.length]?.focus();
  }

  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (host.skip?.(e)) {
      close();
      return;
    }
    const sections = collectMenu(e.target as Element | null, root, e, host);
    if (sections.length === 0) close();
    else open(sections, e.clientX, e.clientY);
  });

  if (typeof window.addEventListener === "function") {
    // Anything else the user does puts the menu away.
    window.addEventListener("mousedown", (e) => {
      if (el && !el.contains(e.target as Node)) close();
    }, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { capture: true, passive: true });
    window.addEventListener("keydown", (e) => {
      if (!el) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") step(1);
      else if (e.key === "ArrowUp") step(-1);
      else if (e.key === "Enter" && el.contains(document.activeElement)) return;
      else {
        close();
        return;
      }
      // The menu's own key: not the island's Escape, not the list's arrows.
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  return {
    close,
    get rect() {
      return rect;
    },
  };
}
