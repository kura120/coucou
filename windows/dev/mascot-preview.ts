// Dev harness: every state and a few emotes of the mascot side by side.
// Not part of the app bundle.

import { BotEngine } from "../src/peika/engine";
import type { BotStateName } from "../src/core/layout";

const STATES: BotStateName[] = [
  "idle", "working", "thinking", "searching", "approval", "question",
  "error", "finished", "ratelimit", "sleeping", "dizzy",
];
const SIZE = 150;
const grid = document.getElementById("grid")!;
const cells: { bot: BotEngine; ctx: CanvasRenderingContext2D }[] = [];
const dpr = window.devicePixelRatio || 1;

function cell(label: string, setup: (b: BotEngine) => void) {
  const fig = document.createElement("figure");
  const cv = document.createElement("canvas");
  cv.width = SIZE * dpr;
  cv.height = SIZE * dpr;
  cv.style.width = `${SIZE}px`;
  cv.style.height = `${SIZE}px`;
  const cap = document.createElement("figcaption");
  cap.textContent = label;
  fig.append(cv, cap);
  grid.append(fig);
  const bot = new BotEngine();
  setup(bot);
  const ctx = cv.getContext("2d")!;
  ctx.scale(dpr, dpr);
  cells.push({ bot, ctx });
}

for (const s of STATES) cell(s, (b) => b.setState(s));
cell("mailbox", (b) => { b.morph = 1; });
cell("peekaboo", (b) => {
  setInterval(() => b.peekaboo(), 3500);
  setTimeout(() => b.peekaboo(), 400);
});


let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const { bot, ctx } of cells) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    bot.update(dt);
    bot.draw(ctx, SIZE, SIZE);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

(window as unknown as { cells: typeof cells }).cells = cells;

if (new URLSearchParams(location.search).has("outfits")) {
  grid.innerHTML = "";
  cells.length = 0;
  for (const o of ["none", "partyHat", "beanie", "crown", "sunglasses", "roundGlasses", "bow", "scarf", "witchHat", "pumpkin", "santaHat", "bunnyEars"] as const) {
    cell(o, (b) => b.setOutfit(o, false));
  }
}

if (new URLSearchParams(location.search).has("hands")) {
  grid.innerHTML = "";
  cells.length = 0;
  cell("hands", (b) => { b.hands = 1; });
  cell("listen", (b) => { b.hands = 1; b.listenHand = 1; });
  cell("click = poke", (b) => { setInterval(() => b.poke(), 3000); });
}
