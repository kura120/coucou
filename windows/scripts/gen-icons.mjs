// Draws the cloud into the PNG/ICO set Tauri needs. No dependencies: the icons are
// rasterised here and encoded with node:zlib, so the app icon stays "drawn in
// code" like the character itself.
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── The cloud ─────────────────────────────────────────────────────────────────────

const BASE_TOP = [255, 255, 255]; // #FFFFFF
const BASE_BOTTOM = [199, 218, 241]; // #C7DAF1
const INK = [26, 20, 18]; // #1A1412
const RIM = [58, 74, 99]; // #3A4A63

const SS = 4; // supersampling factor

/** The cloud's puffs as [x, y, radius] in units of R (same as src/peika/engine.ts). */
const PUFFS = [
  [0, -0.3, 0.52], [-0.46, -0.12, 0.38], [0.46, -0.12, 0.38],
  [-0.72, 0.18, 0.36], [0.72, 0.18, 0.36], [-0.32, 0.36, 0.38], [0.32, 0.36, 0.38],
];

/** Cloud test in body-local coordinates; `grow` pushes the outline out (the rim). */
function insideCloud(x, y, R, grow) {
  const n = 2.7;
  if (Math.pow(Math.abs(x / (R * 0.8 + grow)), n) + Math.pow(Math.abs(y / (R * 0.64 + grow)), n) <= 1) return true;
  for (const [px, py, pr] of PUFFS) {
    if ((x - px * R) ** 2 + (y - py * R) ** 2 <= (pr * R + grow) ** 2) return true;
  }
  return false;
}

function insidePill(x, y, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(hw, hh);
  const cx = Math.max(-hw + r, Math.min(hw - r, x));
  const cy = Math.max(-hh + r, Math.min(hh - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function renderCloud(size, scale = 0.34) {
  const px = new Uint8Array(size * size * 4);
  const R = size * scale;
  const rx = R * 1.0;
  const ry = R * 0.8;
  const cx = size / 2;
  const cy = size / 2;
  const rim = R * 0.055; // dark outline so the tray icon reads on light themes

  // Eyes — same geometry as BotEngine (yaw ±0.37, pitch −0.12)
  const eyeYaw = 0.37;
  const eyePitch = -0.12;
  const cp = Math.cos(eyePitch);
  const ex = Math.sin(eyeYaw) * cp * rx;
  const ey = -Math.sin(eyePitch) * ry;
  const fx = Math.max(0.18, Math.cos(eyeYaw));
  const fy = Math.max(0.18, cp);
  const ew = R * 0.25 * fx;
  const eh = R * 0.27 * fy;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bodyHits = 0;
      let rimHits = 0;
      let eyeHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px0 = x + (sx + 0.5) / SS - cx;
          const py0 = y + (sy + 0.5) / SS - cy;
          if (!insideCloud(px0, py0, R, rim)) continue;
          rimHits++;
          if (!insideCloud(px0, py0, R, 0)) continue;
          bodyHits++;
          if (
            insidePill(px0 + ex, py0 - ey, ew, eh) ||
            insidePill(px0 - ex, py0 - ey, ew, eh)
          ) {
            eyeHits++;
          }
        }
      }
      if (rimHits === 0) continue;

      const total = SS * SS;
      const rimA = rimHits / total;
      const bodyA = bodyHits / total;
      const eyeA = eyeHits / total;

      // Body gradient: top-right → bottom-left, like the Canvas gradient.
      const t = Math.min(1, Math.max(0, ((x - cx) * -0.6 + (y - cy) * 0.8) / (2 * ry) + 0.5));
      const body = [0, 1, 2].map((i) => BASE_TOP[i] + (BASE_BOTTOM[i] - BASE_TOP[i]) * t);

      // rim under body, body over rim, eyes over body
      let col = RIM.slice();
      let alpha = rimA;
      if (bodyA > 0) {
        col = col.map((c, i) => c * (1 - bodyA / rimA) + body[i] * (bodyA / rimA));
        alpha = rimA;
      }
      if (eyeA > 0) {
        col = col.map((c, i) => c * (1 - eyeA) + INK[i] * eyeA);
      }

      const o = (y * size + x) * 4;
      px[o] = Math.round(col[0]);
      px[o + 1] = Math.round(col[1]);
      px[o + 2] = Math.round(col[2]);
      px[o + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba, height = size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (size * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO (PNG-in-ICO, Vista and later) ─────────────────────────────────────────

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderCloud(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);

// ── Apple icons (macOS app, iPhone app and its alternates, menu bar) ──────────
//
//   node scripts/gen-icons.mjs --apple
//
// The cloud on a coloured tile, written into NotchBuddy's asset catalogs.

if (process.argv.includes("--apple")) {
  const CAT = join(OUT, "..", "..", "..", "NotchBuddy");
  const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  /** The cloud over a vertical gradient; `radius` rounds the tile (0 = full bleed). */
  function tile(size, top, bottom, radius, scale = 0.3) {
    const cloud = renderCloud(size, scale);
    const out = new Uint8Array(size * size * 4);
    const r = size * radius;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        const bg = lerp3(top, bottom, y / size);
        const a = cloud[o + 3] / 255;
        let ta = 1;
        if (radius > 0) {
          const cx = Math.min(Math.max(x + 0.5, r), size - r);
          const cy = Math.min(Math.max(y + 0.5, r), size - r);
          ta = Math.min(1, Math.max(0, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
        }
        for (let i = 0; i < 3; i++) out[o + i] = Math.round(cloud[o + i] * a + bg[i] * (1 - a));
        out[o + 3] = Math.round(ta * 255);
      }
    }
    return out;
  }

  /** A black silhouette with the eyes cut out, for the menu bar (a template image). */
  function menubar(w, h) {
    const out = new Uint8Array(w * h * 4);
    const R = h * 0.46;
    const ex = R * 0.37, ew = R * 0.11, eh = R * 0.16;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const px0 = x + (sx + 0.5) / SS - w / 2;
            const py0 = y + (sy + 0.5) / SS - h / 2;
            if (!insideCloud(px0, py0, R, 0)) continue;
            if (insidePill(px0 + ex, py0 - R * 0.1, ew, eh) || insidePill(px0 - ex, py0 - R * 0.1, ew, eh)) continue;
            hits++;
          }
        }
        out[(y * w + x) * 4 + 3] = Math.round((hits / (SS * SS)) * 255);
      }
    }
    return out;
  }

  const write = (rel, data) => {
    writeFileSync(join(CAT, rel), data);
    console.log(rel);
  };
  const SKY = [[176, 208, 247], [120, 168, 236]];
  const ORANGE = [[255, 196, 130], [246, 134, 64]];
  const VARIANTS = {
    Blue: [[140, 190, 250], [70, 120, 222]],
    Green: [[160, 228, 176], [66, 168, 108]],
    Purple: [[196, 168, 244], [128, 92, 212]],
    Pink: [[252, 184, 210], [226, 108, 160]],
    Graphite: [[128, 134, 146], [52, 56, 64]],
  };

  const mac = "Assets.xcassets/AppIcon.appiconset";
  for (const [name, px] of [
    ["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128],
    ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024],
  ]) {
    write(`${mac}/icon_${name}.png`, encodePNG(px, tile(px, ...SKY, 0.2237)));
  }
  for (const [n, w, h] of [["menubar", 24, 18], ["menubar@2x", 48, 36], ["menubar@3x", 72, 54]]) {
    write(`Assets.xcassets/MenuBarIcon.imageset/${n}.png`, encodePNG(w, menubar(w, h), h));
  }

  const phone = "PhoneAssets.xcassets";
  write(`${phone}/AppIcon.appiconset/icon-1024.png`, encodePNG(1024, tile(1024, ...ORANGE, 0)));
  write(`${phone}/AppIcon.appiconset/icon-1024-dark.png`, encodePNG(1024, tile(1024, [44, 48, 76], [18, 20, 38], 0)));
  write(`${phone}/AppIcon.appiconset/icon-1024-tinted.png`, encodePNG(1024, tile(1024, [60, 60, 64], [30, 30, 34], 0)));
  for (const [name, [top, bottom]] of Object.entries(VARIANTS)) {
    write(`${phone}/AppIcon-${name}.appiconset/icon-1024.png`, encodePNG(1024, tile(1024, top, bottom, 0)));
    write(`${phone}/IconPreview-${name}.imageset/preview.png`, encodePNG(180, tile(180, top, bottom, 0)));
  }
  write(`${phone}/IconPreview-Orange.imageset/preview.png`, encodePNG(180, tile(180, ...ORANGE, 0)));

  // The same cloud on the sky tile, for the site.
  writeFileSync(join(OUT, "..", "..", "..", "docs", "media", "icon.png"), encodePNG(256, tile(256, ...SKY, 0.2237)));
  console.log("docs/media/icon.png");
}
