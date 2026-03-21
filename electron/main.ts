import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  NativeImage,
  shell,
  protocol,
  net,
  session,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import type { Category, SubCategory, Sound, Settings } from './types';

// ============================================================
// App Identity (for Windows taskbar pinning)
// ============================================================

if (process.platform === 'win32') {
  app.setAppUserModelId('com.squeetboard.app');
}

// ============================================================
// Enable audio output device selection in webviews
// ============================================================
app.commandLine.appendSwitch('enable-features', 'AudioServiceOutOfProcess');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ============================================================
// Constants and Paths
// ============================================================

const isDev = !app.isPackaged;
let isQuitting = false; // Track if app is quitting (for minimize to tray)
const APP_DATA_PATH = path.join(app.getPath('userData'), 'squeetboard-data');
const SOUNDS_PATH = path.join(APP_DATA_PATH, 'sounds');
const THUMBNAILS_PATH = path.join(APP_DATA_PATH, 'thumbnails');
const DB_PATH = path.join(APP_DATA_PATH, 'squeetboard.db');

// Ensure directories exist
[APP_DATA_PATH, SOUNDS_PATH, THUMBNAILS_PATH].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ============================================================
// Database Setup
// ============================================================

let db: Database.Database;

function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sub_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      categoryId TEXT NOT NULL,
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sounds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filePath TEXT NOT NULL,
      storedPath TEXT NOT NULL,
      categoryId TEXT,
      thumbnailPath TEXT,
      hotkey TEXT,
      volume REAL NOT NULL DEFAULT 1.0,
      trimStart REAL NOT NULL DEFAULT 0,
      trimEnd REAL,
      duration REAL NOT NULL DEFAULT 0,
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Add favorite column if it doesn't exist (migration)
  try {
    db.exec('ALTER TABLE sounds ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists
  }

  // Add subCategoryId column if it doesn't exist (migration)
  try {
    db.exec('ALTER TABLE sounds ADD COLUMN subCategoryId TEXT REFERENCES sub_categories(id) ON DELETE SET NULL');
  } catch {
    // Column already exists
  }

  // Add parentSoundId column if it doesn't exist (migration)
  try {
    db.exec('ALTER TABLE sounds ADD COLUMN parentSoundId TEXT REFERENCES sounds(id) ON DELETE CASCADE');
  } catch {
    // Column already exists
  }

  // Initialize default settings if not exist
  const defaultSettings: Settings = {
    masterVolume: 1.0,
    outputDeviceId: null,
    monitorDeviceId: 'default',
    lockOutputToCable: true, // Default to auto-lock CABLE
    stopAllHotkey: 'Ctrl+Shift+Space',
    pauseResumeHotkey: '',
    allowConcurrentPlayback: false,
    minimizeToTray: true,
    startMinimized: false,
    startWithWindows: false,
    // Mic passthrough defaults
    micPassthroughEnabled: false,
    micInputDeviceId: null,
    monitorVolume: 1.0,
    micVolume: 1.0,
    micNoiseGate: 0, // 0 = off
    micNoiseGateAuto: true, // Auto-adjust by default
    // View preferences
    categoryViewModes: {},
  };

  const existingSettings = db
    .prepare('SELECT key, value FROM settings')
    .all() as { key: string; value: string }[];

  if (existingSettings.length === 0) {
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    Object.entries(defaultSettings).forEach(([key, value]) => {
      insert.run(key, JSON.stringify(value));
    });
  }

  console.log('Database initialized at:', DB_PATH);
}

// ============================================================
// Database Operations
// ============================================================

function getCategories(): Category[] {
  return db
    .prepare('SELECT * FROM categories ORDER BY "order" ASC')
    .all() as Category[];
}

function createCategory(name: string): Category {
  const id = uuidv4();
  const now = new Date().toISOString();
  const maxOrder = db
    .prepare('SELECT MAX("order") as maxOrder FROM categories')
    .get() as { maxOrder: number | null };
  const order = (maxOrder?.maxOrder ?? -1) + 1;

  db.prepare(
    'INSERT INTO categories (id, name, "order", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, order, now, now);

  return { id, name, order, createdAt: now, updatedAt: now };
}

function updateCategory(id: string, name: string): Category {
  const now = new Date().toISOString();
  db.prepare('UPDATE categories SET name = ?, updatedAt = ? WHERE id = ?').run(
    name,
    now,
    id
  );
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category;
}

function deleteCategory(id: string): void {
  db.prepare('UPDATE sounds SET categoryId = NULL WHERE categoryId = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

function reorderCategories(ids: string[]): void {
  const update = db.prepare('UPDATE categories SET "order" = ? WHERE id = ?');
  ids.forEach((id, index) => {
    update.run(index, id);
  });
}

// ============================================================
// SubCategory Database Operations
// ============================================================

function getSubCategories(categoryId: string): SubCategory[] {
  return db
    .prepare('SELECT * FROM sub_categories WHERE categoryId = ? ORDER BY "order" ASC')
    .all(categoryId) as SubCategory[];
}

function getAllSubCategories(): SubCategory[] {
  return db
    .prepare('SELECT * FROM sub_categories ORDER BY "order" ASC')
    .all() as SubCategory[];
}

function createSubCategory(categoryId: string, name: string): SubCategory {
  const id = uuidv4();
  const now = new Date().toISOString();
  const maxOrder = db
    .prepare('SELECT MAX("order") as maxOrder FROM sub_categories WHERE categoryId = ?')
    .get(categoryId) as { maxOrder: number | null };
  const order = (maxOrder?.maxOrder ?? -1) + 1;

  db.prepare(
    'INSERT INTO sub_categories (id, name, categoryId, "order", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, categoryId, order, now, now);

  return { id, name, categoryId, order, createdAt: now, updatedAt: now };
}

function updateSubCategory(id: string, name: string): SubCategory {
  const now = new Date().toISOString();
  db.prepare('UPDATE sub_categories SET name = ?, updatedAt = ? WHERE id = ?').run(
    name,
    now,
    id
  );
  return db.prepare('SELECT * FROM sub_categories WHERE id = ?').get(id) as SubCategory;
}

function deleteSubCategory(id: string): void {
  // Set sounds in this sub-category to null
  db.prepare('UPDATE sounds SET subCategoryId = NULL WHERE subCategoryId = ?').run(id);
  db.prepare('DELETE FROM sub_categories WHERE id = ?').run(id);
}

function reorderSubCategories(ids: string[]): void {
  const update = db.prepare('UPDATE sub_categories SET "order" = ? WHERE id = ?');
  ids.forEach((id, index) => {
    update.run(index, id);
  });
}

function convertSoundFromDb(row: Record<string, unknown>): Sound {
  return {
    ...row,
    favorite: Boolean(row.favorite),
  } as Sound;
}

function getSounds(categoryId?: string | null): Sound[] {
  let rows: Record<string, unknown>[];
  if (categoryId === undefined) {
    rows = db
      .prepare('SELECT * FROM sounds ORDER BY "order" ASC')
      .all() as Record<string, unknown>[];
  } else if (categoryId === null) {
    rows = db
      .prepare('SELECT * FROM sounds WHERE categoryId IS NULL ORDER BY "order" ASC')
      .all() as Record<string, unknown>[];
  } else {
    rows = db
      .prepare('SELECT * FROM sounds WHERE categoryId = ? ORDER BY "order" ASC')
      .all(categoryId) as Record<string, unknown>[];
  }
  return rows.map(convertSoundFromDb);
}

function getSound(id: string): Sound | null {
  const row = db.prepare('SELECT * FROM sounds WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? convertSoundFromDb(row) : null;
}

function createSound(sound: Partial<Sound>): Sound {
  const id = uuidv4();
  const now = new Date().toISOString();
  const maxOrder = db
    .prepare('SELECT MAX("order") as maxOrder FROM sounds')
    .get() as { maxOrder: number | null };
  const order = (maxOrder?.maxOrder ?? -1) + 1;

  const newSound: Sound = {
    id,
    name: sound.name || 'Untitled Sound',
    filePath: sound.filePath || '',
    storedPath: sound.storedPath || '',
    categoryId: sound.categoryId ?? null,
    subCategoryId: sound.subCategoryId ?? null,
    thumbnailPath: sound.thumbnailPath ?? null,
    parentSoundId: sound.parentSoundId ?? null,
    hotkey: sound.hotkey ?? null,
    volume: sound.volume ?? 1.0,
    trimStart: sound.trimStart ?? 0,
    trimEnd: sound.trimEnd ?? null,
    duration: sound.duration ?? 0,
    favorite: sound.favorite ?? false,
    order,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO sounds (id, name, filePath, storedPath, categoryId, subCategoryId, parentSoundId, thumbnailPath, hotkey, volume, trimStart, trimEnd, duration, favorite, "order", createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newSound.id,
    newSound.name,
    newSound.filePath,
    newSound.storedPath,
    newSound.categoryId,
    newSound.subCategoryId,
    newSound.parentSoundId,
    newSound.thumbnailPath,
    newSound.hotkey,
    newSound.volume,
    newSound.trimStart,
    newSound.trimEnd,
    newSound.duration,
    newSound.favorite ? 1 : 0,
    newSound.order,
    newSound.createdAt,
    newSound.updatedAt
  );

  return newSound;
}

function updateSound(id: string, updates: Partial<Sound>): Sound {
  const now = new Date().toISOString();
  const current = getSound(id);
  if (!current) throw new Error('Sound not found');

  const updated = { ...current, ...updates, updatedAt: now };

  db.prepare(`
    UPDATE sounds SET
      name = ?, filePath = ?, storedPath = ?, categoryId = ?, subCategoryId = ?,
      parentSoundId = ?, thumbnailPath = ?, hotkey = ?, volume = ?, trimStart = ?,
      trimEnd = ?, duration = ?, favorite = ?, "order" = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.filePath,
    updated.storedPath,
    updated.categoryId,
    updated.subCategoryId,
    updated.parentSoundId,
    updated.thumbnailPath,
    updated.hotkey,
    updated.volume,
    updated.trimStart,
    updated.trimEnd,
    updated.duration,
    updated.favorite ? 1 : 0,
    updated.order,
    updated.updatedAt,
    id
  );

  return updated;
}

function deleteSound(id: string): void {
  const sound = getSound(id);
  if (sound) {
    // Delete sub-soundbites first
    const subSounds = getSubSounds(id);
    for (const sub of subSounds) {
      deleteSound(sub.id);
    }
    // Delete stored file (only if no other sounds reference it)
    if (sound.storedPath && fs.existsSync(sound.storedPath)) {
      const otherRefs = db.prepare('SELECT COUNT(*) as count FROM sounds WHERE storedPath = ? AND id != ?').get(sound.storedPath, id) as { count: number };
      if (otherRefs.count === 0) {
        fs.unlinkSync(sound.storedPath);
      }
    }
    // Delete thumbnail
    if (sound.thumbnailPath && fs.existsSync(sound.thumbnailPath)) {
      fs.unlinkSync(sound.thumbnailPath);
    }
  }
  db.prepare('DELETE FROM sounds WHERE id = ?').run(id);
}

function getSubSounds(parentId: string): Sound[] {
  const rows = db
    .prepare('SELECT * FROM sounds WHERE parentSoundId = ? ORDER BY "order" ASC')
    .all(parentId) as Record<string, unknown>[];
  return rows.map(convertSoundFromDb);
}

function searchSounds(query: string): Sound[] {
  const searchTerm = `%${query}%`;
  return db
    .prepare('SELECT * FROM sounds WHERE name LIKE ? ORDER BY "order" ASC')
    .all(searchTerm) as Sound[];
}

function reorderSounds(categoryId: string | null, soundIds: string[]): void {
  const update = db.prepare('UPDATE sounds SET "order" = ? WHERE id = ?');
  soundIds.forEach((id, index) => {
    update.run(index, id);
  });
}

function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const settings: Record<string, unknown> = {};
  rows.forEach((row) => {
    settings[row.key] = JSON.parse(row.value);
  });
  return settings as unknown as Settings;
}

function updateSettings(updates: Partial<Settings>): Settings {
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  );
  Object.entries(updates).forEach(([key, value]) => {
    upsert.run(key, JSON.stringify(value));
  });

  // Handle Start with Windows setting
  if ('startWithWindows' in updates) {
    app.setLoginItemSettings({
      openAtLogin: updates.startWithWindows ?? false,
      args: updates.startWithWindows && getSettings().startMinimized ? ['--minimized'] : [],
    });
  }

  // Handle Start Minimized - update login item args
  if ('startMinimized' in updates) {
    const settings = getSettings();
    if (settings.startWithWindows) {
      app.setLoginItemSettings({
        openAtLogin: true,
        args: updates.startMinimized ? ['--minimized'] : [],
      });
    }
  }

  return getSettings();
}

// ============================================================
// File Operations
// ============================================================

function importSound(sourcePath: string): { storedPath: string; duration: number } {
  const fileName = `${uuidv4()}${path.extname(sourcePath)}`;
  const destPath = path.join(SOUNDS_PATH, fileName);
  fs.copyFileSync(sourcePath, destPath);

  // Duration will be calculated in the renderer using Web Audio API
  // We set 0 here and update it after loading
  return { storedPath: destPath, duration: 0 };
}

function copyThumbnail(sourcePath: string): string {
  const fileName = `${uuidv4()}${path.extname(sourcePath)}`;
  const destPath = path.join(THUMBNAILS_PATH, fileName);
  fs.copyFileSync(sourcePath, destPath);
  return destPath;
}

async function selectSoundFiles(): Promise<string[] | null> {
  const result = await dialog.showOpenDialog({
    title: 'Select Sound Files',
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'webm'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? null : result.filePaths;
}

async function selectImageFile(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Select Image',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    ],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
}

function getSoundData(soundPath: string): Buffer {
  return fs.readFileSync(soundPath);
}

// ============================================================
// Hotkey Management
// ============================================================

const registeredHotkeys = new Map<string, string>(); // hotkey -> soundId

function registerHotkey(hotkey: string, soundId: string): boolean {
  try {
    // Unregister if already registered
    if (registeredHotkeys.has(hotkey)) {
      globalShortcut.unregister(hotkey);
    }

    const success = globalShortcut.register(hotkey, () => {
      mainWindow?.webContents.send('hotkey:triggered', soundId);
    });

    if (success) {
      registeredHotkeys.set(hotkey, soundId);
    }
    return success;
  } catch (error) {
    console.error('Failed to register hotkey:', error);
    return false;
  }
}

function unregisterHotkey(hotkey: string): void {
  try {
    globalShortcut.unregister(hotkey);
    registeredHotkeys.delete(hotkey);
  } catch (error) {
    console.error('Failed to unregister hotkey:', error);
  }
}

let stopAllHotkey: string | null = null;

function registerStopAllHotkey(hotkey: string): boolean {
  try {
    if (stopAllHotkey) {
      globalShortcut.unregister(stopAllHotkey);
    }

    const success = globalShortcut.register(hotkey, () => {
      mainWindow?.webContents.send('hotkey:stopAll');
    });

    if (success) {
      stopAllHotkey = hotkey;
    }
    return success;
  } catch (error) {
    console.error('Failed to register stop all hotkey:', error);
    return false;
  }
}

let pauseResumeHotkeyStr: string | null = null;

function registerPauseResumeHotkey(hotkey: string): boolean {
  try {
    if (pauseResumeHotkeyStr) {
      globalShortcut.unregister(pauseResumeHotkeyStr);
    }

    if (!hotkey) {
      pauseResumeHotkeyStr = null;
      return true;
    }

    const success = globalShortcut.register(hotkey, () => {
      mainWindow?.webContents.send('hotkey:pauseResume');
    });

    if (success) {
      pauseResumeHotkeyStr = hotkey;
    }
    return success;
  } catch (error) {
    console.error('Failed to register pause/resume hotkey:', error);
    return false;
  }
}

// Re-register all hotkeys (called on app start)
function registerAllHotkeys(): void {
  const sounds = getSounds();
  sounds.forEach((sound) => {
    if (sound.hotkey) {
      registerHotkey(sound.hotkey, sound.id);
    }
  });

  const settings = getSettings();
  if (settings.stopAllHotkey) {
    registerStopAllHotkey(settings.stopAllHotkey);
  }
  if (settings.pauseResumeHotkey) {
    registerPauseResumeHotkey(settings.pauseResumeHotkey);
  }
}

// ============================================================
// Window and Tray
// ============================================================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function createTray(): void {
  // Use ICO for Windows tray - looks for icon.ico in root
  const iconPath = isDev
    ? path.join(__dirname, '../icon.ico')
    : path.join(app.getAppPath(), 'icon.ico');

  // Create a simple tray icon if file doesn't exist
  let trayIcon: NativeImage;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    // Create a simple 16x16 icon
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAOxAAADsQBlSsOGwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAEJSURBVDiNpZMxTsNAEEXfLLYQDRKiQpQUSJT0NNDSIQrOAAUH4AacgQNQcISInoYOJQUNEogECRBIgPDibLLOrrMLIzma8b75f8YzawA2RA+4BW6AHnAOvAOPwA0wBH6BcwPUgS5QAZ6BiTxvAC3gDFgF3oA2cABsgAMgAY7lOQLWgCdgO4VeBZ6BI+AWqAGLwBVwCEzL8ywQAt/AhYBvgA4QyXME7AMvwFaCLACbwK28L4nPZiTvEeAIeJVnNzjAPbAnxhbQBDbEaQJ3xWE8/AdQB8I/8F9hMG7gD5yJ02LCdSnvMvCZ/HgOvAfUgD/g3P8Z/gE4lgKPSoFz4E3G2wbOgO8/0L8BSR8oKfGy4j8AAAAASUVORK5CYII='
  ) : trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Squeetboard',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Stop All Sounds',
      click: () => {
        mainWindow?.webContents.send('hotkey:stopAll');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Squeetboard');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    frame: false, // Frameless for custom title bar
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // Enable webview for Navigator
    },
    icon: isDev
      ? path.join(__dirname, '../icon.ico')
      : path.join(app.getAppPath(), 'icon.ico'),
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:3456');
    mainWindow.webContents.openDevTools();
  } else {
    // Load from static export - path relative to the app root in production
    const htmlPath = path.join(app.getAppPath(), 'out', 'index.html');
    console.log('Loading HTML from:', htmlPath);
    mainWindow.loadFile(htmlPath);
  }

  // Handle close to tray
  mainWindow.on('close', (event) => {
    const settings = getSettings();
    if (settings.minimizeToTray && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// IPC Handlers
// ============================================================

function setupIpcHandlers(): void {
  // Database - Categories
  ipcMain.handle('db:getCategories', () => getCategories());
  ipcMain.handle('db:createCategory', (_, name: string) => createCategory(name));
  ipcMain.handle('db:updateCategory', (_, id: string, name: string) =>
    updateCategory(id, name)
  );
  ipcMain.handle('db:deleteCategory', (_, id: string) => deleteCategory(id));
  ipcMain.handle('db:reorderCategories', (_, ids: string[]) =>
    reorderCategories(ids)
  );

  // Database - SubCategories
  ipcMain.handle('db:getSubCategories', (_, categoryId: string) =>
    getSubCategories(categoryId)
  );
  ipcMain.handle('db:getAllSubCategories', () => getAllSubCategories());
  ipcMain.handle('db:createSubCategory', (_, categoryId: string, name: string) =>
    createSubCategory(categoryId, name)
  );
  ipcMain.handle('db:updateSubCategory', (_, id: string, name: string) =>
    updateSubCategory(id, name)
  );
  ipcMain.handle('db:deleteSubCategory', (_, id: string) => deleteSubCategory(id));
  ipcMain.handle('db:reorderSubCategories', (_, ids: string[]) =>
    reorderSubCategories(ids)
  );

  // Database - Sounds
  ipcMain.handle('db:getSounds', (_, categoryId?: string | null) =>
    getSounds(categoryId)
  );
  ipcMain.handle('db:getSound', (_, id: string) => getSound(id));
  ipcMain.handle('db:createSound', (_, sound: Partial<Sound>) =>
    createSound(sound)
  );
  ipcMain.handle('db:updateSound', (_, id: string, updates: Partial<Sound>) =>
    updateSound(id, updates)
  );
  ipcMain.handle('db:deleteSound', (_, id: string) => deleteSound(id));
  ipcMain.handle('db:searchSounds', (_, query: string) => searchSounds(query));
  ipcMain.handle('db:reorderSounds', (_, categoryId: string | null, soundIds: string[]) =>
    reorderSounds(categoryId, soundIds)
  );

  // Database - Settings
  ipcMain.handle('db:getSettings', () => getSettings());
  ipcMain.handle('db:updateSettings', (_, settings: Partial<Settings>) =>
    updateSettings(settings)
  );

  // File operations
  ipcMain.handle('file:importSound', (_, sourcePath: string) =>
    importSound(sourcePath)
  );
  ipcMain.handle('file:selectSoundFiles', () => selectSoundFiles());
  ipcMain.handle('file:selectImageFile', () => selectImageFile());
  ipcMain.handle('file:copyThumbnail', (_, sourcePath: string) =>
    copyThumbnail(sourcePath)
  );
  ipcMain.handle('file:getSoundData', (_, soundPath: string) =>
    getSoundData(soundPath)
  );

  // Hotkeys
  ipcMain.handle('hotkey:register', (_, hotkey: string, soundId: string) =>
    registerHotkey(hotkey, soundId)
  );
  ipcMain.handle('hotkey:unregister', (_, hotkey: string) =>
    unregisterHotkey(hotkey)
  );
  ipcMain.handle('hotkey:registerStopAll', (_, hotkey: string) =>
    registerStopAllHotkey(hotkey)
  );
  ipcMain.handle('hotkey:registerPauseResume', (_, hotkey: string) =>
    registerPauseResumeHotkey(hotkey)
  );

  // Sub-sounds
  ipcMain.handle('db:getSubSounds', (_, parentId: string) =>
    getSubSounds(parentId)
  );

  // Window operations
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.on('window:hide', () => mainWindow?.hide());
  ipcMain.on('window:show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ============================================================
// App Lifecycle
// ============================================================

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('ready', () => {
    // Register custom protocol for serving local files (images/thumbnails)
    protocol.handle('local-file', (request) => {
      // Remove protocol and decode, handle Windows paths
      let filePath = decodeURIComponent(request.url.replace('local-file://', ''));
      // Convert backslashes to forward slashes for file:// URL
      filePath = filePath.replace(/\\/g, '/');
      // Ensure path starts with / for file:// protocol on Windows
      if (!filePath.startsWith('/')) {
        filePath = '/' + filePath;
      }
      return net.fetch('file://' + filePath);
    });

    // Set up permissions for the Navigator webview sessions
    const allowedPermissions = ['media', 'audioCapture', 'mediaKeySystem', 'midi', 'midiSysex'];

    const navigatorSession = session.fromPartition('persist:navigator');
    navigatorSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(allowedPermissions.includes(permission));
    });
    navigatorSession.setPermissionCheckHandler((webContents, permission) => {
      return allowedPermissions.includes(permission);
    });

    // Mirror webview session (for dual audio output)
    const mirrorSession = session.fromPartition('persist:navigator-mirror');
    mirrorSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(allowedPermissions.includes(permission));
    });
    mirrorSession.setPermissionCheckHandler((webContents, permission) => {
      return allowedPermissions.includes(permission);
    });

    initDatabase();
    setupIpcHandlers();
    createWindow();
    createTray();
    registerAllHotkeys();
    startApiServer();

    // Handle start minimized (from command line or startup)
    const settings = getSettings();
    const startMinimized = process.argv.includes('--minimized') || settings.startMinimized;
    if (startMinimized && mainWindow) {
      mainWindow.hide();
    }
  });

  // ============================================================
  // Local HTTP API (for BobbyBot / external control)
  // ============================================================

  function startApiServer() {
    const API_PORT = 9502;

    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);
      const pathname = url.pathname;

      try {
        // GET /api/categories — list all categories with sub-categories
        if (req.method === 'GET' && pathname === '/api/categories') {
          const categories = getCategories();
          const allSubs = getAllSubCategories();
          const result = categories.map((cat) => ({
            ...cat,
            subCategories: allSubs.filter((s) => s.categoryId === cat.id),
          }));
          res.writeHead(200);
          res.end(JSON.stringify({ categories: result }));
          return;
        }

        // GET /api/sounds — list all sounds, optional ?category=name&q=search
        if (req.method === 'GET' && pathname === '/api/sounds') {
          const categoryName = url.searchParams.get('category');
          const query = url.searchParams.get('q');

          let sounds: Sound[];

          if (query) {
            sounds = searchSounds(query);
          } else if (categoryName) {
            const categories = getCategories();
            const cat = categories.find(
              (c) => c.name.toLowerCase() === categoryName.toLowerCase()
            );
            sounds = cat ? getSounds(cat.id) : [];
          } else {
            sounds = getSounds();
          }

          // Strip internal paths, return useful info
          const result = sounds.map((s) => ({
            id: s.id,
            name: s.name,
            categoryId: s.categoryId,
            subCategoryId: s.subCategoryId,
            duration: s.duration,
            favorite: s.favorite,
            volume: s.volume,
          }));

          res.writeHead(200);
          res.end(JSON.stringify({ sounds: result, count: result.length }));
          return;
        }

        // POST /api/play/:id — play a sound by ID or name
        if (req.method === 'POST' && pathname.startsWith('/api/play/')) {
          const idOrName = decodeURIComponent(pathname.replace('/api/play/', ''));

          // Try by ID first, then search by name
          let sound = getSound(idOrName);
          if (!sound) {
            const results = searchSounds(idOrName);
            if (results.length > 0) sound = results[0];
          }

          if (!sound) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: `Sound "${idOrName}" not found.` }));
            return;
          }

          // Trigger playback via the renderer (same as hotkey)
          mainWindow?.webContents.send('hotkey:triggered', sound.id);

          res.writeHead(200);
          res.end(
            JSON.stringify({
              success: true,
              sound: { id: sound.id, name: sound.name },
              message: `Playing "${sound.name}"`,
            })
          );
          return;
        }

        // POST /api/stop — stop all sounds
        if (req.method === 'POST' && pathname === '/api/stop') {
          mainWindow?.webContents.send('hotkey:stopAll');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Stopped all sounds.' }));
          return;
        }

        // POST /api/pause — pause/resume
        if (req.method === 'POST' && pathname === '/api/pause') {
          mainWindow?.webContents.send('hotkey:pauseResume');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Toggled pause/resume.' }));
          return;
        }

        // 404
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found.' }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });

    server.listen(API_PORT, () => {
      console.log(`Squeetboard API listening on port ${API_PORT}`);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Squeetboard API port ${API_PORT} in use, skipping.`);
      } else {
        console.error('Squeetboard API error:', err);
      }
    });
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    db?.close();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });
}
