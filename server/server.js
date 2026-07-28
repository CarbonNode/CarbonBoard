// CarbonBoard clip server — the server-side backing for the sound library.
// The Electron app plays clips through the rig's audio devices; this serves the
// same library over HTTP so anything can use it: the Cortex Discord soundboard
// (Lavalink fetches /clips/<file> and plays it into a voice channel), browsers
// (preview with Range requests), and future CarbonBoard sync.
//
// Deliberately dependency-light: files under DATA_DIR/clips + one clips.json.
// Runs 24/7 on carbonserver (docker-compose in this directory).
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 9601);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CLIPS_DIR = path.join(DATA_DIR, 'clips');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_FILE = path.join(DATA_DIR, 'clips.json');
const MAX_UPLOAD = 25 * 1024 * 1024;
const EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm', 'opus']);
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

fs.mkdirSync(CLIPS_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

/** @type {Array<Record<string, unknown>>} */
let clips = [];
try {
  clips = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  if (!Array.isArray(clips)) clips = [];
} catch {
  clips = [];
}

let saveQueued = false;
function save() {
  // Serialize writers within the tick; atomic tmp+rename so a crash never
  // leaves a half-written library.
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clips, null, 2));
    fs.renameSync(tmp, DB_FILE);
  });
}

const num = (v, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function publicClip(c) {
  return { ...c, file: `/clips/${c.id}.${c.ext}` };
}

const app = express();
app.use(express.json());

// Open CORS — home-LAN utility service; the Cortex gateway fronts it for the
// console, Lavalink fetches audio with plain GETs.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, clips: clips.length }));

app.get('/api/clips', (_req, res) => {
  const sorted = [...clips].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || String(a.name).localeCompare(String(b.name)),
  );
  const categories = [...new Set(clips.map(c => c.category).filter(Boolean))].sort();
  res.json({ clips: sorted.map(publicClip), categories });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: CLIPS_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname).slice(1) || 'mp3').toLowerCase();
      if (!EXTS.has(ext)) return cb(new Error(`Unsupported audio format .${ext}`));
      req.clipId = randomUUID();
      req.clipExt = ext;
      cb(null, `${req.clipId}.${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD },
});

app.post('/api/clips', upload.single('file'), (req, res) => {
  if (!req.file || !req.clipId) return res.status(400).json({ error: 'Missing audio file' });
  const b = req.body ?? {};
  const now = new Date().toISOString();
  const clip = {
    id: req.clipId,
    ext: req.clipExt,
    name: String(b.name || path.parse(req.file.originalname).name).slice(0, 120),
    category: String(b.category || '').slice(0, 60) || null,
    favorite: b.favorite === 'true' || b.favorite === true,
    volume: clamp(num(b.volume, 1), 0, 2),           // CarbonBoard's 0..1 gain (2 = boost)
    trimStart: Math.max(0, num(b.trimStart, 0)),      // seconds
    trimEnd: b.trimEnd != null && b.trimEnd !== '' ? Math.max(0, num(b.trimEnd, 0)) : null,
    duration: Math.max(0, num(b.duration, 0)),        // seconds, 0 = unknown
    size: req.file.size,
    source: String(b.source || 'upload').slice(0, 40),
    addedAt: now,
    updatedAt: now,
  };
  clips.push(clip);
  save();
  res.json({ clip: publicClip(clip) });
});

app.patch('/api/clips/:id', (req, res) => {
  const clip = clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip not found' });
  const b = req.body ?? {};
  if (b.name != null) clip.name = String(b.name).slice(0, 120);
  if (b.category !== undefined) clip.category = b.category ? String(b.category).slice(0, 60) : null;
  if (b.favorite != null) clip.favorite = !!b.favorite;
  if (b.volume != null) clip.volume = clamp(num(b.volume, clip.volume), 0, 2);
  if (b.trimStart != null) clip.trimStart = Math.max(0, num(b.trimStart, clip.trimStart));
  if (b.trimEnd !== undefined) clip.trimEnd = b.trimEnd == null ? null : Math.max(0, num(b.trimEnd, 0));
  if (b.duration != null) clip.duration = Math.max(0, num(b.duration, clip.duration));
  clip.updatedAt = new Date().toISOString();
  save();
  res.json({ clip: publicClip(clip) });
});

app.delete('/api/clips/:id', (req, res) => {
  const idx = clips.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Clip not found' });
  const [clip] = clips.splice(idx, 1);
  save();
  fs.promises.unlink(path.join(CLIPS_DIR, `${clip.id}.${clip.ext}`)).catch(() => {});
  if (clip.image) fs.promises.unlink(path.join(IMAGES_DIR, path.basename(String(clip.image)))).catch(() => {});
  res.json({ ok: true });
});

// Button art — CarbonBoard's board is visual; a clip can carry a thumbnail.
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname).slice(1) || 'png').toLowerCase();
      if (!IMG_EXTS.has(ext)) return cb(new Error(`Unsupported image format .${ext}`));
      req.imgExt = ext;
      cb(null, `${req.params.id}.${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

app.post('/api/clips/:id/image', imageUpload.single('file'), (req, res) => {
  const clip = clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip not found' });
  if (!req.file || !req.imgExt) return res.status(400).json({ error: 'Missing image file' });
  const prev = clip.image ? path.basename(String(clip.image)) : null;
  clip.image = `/images/${clip.id}.${req.imgExt}`;
  clip.updatedAt = new Date().toISOString();
  save();
  if (prev && prev !== `${clip.id}.${req.imgExt}`) {
    fs.promises.unlink(path.join(IMAGES_DIR, prev)).catch(() => {});
  }
  res.json({ clip: publicClip(clip) });
});

app.use('/images', express.static(IMAGES_DIR, { fallthrough: false, immutable: true, maxAge: '365d' }));

// Audio bytes — express.static gives us Range requests (browser scrubbing) free.
app.use('/clips', express.static(CLIPS_DIR, {
  fallthrough: false,
  immutable: true,
  maxAge: '365d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m4a')) res.setHeader('Content-Type', 'audio/mp4');
    if (filePath.endsWith('.opus')) res.setHeader('Content-Type', 'audio/ogg');
  },
}));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
  res.status(err?.status || 500).json({ error: err?.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`CarbonBoard clip server on :${PORT} — ${clips.length} clips, data at ${DATA_DIR}`);
});
