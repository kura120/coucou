// The right-click menu (src/views/menu.ts) on a fake DOM: what a right-click
// gathers, in which order, and that the webview's own menu never shows.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { h } = await import("../src/views/dom.ts");
const { collectMenu, insertText, installContextMenu, placeMenu, provideMenu } = await import("../src/views/menu.ts");

const labels = (sections) => sections.map((section) => section.map((item) => item.label));
const item = (label, extra = {}) => ({ label, action() {}, ...extra });

/** A right-click on `target`, as the page's listener gets it. */
function rightClick(root, target, at = { x: 40, y: 30 }) {
  const event = {
    type: "contextmenu",
    target,
    clientX: at.x,
    clientY: at.y,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  for (const listener of root.listeners.get("contextmenu") ?? []) listener(event);
  return event;
}

const shown = () => document.body.find(".ctx-menu");

beforeEach(() => {
  document.body.replaceChildren();
});

test("a right-click gathers what the element and its ancestors offer, nearest first", () => {
  const leaf = h("span");
  const row = h("div", {}, leaf);
  const list = h("div", {}, row);
  const root = h("div", {}, list);
  provideMenu(list, () => [item("New chat")]);
  provideMenu(row, () => [item("Open"), item("Delete")]);
  assert.deepEqual(labels(collectMenu(leaf, root, {})), [["Open", "Delete"], ["New chat"]]);
  // From the list itself, the row has nothing to say.
  assert.deepEqual(labels(collectMenu(list, root, {})), [["New chat"]]);
});

test("an element can be given more to offer later, and gets the event", () => {
  const row = h("div");
  const root = h("div", {}, row);
  const seen = [];
  provideMenu(row, (e) => (seen.push(e.clientX), [item("Open")]));
  provideMenu(row, () => [item("Copy path")]);
  assert.deepEqual(labels(collectMenu(row, root, { clientX: 7 })), [["Open"], ["Copy path"]]);
  assert.deepEqual(seen, [7]);
});

test("nothing offered is no section, and nothing above the window's root is asked", () => {
  const row = h("div");
  const root = h("div", {}, row);
  const outside = h("div", {}, root);
  provideMenu(outside, () => [item("Not ours")]);
  provideMenu(row, () => null);
  provideMenu(root, () => []);
  assert.deepEqual(collectMenu(row, root, {}), []);
});

test("a text field offers cut, copy, paste and select all, before anything else", () => {
  const field = h("input", { type: "text" });
  Object.assign(field, { type: "text", value: "hello", selectionStart: 0, selectionEnd: 5 });
  const bar = h("div", {}, field);
  provideMenu(bar, () => [item("Send")]);
  const sections = collectMenu(field, bar, {});
  assert.deepEqual(labels(sections), [["Cut", "Copy", "Paste", "Select all"], ["Send"]]);
  assert.ok(sections[0].every((i) => !i.disabled));

  // Nothing selected: nothing to cut or copy. Nothing typed: nothing to select.
  Object.assign(field, { value: "", selectionStart: 0, selectionEnd: 0 });
  const empty = collectMenu(field, bar, {})[0];
  assert.deepEqual(empty.map((i) => Boolean(i.disabled)), [true, true, false, true]);
});

test("a password is never cut or copied out of its field", () => {
  const field = h("input");
  Object.assign(field, { type: "password", value: "secret", selectionStart: 0, selectionEnd: 6 });
  const [cut, copy, paste] = collectMenu(field, h("div", {}, field), {})[0];
  assert.ok(cut.disabled && copy.disabled);
  assert.ok(!paste.disabled);
});

test("a checkbox or a button is not a text field", () => {
  const box = h("input");
  box.type = "checkbox";
  assert.deepEqual(collectMenu(box, h("div", {}, box), {}), []);
});

test("paste takes the clipboard from Rust and puts it where the selection was", async () => {
  const field = h("input");
  const typed = [];
  Object.assign(field, {
    type: "text",
    value: "hello world",
    selectionStart: 6,
    selectionEnd: 11,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    dispatchEvent: (e) => typed.push(e.type),
  });
  const paste = collectMenu(field, h("div", {}, field), {}, { clipboardText: async () => "Mochi\r\n  and friends" })[0][2];
  paste.action();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A one-line field takes a pasted paragraph on one line.
  assert.equal(field.value, "hello Mochi and friends");
  assert.deepEqual(typed, ["input"]);

  // An empty clipboard changes nothing.
  collectMenu(field, h("div", {}, field), {}, { clipboardText: async () => null })[0][2].action();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(field.value, "hello Mochi and friends");

  // A multi-line field keeps the lines.
  const area = h("textarea");
  Object.assign(area, { value: "", setRangeText(text) { this.value = text; }, dispatchEvent() {} });
  insertText(area, "one\ntwo");
  assert.equal(area.value, "one\ntwo");
});

test("the menu opens at the pointer, pulled back inside the window", () => {
  assert.deepEqual(placeMenu(100, 80, 150, 90, 720, 640), { x: 100, y: 80 });
  assert.deepEqual(placeMenu(700, 630, 150, 90, 720, 640), { x: 564, y: 544 });
  assert.deepEqual(placeMenu(-20, 2, 150, 90, 720, 640), { x: 6, y: 6 });
});

test("the webview's menu never shows, whether or not Coucou has one to show", () => {
  const row = h("div");
  const plain = h("div");
  const root = h("div", {}, row, plain);
  provideMenu(row, () => [item("Open")]);
  installContextMenu(root);
  assert.ok(rightClick(root, plain).defaultPrevented);
  assert.equal(shown().length, 0);
  assert.ok(rightClick(root, row).defaultPrevented);
  assert.equal(shown().length, 1);
});

test("the menu shows a section per contributor; picking an item runs it and closes the menu", () => {
  const row = h("div");
  const root = h("div", {}, row);
  const ran = [];
  provideMenu(row, () => [
    item("Open", { action: () => ran.push("open") }),
    item("Delete", { danger: true, action: () => ran.push("delete") }),
    item("Rename", { disabled: true }),
  ]);
  provideMenu(root, () => [item("New chat")]);
  const rects = [];
  const menu = installContextMenu(root, { onRect: (rect) => rects.push(rect) });

  rightClick(root, row, { x: 40, y: 30 });
  const el = shown()[0];
  assert.equal(el.find(".ctx-section").length, 2);
  const rows = el.find(".ctx-item");
  assert.deepEqual(rows.map((r) => r.textContent), ["Open", "Delete", "Rename", "New chat"]);
  assert.ok(rows[1].classList.contains("danger"));
  assert.equal(rows[2].disabled, true);
  // The island is told where the menu is, to let its clicks in.
  assert.deepEqual(rects, [{ x: 40, y: 30, w: 0, h: 0 }]);
  assert.deepEqual(menu.rect, { x: 40, y: 30, w: 0, h: 0 });

  rows[1].fire("click");
  assert.deepEqual(ran, ["delete"]);
  assert.equal(shown().length, 0);
  assert.equal(rects.at(-1), null);
  assert.equal(menu.rect, null);
});

test("a second right-click replaces the menu, and a right-click on nothing closes it", () => {
  const a = h("div");
  const b = h("div");
  const nothing = h("div");
  const root = h("div", {}, a, b, nothing);
  provideMenu(a, () => [item("A")]);
  provideMenu(b, () => [item("B")]);
  const menu = installContextMenu(root);
  rightClick(root, a);
  rightClick(root, b);
  assert.deepEqual(shown().map((m) => m.textContent), ["B"]);
  rightClick(root, nothing);
  assert.equal(shown().length, 0);
  // Closing twice is nothing.
  menu.close();
});

test("where a right-click is someone else's, no menu shows", () => {
  const mochi = h("div");
  const root = h("div", {}, mochi);
  provideMenu(root, () => [item("Open")]);
  installContextMenu(root, { skip: (e) => e.target === mochi });
  assert.ok(rightClick(root, mochi).defaultPrevented);
  assert.equal(shown().length, 0);
  rightClick(root, root);
  assert.equal(shown().length, 1);
});
