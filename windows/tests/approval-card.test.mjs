// The permission card (src/views/views.ts buildApproval): what an Edit, MultiEdit
// or Write would change, shown under the target before it is allowed, and the
// buttons that answer it. Built on the fake DOM; the preview itself is
// core/diff.ts approvalPreview.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { approvalPreview, buildFileDiff } = await import("../src/core/diff.ts");
const { PREVIEW_ROWS, approvalCardHeight, buildApproval } = await import("../src/views/views.ts");
const layout = await import("../src/core/layout.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

const lines = (n, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

// ── The preview ───────────────────────────────────────────────────────────────

test("an Edit previews its removed and added lines, with the counts the ticker shows", () => {
  const input = { file_path: "/p/a.ts", old_string: "a\nb\nc", new_string: "a\nB\nB2\nc" };
  const p = approvalPreview("Edit", input);
  assert.deepEqual(p.lines, [
    { kind: "removed", text: "b" },
    { kind: "added", text: "B" },
    { kind: "added", text: "B2" },
  ]);
  const diff = buildFileDiff("Edit", input);
  assert.equal(p.added, diff.added);
  assert.equal(p.removed, diff.removed);
  assert.equal(`+${p.added} −${p.removed}`, "+2 −1");
  assert.equal(p.path, "/p/a.ts");
  assert.equal(p.isNewFile, false);
  assert.equal(p.partial, false);
});

test("a MultiEdit previews every edit in order and adds the counts up", () => {
  const p = approvalPreview("MultiEdit", {
    file_path: "/p/a.ts",
    edits: [
      { old_string: "one", new_string: "ONE" },
      { old_string: "two\n", new_string: "" },
      { old_string: "", new_string: "three" },
    ],
  });
  assert.deepEqual(p.lines.map((l) => `${l.kind[0]}:${l.text}`), ["r:one", "a:ONE", "r:two", "a:three"]);
  assert.equal(p.added, 2);
  assert.equal(p.removed, 2);
});

test("a Write previews the start of the new file", () => {
  const p = approvalPreview("Write", { file_path: "/p/new.md", content: "# Title\nbody" });
  assert.deepEqual(p.lines, [{ kind: "added", text: "# Title" }, { kind: "added", text: "body" }]);
  assert.equal(p.isNewFile, true);
  assert.equal(p.added, 2);
  assert.equal(p.removed, 0);
});

test("only the changed lines are kept, and only so many of them", () => {
  const p = approvalPreview("Write", { file_path: "/p/big.txt", content: lines(500) });
  assert.equal(p.added, 500);
  assert.equal(p.lines.length, 200);
  assert.equal(p.lines[0].text, "line 1");
  // Context around a change is not part of the preview.
  const edit = approvalPreview("Edit", { file_path: "/p/a.ts", old_string: `${lines(10)}\nx`, new_string: `${lines(10)}\ny` });
  assert.deepEqual(edit.lines, [{ kind: "removed", text: "x" }, { kind: "added", text: "y" }]);
});

test("anything that is not a file edit, or changes nothing, has no preview", () => {
  assert.equal(approvalPreview("Bash", { command: "ls" }), null);
  assert.equal(approvalPreview("Read", { file_path: "/p/a.ts" }), null);
  assert.equal(approvalPreview("Edit", { file_path: "/p/a.ts", old_string: "same", new_string: "same" }), null);
  assert.equal(approvalPreview("Edit", { old_string: "a", new_string: "b" }), null);
  assert.equal(approvalPreview("Write", { file_path: "/p/a.ts", content: "" }), null);
  assert.equal(approvalPreview("MultiEdit", { file_path: "/p/a.ts", edits: [] }), null);
});

test("an edit too big to diff keeps its counts and no lines", () => {
  const huge = "x".repeat(300 * 1024);
  const p = approvalPreview("Write", { file_path: "/p/huge.txt", content: huge });
  assert.equal(p.tooLarge, true);
  assert.deepEqual(p.lines, []);
  assert.ok(p.added > 0);
});

test("text the relay cut is said to be partial; a long line that merely ends in an ellipsis is not", () => {
  const cut = `${"y".repeat(2000)}…`;
  assert.equal(approvalPreview("Write", { file_path: "/p/a.txt", content: cut }).partial, true);
  assert.equal(approvalPreview("Edit", { file_path: "/p/a.txt", old_string: "a", new_string: cut }).partial, true);
  assert.equal(
    approvalPreview("MultiEdit", { file_path: "/p/a.txt", edits: [{ old_string: "a", new_string: cut }] }).partial,
    true,
  );
  assert.equal(approvalPreview("Write", { file_path: "/p/a.txt", content: "wait…" }).partial, false);
  assert.equal(approvalPreview("Write", { file_path: "/p/a.txt", content: `${"y".repeat(5000)}…` }).partial, false);
});

// ── The card ──────────────────────────────────────────────────────────────────

let decided;
let view;
const actions = {
  decide: (d) => decided.push(d),
  foldApproval() {},
  setView() {},
};

const request = (over = {}) => ({
  requestId: "r1", sessionId: "s1", pillId: "integration_claude", tool: "Edit", inputKey: "k",
  received: Date.now(), command: "Edit · /p/a.ts", ...over,
});
const edit = (n) => approvalPreview("Write", { file_path: "/p/a.ts", content: lines(n) });
const rows = () => view.el.find(".diff-line");
const button = (label) => view.el.find("BUTTON").find((b) => b.textContent.startsWith(label));
const hidden = (cls) => view.el.querySelector(`.${cls}`).style.display === "none";

beforeEach(() => {
  decided = [];
  State.settings = { ...DEFAULT_SETTINGS };
  State.pendingApproval = null;
  view = buildApproval(actions);
});

test("a short edit shows all its lines and the counts, with nothing to open", () => {
  State.pendingApproval = request({ preview: edit(2) });
  view.sync();
  assert.equal(rows().length, 2);
  assert.equal(view.el.querySelector("approval-counts").find(".plus")[0].textContent, "+2");
  assert.equal(hidden("approval-more"), true);
  assert.equal(hidden("approval-preview"), false);
  assert.equal(view.el.querySelector("code").textContent, "Edit · /p/a.ts");
});

test("a long edit is cut to three lines, and one click shows more of it without leaving the card", () => {
  State.pendingApproval = request({ preview: edit(40) });
  view.sync();
  assert.equal(rows().length, PREVIEW_ROWS);
  assert.equal(PREVIEW_ROWS, 3);
  assert.equal(view.el.querySelector("approval-counts").find(".plus")[0].textContent, "+40");
  assert.equal(hidden("approval-more"), false);
  assert.equal(view.el.querySelector("approval-more").textContent, "Show all");
  const more = view.el.querySelector("approval-more");

  more.fire("click");
  view.sync();
  assert.equal(rows().length, 40);
  assert.equal(view.el.querySelector("approval-more").textContent, "Show less");
  assert.equal(view.el.querySelector("approval-preview").classList.contains("open"), true);
  // The same button, not a rebuilt one: a click between mouse-down and mouse-up must land.
  assert.equal(view.el.querySelector("approval-more"), more);

  more.fire("click");
  view.sync();
  assert.equal(rows().length, 3);
  assert.equal(view.el.querySelector("approval-preview").classList.contains("open"), false);
});

test("the next request starts folded again", () => {
  State.pendingApproval = request({ preview: edit(40) });
  view.sync();
  view.el.querySelector("approval-more").fire("click");
  view.sync();
  assert.equal(rows().length, 40);
  State.pendingApproval = request({ requestId: "r2", preview: edit(40) });
  view.sync();
  assert.equal(rows().length, 3);
});

test("added lines and removed lines are marked, and their text is never parsed as markup", () => {
  const preview = approvalPreview("Edit", { file_path: "/p/a.html", old_string: "<b>old</b>", new_string: "<img src=x onerror=1>" });
  State.pendingApproval = request({ preview });
  view.sync();
  const [removed, added] = rows();
  assert.equal(removed.classList.contains("removed"), true);
  assert.equal(added.classList.contains("added"), true);
  assert.equal(removed.find(".txt")[0].textContent, "<b>old</b>");
  assert.equal(added.find(".txt")[0].textContent, "<img src=x onerror=1>");
});

test("a new file says so, a cut edit says it is partial, a huge one shows its counts only", () => {
  State.pendingApproval = request({ tool: "Write", preview: edit(2) });
  view.sync();
  assert.match(view.el.querySelector("approval-counts").textContent, /^New/);

  State.pendingApproval = request({
    requestId: "r2",
    preview: approvalPreview("Write", { file_path: "/p/a.txt", content: `${"y".repeat(2000)}…` }),
  });
  view.sync();
  assert.ok(view.el.querySelector("approval-partial"));

  State.pendingApproval = request({
    requestId: "r3",
    preview: approvalPreview("Write", { file_path: "/p/h.txt", content: "x".repeat(300 * 1024) }),
  });
  view.sync();
  assert.equal(rows().length, 0);
  assert.equal(view.el.querySelector("diff-note").textContent, "Diff too large");
});

test("a tool that edits no file keeps today's line: the target, no counts, no preview", () => {
  State.pendingApproval = request({ tool: "Bash", command: "Bash · npm test" });
  view.sync();
  assert.equal(view.el.querySelector("code").textContent, "Bash · npm test");
  assert.equal(hidden("approval-preview"), true);
  assert.equal(hidden("approval-counts"), true);
  assert.equal(hidden("approval-more"), true);
  assert.equal(rows().length, 0);
  // A request with a preview, then one without: nothing of the first is left.
  State.pendingApproval = request({ preview: edit(5) });
  view.sync();
  State.pendingApproval = request({ requestId: "r2", tool: "Bash", command: "Bash · ls" });
  view.sync();
  assert.equal(rows().length, 0);
  assert.equal(hidden("approval-preview"), true);
});

test("the buttons are built once and the click guard still holds them for 600 ms", () => {
  State.pendingApproval = request({ preview: edit(40) });
  view.sync();
  const allow = button("Allow");
  const deny = button("Deny");
  assert.ok(allow && deny);
  view.sync();
  assert.equal(button("Allow"), allow);

  // A click right after the card appears is meant for the window underneath.
  allow.fire("click");
  deny.fire("click");
  assert.deepEqual(decided, []);

  const now = performance.now();
  const realNow = performance.now.bind(performance);
  performance.now = () => realNow() + 700;
  try {
    allow.fire("click");
    deny.fire("click");
  } finally {
    performance.now = realNow;
  }
  assert.deepEqual(decided, ["allow", "deny"]);
  assert.ok(now > 0);
});

test("the island grows to the card a preview makes, and goes back for a request without one", () => {
  const { VIEW_LAYOUTS } = layout;
  assert.equal(approvalCardHeight(null, false), 108);
  assert.equal(approvalCardHeight(edit(1), false), 120);
  assert.equal(approvalCardHeight(edit(40), false), 148);
  assert.equal(approvalCardHeight(edit(40), true), 162);
  assert.equal(approvalCardHeight(edit(2), true), 134);
  // Never below the usual card.
  assert.equal(approvalCardHeight(approvalPreview("Write", { file_path: "/p/h.txt", content: "x".repeat(300 * 1024) }), false), 120);

  State.pendingApproval = request({ preview: edit(40) });
  view.sync();
  assert.equal(VIEW_LAYOUTS.approval.height, 148 + 52);
  view.el.querySelector("approval-more").fire("click");
  view.sync();
  assert.equal(VIEW_LAYOUTS.approval.height, 162 + 52);
  State.pendingApproval = request({ requestId: "r2", tool: "Bash", command: "Bash · ls" });
  view.sync();
  assert.equal(VIEW_LAYOUTS.approval.height, 160);
});
