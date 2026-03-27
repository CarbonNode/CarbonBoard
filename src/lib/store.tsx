'use client';

import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import type { Category, SubCategory, Sound, Settings, AudioDevice, ViewMode } from '../../shared/types';
// VAD disabled - doesn't work in packaged Electron due to ASAR/WASM issues

// ============================================================
// State Types
// ============================================================

interface PlayingAudio {
  audio: HTMLAudioElement;
  monitorAudio: HTMLAudioElement | null;  // Secondary audio for local monitoring
  soundVolume: number; // Individual sound volume (0-1)
  paused: boolean; // Whether this sound is paused (not stopped)
}

interface AppState {
  categories: Category[];
  subCategories: SubCategory[];
  sounds: Sound[];
  settings: Settings;
  audioDevices: AudioDevice[];
  micInputDevices: AudioDevice[];
  selectedCategoryId: string | null; // null = "All Sounds"
  searchQuery: string;
  playingSounds: Map<string, PlayingAudio>;
  isLoading: boolean;
  editingSound: Sound | null;
  micPassthroughActive: boolean;
  micLevel: number; // 0-100, current mic input level for UI display
  selectedSoundId: string | null; // Currently selected sound for copy/paste
  clipboardThumbnail: string | null; // Copied thumbnail path
  playbackLocked: boolean; // When true, clicking sounds only selects, doesn't play
  expandedSoundIds: Set<string>; // Parent sound IDs whose sub-soundbites are visible
}

type Action =
  | { type: 'SET_CATEGORIES'; payload: Category[] }
  | { type: 'ADD_CATEGORY'; payload: Category }
  | { type: 'UPDATE_CATEGORY'; payload: Category }
  | { type: 'DELETE_CATEGORY'; payload: string }
  | { type: 'SET_SUB_CATEGORIES'; payload: SubCategory[] }
  | { type: 'ADD_SUB_CATEGORY'; payload: SubCategory }
  | { type: 'UPDATE_SUB_CATEGORY'; payload: SubCategory }
  | { type: 'DELETE_SUB_CATEGORY'; payload: string }
  | { type: 'SET_SOUNDS'; payload: Sound[] }
  | { type: 'ADD_SOUND'; payload: Sound }
  | { type: 'UPDATE_SOUND'; payload: Sound }
  | { type: 'DELETE_SOUND'; payload: string }
  | { type: 'SET_SETTINGS'; payload: Settings }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<Settings> }
  | { type: 'SET_AUDIO_DEVICES'; payload: AudioDevice[] }
  | { type: 'SET_MIC_INPUT_DEVICES'; payload: AudioDevice[] }
  | { type: 'SET_MIC_PASSTHROUGH_ACTIVE'; payload: boolean }
  | { type: 'SET_MIC_LEVEL'; payload: number }
  | { type: 'SET_SELECTED_CATEGORY'; payload: string | null }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'ADD_PLAYING_SOUND'; payload: { id: string; audio: HTMLAudioElement; monitorAudio: HTMLAudioElement | null; soundVolume: number } }
  | { type: 'REMOVE_PLAYING_SOUND'; payload: string }
  | { type: 'CLEAR_PLAYING_SOUNDS' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_EDITING_SOUND'; payload: Sound | null }
  | { type: 'SET_SELECTED_SOUND'; payload: string | null }
  | { type: 'SET_CLIPBOARD_THUMBNAIL'; payload: string | null }
  | { type: 'SET_PLAYBACK_LOCKED'; payload: boolean }
  | { type: 'SET_SOUND_PAUSED'; payload: { id: string; paused: boolean } }
  | { type: 'TOGGLE_EXPANDED_SOUND'; payload: string }
  | { type: 'EXPAND_SOUND'; payload: string };

// ============================================================
// Initial State
// ============================================================

const initialState: AppState = {
  categories: [],
  subCategories: [],
  sounds: [],
  settings: {
    masterVolume: 1.0,
    outputDeviceId: null,
    monitorDeviceId: 'default',
    lockOutputToCable: true,
    stopAllHotkey: 'Ctrl+Shift+Space',
    pauseResumeHotkey: '',
    allowConcurrentPlayback: false,
    minimizeToTray: true,
    startMinimized: false,
    startWithWindows: false,
    micPassthroughEnabled: false,
    micInputDeviceId: null,
    monitorVolume: 1.0,
    micVolume: 1.0,
    micNoiseGate: 0,
    micNoiseGateAuto: true,
    micNoiseSuppression: false,
    micEchoCancellation: false,
    micAutoGainControl: false,
    categoryViewModes: {},
  },
  audioDevices: [],
  micInputDevices: [],
  selectedCategoryId: null,
  searchQuery: '',
  playingSounds: new Map(),
  isLoading: true,
  editingSound: null,
  micPassthroughActive: false,
  micLevel: 0,
  selectedSoundId: null,
  clipboardThumbnail: null,
  playbackLocked: false,
  expandedSoundIds: new Set(),
};

// ============================================================
// Reducer
// ============================================================

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_CATEGORIES':
      return { ...state, categories: action.payload };
    case 'ADD_CATEGORY':
      return { ...state, categories: [...state.categories, action.payload] };
    case 'UPDATE_CATEGORY':
      return {
        ...state,
        categories: state.categories.map((c) =>
          c.id === action.payload.id ? action.payload : c
        ),
      };
    case 'DELETE_CATEGORY':
      return {
        ...state,
        categories: state.categories.filter((c) => c.id !== action.payload),
        selectedCategoryId:
          state.selectedCategoryId === action.payload ? null : state.selectedCategoryId,
      };
    case 'SET_SUB_CATEGORIES':
      return { ...state, subCategories: action.payload };
    case 'ADD_SUB_CATEGORY':
      return { ...state, subCategories: [...state.subCategories, action.payload] };
    case 'UPDATE_SUB_CATEGORY':
      return {
        ...state,
        subCategories: state.subCategories.map((sc) =>
          sc.id === action.payload.id ? action.payload : sc
        ),
      };
    case 'DELETE_SUB_CATEGORY':
      return {
        ...state,
        subCategories: state.subCategories.filter((sc) => sc.id !== action.payload),
      };
    case 'SET_SOUNDS':
      return { ...state, sounds: action.payload };
    case 'ADD_SOUND':
      return { ...state, sounds: [...state.sounds, action.payload] };
    case 'UPDATE_SOUND':
      return {
        ...state,
        sounds: state.sounds.map((s) =>
          s.id === action.payload.id ? action.payload : s
        ),
      };
    case 'DELETE_SOUND':
      return {
        ...state,
        sounds: state.sounds.filter((s) => s.id !== action.payload),
      };
    case 'SET_SETTINGS':
      return { ...state, settings: action.payload };
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.payload } };
    case 'SET_AUDIO_DEVICES':
      return { ...state, audioDevices: action.payload };
    case 'SET_MIC_INPUT_DEVICES':
      return { ...state, micInputDevices: action.payload };
    case 'SET_MIC_PASSTHROUGH_ACTIVE':
      return { ...state, micPassthroughActive: action.payload };
    case 'SET_MIC_LEVEL':
      return { ...state, micLevel: action.payload };
    case 'SET_SELECTED_CATEGORY':
      return { ...state, selectedCategoryId: action.payload };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
    case 'ADD_PLAYING_SOUND': {
      const newMap = new Map(state.playingSounds);
      newMap.set(action.payload.id, {
        audio: action.payload.audio,
        monitorAudio: action.payload.monitorAudio,
        soundVolume: action.payload.soundVolume,
        paused: false,
      });
      return { ...state, playingSounds: newMap };
    }
    case 'REMOVE_PLAYING_SOUND': {
      const newMap = new Map(state.playingSounds);
      newMap.delete(action.payload);
      return { ...state, playingSounds: newMap };
    }
    case 'CLEAR_PLAYING_SOUNDS':
      return { ...state, playingSounds: new Map() };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_EDITING_SOUND':
      return { ...state, editingSound: action.payload };
    case 'SET_SELECTED_SOUND':
      return { ...state, selectedSoundId: action.payload };
    case 'SET_CLIPBOARD_THUMBNAIL':
      return { ...state, clipboardThumbnail: action.payload };
    case 'SET_PLAYBACK_LOCKED':
      return { ...state, playbackLocked: action.payload };
    case 'SET_SOUND_PAUSED': {
      const newMap = new Map(state.playingSounds);
      const entry = newMap.get(action.payload.id);
      if (entry) {
        newMap.set(action.payload.id, { ...entry, paused: action.payload.paused });
      }
      return { ...state, playingSounds: newMap };
    }
    case 'TOGGLE_EXPANDED_SOUND': {
      const next = new Set(state.expandedSoundIds);
      if (next.has(action.payload)) next.delete(action.payload);
      else next.add(action.payload);
      return { ...state, expandedSoundIds: next };
    }
    case 'EXPAND_SOUND': {
      const next = new Set(state.expandedSoundIds);
      next.add(action.payload);
      return { ...state, expandedSoundIds: next };
    }
    default:
      return state;
  }
}

// ============================================================
// Context
// ============================================================

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  audioContext: AudioContext | null;
  loadData: () => Promise<Settings | null>;
  createCategory: (name: string) => Promise<void>;
  updateCategory: (id: string, name: string) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  createSubCategory: (categoryId: string, name: string) => Promise<SubCategory | undefined>;
  updateSubCategory: (id: string, name: string) => Promise<void>;
  deleteSubCategory: (id: string) => Promise<void>;
  reorderSubCategories: (subCategoryIds: string[]) => Promise<void>;
  importSounds: (filePaths: string[]) => Promise<void>;
  updateSound: (id: string, updates: Partial<Sound>) => Promise<void>;
  deleteSound: (id: string) => Promise<void>;
  reorderSounds: (categoryId: string | null, soundIds: string[]) => Promise<void>;
  reorderCategories: (categoryIds: string[]) => Promise<void>;
  playSound: (sound: Sound) => Promise<void>;
  previewSound: (sound: Sound) => Promise<void>;
  stopPreview: () => void;
  getPreviewAudio: () => HTMLAudioElement | null;
  stopSound: (soundId: string) => void;
  stopAllSounds: () => void;
  seekSound: (soundId: string, time: number) => void;
  pauseSound: (soundId: string) => void;
  resumeSound: (soundId: string) => void;
  pauseResumeLastSound: () => void;
  createSubSoundbite: (parentSound: Sound, trimStart: number, trimEnd: number, name: string) => Promise<void>;
  updateSettings: (settings: Partial<Settings>) => Promise<void>;
  refreshAudioDevices: () => Promise<AudioDevice[]>;
  startMicPassthrough: () => Promise<void>;
  stopMicPassthrough: () => void;
  setMicVolume: (volume: number) => void;
}

const AppContext = createContext<AppContextType | null>(null);

// ============================================================
// Provider
// ============================================================

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const audioContextRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // Mic passthrough refs
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micGainRef = useRef<GainNode | null>(null);
  const micOutputAudioRef = useRef<HTMLAudioElement | null>(null);
  const micDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micLevelIntervalRef = useRef<number | null>(null);
  const micGateGainRef = useRef<GainNode | null>(null); // For noise gate
  const micNoiseGateThresholdRef = useRef<number>(0); // Track current threshold
  const micNoiseGateAutoRef = useRef<boolean>(true); // Track auto mode
  const micNoiseFloorRef = useRef<number>(10); // Track background noise level
  const micNoiseFloorSamplesRef = useRef<number[]>([]); // Rolling samples for noise floor
  const micGateOpenRef = useRef<boolean>(false); // Track if gate is currently open (speaking)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null); // Track current preview audio
  // VAD disabled - using volume-based detection instead

  // Initialize AudioContext
  useEffect(() => {
    audioContextRef.current = new AudioContext();
    return () => {
      audioContextRef.current?.close();
    };
  }, []);

  // Global keyboard handler for Ctrl+C/V (copy/paste thumbnail)
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Only handle Ctrl+C and Ctrl+V
      if (!e.ctrlKey || (e.key !== 'c' && e.key !== 'v')) return;

      // Don't handle if we're in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'c' && state.selectedSoundId) {
        // Copy thumbnail from selected sound
        const sound = state.sounds.find((s) => s.id === state.selectedSoundId);
        if (sound?.thumbnailPath) {
          dispatch({ type: 'SET_CLIPBOARD_THUMBNAIL', payload: sound.thumbnailPath });
          console.log('Copied thumbnail from:', sound.name);
        }
      } else if (e.key === 'v' && state.selectedSoundId && state.clipboardThumbnail) {
        // Paste thumbnail to selected sound
        e.preventDefault();
        const sound = state.sounds.find((s) => s.id === state.selectedSoundId);
        if (sound && window.electronAPI) {
          try {
            await window.electronAPI.updateSound(state.selectedSoundId, {
              thumbnailPath: state.clipboardThumbnail,
            });
            // Reload sounds to get updated data
            const sounds = await window.electronAPI.getSounds();
            dispatch({ type: 'SET_SOUNDS', payload: sounds });
            console.log('Pasted thumbnail to:', sound.name);
          } catch (err) {
            console.error('Failed to paste thumbnail:', err);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.selectedSoundId, state.clipboardThumbnail, state.sounds]);

  // Load initial data
  const loadData = useCallback(async (): Promise<Settings | null> => {
    if (typeof window === 'undefined' || !window.electronAPI) return null;

    try {
      dispatch({ type: 'SET_LOADING', payload: true });

      const [categories, subCategories, sounds, loadedSettings] = await Promise.all([
        window.electronAPI.getCategories(),
        window.electronAPI.getAllSubCategories(),
        window.electronAPI.getSounds(),
        window.electronAPI.getSettings(),
      ]);

      // Merge loaded settings with defaults to handle missing fields
      const defaultSettings: Settings = {
        masterVolume: 1.0,
        outputDeviceId: null,
        monitorDeviceId: 'default',
        lockOutputToCable: true,
        stopAllHotkey: 'Ctrl+Shift+Space',
        pauseResumeHotkey: '',
        allowConcurrentPlayback: false,
        minimizeToTray: true,
        startMinimized: false,
        startWithWindows: false,
        micPassthroughEnabled: false,
        micInputDeviceId: null,
        monitorVolume: 1.0,
        micVolume: 1.0,
        micNoiseGate: 0,
        micNoiseGateAuto: true,
        micNoiseSuppression: false,
        micEchoCancellation: false,
        micAutoGainControl: false,
        categoryViewModes: {},
      };
      const settings: Settings = { ...defaultSettings, ...loadedSettings };

      dispatch({ type: 'SET_CATEGORIES', payload: categories });
      dispatch({ type: 'SET_SUB_CATEGORIES', payload: subCategories });
      dispatch({ type: 'SET_SOUNDS', payload: sounds });
      dispatch({ type: 'SET_SETTINGS', payload: settings });

      // Register stop all hotkey
      if (settings.stopAllHotkey) {
        await window.electronAPI.registerStopAllHotkey(settings.stopAllHotkey);
      }

      // Register all sound hotkeys
      for (const sound of sounds) {
        if (sound.hotkey) {
          await window.electronAPI.registerHotkey(sound.hotkey, sound.id);
        }
      }

      return settings;
    } catch (error) {
      console.error('Failed to load data:', error);
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, []);

  // Refresh audio devices
  const refreshAudioDevices = useCallback(async () => {
    try {
      // Request mic permission to get device labels
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Permission denied, continue with limited device info
      }

      const devices = await navigator.mediaDevices.enumerateDevices();

      const audioOutputs = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Output ${d.deviceId.slice(0, 8)}`,
          kind: 'audiooutput' as const,
        }));

      const audioInputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          kind: 'audiooutput' as const, // Type compatibility
        }));

      dispatch({ type: 'SET_AUDIO_DEVICES', payload: audioOutputs });
      dispatch({ type: 'SET_MIC_INPUT_DEVICES', payload: audioInputs });

      return audioOutputs;
    } catch (error) {
      console.error('Failed to enumerate audio devices:', error);
      return [];
    }
  }, []);

  // Initialize
  useEffect(() => {
    const init = async () => {
      const settings = await loadData();
      const devices = await refreshAudioDevices();

      // Find CABLE Input device
      const cableDevice = devices.find((d) =>
        d.label.toLowerCase().includes('cable input') ||
        d.label.toLowerCase().includes('vb-audio')
      );

      // Auto-select VB-CABLE if lockOutputToCable is enabled OR if no output device is set
      if (cableDevice && settings) {
        const shouldAutoSelect = settings.lockOutputToCable || !settings.outputDeviceId;
        if (shouldAutoSelect && settings.outputDeviceId !== cableDevice.deviceId) {
          console.log('Auto-selecting VB-CABLE:', cableDevice.label);
          if (window.electronAPI) {
            const updated = await window.electronAPI.updateSettings({ outputDeviceId: cableDevice.deviceId });
            dispatch({ type: 'SET_SETTINGS', payload: updated });
          }
        }
      }
    };

    init();

    // Listen for device changes
    const handleDeviceChange = async () => {
      const devices = await refreshAudioDevices();

      // Re-lock to CABLE if setting is enabled
      const currentSettings = state.settings;
      if (currentSettings.lockOutputToCable) {
        const cableDevice = devices.find((d) =>
          d.label.toLowerCase().includes('cable input') ||
          d.label.toLowerCase().includes('vb-audio')
        );
        if (cableDevice && currentSettings.outputDeviceId !== cableDevice.deviceId) {
          console.log('Re-locking to VB-CABLE after device change:', cableDevice.label);
          if (window.electronAPI) {
            const updated = await window.electronAPI.updateSettings({ outputDeviceId: cableDevice.deviceId });
            dispatch({ type: 'SET_SETTINGS', payload: updated });
          }
        }
      }
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

    // Periodic health check — verify output device is still valid every 30s
    const healthCheck = setInterval(async () => {
      const devices = await refreshAudioDevices();
      const currentSettings = state.settings;
      if (!currentSettings.outputDeviceId) return;

      const deviceStillExists = devices.some(d => d.deviceId === currentSettings.outputDeviceId);
      if (!deviceStillExists && currentSettings.lockOutputToCable) {
        // Stored device ID is stale — re-find CABLE by name
        const cableDevice = devices.find((d) =>
          d.label.toLowerCase().includes('cable input') ||
          d.label.toLowerCase().includes('vb-audio')
        );
        if (cableDevice) {
          console.log('Output device ID stale, re-locking to VB-CABLE:', cableDevice.label);
          if (window.electronAPI) {
            const updated = await window.electronAPI.updateSettings({ outputDeviceId: cableDevice.deviceId });
            dispatch({ type: 'SET_SETTINGS', payload: updated });
          }
        }
      }
    }, 30000);

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      clearInterval(healthCheck);
    };
  }, []);

  // Category operations
  const createCategory = useCallback(async (name: string) => {
    if (!window.electronAPI) return;
    const category = await window.electronAPI.createCategory(name);
    dispatch({ type: 'ADD_CATEGORY', payload: category });
  }, []);

  const updateCategory = useCallback(async (id: string, name: string) => {
    if (!window.electronAPI) return;
    const category = await window.electronAPI.updateCategory(id, name);
    dispatch({ type: 'UPDATE_CATEGORY', payload: category });
  }, []);

  const deleteCategory = useCallback(async (id: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.deleteCategory(id);
    dispatch({ type: 'DELETE_CATEGORY', payload: id });
    // Reload sounds to update categoryId references
    const sounds = await window.electronAPI.getSounds();
    dispatch({ type: 'SET_SOUNDS', payload: sounds });
  }, []);

  // Sound operations
  const importSounds = useCallback(async (filePaths: string[]) => {
    if (!window.electronAPI) return;

    for (const filePath of filePaths) {
      try {
        const { storedPath } = await window.electronAPI.importSound(filePath);

        // Get file name without extension for default name
        const fileName = filePath.split(/[\\/]/).pop() || 'Untitled';
        const name = fileName.replace(/\.[^/.]+$/, '');

        // Create sound entry
        const sound = await window.electronAPI.createSound({
          name,
          filePath,
          storedPath,
          categoryId: state.selectedCategoryId,
          volume: 1.0,
          trimStart: 0,
          trimEnd: null,
          duration: 0, // Will be set when loaded
        });

        dispatch({ type: 'ADD_SOUND', payload: sound });
      } catch (error) {
        console.error('Failed to import sound:', filePath, error);
      }
    }
  }, [state.selectedCategoryId]);

  const updateSoundFn = useCallback(async (id: string, updates: Partial<Sound>) => {
    if (!window.electronAPI) return;
    const sound = await window.electronAPI.updateSound(id, updates);
    dispatch({ type: 'UPDATE_SOUND', payload: sound });

    // Handle hotkey changes
    const oldSound = state.sounds.find((s) => s.id === id);
    if (oldSound?.hotkey && oldSound.hotkey !== updates.hotkey) {
      await window.electronAPI.unregisterHotkey(oldSound.hotkey);
    }
    if (updates.hotkey) {
      await window.electronAPI.registerHotkey(updates.hotkey, id);
    }
  }, [state.sounds]);

  const deleteSound = useCallback(async (id: string) => {
    if (!window.electronAPI) return;
    const sound = state.sounds.find((s) => s.id === id);
    if (sound?.hotkey) {
      await window.electronAPI.unregisterHotkey(sound.hotkey);
    }
    await window.electronAPI.deleteSound(id);
    dispatch({ type: 'DELETE_SOUND', payload: id });
  }, [state.sounds]);

  const reorderSounds = useCallback(async (categoryId: string | null, soundIds: string[]) => {
    if (!window.electronAPI) return;
    await window.electronAPI.reorderSounds(categoryId, soundIds);
    // Reload sounds to get updated order
    const sounds = await window.electronAPI.getSounds();
    dispatch({ type: 'SET_SOUNDS', payload: sounds });
  }, []);

  const reorderCategories = useCallback(async (categoryIds: string[]) => {
    if (!window.electronAPI) return;
    await window.electronAPI.reorderCategories(categoryIds);
    // Reload categories to get updated order
    const categories = await window.electronAPI.getCategories();
    dispatch({ type: 'SET_CATEGORIES', payload: categories });
  }, []);

  // SubCategory operations
  const createSubCategory = useCallback(async (categoryId: string, name: string) => {
    if (!window.electronAPI) return;
    const subCategory = await window.electronAPI.createSubCategory(categoryId, name);
    dispatch({ type: 'ADD_SUB_CATEGORY', payload: subCategory });
    return subCategory;
  }, []);

  const updateSubCategory = useCallback(async (id: string, name: string) => {
    if (!window.electronAPI) return;
    const subCategory = await window.electronAPI.updateSubCategory(id, name);
    dispatch({ type: 'UPDATE_SUB_CATEGORY', payload: subCategory });
  }, []);

  const deleteSubCategory = useCallback(async (id: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.deleteSubCategory(id);
    dispatch({ type: 'DELETE_SUB_CATEGORY', payload: id });
    // Reload sounds to update subCategoryId references
    const sounds = await window.electronAPI.getSounds();
    dispatch({ type: 'SET_SOUNDS', payload: sounds });
  }, []);

  const reorderSubCategories = useCallback(async (subCategoryIds: string[]) => {
    if (!window.electronAPI) return;
    await window.electronAPI.reorderSubCategories(subCategoryIds);
    // Reload sub-categories to get updated order
    const subCategories = await window.electronAPI.getAllSubCategories();
    dispatch({ type: 'SET_SUB_CATEGORIES', payload: subCategories });
  }, []);

  // Playback operations
  const playSound = useCallback(async (sound: Sound) => {
    if (!window.electronAPI) return;

    // Check concurrent playback setting
    if (!state.settings.allowConcurrentPlayback) {
      stopAllSounds();
    }

    // Check if already playing - stop it first, then restart
    if (state.playingSounds.has(sound.id)) {
      stopSound(sound.id);
    }

    try {
      // Get sound data
      const data = await window.electronAPI.getSoundData(sound.storedPath);

      // Create audio element for primary output (CABLE Input for Discord)
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      // Set output device for Discord
      if (state.settings.outputDeviceId && 'setSinkId' in audio) {
        try {
          await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
            .setSinkId(state.settings.outputDeviceId);
          console.log('Sound routed to output:', state.settings.outputDeviceId);
        } catch (e) {
          console.warn('Failed to set output device:', e);
        }
      }

      // Create second audio element for monitor (local speakers)
      let monitorAudio: HTMLAudioElement | null = null;
      const monitorDevice = state.settings?.monitorDeviceId;

      // "off" = no monitor, "default" or null = system default, otherwise specific device
      if (monitorDevice && monitorDevice !== 'off') {
        try {
          monitorAudio = new Audio(url);
          // Only set sink if it's a specific device (not "default")
          if (monitorDevice !== 'default' && 'setSinkId' in monitorAudio) {
            await (monitorAudio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
              .setSinkId(monitorDevice);
            console.log('Sound routed to monitor:', monitorDevice);
          } else {
            console.log('Sound routed to monitor: system default');
          }
        } catch (e) {
          console.warn('Failed to set monitor device:', e);
          monitorAudio = null;
        }
      }

      // Set volume: master for output, monitorVolume for monitor (clamp to 0-1)
      audio.volume = Math.min(1, Math.max(0, sound.volume * state.settings.masterVolume));
      if (monitorAudio) {
        monitorAudio.volume = Math.min(1, Math.max(0, sound.volume * (state.settings.monitorVolume ?? state.settings.masterVolume)));
        monitorAudio.currentTime = sound.trimStart;
      }

      // Set start time
      audio.currentTime = sound.trimStart;

      // Handle end time
      const handleTimeUpdate = () => {
        if (sound.trimEnd !== null && audio.currentTime >= sound.trimEnd) {
          audio.pause();
          if (monitorAudio) monitorAudio.pause();
          audio.dispatchEvent(new Event('ended'));
        }
      };

      const handleEnded = () => {
        audio.removeEventListener('timeupdate', handleTimeUpdate);
        audio.removeEventListener('ended', handleEnded);
        if (monitorAudio) {
          monitorAudio.pause();
        }
        URL.revokeObjectURL(url);
        dispatch({ type: 'REMOVE_PLAYING_SOUND', payload: sound.id });
      };

      audio.addEventListener('timeupdate', handleTimeUpdate);
      audio.addEventListener('ended', handleEnded);

      dispatch({
        type: 'ADD_PLAYING_SOUND',
        payload: { id: sound.id, audio, monitorAudio, soundVolume: sound.volume }
      });

      // Play both audio elements
      await audio.play();
      if (monitorAudio) {
        await monitorAudio.play();
      }
    } catch (error) {
      console.error('Failed to play sound:', error);
    }
  }, [state.settings, state.playingSounds]);

  // Preview sound - plays to monitor device only (for editing)
  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      const src = previewAudioRef.current.src;
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      previewAudioRef.current = null;
    }
  }, []);

  const previewSound = useCallback(async (sound: Sound) => {
    if (!window.electronAPI) return;

    // Stop any existing preview
    stopPreview();

    try {
      const data = await window.electronAPI.getSoundData(sound.storedPath);
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      // Play to monitor device (local speakers) or default
      const monitorDevice = state.settings?.monitorDeviceId;
      // Only set sink if it's a specific device (not "default" or "off")
      if (monitorDevice && monitorDevice !== 'default' && monitorDevice !== 'off' && 'setSinkId' in audio) {
        try {
          await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
            .setSinkId(monitorDevice);
        } catch (e) {
          console.warn('Failed to set preview device:', e);
        }
      }
      // If "default", "off", or not set, just plays to system default

      // Set volume (preview goes to monitor only, clamp to 0-1)
      audio.volume = Math.min(1, Math.max(0, sound.volume * (state.settings.monitorVolume ?? state.settings.masterVolume)));
      audio.currentTime = sound.trimStart;

      // Handle trim end
      const handleTimeUpdate = () => {
        if (sound.trimEnd !== null && audio.currentTime >= sound.trimEnd) {
          audio.pause();
          URL.revokeObjectURL(url);
        }
      };

      const handleEnded = () => {
        audio.removeEventListener('timeupdate', handleTimeUpdate);
        URL.revokeObjectURL(url);
      };

      audio.addEventListener('timeupdate', handleTimeUpdate);
      audio.addEventListener('ended', () => {
        handleEnded();
        previewAudioRef.current = null;
      });

      previewAudioRef.current = audio;
      await audio.play();
    } catch (error) {
      console.error('Failed to preview sound:', error);
    }
  }, [state.settings]);

  const stopSound = useCallback((soundId: string) => {
    const playing = state.playingSounds.get(soundId);
    if (playing) {
      playing.audio.pause();
      playing.audio.currentTime = 0;
      if (playing.monitorAudio) {
        playing.monitorAudio.pause();
        playing.monitorAudio.currentTime = 0;
      }
      dispatch({ type: 'REMOVE_PLAYING_SOUND', payload: soundId });
    }
  }, [state.playingSounds]);

  const stopAllSounds = useCallback(() => {
    state.playingSounds.forEach((playing) => {
      playing.audio.pause();
      playing.audio.currentTime = 0;
      if (playing.monitorAudio) {
        playing.monitorAudio.pause();
        playing.monitorAudio.currentTime = 0;
      }
    });
    dispatch({ type: 'CLEAR_PLAYING_SOUNDS' });
  }, [state.playingSounds]);

  const seekSound = useCallback((soundId: string, time: number) => {
    const playing = state.playingSounds.get(soundId);
    if (playing) {
      try {
        playing.audio.currentTime = time;
        if (playing.monitorAudio) {
          playing.monitorAudio.currentTime = time;
        }
      } catch (e) {
        console.warn('Failed to seek:', e);
      }
    }
  }, [state.playingSounds]);

  const pauseSound = useCallback((soundId: string) => {
    const playing = state.playingSounds.get(soundId);
    if (playing && !playing.paused) {
      playing.audio.pause();
      if (playing.monitorAudio) {
        playing.monitorAudio.pause();
      }
      dispatch({ type: 'SET_SOUND_PAUSED', payload: { id: soundId, paused: true } });
    }
  }, [state.playingSounds]);

  const resumeSound = useCallback((soundId: string) => {
    const playing = state.playingSounds.get(soundId);
    if (playing && playing.paused) {
      playing.audio.play();
      if (playing.monitorAudio) {
        playing.monitorAudio.play();
      }
      dispatch({ type: 'SET_SOUND_PAUSED', payload: { id: soundId, paused: false } });
    }
  }, [state.playingSounds]);

  const pauseResumeLastSound = useCallback(() => {
    // Find the last entry in playingSounds (most recently added)
    let lastId: string | null = null;
    for (const [id] of state.playingSounds) {
      lastId = id;
    }
    if (lastId) {
      const playing = state.playingSounds.get(lastId);
      if (playing) {
        if (playing.paused) {
          resumeSound(lastId);
        } else {
          pauseSound(lastId);
        }
      }
    }
  }, [state.playingSounds, pauseSound, resumeSound]);

  const createSubSoundbite = useCallback(async (parentSound: Sound, subTrimStart: number, subTrimEnd: number, subName: string) => {
    if (!window.electronAPI) return;
    const newSound = await window.electronAPI.createSound({
      name: subName,
      filePath: parentSound.filePath,
      storedPath: parentSound.storedPath,
      categoryId: parentSound.categoryId,
      subCategoryId: parentSound.subCategoryId,
      parentSoundId: parentSound.id,
      thumbnailPath: parentSound.thumbnailPath,
      volume: parentSound.volume,
      trimStart: subTrimStart,
      trimEnd: subTrimEnd,
      duration: parentSound.duration,
    });
    dispatch({ type: 'ADD_SOUND', payload: newSound });
    dispatch({ type: 'EXPAND_SOUND', payload: parentSound.id });
  }, []);

  // Listen for hotkey events from main process
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    const unsubscribeHotkey = window.electronAPI.onHotkeyTriggered((soundId) => {
      const sound = state.sounds.find((s) => s.id === soundId);
      if (sound) {
        playSound(sound);
      }
    });

    const unsubscribeStopAll = window.electronAPI.onStopAll(() => {
      stopAllSounds();
    });

    const unsubscribePauseResume = window.electronAPI.onPauseResume(() => {
      pauseResumeLastSound();
    });

    const unsubscribeSettingsUpdated = window.electronAPI.onSettingsUpdated?.(async () => {
      const settings = await window.electronAPI.getSettings();
      dispatch({ type: 'SET_SETTINGS', payload: settings });
      await refreshAudioDevices();
    }) || (() => {});

    return () => {
      unsubscribeHotkey();
      unsubscribeStopAll();
      unsubscribePauseResume();
      unsubscribeSettingsUpdated();
    };
  }, [state.sounds, playSound, stopAllSounds, pauseResumeLastSound]);

  // Settings operations
  const updateSettingsFn = useCallback(async (settings: Partial<Settings>) => {
    if (!window.electronAPI) return;
    const updated = await window.electronAPI.updateSettings(settings);
    dispatch({ type: 'SET_SETTINGS', payload: updated });

    // Update stop all hotkey if changed
    if (settings.stopAllHotkey) {
      await window.electronAPI.registerStopAllHotkey(settings.stopAllHotkey);
    }

    // Update pause/resume hotkey if changed
    if ('pauseResumeHotkey' in settings) {
      await window.electronAPI.registerPauseResumeHotkey(settings.pauseResumeHotkey || '');
    }
  }, []);

  // Update all playing sounds' volume when master or monitor volume changes
  useEffect(() => {
    state.playingSounds.forEach((playing) => {
      try {
        if (playing.audio && !playing.audio.paused) {
          playing.audio.volume = Math.min(1, Math.max(0, playing.soundVolume * state.settings.masterVolume));
        }
        if (playing.monitorAudio && !playing.monitorAudio.paused) {
          playing.monitorAudio.volume = Math.min(1, Math.max(0, playing.soundVolume * (state.settings.monitorVolume ?? state.settings.masterVolume)));
        }
      } catch (e) {
        // Audio element may have been disposed
      }
    });
  }, [state.settings.masterVolume, state.settings.monitorVolume, state.playingSounds]);

  // ============================================================
  // Mic Passthrough
  // ============================================================

  const startMicPassthrough = useCallback(async () => {
    console.log('startMicPassthrough called');

    // Create AudioContext if not exists
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    // Stop existing passthrough first
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (micOutputAudioRef.current) {
      micOutputAudioRef.current.pause();
      micOutputAudioRef.current.srcObject = null;
    }

    try {
      // Get mic input with optional browser audio processing
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: state.settings.micInputDeviceId
            ? { exact: state.settings.micInputDeviceId }
            : undefined,
          noiseSuppression: state.settings.micNoiseSuppression ?? false,
          echoCancellation: state.settings.micEchoCancellation ?? false,
          autoGainControl: state.settings.micAutoGainControl ?? false,
        },
      };

      console.log('Requesting mic with constraints:', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current = stream;
      console.log('Got mic stream with noise suppression');

      // Resume audio context if suspended
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      // Create source from mic stream
      const source = audioContextRef.current.createMediaStreamSource(stream);
      micSourceRef.current = source;

      // Create analyser node for level monitoring
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      micAnalyserRef.current = analyser;

      // Create gain node for mic volume
      const gainNode = audioContextRef.current.createGain();
      gainNode.gain.value = state.settings.micVolume ?? 1.0;
      micGainRef.current = gainNode;

      // Create gate gain node for noise gate
      const gateGain = audioContextRef.current.createGain();
      // Start CLOSED in auto mode (VAD will open when speech detected)
      // Start OPEN in manual mode with no threshold set
      const isAutoMode = state.settings.micNoiseGateAuto ?? true;
      const manualThreshold = state.settings.micNoiseGate ?? 0;
      gateGain.gain.value = isAutoMode || manualThreshold > 0 ? 0 : 1.0;
      micGateGainRef.current = gateGain;

      // Create a destination node to capture the processed audio
      const destination = audioContextRef.current.createMediaStreamDestination();
      micDestinationRef.current = destination;

      // Connect: mic -> analyser -> volume gain -> gate gain -> destination
      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(gateGain);
      gateGain.connect(destination);

      // Initialize refs
      micNoiseGateThresholdRef.current = state.settings.micNoiseGate ?? 0;
      micNoiseGateAutoRef.current = state.settings.micNoiseGateAuto ?? true;
      micNoiseFloorRef.current = 30; // Start with conservative estimate (will adapt)
      micNoiseFloorSamplesRef.current = [];
      micGateOpenRef.current = false;

      // Start level monitoring
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const NOISE_FLOOR_SAMPLE_COUNT = 40; // ~2 seconds of samples at 50ms interval
      const AUTO_THRESHOLD_MARGIN = 25; // Add this % above noise floor (was 15, increased for noisy environments)

      const updateLevel = () => {
        if (!micAnalyserRef.current) return;

        micAnalyserRef.current.getByteFrequencyData(dataArray);
        // Calculate RMS level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const level = Math.min(100, Math.round((rms / 128) * 100));

        dispatch({ type: 'SET_MIC_LEVEL', payload: level });

        // Volume-based noise gate threshold
        let threshold = micNoiseGateThresholdRef.current;

        if (micNoiseGateAutoRef.current) {
          // Auto mode - dynamically calculate threshold based on noise floor
          const noiseFloor = micNoiseFloorRef.current;

          // If gate is closed (not speaking), sample the noise floor
          if (!micGateOpenRef.current) {
            micNoiseFloorSamplesRef.current.push(level);
            // Keep only recent samples
            if (micNoiseFloorSamplesRef.current.length > NOISE_FLOOR_SAMPLE_COUNT) {
              micNoiseFloorSamplesRef.current.shift();
            }
            // Calculate noise floor as the average of samples
            if (micNoiseFloorSamplesRef.current.length >= 10) {
              const avgNoise = micNoiseFloorSamplesRef.current.reduce((a, b) => a + b, 0)
                / micNoiseFloorSamplesRef.current.length;
              micNoiseFloorRef.current = Math.max(5, Math.round(avgNoise));
            }
          }

          // Auto threshold = noise floor + margin
          threshold = Math.min(100, noiseFloor + AUTO_THRESHOLD_MARGIN);
        }

        // Apply noise gate
        if (threshold > 0 && micGateGainRef.current) {
          // Use hysteresis: open at threshold, close at threshold - 15 (larger gap to prevent flutter)
          const closeThreshold = Math.max(0, threshold - 15);

          if (micGateOpenRef.current) {
            // Gate is open - close if level drops below close threshold
            if (level < closeThreshold) {
              micGateGainRef.current.gain.linearRampToValueAtTime(0, audioContextRef.current!.currentTime + 0.01);
              micGateOpenRef.current = false;
            }
          } else {
            // Gate is closed - open if level rises above threshold
            if (level >= threshold) {
              micGateGainRef.current.gain.linearRampToValueAtTime(1, audioContextRef.current!.currentTime + 0.01);
              micGateOpenRef.current = true;
              // Clear noise floor samples when speaking starts
              if (micNoiseGateAutoRef.current) {
                micNoiseFloorSamplesRef.current = [];
              }
            }
          }
        } else if (micGateGainRef.current && !micNoiseGateAutoRef.current) {
          // Manual mode with threshold 0 - ensure gate is open
          micGateGainRef.current.gain.value = 1;
          micGateOpenRef.current = true;
        }
      };

      micLevelIntervalRef.current = window.setInterval(updateLevel, 50);

      // Create an Audio element to play the mic to the selected output device
      const audio = new Audio();
      audio.srcObject = destination.stream;
      micOutputAudioRef.current = audio;

      // Route to CABLE Input (or selected output device)
      if (state.settings.outputDeviceId && 'setSinkId' in audio) {
        try {
          await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
            .setSinkId(state.settings.outputDeviceId);
          console.log('Mic routed to:', state.settings.outputDeviceId);
        } catch (e) {
          console.warn('Failed to set mic output device:', e);
        }
      }

      await audio.play();
      console.log('Mic audio playing');

      // Note: Silero VAD disabled - doesn't work in packaged Electron apps due to ASAR/WASM issues
      // Using volume-based detection with browser's built-in noiseSuppression instead
      console.log('Using volume-based voice detection (browser noiseSuppression enabled)');

      dispatch({ type: 'SET_MIC_PASSTHROUGH_ACTIVE', payload: true });
      console.log('Mic passthrough started successfully');
    } catch (error) {
      console.error('Failed to start mic passthrough:', error);
      dispatch({ type: 'SET_MIC_PASSTHROUGH_ACTIVE', payload: false });
    }
  }, [state.settings.micInputDeviceId, state.settings.micVolume, state.settings.outputDeviceId]);

  const stopMicPassthrough = useCallback(() => {
    // Stop level monitoring
    if (micLevelIntervalRef.current) {
      clearInterval(micLevelIntervalRef.current);
      micLevelIntervalRef.current = null;
    }

    // Stop audio output
    if (micOutputAudioRef.current) {
      micOutputAudioRef.current.pause();
      micOutputAudioRef.current.srcObject = null;
      micOutputAudioRef.current = null;
    }

    // Stop all tracks
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    // Disconnect nodes
    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }

    if (micAnalyserRef.current) {
      micAnalyserRef.current.disconnect();
      micAnalyserRef.current = null;
    }

    if (micGainRef.current) {
      micGainRef.current.disconnect();
      micGainRef.current = null;
    }

    if (micGateGainRef.current) {
      micGateGainRef.current.disconnect();
      micGateGainRef.current = null;
    }

    if (micDestinationRef.current) {
      micDestinationRef.current.disconnect();
      micDestinationRef.current = null;
    }

    dispatch({ type: 'SET_MIC_PASSTHROUGH_ACTIVE', payload: false });
    dispatch({ type: 'SET_MIC_LEVEL', payload: 0 });
    console.log('Mic passthrough stopped');
  }, []);

  const setMicVolume = useCallback((volume: number) => {
    if (micGainRef.current) {
      micGainRef.current.gain.value = volume;
    }
  }, []);

  // Update mic volume when setting changes
  useEffect(() => {
    if (micGainRef.current) {
      micGainRef.current.gain.value = state.settings.micVolume;
    }
  }, [state.settings.micVolume]);

  // Update noise gate refs when settings change
  useEffect(() => {
    micNoiseGateThresholdRef.current = state.settings.micNoiseGate ?? 0;
  }, [state.settings.micNoiseGate]);

  useEffect(() => {
    micNoiseGateAutoRef.current = state.settings.micNoiseGateAuto ?? true;
    // Reset noise floor when switching modes
    if (state.settings.micNoiseGateAuto) {
      micNoiseFloorRef.current = 10;
      micNoiseFloorSamplesRef.current = [];
    }
  }, [state.settings.micNoiseGateAuto]);

  // Restart mic passthrough when input device changes (if currently active)
  const prevMicDeviceRef = useRef<string | null>(state.settings.micInputDeviceId);
  useEffect(() => {
    const prevDevice = prevMicDeviceRef.current;
    const newDevice = state.settings.micInputDeviceId;
    prevMicDeviceRef.current = newDevice;

    // If device changed and passthrough is active, restart it
    if (prevDevice !== newDevice && state.micPassthroughActive) {
      console.log('Mic input device changed, restarting passthrough');
      // Reset noise floor for new device
      micNoiseFloorRef.current = 10;
      micNoiseFloorSamplesRef.current = [];
      // Restart passthrough with new device
      stopMicPassthrough();
      startMicPassthrough();
    }
  }, [state.settings.micInputDeviceId, state.micPassthroughActive, stopMicPassthrough, startMicPassthrough]);

  // Restart mic passthrough when output device changes (mic routes to output)
  const prevOutputDeviceRef = useRef<string | null>(state.settings.outputDeviceId);
  useEffect(() => {
    const prevDevice = prevOutputDeviceRef.current;
    const newDevice = state.settings.outputDeviceId;
    prevOutputDeviceRef.current = newDevice;

    // If output device changed and passthrough is active, restart to route to new output
    if (prevDevice !== newDevice && state.micPassthroughActive) {
      console.log('Output device changed, restarting mic passthrough');
      // Don't reset noise floor - same mic, just different output
      stopMicPassthrough();
      startMicPassthrough();
    }
  }, [state.settings.outputDeviceId, state.micPassthroughActive, stopMicPassthrough, startMicPassthrough]);

  // Update monitor audio on playing sounds when monitor device changes
  const prevMonitorDeviceRef = useRef<string | null>(state.settings.monitorDeviceId ?? null);
  useEffect(() => {
    const prevDevice = prevMonitorDeviceRef.current;
    const newDevice = state.settings.monitorDeviceId ?? null;
    prevMonitorDeviceRef.current = newDevice;

    // If monitor device changed, update all playing sounds
    if (prevDevice !== newDevice && state.playingSounds.size > 0) {
      console.log('Monitor device changed, updating playing sounds:', newDevice);

      state.playingSounds.forEach((playing, soundId) => {
        if (playing.monitorAudio && 'setSinkId' in playing.monitorAudio) {
          const audioWithSink = playing.monitorAudio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> };

          if (newDevice === 'off') {
            // Mute monitor
            playing.monitorAudio.pause();
          } else if (newDevice && newDevice !== 'default') {
            // Switch to specific device
            audioWithSink.setSinkId(newDevice).catch((e) => {
              console.warn('Failed to update monitor device for playing sound:', e);
            });
            if (playing.monitorAudio.paused && !playing.audio.paused) {
              playing.monitorAudio.currentTime = playing.audio.currentTime;
              playing.monitorAudio.play().catch(() => {});
            }
          } else {
            // Switch to default device
            audioWithSink.setSinkId('').catch((e) => {
              console.warn('Failed to reset monitor device to default:', e);
            });
            if (playing.monitorAudio.paused && !playing.audio.paused) {
              playing.monitorAudio.currentTime = playing.audio.currentTime;
              playing.monitorAudio.play().catch(() => {});
            }
          }
        }
      });
    }
  }, [state.settings.monitorDeviceId, state.playingSounds]);

  // Auto-start mic passthrough if enabled on load
  useEffect(() => {
    if (state.settings.micPassthroughEnabled && !state.micPassthroughActive && !state.isLoading) {
      startMicPassthrough();
    }
  }, [state.settings.micPassthroughEnabled, state.isLoading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMicPassthrough();
    };
  }, [stopMicPassthrough]);

  // Listen for system device changes (e.g., user switches default device via Audio Switcher)
  useEffect(() => {
    const handleDeviceChange = async () => {
      console.log('System audio devices changed');

      // Refresh our device list
      await refreshAudioDevices();

      // If mic passthrough is active, restart it to pick up new default device
      if (state.micPassthroughActive) {
        console.log('Restarting mic passthrough due to device change');
        stopMicPassthrough();
        // Small delay to let the system settle
        setTimeout(() => {
          startMicPassthrough();
        }, 100);
      }
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [state.micPassthroughActive, refreshAudioDevices, stopMicPassthrough, startMicPassthrough]);

  const value: AppContextType = {
    state,
    dispatch,
    audioContext: audioContextRef.current,
    loadData,
    createCategory,
    updateCategory,
    deleteCategory,
    createSubCategory,
    updateSubCategory,
    deleteSubCategory,
    reorderSubCategories,
    importSounds,
    updateSound: updateSoundFn,
    deleteSound,
    reorderSounds,
    reorderCategories,
    playSound,
    previewSound,
    stopPreview,
    getPreviewAudio: () => previewAudioRef.current,
    stopSound,
    stopAllSounds,
    seekSound,
    pauseSound,
    resumeSound,
    pauseResumeLastSound,
    createSubSoundbite,
    updateSettings: updateSettingsFn,
    refreshAudioDevices,
    startMicPassthrough,
    stopMicPassthrough,
    setMicVolume,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ============================================================
// Hook
// ============================================================

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
