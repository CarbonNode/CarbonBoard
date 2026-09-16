'use client';

import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import type { Category, SubCategory, Sound, Settings, AudioDevice, ViewMode } from '../../shared/types';
import { findDeviceByLabel } from './deviceLabel';
// VAD disabled - doesn't work in packaged Electron due to ASAR/WASM issues

// ============================================================
// State Types
// ============================================================

interface PlayingAudio {
  audio: HTMLAudioElement;
  monitorAudio: HTMLAudioElement | null;  // Secondary audio for local monitoring
  soundVolume: number; // Individual sound volume (clip server allows 0-2)
  paused: boolean; // Whether this sound is paused (not stopped)
  /**
   * Web Audio gain stages, when the output could be routed through one. An
   * <audio> element caps at 100%; a GainNode does not, which is what lets the
   * master go to 400%. null = the element path (volume clamped to 1).
   */
  gain: GainNode | null;
  monitorGain: GainNode | null;
  /** The contexts behind those gains, closed when the clip ends or is stopped. */
  contexts: AudioContext[];
  startedAt: number;
}

/** How loud a clip may be asked to go: 2x clip boost x 4x master. Web Audio clips past 0 dBFS, so past ~1 this is deliberately crunchy. */
const MAX_GAIN = 8;
const clampGain = (v: number) => Math.min(MAX_GAIN, Math.max(0, Number.isFinite(v) ? v : 1));

/**
 * Route an <audio> element through a GainNode on its own AudioContext so its
 * loudness is not capped at 100%. `sinkId` null/'default' = the default output.
 * Returns null when the browser cannot put a context on that sink (older
 * Chromium, or a special id like "communications"), and the caller falls back
 * to the element's own volume.
 */
async function attachGain(
  audio: HTMLAudioElement, sinkId: string | null | undefined, gain: number,
): Promise<{ ctx: AudioContext; gain: GainNode } | null> {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    if (sinkId && sinkId !== 'default') {
      const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (typeof c.setSinkId !== 'function') throw new Error('AudioContext.setSinkId unavailable');
      await c.setSinkId(sinkId);
    }
    const src = ctx.createMediaElementSource(audio);
    const g = ctx.createGain();
    g.gain.value = clampGain(gain);
    src.connect(g);
    g.connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume();
    // The element's own volume still multiplies in front of the source node.
    audio.volume = 1;
    return { ctx, gain: g };
  } catch (e) {
    console.warn('Gain path unavailable, using element volume (capped at 100%):', e);
    if (ctx) { try { await ctx.close(); } catch { /* fine */ } }
    return null;
  }
}

const closeContexts = (p: PlayingAudio) => {
  for (const c of p.contexts) { c.close().catch(() => {}); }
};

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
  | { type: 'ADD_PLAYING_SOUND'; payload: { id: string; audio: HTMLAudioElement; monitorAudio: HTMLAudioElement | null; soundVolume: number; gain: GainNode | null; monitorGain: GainNode | null; contexts: AudioContext[] } }
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
        // Remove the sound, promote its sub-sounds to standalone
        sounds: state.sounds
          .filter((s) => s.id !== action.payload)
          .map((s) => s.parentSoundId === action.payload ? { ...s, parentSoundId: null } : s),
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
        gain: action.payload.gain,
        monitorGain: action.payload.monitorGain,
        contexts: action.payload.contexts,
        startedAt: Date.now(),
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
  // Serialises startMicPassthrough. Its "stop the existing stream" step runs
  // BEFORE the await on getUserMedia, so two overlapping starts each opened a
  // stream and only the last one landed in micStreamRef -- the other became a
  // capture handle nothing could ever close. Re-applying the profile (how the
  // watchdog self-heals) stops only the referenced stream, so the orphan
  // survived every heal and the app sat holding two microphones for hours.
  const micStartGenRef = useRef(0);
  // Read from a device-change callback, which closes over a stale `state`, so
  // the live value has to come from a ref rather than the reducer.
  const micPassthroughActiveRef = useRef(false);
  const lastDefaultMicRef = useRef<string | null>(null);
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
  // Gate timing. A gate that closes the instant the level dips is a gate that
  // chops the gaps between words: speech is full of 100-300 ms holes that sit
  // below any sane threshold, and every one of them used to cut the cable and
  // cost the first consonant of the next word. Hold the gate open through them,
  // and only sample the noise floor once it has been quiet long enough that the
  // tail of the last word is out of the window.
  const micGateBelowSinceRef = useRef<number>(0); // ms timestamp the level first fell below the close threshold while open; 0 = not below
  const micGateOpenedAtRef = useRef<number>(0);
  const micGateClosedAtRef = useRef<number>(0);
  // What the main process's chain watch is told every 500 ms: the input level,
  // whether the gate is open and how many clips are playing -- i.e. whether
  // anything SHOULD be on the cable right now. Main meters the cable itself.
  const micLevelRef = useRef<number>(0);
  const micThresholdEffRef = useRef<number>(0);
  const playingCountRef = useRef<number>(0);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null); // Track current preview audio
  // VAD disabled - using volume-based detection instead

  // Self-healing refs
  const micIntentionalStopRef = useRef<boolean>(false); // Distinguish intentional stop from unexpected track end
  const micRecoveryInProgressRef = useRef<boolean>(false); // Prevent concurrent recovery attempts
  const cableRestartTimestampRef = useRef<number>(0); // Rate-limit VB-CABLE restarts (min 30s between attempts)
  const micHealthCheckRef = useRef<number | null>(null); // Interval ref for mic pipeline health check
  /**
   * The mic pipeline reads its configuration through these refs, never through
   * `state` directly.
   *
   * startMicPassthrough and the devicechange listener are both created once, so
   * the `state.settings` they close over is the INITIAL state — every field
   * undefined — for the entire life of the app. That is not a style point, it is
   * the bug that produced the permanent green ring in Discord: the restart path
   * saw no configured mic, fell through to the system default, and the system
   * default is the virtual cable this app feeds. It captured its own output.
   */
  const settingsRef = useRef(initialState.settings);
  const micInputDevicesRef = useRef<AudioDevice[]>([]);

  // Initialize AudioContext
  useEffect(() => {
    audioContextRef.current = new AudioContext();

    // Auto-resume AudioContext if it gets suspended (Chromium autoplay policy)
    audioContextRef.current.onstatechange = () => {
      if (audioContextRef.current?.state === 'suspended') {
        console.warn('AudioContext suspended, attempting to resume...');
        audioContextRef.current.resume().catch(e =>
          console.error('Failed to resume AudioContext:', e)
        );
      }
    };

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

      // Auto-expand parents that have sub-sounds so they're visible on load
      const parentIds = new Set(sounds.filter(s => s.parentSoundId).map(s => s.parentSoundId!));
      parentIds.forEach(id => dispatch({ type: 'EXPAND_SOUND', payload: id }));

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

  settingsRef.current = state.settings;
  micInputDevicesRef.current = state.micInputDevices;

  // Refresh audio devices
  const refreshAudioDevices = useCallback(async () => {
    try {
      // Unlock device LABELS. enumerateDevices() returns empty label strings
      // until the page has held a microphone once, and the whole mic-by-label
      // design depends on those labels.
      //
      // Two things here are load-bearing, and both were bugs:
      //   1. The tracks MUST be stopped. This runs on startup and again on every
      //      `devicechange`, so a leaked stream is a capture handle that lives as
      //      long as the app does — CarbonBoard showed up in the audio-session
      //      list holding TWO capture streams, one of them on CABLE Output.
      //   2. It must never ask for `{ audio: true }`. That is the DEFAULT
      //      recording device, which on this machine is deliberately the virtual
      //      cable that CarbonBoard itself feeds. Asking for a named non-cable
      //      device instead keeps the permission prompt off the loop entirely.
      try {
        const prior = await navigator.mediaDevices.enumerateDevices();
        // A usable label is the proof this device is really named — on a cold
        // first run every label is '' and there is nothing to pick from, so we
        // fall back to the default for that one prompt and stop it immediately.
        const safe = prior.find(
          d => d.kind === 'audioinput'
            && !!d.deviceId
            && !!d.label
            && d.deviceId !== 'default'
            && d.deviceId !== 'communications'
            && !/cable|vb-audio/i.test(d.label),
        );
        // Probe ONLY while the labels are still hidden. The permission is
        // granted once and stays granted, so re-opening a real microphone on
        // every devicechange and every 30s health check bought nothing and
        // cost a capture handle: any probe that fails to close is a second
        // microphone the app then holds for its whole life, which is what the
        // watchdog kept reporting as "2 microphones open at once".
        const labelled = prior.some(d => d.kind === 'audioinput' && !!d.label);
        if (!labelled) {
          const probe = await navigator.mediaDevices.getUserMedia(
            safe ? { audio: { deviceId: { exact: safe.deviceId } } } : { audio: true },
          );
          probe.getTracks().forEach(t => t.stop());
        }
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
      // Immediately, not on the next render: startMicPassthrough can run inside
      // this same tick and must be able to match its mic by label.
      micInputDevicesRef.current = audioInputs;

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

    // Which physical mic "Windows default" currently points at. When the mic
    // input is set to Default (the recommended setting), the passthrough has to
    // be re-opened whenever that changes — getUserMedia binds a device at open
    // time and keeps holding the old one, which is exactly how switching
    // headsets used to leave the soundboard mixed with a dead microphone.
    /**
     * The default RECORDING device. It must be given the capture list —
     * refreshAudioDevices() returns the render list, so passing its result here
     * read back the default speakers and reported them as a mic change.
     */
    const defaultMicLabel = (devices: { deviceId: string; label: string }[]): string | null =>
      devices.find(d => d.deviceId === 'default')?.label ?? null;

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

      await followDefaultMic();
    };

    /** Re-open the passthrough if it is following the default and that moved. */
    const followDefaultMic = async () => {
      const cur = settingsRef.current;
      // The profile switcher owns the mic now, by label. Following the system
      // default is not just unnecessary but wrong: the default recording device
      // is pinned to the virtual cable, and the cable carries our own output.
      if (cur.micInputLabel || cur.micInputDeviceId) return;
      if (!micPassthroughActiveRef.current) return;
      await refreshAudioDevices();
      const label = defaultMicLabel(micInputDevicesRef.current);
      if (!label || label === lastDefaultMicRef.current) return;
      // Never follow the default onto the virtual cable: the soundboard's own
      // output is on the other end of it, so that is a feedback loop.
      if (/cable output|vb-audio/i.test(label)) {
        console.warn('Default mic is the virtual cable — not following it (feedback loop).');
        lastDefaultMicRef.current = label;
        return;
      }
      console.log('Windows default mic changed ->', label, '- restarting passthrough');
      lastDefaultMicRef.current = label;
      micNoiseFloorRef.current = 10;
      micNoiseFloorSamplesRef.current = [];
      stopMicPassthrough();
      setTimeout(() => { void startMicPassthrough(); }, 250);
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

    // Periodic health check — verify output device is still valid every 30s
    const healthCheck = setInterval(async () => {
      const devices = await refreshAudioDevices();
      // A profile switch changes which device is "default" without plugging
      // anything in, and Chromium does not always fire devicechange for that.
      await followDefaultMic();
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
        } else {
          // VB-CABLE completely gone — auto-restart it (rate-limited to once per 30s)
          const now = Date.now();
          if (now - cableRestartTimestampRef.current > 30000 && window.electronAPI) {
            cableRestartTimestampRef.current = now;
            console.warn('VB-CABLE disappeared, auto-restarting device...');
            const result = await window.electronAPI.restartCable();
            if (result.success) {
              console.log('VB-CABLE restart triggered, waiting for device to reappear...');
              // Wait for driver to re-initialize, then re-detect
              setTimeout(async () => {
                const newDevices = await refreshAudioDevices();
                const newCable = newDevices.find((d) =>
                  d.label.toLowerCase().includes('cable input') ||
                  d.label.toLowerCase().includes('vb-audio')
                );
                if (newCable && window.electronAPI) {
                  console.log('VB-CABLE reappeared after restart:', newCable.label);
                  const updated = await window.electronAPI.updateSettings({ outputDeviceId: newCable.deviceId });
                  dispatch({ type: 'SET_SETTINGS', payload: updated });
                }
              }, 5000);
            } else {
              console.error('VB-CABLE auto-restart failed:', result.error);
            }
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

      // Loudness: clip volume x master for the output, x monitor volume for the
      // monitor. Through a GainNode where the sink allows it (no 100% ceiling);
      // otherwise the element's volume, clamped, as before.
      const outGain = sound.volume * state.settings.masterVolume;
      const monGain = sound.volume * (state.settings.monitorVolume ?? state.settings.masterVolume);
      const contexts: AudioContext[] = [];
      const routed = await attachGain(audio, state.settings.outputDeviceId, outGain);
      if (routed) contexts.push(routed.ctx);
      else audio.volume = Math.min(1, Math.max(0, outGain));
      let monitorRouted: { ctx: AudioContext; gain: GainNode } | null = null;
      if (monitorAudio) {
        monitorRouted = await attachGain(monitorAudio, monitorDevice === 'default' ? null : monitorDevice, monGain);
        if (monitorRouted) contexts.push(monitorRouted.ctx);
        else monitorAudio.volume = Math.min(1, Math.max(0, monGain));
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
        for (const c of contexts) { c.close().catch(() => {}); }
        dispatch({ type: 'REMOVE_PLAYING_SOUND', payload: sound.id });
      };

      audio.addEventListener('timeupdate', handleTimeUpdate);
      audio.addEventListener('ended', handleEnded);

      dispatch({
        type: 'ADD_PLAYING_SOUND',
        payload: {
          id: sound.id, audio, monitorAudio, soundVolume: sound.volume,
          gain: routed?.gain ?? null, monitorGain: monitorRouted?.gain ?? null, contexts,
        }
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
      closeContexts(playing);
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
      closeContexts(playing);
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
    try {
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
    } catch (error) {
      console.error('Failed to create sub-soundbite:', error);
    }
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

    // Transport commands from the HTTP API (the Cortex console's Pause / Stop
    // on ONE clip while several are layered). Without a soundId they act on the
    // most recently started clip, the same one the hotkey acts on.
    const unsubscribePlayback = window.electronAPI.onPlaybackControl?.((cmd) => {
      let id = cmd.soundId ?? null;
      if (!id) { for (const [k] of state.playingSounds) id = k; }
      if (!id) return;
      const playing = state.playingSounds.get(id);
      if (!playing) return;
      switch (cmd.action) {
        case 'pause': pauseSound(id); break;
        case 'resume': resumeSound(id); break;
        case 'toggle': playing.paused ? resumeSound(id) : pauseSound(id); break;
        case 'stop': stopSound(id); break;
      }
    }) ?? (() => {});

    const unsubscribeSettingsUpdated = window.electronAPI.onSettingsUpdated?.(async () => {
      const settings = await window.electronAPI.getSettings();
      dispatch({ type: 'SET_SETTINGS', payload: settings });
      await refreshAudioDevices();
    }) || (() => {});

    return () => {
      unsubscribeHotkey();
      unsubscribeStopAll();
      unsubscribePauseResume();
      unsubscribePlayback();
      unsubscribeSettingsUpdated();
    };
  }, [state.sounds, state.playingSounds, playSound, stopAllSounds, stopSound, pauseSound, resumeSound, pauseResumeLastSound]);

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
        const out = playing.soundVolume * state.settings.masterVolume;
        const mon = playing.soundVolume * (state.settings.monitorVolume ?? state.settings.masterVolume);
        if (playing.gain) playing.gain.gain.value = clampGain(out);
        else if (playing.audio) playing.audio.volume = Math.min(1, Math.max(0, out));
        if (playing.monitorGain) playing.monitorGain.gain.value = clampGain(mon);
        else if (playing.monitorAudio) playing.monitorAudio.volume = Math.min(1, Math.max(0, mon));
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

    // Claim this attempt. Any start already in flight is now stale and must
    // close whatever it opens instead of leaking it.
    const gen = ++micStartGenRef.current;

    // Create AudioContext if not exists or closed
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
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
      // Resolve the profile's mic by LABEL first. The system default is NOT a
      // useful fallback any more: with the virtual cable pinned as the default
      // recording device, capturing "default" would capture our own output.
      const live = settingsRef.current;
      const wantLabel = live.micInputLabel ?? null;
      const known = micInputDevicesRef.current;

      // The LABEL is the source of truth, never the saved id. Chromium reassigns
      // its deviceId hashes when Windows renumbers an endpoint, so a saved id can
      // quietly come to mean a DIFFERENT microphone: that is how this once opened
      // an Insta360 lapel mic while the A50 sat unused, held two capture streams
      // at once, and left Discord showing a permanent green ring. A saved id is
      // honoured only when there is no label, and only if it still names a device
      // that exists.
      let resolvedId: string | null = null;
      if (wantLabel) {
        const hit = findDeviceByLabel(known, wantLabel);
        if (hit) resolvedId = hit.deviceId;
        else console.warn('Mic passthrough: no device matches label', wantLabel);
      } else if (live.micInputDeviceId) {
        resolvedId = known.some(d => d.deviceId === live.micInputDeviceId)
          ? live.micInputDeviceId
          : null;
        if (!resolvedId) console.warn('Mic passthrough: saved device id no longer names a real device');
      }

      // NEVER fall back to the system default. The default recording device is
      // the virtual cable, and the passthrough's OUTPUT is the other end of it,
      // so an unresolved label used to open a self-sustaining FEEDBACK LOOP:
      // Discord saw a permanent green ring, the cable sat pinned near full scale,
      // and the real microphone was never opened at all. Refusing is strictly
      // better than howling; the retry below picks it up once devices resolve.
      if (!resolvedId) {
        console.warn('Mic passthrough: no device resolved, refusing to capture the default (that is the cable).');
        setTimeout(() => { void startMicPassthrough(); }, 4000);
        return;
      }
      const chosen = known.find(d => d.deviceId === resolvedId);
      if (chosen && /cable output|vb-audio/i.test(chosen.label)) {
        console.warn('Mic passthrough: refusing to capture the virtual cable (feedback loop).');
        return;
      }
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: { exact: resolvedId },
          noiseSuppression: live.micNoiseSuppression ?? false,
          echoCancellation: live.micEchoCancellation ?? false,
          autoGainControl: live.micAutoGainControl ?? false,
        },
      };

      console.log('Requesting mic with constraints:', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      // A newer start, or a stop, overtook us while getUserMedia was open.
      // Nothing else holds this stream, so close it here or it stays open for
      // the life of the app.
      if (gen !== micStartGenRef.current) {
        console.warn('Mic passthrough: superseded while opening, closing the stream we just got.');
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      // Prove we opened the microphone we asked for. The id was resolved from
      // the device list a moment ago; if that list shifted underneath us (a
      // replug, a renumber) Chromium can hand back a different device. Opening
      // the wrong mic SILENTLY is the whole failure this guards against.
      const gotLabel = stream.getAudioTracks()[0]?.label ?? '';
      if (wantLabel && gotLabel && !findDeviceByLabel([{ deviceId: resolvedId, label: gotLabel }], wantLabel)) {
        console.warn('Mic passthrough: opened the wrong device, retrying', { wanted: wantLabel, got: gotLabel });
        stream.getTracks().forEach(t => t.stop());
        setTimeout(() => { void startMicPassthrough(); }, 2000);
        return;
      }

      // Never overwrite a live stream: the one being replaced would be lost.
      if (micStreamRef.current && micStreamRef.current !== stream) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
      }
      micStreamRef.current = stream;
      micIntentionalStopRef.current = false;
      console.log('Got mic stream with noise suppression');

      // Auto-recovery: restart passthrough if mic track ends unexpectedly (device disconnect, driver crash)
      stream.getTracks().forEach(track => {
        track.onended = () => {
          if (micIntentionalStopRef.current || micRecoveryInProgressRef.current) return;
          console.warn('Mic track ended unexpectedly, attempting auto-recovery in 1s...');
          micRecoveryInProgressRef.current = true;
          setTimeout(async () => {
            try {
              stopMicPassthrough();
              await startMicPassthrough();
              console.log('Mic passthrough auto-recovered from track ended');
            } catch (e) {
              console.error('Mic auto-recovery failed:', e);
            } finally {
              micRecoveryInProgressRef.current = false;
            }
          }, 1000);
        };
      });

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
      micGateBelowSinceRef.current = 0;
      micGateOpenedAtRef.current = 0;
      micGateClosedAtRef.current = Date.now();

      // Start level monitoring
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const NOISE_FLOOR_SAMPLE_COUNT = 40; // ~2 seconds of samples at 50ms interval
      const AUTO_THRESHOLD_MARGIN = 25; // Add this % above noise floor (was 15, increased for noisy environments)
      const GATE_HOLD_MS = 400;     // stay open this long after the level drops, so the gaps between words do not close it
      const GATE_ATTACK_S = 0.005;  // open fast: the first consonant is the one that gets lost
      const GATE_RELEASE_S = 0.06;  // close gently: a 10 ms cut is an audible click on the far end
      const FLOOR_SETTLE_MS = 600;  // sample the noise floor only once the gate has been closed this long
      const FLOOR_CAP = 25;         // the auto threshold never exceeds FLOOR_CAP + margin: a gate that cannot open is worse than one that lets noise through

      const updateLevel = () => {
        if (!micAnalyserRef.current) return;

        // Health check: resume AudioContext if suspended (Chromium can suspend it)
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          console.warn('AudioContext suspended, resuming...');
          audioContextRef.current.resume();
        }

        // Health check: restart audio element if it stopped playing
        if (micOutputAudioRef.current && micOutputAudioRef.current.paused && micStreamRef.current) {
          console.warn('Mic audio element paused, restarting...');
          micOutputAudioRef.current.play().catch(() => {});
        }

        // Health check: verify mic tracks are still alive
        if (micStreamRef.current) {
          const tracks = micStreamRef.current.getAudioTracks();
          if (tracks.length === 0 || tracks.every(t => t.readyState === 'ended')) {
            console.warn('Mic tracks ended, restarting passthrough...');
            stopMicPassthrough();
            setTimeout(() => startMicPassthrough(), 500);
            return;
          }
        }

        micAnalyserRef.current.getByteFrequencyData(dataArray);
        // Calculate RMS level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const level = Math.min(100, Math.round((rms / 128) * 100));
        micLevelRef.current = level;

        dispatch({ type: 'SET_MIC_LEVEL', payload: level });

        // Volume-based noise gate threshold
        let threshold = micNoiseGateThresholdRef.current;

        if (micNoiseGateAutoRef.current) {
          // Auto mode - dynamically calculate threshold based on noise floor
          const noiseFloor = micNoiseFloorRef.current;

          // If the gate is closed (not speaking) and has been for long enough that
          // the tail of the last word is out of the window, sample the noise floor
          if (!micGateOpenRef.current && Date.now() - micGateClosedAtRef.current >= FLOOR_SETTLE_MS) {
            micNoiseFloorSamplesRef.current.push(level);
            // Keep only recent samples
            if (micNoiseFloorSamplesRef.current.length > NOISE_FLOOR_SAMPLE_COUNT) {
              micNoiseFloorSamplesRef.current.shift();
            }
            // Calculate noise floor as the average of samples
            if (micNoiseFloorSamplesRef.current.length >= 10) {
              const avgNoise = micNoiseFloorSamplesRef.current.reduce((a, b) => a + b, 0)
                / micNoiseFloorSamplesRef.current.length;
              micNoiseFloorRef.current = Math.min(FLOOR_CAP, Math.max(5, Math.round(avgNoise)));
            }
          }

          // Auto threshold = noise floor + margin
          threshold = Math.min(100, noiseFloor + AUTO_THRESHOLD_MARGIN);
        }

        micThresholdEffRef.current = threshold;

        // Apply noise gate
        if (threshold > 0 && micGateGainRef.current) {
          // Use hysteresis: open at threshold, close at threshold - 15 (larger gap to prevent flutter)
          const closeThreshold = Math.max(0, threshold - 15);

          const now = Date.now();
          if (micGateOpenRef.current) {
            // Gate is open. Dropping below the close threshold starts the hold
            // clock; the gate closes only once it has stayed below for
            // GATE_HOLD_MS. Any sample back above it resets the clock.
            if (level < closeThreshold) {
              if (!micGateBelowSinceRef.current) micGateBelowSinceRef.current = now;
              if (now - micGateBelowSinceRef.current >= GATE_HOLD_MS) {
                const g = micGateGainRef.current.gain;
                const t = audioContextRef.current!.currentTime;
                g.cancelScheduledValues(t);
                g.setValueAtTime(g.value, t);
                g.linearRampToValueAtTime(0, t + GATE_RELEASE_S);
                micGateOpenRef.current = false;
                micGateClosedAtRef.current = now;
                micGateBelowSinceRef.current = 0;
                console.info(`gate closed after ${now - micGateOpenedAtRef.current}ms open (thr=${threshold} floor=${micNoiseFloorRef.current})`);
              }
            } else {
              micGateBelowSinceRef.current = 0;
            }
          } else {
            // Gate is closed - open if level rises above threshold
            if (level >= threshold) {
              const g = micGateGainRef.current.gain;
              const t = audioContextRef.current!.currentTime;
              g.cancelScheduledValues(t);
              g.setValueAtTime(g.value, t);
              g.linearRampToValueAtTime(1, t + GATE_ATTACK_S);
              micGateOpenRef.current = true;
              micGateOpenedAtRef.current = now;
              micGateBelowSinceRef.current = 0;
              console.info(`gate open lvl=${level} thr=${threshold} floor=${micNoiseFloorRef.current} quiet-for=${micGateClosedAtRef.current ? now - micGateClosedAtRef.current : 0}ms`);
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

      try {
        await audio.play();
      } catch (e) {
        console.error('Failed to play mic audio, retrying:', e);
        // Retry once after a short delay
        await new Promise(r => setTimeout(r, 200));
        await audio.play();
      }
      console.log('Mic audio playing');

      // Note: Silero VAD disabled - doesn't work in packaged Electron apps due to ASAR/WASM issues
      // Using volume-based detection with browser's built-in noiseSuppression instead
      console.log('Using volume-based voice detection (browser noiseSuppression enabled)');

      micPassthroughActiveRef.current = true;
      dispatch({ type: 'SET_MIC_PASSTHROUGH_ACTIVE', payload: true });
      console.log('Mic passthrough started successfully');
    } catch (error) {
      console.error('Failed to start mic passthrough:', error);
      micPassthroughActiveRef.current = false;
      dispatch({ type: 'SET_MIC_PASSTHROUGH_ACTIVE', payload: false });
    }
  }, [state.settings.micInputDeviceId, state.settings.micVolume, state.settings.outputDeviceId]);

  const stopMicPassthrough = useCallback(() => {
    // Signal that this is an intentional stop (prevents auto-recovery from triggering)
    micIntentionalStopRef.current = true;

    // Invalidate any start still waiting on getUserMedia, so it closes what it
    // opens rather than installing a microphone after we asked for silence.
    micStartGenRef.current++;

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

    micPassthroughActiveRef.current = false;
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
  }, [state.settings.micInputDeviceId, state.settings.micInputLabel, state.micPassthroughActive, stopMicPassthrough, startMicPassthrough]);

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

  // Mic passthrough health check — auto-recover broken pipelines every 5s
  useEffect(() => {
    if (!state.micPassthroughActive) {
      if (micHealthCheckRef.current) {
        clearInterval(micHealthCheckRef.current);
        micHealthCheckRef.current = null;
      }
      return;
    }

    micHealthCheckRef.current = window.setInterval(async () => {
      if (micRecoveryInProgressRef.current || micIntentionalStopRef.current) return;

      let needsRestart = false;
      const reasons: string[] = [];

      // Check 1: AudioContext state
      if (audioContextRef.current?.state === 'suspended') {
        try {
          await audioContextRef.current.resume();
          console.log('Mic health check: resumed suspended AudioContext');
        } catch {
          reasons.push('AudioContext suspended and could not resume');
          needsRestart = true;
        }
      } else if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        reasons.push('AudioContext closed');
        needsRestart = true;
      }

      // Check 2: Mic stream tracks still live
      if (micStreamRef.current) {
        const tracks = micStreamRef.current.getTracks();
        if (tracks.length === 0 || tracks.some(t => t.readyState === 'ended')) {
          reasons.push('mic track ended');
          needsRestart = true;
        }
      } else {
        reasons.push('mic stream lost');
        needsRestart = true;
      }

      // Check 3: Output audio element still playing
      if (micOutputAudioRef.current) {
        if (micOutputAudioRef.current.paused) {
          try {
            await micOutputAudioRef.current.play();
            console.log('Mic health check: resumed paused mic output audio');
          } catch {
            reasons.push('mic output audio paused and could not resume');
            needsRestart = true;
          }
        }
      } else {
        reasons.push('mic output audio element lost');
        needsRestart = true;
      }

      if (needsRestart) {
        console.warn('Mic health check failed:', reasons.join(', '), '— restarting passthrough...');
        micRecoveryInProgressRef.current = true;
        try {
          stopMicPassthrough();
          await new Promise(r => setTimeout(r, 500));
          await startMicPassthrough();
          console.log('Mic passthrough auto-recovered by health check');
        } catch (e) {
          console.error('Mic health check recovery failed:', e);
        } finally {
          micRecoveryInProgressRef.current = false;
        }
      }
    }, 5000);

    return () => {
      if (micHealthCheckRef.current) {
        clearInterval(micHealthCheckRef.current);
        micHealthCheckRef.current = null;
      }
    };
  }, [state.micPassthroughActive, stopMicPassthrough, startMicPassthrough]);

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

  useEffect(() => {
    playingCountRef.current = state.playingSounds.size;
  }, [state.playingSounds]);

  // Playback telemetry for /api/playing: name, position and length of every
  // clip playing, 4x a second while anything plays and once (empty) when the
  // last one ends, so a remote transport can show and control it.
  useEffect(() => {
    const report = window.electronAPI?.reportPlayback;
    if (typeof window === 'undefined' || !report) return;
    const snapshot = () => {
      const sounds: import('../../shared/types').PlayingSoundInfo[] = [];
      state.playingSounds.forEach((playing, id) => {
        const sound = state.sounds.find(s => s.id === id);
        if (!sound) return;
        const start = sound.trimStart || 0;
        const end = sound.trimEnd || playing.audio.duration || sound.duration || 0;
        sounds.push({
          id, name: sound.name,
          position: Math.max(0, playing.audio.currentTime - start),
          duration: Math.max(0, end - start),
          paused: playing.paused,
          startedAt: playing.startedAt,
        });
      });
      report({ sounds, at: Date.now() });
    };
    snapshot();
    if (state.playingSounds.size === 0) return;
    const t = window.setInterval(snapshot, 250);
    return () => window.clearInterval(t);
  }, [state.playingSounds, state.sounds]);

  // Telemetry for the chain watch (electron/chain-watch.ts). Sent from refs,
  // never from `state`, for the same stale-closure reason as everything else in
  // the mic pipeline. Cheap: one small IPC message twice a second.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.reportMicTelemetry) return;
    const report = window.electronAPI.reportMicTelemetry;
    const id = window.setInterval(() => {
      report({
        passthrough: micPassthroughActiveRef.current,
        level: micLevelRef.current,
        gateOpen: micGateOpenRef.current,
        threshold: micThresholdEffRef.current,
        floor: micNoiseFloorRef.current,
        clips: playingCountRef.current,
      });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // The heal the chain watch asks for when the cable is silent while signal is
  // expected: tear the whole output path down and open it again.
  //
  // Clips are stopped too, deliberately. Chromium shares ONE physical output
  // stream per device across every element routed to it, and that shared
  // stream is exactly what dies. A clip still playing would keep the dead
  // stream referenced, and the re-opened passthrough would join it. Everything
  // routed to the cable has to let go for the sink to be rebuilt -- which is
  // why the 2026-09-15 fix by hand (stop passthrough, wait, start) worked.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onMicRestart) return;
    return window.electronAPI.onMicRestart(() => {
      console.warn('Chain watch: cable silent while signal expected - re-opening the output path');
      stopAllSounds();
      stopMicPassthrough();
      micNoiseFloorRef.current = 10;
      micNoiseFloorSamplesRef.current = [];
      window.setTimeout(() => {
        if (settingsRef.current.micPassthroughEnabled) void startMicPassthrough();
      }, 800);
    });
  }, [stopAllSounds, stopMicPassthrough, startMicPassthrough]);

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
