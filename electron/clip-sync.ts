// Clip-server sync — the library lives on carbonserver, this PC mirrors it.
//
// Before this, CarbonBoard's SQLite and the clip server were two libraries that
// happened to hold the same sounds. Adding a clip meant adding it twice, and a
// rename in one place made the other lie. Now the clip server is the source of
// truth — it is what the Cortex console edits, what the Discord bot plays, and
// what anyone means when they name a clip — and this file keeps the local
// library equal to it.
//
// The local rows are still real CarbonBoard sounds, so hotkeys, categories, the
// tray, trims and device routing all keep working untouched. The only new fact
// is a `clipId` column recording which server clip each row mirrors.

import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';

export interface ServerClip {
  id: string; ext: string; name: string; category: string | null; favorite: boolean;
  volume: number; trimStart: number; trimEnd: number | null; duration: number;
  file: string; image?: string | null;
}

export interface SyncResult {
  ok: boolean;
  added: number;
  updated: number;
  adopted: number;
  removed: number;
  total: number;
  error?: string;
}

type Deps = {
  db: Database;
  soundsPath: string;
  /** Called after the library changes so the open window redraws. */
  onChanged: () => void;
  /** CarbonBoard's own helpers, so sync creates rows exactly like an import does. */
  createSound: (s: Record<string, unknown>) => { id: string };
  getCategories: () => { id: string; name: string }[];
  createCategory: (name: string) => { id: string; name: string };
};

let deps: Deps | null = null;
let baseUrl = 'http://192.168.0.35:9601';
let syncing = false;

export function initClipSync(d: Deps, url?: string): void {
  deps = d;
  if (url) baseUrl = url.replace(/\/+$/, '');
  // One column, added the same idempotent way the app does its other migrations.
  try { d.db.exec('ALTER TABLE sounds ADD COLUMN clipId TEXT'); } catch { /* already there */ }
  try { d.db.exec('CREATE INDEX IF NOT EXISTS idx_sounds_clipId ON sounds(clipId)'); } catch { /* fine */ }
}

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`clip server HTTP ${r.status}`);
    return await r.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function download(url: string, dest: string, timeoutMs = 60_000): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`clip download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    // Write beside the target and rename: a half-written file that a later run
    // treats as "already have it" is a clip that never plays again.
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } finally {
    clearTimeout(timer);
  }
}

/** Normalised name, for adopting rows that predate sync. */
const key = (s: string) => s.trim().toLowerCase();

/**
 * Make the local library equal the clip server.
 *
 * Rows the server no longer has are deleted ONLY if they were synced (they have
 * a clipId). A sound someone imported locally and never pushed up is theirs to
 * keep — sync mirrors the server, it does not police the library.
 */
export async function syncClips(): Promise<SyncResult> {
  if (!deps) return { ok: false, added: 0, updated: 0, adopted: 0, removed: 0, total: 0, error: 'sync not initialised' };
  if (syncing) return { ok: false, added: 0, updated: 0, adopted: 0, removed: 0, total: 0, error: 'A sync is already running' };
  syncing = true;
  const { db, soundsPath, createSound, getCategories, createCategory, onChanged } = deps;

  try {
    const { clips } = await fetchJson<{ clips: ServerClip[] }>(`${baseUrl}/api/clips`);
    fs.mkdirSync(soundsPath, { recursive: true });

    const localRows = db.prepare('SELECT id, name, clipId, storedPath FROM sounds').all() as
      { id: string; name: string; clipId: string | null; storedPath: string }[];
    const byClipId = new Map(localRows.filter(r => r.clipId).map(r => [r.clipId as string, r]));
    // Rows with no clipId yet, matched on name — this is what stops the first
    // sync from duplicating a library that was already a hand-made mirror.
    const unclaimedByName = new Map<string, typeof localRows[number]>();
    for (const r of localRows) if (!r.clipId) unclaimedByName.set(key(r.name), r);

    // Categories, created once up front so each clip can just look its own up.
    const catId = new Map(getCategories().map(c => [key(c.name), c.id]));
    for (const name of new Set(clips.map(c => c.category).filter((c): c is string => !!c))) {
      if (!catId.has(key(name))) catId.set(key(name), createCategory(name).id);
    }

    let added = 0, updated = 0, adopted = 0;

    for (const clip of clips) {
      const dest = path.join(soundsPath, `cb-${clip.id}.${clip.ext}`);
      const category = clip.category ? catId.get(key(clip.category)) ?? null : null;

      let row = byClipId.get(clip.id);
      if (!row) {
        const claim = unclaimedByName.get(key(clip.name));
        if (claim) {
          // Adopt: this local sound IS this server clip. Keep its existing audio
          // file and hotkey, just record the link and take the server's metadata.
          db.prepare('UPDATE sounds SET clipId = ? WHERE id = ?').run(clip.id, claim.id);
          unclaimedByName.delete(key(clip.name));
          row = { ...claim, clipId: clip.id };
          adopted++;
        }
      }

      if (!fs.existsSync(dest) && (!row || !fs.existsSync(row.storedPath))) {
        await download(`${baseUrl}${clip.file}`, dest);
      }

      if (row) {
        // The server owns everything except the hotkey, which is this PC's own.
        db.prepare(`
          UPDATE sounds SET name = ?, categoryId = ?, favorite = ?, volume = ?,
                            trimStart = ?, trimEnd = ?, duration = ?, updatedAt = ?
          WHERE id = ?
        `).run(
          clip.name, category, clip.favorite ? 1 : 0, clip.volume,
          clip.trimStart, clip.trimEnd, clip.duration, new Date().toISOString(), row.id,
        );
        if (!adopted || row.clipId !== clip.id) updated++;
      } else {
        // createSound owns the INSERT (ordering, defaults, the `order` column),
        // so the link is stamped on afterwards rather than threaded through it.
        const created = createSound({
          name: clip.name,
          filePath: `${baseUrl}${clip.file}`,
          storedPath: dest,
          categoryId: category,
          favorite: clip.favorite,
          volume: clip.volume,
          trimStart: clip.trimStart,
          trimEnd: clip.trimEnd,
          duration: clip.duration,
        });
        db.prepare('UPDATE sounds SET clipId = ? WHERE id = ?').run(clip.id, created.id);
        added++;
      }
    }

    // Clips deleted on the server go here too — but only ones sync put here.
    const serverIds = new Set(clips.map(c => c.id));
    const stale = localRows.filter(r => r.clipId && !serverIds.has(r.clipId));
    for (const r of stale) {
      db.prepare('DELETE FROM sounds WHERE id = ?').run(r.id);
      if (r.storedPath?.includes('cb-')) { try { fs.unlinkSync(r.storedPath); } catch { /* gone already */ } }
    }

    onChanged();
    return { ok: true, added, updated, adopted, removed: stale.length, total: clips.length };
  } catch (err) {
    return {
      ok: false, added: 0, updated: 0, adopted: 0, removed: 0, total: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    syncing = false;
  }
}

/** The local sound mirroring a given server clip, if this PC has it. */
export function soundIdForClip(clipId: string): string | null {
  if (!deps) return null;
  const row = deps.db.prepare('SELECT id FROM sounds WHERE clipId = ?').get(clipId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Resolve a clip id to a local sound, pulling it from the server if this PC has
 * never seen it. Lets the console play a clip that was uploaded seconds ago
 * without anyone waiting for the periodic sync.
 */
export async function ensureClip(clipId: string): Promise<string | null> {
  const existing = soundIdForClip(clipId);
  if (existing) return existing;
  await syncClips();
  return soundIdForClip(clipId);
}

/** Sync now, then every `minutes`. Quiet on failure: the PC may just be off-LAN. */
export function startPeriodicSync(minutes = 15): void {
  const run = () => { void syncClips().catch(() => {}); };
  setTimeout(run, 5_000);
  setInterval(run, Math.max(1, minutes) * 60_000);
}
