// ============================================================
// CarbonBoard Shared Types
// ============================================================

export interface Category {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubCategory {
  id: string;
  name: string;
  categoryId: string;  // Parent category (required)
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface Sound {
  id: string;
  name: string;
  filePath: string;           // Original file path
  storedPath: string;         // Path in app data directory
  categoryId: string | null;
  subCategoryId: string | null;  // Sub-category within the category
  thumbnailPath: string | null;
  hotkey: string | null;      // e.g., "Ctrl+Shift+1"
  volume: number;             // 0.0 to 1.0
  trimStart: number;          // Start time in seconds
  trimEnd: number | null;     // End time in seconds (null = full duration)
  duration: number;           // Total duration in seconds
  parentSoundId: string | null; // Parent sound ID for sub-soundbites
  favorite: boolean;          // Whether sound is favorited
  order: number;
  createdAt: string;
  updatedAt: string;
}

export type ViewMode = 'grid' | 'list';

export interface Settings {
  masterVolume: number;
  outputDeviceId: string | null;
  monitorDeviceId: string | null;  // Secondary output for local monitoring
  lockOutputToCable: boolean; // Auto-select CABLE Input when available
  stopAllHotkey: string;
  pauseResumeHotkey: string;
  allowConcurrentPlayback: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
  startWithWindows: boolean;
  // Mic passthrough settings
  micPassthroughEnabled: boolean;
  micInputDeviceId: string | null;
  monitorVolume: number;
  micVolume: number;
  micNoiseGate: number; // 0 = off, 1-100 = threshold
  micNoiseGateAuto: boolean; // Auto-adjust threshold based on background noise
  micNoiseSuppression: boolean; // Browser noise suppression (can cause boxy audio)
  micEchoCancellation: boolean; // Browser echo cancellation (can cause phasing)
  micAutoGainControl: boolean; // Browser auto gain control (can cause pumping)
  // View preferences per category (categoryId -> viewMode, 'all' for all sounds)
  categoryViewModes: Record<string, ViewMode>;
}

export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: 'audiooutput';
}

// IPC Channel types
export type IpcChannels = {
  // Database operations
  'db:getCategories': () => Category[];
  'db:createCategory': (name: string) => Category;
  'db:updateCategory': (id: string, name: string) => Category;
  'db:deleteCategory': (id: string) => void;
  'db:reorderCategories': (ids: string[]) => void;

  'db:getSounds': (categoryId?: string | null) => Sound[];
  'db:getSound': (id: string) => Sound | null;
  'db:createSound': (sound: Partial<Sound>) => Sound;
  'db:updateSound': (id: string, updates: Partial<Sound>) => Sound;
  'db:deleteSound': (id: string) => void;
  'db:searchSounds': (query: string) => Sound[];
  'db:reorderSounds': (categoryId: string | null, soundIds: string[]) => void;

  'db:getSettings': () => Settings;
  'db:updateSettings': (settings: Partial<Settings>) => Settings;

  // File operations
  'file:importSound': (sourcePath: string) => { storedPath: string; duration: number };
  'file:selectSoundFiles': () => string[] | null;
  'file:selectImageFile': () => string | null;
  'file:copyThumbnail': (sourcePath: string) => string;
  'file:getSoundData': (path: string) => ArrayBuffer;

  // Hotkey operations
  'hotkey:register': (hotkey: string, soundId: string) => boolean;
  'hotkey:unregister': (hotkey: string) => void;
  'hotkey:registerStopAll': (hotkey: string) => boolean;
  'hotkey:registerPauseResume': (hotkey: string) => boolean;

  'db:getSubSounds': (parentId: string) => Sound[];

  // Window operations
  'window:minimize': () => void;
  'window:maximize': () => void;
  'window:close': () => void;
  'window:hide': () => void;
  'window:show': () => void;

  // Tray operations
  'tray:stopAll': () => void;
};

// Events from main to renderer
export type IpcEvents = {
  'hotkey:triggered': (soundId: string) => void;
  'hotkey:stopAll': () => void;
  'hotkey:pauseResume': () => void;
  'tray:show': () => void;
  'tray:stopAll': () => void;
};

// Preload API exposed to renderer
export interface ElectronAPI {
  // Database - Categories
  getCategories: () => Promise<Category[]>;
  createCategory: (name: string) => Promise<Category>;
  updateCategory: (id: string, name: string) => Promise<Category>;
  deleteCategory: (id: string) => Promise<void>;
  reorderCategories: (ids: string[]) => Promise<void>;

  // Database - SubCategories
  getSubCategories: (categoryId: string) => Promise<SubCategory[]>;
  getAllSubCategories: () => Promise<SubCategory[]>;
  createSubCategory: (categoryId: string, name: string) => Promise<SubCategory>;
  updateSubCategory: (id: string, name: string) => Promise<SubCategory>;
  deleteSubCategory: (id: string) => Promise<void>;
  reorderSubCategories: (ids: string[]) => Promise<void>;

  getSounds: (categoryId?: string | null) => Promise<Sound[]>;
  getSound: (id: string) => Promise<Sound | null>;
  createSound: (sound: Partial<Sound>) => Promise<Sound>;
  updateSound: (id: string, updates: Partial<Sound>) => Promise<Sound>;
  deleteSound: (id: string) => Promise<void>;
  searchSounds: (query: string) => Promise<Sound[]>;
  reorderSounds: (categoryId: string | null, soundIds: string[]) => Promise<void>;

  getSettings: () => Promise<Settings>;
  updateSettings: (settings: Partial<Settings>) => Promise<Settings>;

  // Files
  importSound: (sourcePath: string) => Promise<{ storedPath: string; duration: number }>;
  selectSoundFiles: () => Promise<string[] | null>;
  selectImageFile: () => Promise<string | null>;
  copyThumbnail: (sourcePath: string) => Promise<string>;
  getSoundData: (path: string) => Promise<ArrayBuffer>;

  // Audio utilities
  restartCable: () => Promise<{ success: boolean; error?: string }>;
  onSettingsUpdated: (callback: () => void) => () => void;

  // Hotkeys
  registerHotkey: (hotkey: string, soundId: string) => Promise<boolean>;
  unregisterHotkey: (hotkey: string) => Promise<void>;
  registerStopAllHotkey: (hotkey: string) => Promise<boolean>;
  registerPauseResumeHotkey: (hotkey: string) => Promise<boolean>;
  getSubSounds: (parentId: string) => Promise<Sound[]>;

  // Window
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  hideWindow: () => void;
  showWindow: () => void;

  // Events
  onHotkeyTriggered: (callback: (soundId: string) => void) => () => void;
  onStopAll: (callback: () => void) => () => void;
  onPauseResume: (callback: () => void) => () => void;
  onTrayShow: (callback: () => void) => () => void;

  // Utilities
  getPathForFile: (file: File) => string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
