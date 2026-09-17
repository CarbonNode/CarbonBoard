// The tray icon: the mic feed's controls in the bottom-right corner of Windows.
//
// WHY (2026-09-17)
// ----------------
// When the virtual mic breaks mid-call the fix is always one of three things --
// re-open the passthrough, switch the microphone, switch the profile -- and every
// one of them lived behind a hotkey, an HTTP API or the full soundboard window.
// None of those is what you reach for while four people are asking "can you hear
// us". This puts them one click away, tells you what the chain currently believes
// (the verdict from chain-watch.ts, by SIGNAL not by state), and paints a dot on
// the icon so a dead feed is visible before anyone has to say so.
//
// Everything here is main-process: the menu is built from caches that are already
// in memory (chain status, the capture mic, the device list refreshed in the
// background), so it pops instantly and never waits on PowerShell.

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, nativeImage, NativeImage, shell, Tray } from 'electron';
import * as fs from 'fs';
import type { ChainWatch, ChainVerdict } from './chain-watch';
import type * as AudioRigModule from './audio-rig';
import type { Settings } from './types';

type AudioRig = typeof AudioRigModule;

export interface TrayDeps {
  iconPath: string;
  dataDir: string;
  chain: ChainWatch;
  audioRig: AudioRig;
  window: () => BrowserWindow | null;
  getSettings: () => Settings;
  updateSettings: (s: Partial<Settings>) => void;
  toast: (title: string, mic: string | null, output: string | null, ms?: number, error?: string) => void;
  /** Tell the renderer its settings changed (mic label, mute). */
  settingsChanged: () => void;
  quit: () => void;
}

const DEVICE_REFRESH_MS = 30_000;
const ICON_REFRESH_MS = 2_000;

let tray: Tray | null = null;
let deps: TrayDeps | null = null;
let base16: NativeImage | null = null;
let base32: NativeImage | null = null;
let devices: { inputs: string[]; outputs: string[] } = { inputs: [], outputs: [] };
let devicesAt = 0;
let refreshing = false;
let lastIconState: string | null = null;
let lastTooltip: string | null = null;

export function createTray(d: TrayDeps): Tray {
  deps = d;
  const raw = fs.existsSync(d.iconPath) ? nativeImage.createFromPath(d.iconPath) : nativeImage.createEmpty();
  if (!raw.isEmpty()) {
    base16 = raw.resize({ width: 16, height: 16 });
    base32 = raw.resize({ width: 32, height: 32 });
  }
  tray = new Tray(iconFor('ok'));
  tray.setToolTip('CarbonBoard');

  // No setContextMenu: it would show a menu built at boot. Build on every open
  // instead, from the caches, so the header and the radio ticks are current.
  const open = (): void => { if (tray) tray.popUpContextMenu(buildMenu()); };
  tray.on('click', open);
  tray.on('right-click', open);
  tray.on('double-click', () => {
    const w = d.window();
    w?.show();
    w?.focus();
  });

  void refreshDevices();
  setInterval(() => { void refreshDevices(); }, DEVICE_REFRESH_MS);
  setInterval(refreshIcon, ICON_REFRESH_MS);
  refreshIcon();
  return tray;
}

/** Re-read the device list; the menu is built from the cache so this is off the click path. */
export async function refreshDevices(): Promise<void> {
  if (!deps || refreshing) return;
  refreshing = true;
  try {
    devices = await deps.audioRig.listDevices();
    devicesAt = Date.now();
  } catch {
    // Keep the last list; the menu says how old it is.
  } finally {
    refreshing = false;
  }
}

// ── the menu ─────────────────────────────────────────────────────────────────

function buildMenu(): Menu {
  const d = deps!;
  const v = d.chain.verdict();
  const settings = d.getSettings();
  const muted = !settings.micPassthroughEnabled;
  const captureMic = d.audioRig.getCaptureMic();
  const profiles = d.audioRig.readProfiles();
  const lastOutput = d.audioRig.getLastOutput();
  const same = (a: string | null, b: string | null) => d.audioRig.sameDevice(a, b);
  const activeProfile = profiles.find(p =>
    (!p.mic || same(p.mic, captureMic)) && (!p.output || same(p.output, lastOutput)))?.name ?? null;

  const mark = v.state === 'ok' ? '●' : v.state === 'off' ? '○' : '✕';
  const items: MenuItemConstructorOptions[] = [
    { label: `${mark}  ${v.title}`, enabled: false },
    { label: `    ${v.detail}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Restart mic feed',
      sublabel: 'Re-opens the microphone and the cable output',
      click: () => {
        const ok = d.chain.heal('tray');
        d.toast(ok ? 'Re-opening the mic feed' : 'Cannot re-open: no soundboard window', captureMic, null);
      },
    },
    {
      label: 'Re-pin cable as the Windows mic',
      sublabel: 'Default recording device = CABLE Output, both ends at 48 kHz',
      click: () => {
        void (async () => {
          const pinned = await d.audioRig.ensureCablePinned();
          await d.audioRig.ensureCableFormat();
          d.toast(pinned ? 'Cable pinned as the default mic' : 'VB-CABLE not found', captureMic, null, 3200, pinned ? undefined : 'Is VB-CABLE installed?');
        })();
      },
    },
    { type: 'separator' },
    {
      label: 'Profile',
      submenu: profiles.length
        ? profiles.map<MenuItemConstructorOptions>(p => ({
          label: p.name,
          sublabel: [p.mic, p.output].filter(Boolean).join('  →  ') || undefined,
          type: 'radio',
          checked: p.name === activeProfile,
          click: () => {
            d.audioRig.applyProfile(p.name)
              .then(r => { d.toast(r.applied, r.mic, r.output); d.settingsChanged(); })
              .catch(err => d.toast(p.name, null, null, 5200, err instanceof Error ? err.message : String(err)));
          },
        }))
        : [{ label: 'No profiles (SoundSwitch config not found)', enabled: false }],
    },
    {
      label: 'Microphone',
      sublabel: captureMic ?? 'none selected',
      submenu: deviceMenu(
        devices.inputs.filter(n => !d.audioRig.isCable(n)),
        captureMic,
        name => {
          // The renderer captures by label and follows this setting on its own;
          // it also re-opens the stream, which is the point when the old one is dead.
          d.audioRig.setCaptureMic(name);
          d.toast('Microphone', name, lastOutput);
        },
        'No microphones found',
      ),
    },
    {
      label: 'Headphones / speakers',
      sublabel: lastOutput ?? undefined,
      submenu: deviceMenu(
        devices.outputs.filter(n => !/cable input/i.test(n)),
        lastOutput,
        name => {
          d.audioRig.setDefaultOutput(name)
            .then(ok => d.toast(ok ? 'Output' : name, captureMic, ok ? name : null, 3200, ok ? undefined : 'Device not found'))
            .catch(err => d.toast(name, null, null, 5200, err instanceof Error ? err.message : String(err)));
        },
        'No playback devices found',
      ),
    },
    {
      label: muted ? 'Mic is MUTED - click to unmute' : 'Mute mic',
      type: 'checkbox',
      checked: muted,
      click: () => {
        d.updateSettings({ micPassthroughEnabled: muted } as Partial<Settings>);
        d.settingsChanged();
        d.toast(muted ? 'Mic unmuted' : 'Mic muted', captureMic, null);
      },
    },
    { type: 'separator' },
    { label: 'Show CarbonBoard', click: () => { const w = d.window(); w?.show(); w?.focus(); } },
    { label: 'Stop all sounds', click: () => d.window()?.webContents.send('hotkey:stopAll') },
    { label: 'Open logs folder', sublabel: 'chain.log, renderer.log, main.log', click: () => { void shell.openPath(d.dataDir); } },
    {
      label: 'Restart CarbonBoard',
      sublabel: 'The last resort: a fresh audio service',
      click: () => {
        app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--minimized').concat('--minimized') });
        d.quit();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => d.quit() },
  ];
  return Menu.buildFromTemplate(items);
}

function deviceMenu(
  names: string[],
  current: string | null,
  pick: (name: string) => void,
  empty: string,
): MenuItemConstructorOptions[] {
  if (!deps) return [];
  const same = (a: string | null, b: string | null) => deps!.audioRig.sameDevice(a, b);
  const list: MenuItemConstructorOptions[] = names.length
    ? names.map(n => ({ label: n, type: 'radio' as const, checked: same(n, current), click: () => pick(n) }))
    : [{ label: empty, enabled: false }];
  const age = devicesAt ? Math.round((Date.now() - devicesAt) / 1000) : null;
  list.push({ type: 'separator' });
  list.push({
    label: age === null ? 'Refresh list' : `Refresh list (${age}s old)`,
    click: () => { void refreshDevices(); },
  });
  return list;
}

// ── the icon ─────────────────────────────────────────────────────────────────

function refreshIcon(): void {
  if (!tray || !deps) return;
  const v = deps.chain.verdict();
  const key = v.state;
  if (key !== lastIconState) {
    lastIconState = key;
    try { tray.setImage(iconFor(key)); } catch { /* an icon is never worth a crash */ }
  }
  const tip = `CarbonBoard - ${v.title}\n${v.detail}`;
  if (tip !== lastTooltip) {
    lastTooltip = tip;
    tray.setToolTip(tip.slice(0, 127)); // Windows caps tooltips at 127 chars
  }
}

/** The app icon with a status dot in the corner: none when fine, amber when blind, red when dead or silent. */
function iconFor(state: ChainVerdict['state']): NativeImage {
  const color = state === 'ok' ? null
    : state === 'blind' || state === 'off' ? [0xff, 0xb0, 0x20]
    : [0xff, 0x30, 0x30];
  if (!base16 || !base32) return fallbackIcon();
  if (!color) {
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: base16.toBitmap() });
    img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: base32.toBitmap() });
    return img;
  }
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: withDot(base16.toBitmap(), 16, color) });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: withDot(base32.toBitmap(), 32, color) });
  return img;
}

/** Paint a filled circle with a dark rim into the bottom-right of a BGRA bitmap. */
function withDot(src: Buffer, size: number, rgb: number[]): Buffer {
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

function fallbackIcon(): NativeImage {
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAOxAAADsQBlSsOGwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAEJSURBVDiNpZMxTsNAEEXfLLYQDRKiQpQUSJT0NNDSIQrOAAUH4AacgQNQcISInoYOJQUNEogECRBIgPDibLLOrrMLIzma8b75f8YzawA2RA+4BW6AHnAOvAOPwA0wBH6BcwPUgS5QAZ6BiTxvAC3gDFgF3oA2cABsgAMgAY7lOQLWgCdgO4VeBZ6BI+AWqAGLwBVwCEzL8ywQAt/AhYBvgA4QyXME7AMvwFaCLACbwK28L4nPZiTvEeAIeJVnNzjAPbAnxhbQBDbEaQJ3xWE8/AdQB8I/8F9hMG7gD5yJ02LCdSnvMvCZ/HgOvAfUgD/g3P8Z/gE4lgKPSoFz4E3G2wbOgO8/0L8BSR8oKfGy4j8AAAAASUVORK5CYII=',
  );
}
