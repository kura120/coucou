// The screen capture's overlay (capture.html, src-tauri/src/capture/mod.rs).
//
// Rust copies the screen when the shortcut is pressed and lays this window,
// see-through, over every monitor. It dims the screen; a drag draws the part
// that will be kept. The part itself is cut in Rust from where the cursor
// was when the button went down and came up, in physical pixels, so the
// rectangle drawn here only has to look right. Esc, a right click, or a click
// without a drag cancels.

import "./capture.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pickRect } from "./pick";

const pick = document.getElementById("pick") as HTMLElement;
let from: { x: number; y: number } | null = null;

function reset() {
  from = null;
  pick.hidden = true;
  document.body.classList.remove("picking");
}

function cancel() {
  reset();
  void invoke("capture_cancel").catch(() => {});
}

window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) {
    cancel();
    return;
  }
  from = { x: e.clientX, y: e.clientY };
  void invoke("capture_from").catch(() => {});
});

window.addEventListener("mousemove", (e) => {
  if (!from) return;
  const r = pickRect(from, { x: e.clientX, y: e.clientY });
  pick.hidden = false;
  document.body.classList.add("picking");
  pick.style.left = `${r.left}px`;
  pick.style.top = `${r.top}px`;
  pick.style.width = `${r.width}px`;
  pick.style.height = `${r.height}px`;
});

window.addEventListener("mouseup", (e) => {
  if (!from || e.button !== 0) return;
  reset();
  // Rust decides from the cursor whether this was a drag or a click.
  void invoke("capture_select").catch(() => {});
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
});

window.addEventListener("contextmenu", (e) => e.preventDefault());

// Every capture starts clean.
void listen("capture-start", () => reset());
