import { contextBridge, ipcRenderer, webUtils, desktopCapturer } from 'electron';
import type { Sound, Settings, Category, SubCategory } from './types';

// ============================================================
// Preload Script - Exposes IPC to Renderer
// ============================================================

const electronAPI = {
  // Database - Categories
  getCategories: (): Promise<Category[]> =>
    ipcRenderer.invoke('db:getCategories'),
  createCategory: (name: string): Promise<Category> =>
    ipcRenderer.invoke('db:createCategory', name),
  updateCategory: (id: string, name: string): Promise<Category> =>
    ipcRenderer.invoke('db:updateCategory', id, name),
  deleteCategory: (id: string): Promise<void> =>
    ipcRenderer.invoke('db:deleteCategory', id),
  reorderCategories: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('db:reorderCategories', ids),

  // Database - SubCategories
  getSubCategories: (categoryId: string): Promise<SubCategory[]> =>
    ipcRenderer.invoke('db:getSubCategories', categoryId),
  getAllSubCategories: (): Promise<SubCategory[]> =>
    ipcRenderer.invoke('db:getAllSubCategories'),
  createSubCategory: (categoryId: string, name: string): Promise<SubCategory> =>
    ipcRenderer.invoke('db:createSubCategory', categoryId, name),
  updateSubCategory: (id: string, name: string): Promise<SubCategory> =>
    ipcRenderer.invoke('db:updateSubCategory', id, name),
  deleteSubCategory: (id: string): Promise<void> =>
    ipcRenderer.invoke('db:deleteSubCategory', id),
  reorderSubCategories: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('db:reorderSubCategories', ids),

  // Database - Sounds
  getSounds: (categoryId?: string | null): Promise<Sound[]> =>
    ipcRenderer.invoke('db:getSounds', categoryId),
  getSound: (id: string): Promise<Sound | null> =>
    ipcRenderer.invoke('db:getSound', id),
  createSound: (sound: Partial<Sound>): Promise<Sound> =>
    ipcRenderer.invoke('db:createSound', sound),
  updateSound: (id: string, updates: Partial<Sound>): Promise<Sound> =>
    ipcRenderer.invoke('db:updateSound', id, updates),
  deleteSound: (id: string): Promise<void> =>
    ipcRenderer.invoke('db:deleteSound', id),
  searchSounds: (query: string): Promise<Sound[]> =>
    ipcRenderer.invoke('db:searchSounds', query),
  reorderSounds: (categoryId: string | null, soundIds: string[]): Promise<void> =>
    ipcRenderer.invoke('db:reorderSounds', categoryId, soundIds),

  // Database - Settings
  getSettings: (): Promise<Settings> =>
    ipcRenderer.invoke('db:getSettings'),
  updateSettings: (settings: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('db:updateSettings', settings),

  // File operations
  importSound: (sourcePath: string): Promise<{ storedPath: string; duration: number }> =>
    ipcRenderer.invoke('file:importSound', sourcePath),
  selectSoundFiles: (): Promise<string[] | null> =>
    ipcRenderer.invoke('file:selectSoundFiles'),
  selectImageFile: (): Promise<string | null> =>
    ipcRenderer.invoke('file:selectImageFile'),
  copyThumbnail: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke('file:copyThumbnail', sourcePath),
  getSoundData: async (soundPath: string): Promise<ArrayBuffer> => {
    // Node.js Buffer gets serialized through IPC, need to convert to ArrayBuffer
    const buffer = await ipcRenderer.invoke('file:getSoundData', soundPath);
    // Buffer comes as {type: 'Buffer', data: [...]} or Uint8Array
    if (buffer && buffer.type === 'Buffer' && Array.isArray(buffer.data)) {
      return new Uint8Array(buffer.data).buffer as ArrayBuffer;
    }
    // If already Uint8Array or ArrayBuffer-like
    if (buffer instanceof Uint8Array) {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    }
    // Fallback: try to use as-is
    return buffer;
  },

  // Audio utilities
  restartCable: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('audio:restartCable'),

  // Hotkeys
  registerHotkey: (hotkey: string, soundId: string): Promise<boolean> =>
    ipcRenderer.invoke('hotkey:register', hotkey, soundId),
  unregisterHotkey: (hotkey: string): Promise<void> =>
    ipcRenderer.invoke('hotkey:unregister', hotkey),
  registerStopAllHotkey: (hotkey: string): Promise<boolean> =>
    ipcRenderer.invoke('hotkey:registerStopAll', hotkey),
  registerPauseResumeHotkey: (hotkey: string): Promise<boolean> =>
    ipcRenderer.invoke('hotkey:registerPauseResume', hotkey),
  getSubSounds: (parentId: string): Promise<Sound[]> =>
    ipcRenderer.invoke('db:getSubSounds', parentId),

  // Window operations
  minimizeWindow: (): void => ipcRenderer.send('window:minimize'),
  maximizeWindow: (): void => ipcRenderer.send('window:maximize'),
  closeWindow: (): void => ipcRenderer.send('window:close'),
  hideWindow: (): void => ipcRenderer.send('window:hide'),
  showWindow: (): void => ipcRenderer.send('window:show'),

  // Event listeners
  onHotkeyTriggered: (callback: (soundId: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, soundId: string) => callback(soundId);
    ipcRenderer.on('hotkey:triggered', handler);
    return () => ipcRenderer.removeListener('hotkey:triggered', handler);
  },

  onStopAll: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('hotkey:stopAll', handler);
    return () => ipcRenderer.removeListener('hotkey:stopAll', handler);
  },

  onPauseResume: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('hotkey:pauseResume', handler);
    return () => ipcRenderer.removeListener('hotkey:pauseResume', handler);
  },

  onTrayShow: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('tray:show', handler);
    return () => ipcRenderer.removeListener('tray:show', handler);
  },
  onSettingsUpdated: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('settings:updated', handler);
    return () => ipcRenderer.removeListener('settings:updated', handler);
  },

  // Utility to get file path from dropped File object
  getPathForFile: (file: File): string => {
    return webUtils.getPathForFile(file);
  },

  // Get desktop capturer sources for audio capture
  getDesktopCapturerSources: async (): Promise<Electron.DesktopCapturerSource[]> => {
    return desktopCapturer.getSources({
      types: ['window', 'screen'],
      fetchWindowIcons: false,
    });
  },
};

// Expose API to renderer
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
