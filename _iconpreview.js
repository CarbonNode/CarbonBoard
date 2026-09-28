// _iconpreview.js -- render the tray icon's states to a PNG contact sheet so a
// human (or a session) can LOOK at them without muting anything live.
// Run: electron _iconpreview.js   (writes _iconpreview.png next to this file)
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SCALE = 6;
const PAD = 8;

// --- the two marks, copied verbatim from electron/tray.ts -------------------
function withDot(src, size, rgb) {
  const out = Buffer.from(src);
  const r = size * 0.28;
  const cx = size - r - 0.5;
  const cy = size - r - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r + 0.6) continue;
      const i = (y * size + x) * 4;
      const rim = dist > r - Math.max(1, size / 16);
      const [R, G, B] = rim ? [0x20, 0x10, 0x10] : rgb;
      out[i] = B; out[i + 1] = G; out[i + 2] = R; out[i + 3] = 0xff;
    }
  }
  return out;
}
function withSlash(src, size, rgb) {
  const out = Buffer.from(src);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.round(out[i] * 0.75);
    out[i + 1] = Math.round(out[i + 1] * 0.75);
    out[i + 2] = Math.round(out[i + 2] * 0.75);
  }
  const half = size * 0.11;
  const rim = half + Math.max(1, size / 16);
  const [R, G, B] = rgb;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.abs(x - y) / Math.SQRT2;
      if (dist > rim) continue;
      const i = (y * size + x) * 4;
      const onRim = dist > half;
      out[i] = onRim ? 0x14 : B;
      out[i + 1] = onRim ? 0x0a : G;
      out[i + 2] = onRim ? 0x0a : R;
      out[i + 3] = 0xff;
    }
  }
  return out;
}

// Nearest-neighbour blow-up over a flat background, so 16px pixels stay pixels.
function upscaleOnto(canvas, cw, src, size, ox, oy, bg) {
  for (let y = 0; y < size * SCALE; y++) {
    for (let x = 0; x < size * SCALE; x++) {
      const si = (Math.floor(y / SCALE) * size + Math.floor(x / SCALE)) * 4;
      const a = src[si + 3] / 255;
      const di = ((oy + y) * cw + (ox + x)) * 4;
      // Electron's bitmaps are premultiplied: out = src + bg*(1-a).
      canvas[di] = Math.min(255, src[si] + bg[2] * (1 - a));
      canvas[di + 1] = Math.min(255, src[si + 1] + bg[1] * (1 - a));
      canvas[di + 2] = Math.min(255, src[si + 2] + bg[0] * (1 - a));
      canvas[di + 3] = 0xff;
    }
  }
}

app.whenReady().then(() => {
  const raw = nativeImage.createFromPath(path.join(ROOT, 'icon.ico'));
  if (raw.isEmpty()) { console.log('ICON MISSING'); app.exit(1); return; }
  const base16 = raw.resize({ width: 16, height: 16 }).toBitmap();

  const states = [
    ['healthy (no mark)', base16],
    ['feed dead (red dot, today)', withDot(Buffer.from(base16), 16, [0xff, 0x30, 0x30])],
    ['OUTPUT MUTED (new)', withSlash(Buffer.from(base16), 16, [0xff, 0x30, 0x30])],
    ['MIC MUTED (new)', withSlash(Buffer.from(base16), 16, [0xff, 0xb0, 0x20])],
  ];

  const cell = 16 * SCALE;
  const cw = states.length * cell + (states.length + 1) * PAD;
  const rows = [[0x1c, 0x1c, 0x22], [0xe8, 0xe8, 0xee]]; // dark taskbar, light taskbar
  const ch = rows.length * cell + (rows.length + 1) * PAD;
  const canvas = Buffer.alloc(cw * ch * 4);

  rows.forEach((bg, r) => {
    // flood the row band with the background colour
    const y0 = PAD + r * (cell + PAD) - PAD / 2;
    for (let y = Math.max(0, y0); y < Math.min(ch, y0 + cell + PAD); y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        canvas[i] = bg[2]; canvas[i + 1] = bg[1]; canvas[i + 2] = bg[0]; canvas[i + 3] = 0xff;
      }
    }
    states.forEach(([, bmp], c) => {
      upscaleOnto(canvas, cw, bmp, 16, PAD + c * (cell + PAD), PAD + r * (cell + PAD), bg);
    });
  });

  const sheet = nativeImage.createFromBitmap(canvas, { width: cw, height: ch });
  fs.writeFileSync(path.join(ROOT, '_iconpreview.png'), sheet.toPNG());
  // Also the true 16px versions, for a 1:1 look.
  states.forEach(([label, bmp], i) => {
    const img = nativeImage.createFromBitmap(Buffer.from(bmp), { width: 16, height: 16 });
    fs.writeFileSync(path.join(ROOT, `_icon16_${i}.png`), img.toPNG());
    console.log(`${i}  ${label}`);
  });
  console.log('PREVIEW_OK ' + cw + 'x' + ch);
  app.exit(0);
});
