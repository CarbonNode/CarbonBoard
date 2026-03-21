'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '@/lib/store';
import { WaveformVisualizer } from './WaveformVisualizer';
import type { Sound } from '../../shared/types';

export function SoundEditor() {
  const { state, dispatch, updateSound, previewSound, stopPreview, createSubSoundbite } = useApp();
  const sound = state.editingSound;

  const [name, setName] = useState('');
  const [volume, setVolume] = useState(1);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState<number | null>(null);
  const [hotkey, setHotkey] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [duration, setDuration] = useState(0);

  // Load sound data when editing sound changes
  useEffect(() => {
    if (sound) {
      setName(sound.name);
      setVolume(sound.volume);
      setTrimStart(sound.trimStart);
      setTrimEnd(sound.trimEnd);
      setHotkey(sound.hotkey);
      setCategoryId(sound.categoryId);
      setDuration(sound.duration);

      // Load audio buffer for waveform
      loadAudioBuffer(sound);
    }
  }, [sound]);

  const loadAudioBuffer = async (sound: Sound) => {
    if (!window.electronAPI) {
      console.error('electronAPI not available');
      return;
    }

    try {
      console.log('Loading audio from:', sound.storedPath);
      const data = await window.electronAPI.getSoundData(sound.storedPath);
      console.log('Got audio data, size:', data?.byteLength || 'unknown');

      const audioContext = new AudioContext();
      const buffer = await audioContext.decodeAudioData(data);
      console.log('Decoded audio, duration:', buffer.duration);

      setAudioBuffer(buffer);
      setDuration(buffer.duration);

      // Update duration in DB if it was 0
      if (sound.duration === 0) {
        await updateSound(sound.id, { duration: buffer.duration });
      }

      // Set trimEnd to duration if null
      if (sound.trimEnd === null) {
        setTrimEnd(buffer.duration);
      }

      audioContext.close();
    } catch (error) {
      console.error('Failed to load audio buffer:', error);
    }
  };

  const handleClose = () => {
    stopPreview();
    dispatch({ type: 'SET_EDITING_SOUND', payload: null });
  };

  const handleSave = async () => {
    if (!sound) return;

    // Unregister old hotkey if changed
    if (sound.hotkey && sound.hotkey !== hotkey) {
      await window.electronAPI?.unregisterHotkey(sound.hotkey);
    }

    await updateSound(sound.id, {
      name,
      volume,
      trimStart,
      trimEnd,
      hotkey,
      categoryId,
      duration,
    });

    // Register new hotkey
    if (hotkey) {
      await window.electronAPI?.registerHotkey(hotkey, sound.id);
    }

    handleClose();
  };

  const handleHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecordingHotkey) return;

    e.preventDefault();

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key.startsWith('Arrow')) key = key.replace('Arrow', '');

    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      parts.push(key);
      setHotkey(parts.join('+'));
      setIsRecordingHotkey(false);
    }
  };

  const handleSelectThumbnail = async () => {
    if (!sound || !window.electronAPI) return;

    const imagePath = await window.electronAPI.selectImageFile();
    if (imagePath) {
      const thumbnailPath = await window.electronAPI.copyThumbnail(imagePath);
      await updateSound(sound.id, { thumbnailPath });
    }
  };

  const handlePreview = () => {
    if (!sound) return;

    // Create a temporary sound object with current trim values
    const previewSoundData: Sound = {
      ...sound,
      trimStart,
      trimEnd,
      volume,
    };
    previewSound(previewSoundData);
  };

  if (!sound) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={handleClose}>
      <div
        className="bg-bg-secondary rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-bg-tertiary">
          <h2 className="text-lg font-semibold">Edit Sound</h2>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-bg-tertiary rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-6">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium mb-2">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-bg-tertiary rounded-lg focus:ring-2 focus:ring-accent"
            />
          </div>

          {/* Waveform Visualizer */}
          <div>
            <label className="block text-sm font-medium mb-2">Waveform & Trim</label>
            <WaveformVisualizer
              audioBuffer={audioBuffer}
              duration={duration}
              trimStart={trimStart}
              trimEnd={trimEnd ?? duration}
              onTrimChange={(start, end) => {
                setTrimStart(start);
                setTrimEnd(end);
              }}
            />
            <div className="flex justify-between text-xs text-text-secondary mt-1">
              <span>Start: {formatTime(trimStart)}</span>
              <span>End: {formatTime(trimEnd ?? duration)}</span>
              <span>Duration: {formatTime((trimEnd ?? duration) - trimStart)}</span>
            </div>
          </div>

          {/* Preview & Sub-Soundbite Buttons */}
          <div className="flex gap-2">
            <button
              onClick={handlePreview}
              className="px-4 py-2 bg-bg-tertiary hover:bg-accent/20 rounded-lg transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              Preview
            </button>
            <button
              onClick={stopPreview}
              className="px-4 py-2 bg-bg-tertiary hover:bg-red-600/20 rounded-lg transition-colors flex items-center gap-2"
              title="Stop preview"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
              Stop
            </button>
            {!sound?.parentSoundId && (
            <button
              onClick={async () => {
                if (!sound) return;
                const subName = `${name} (clip)`;
                const subEnd = trimEnd ?? duration;
                await createSubSoundbite(sound, trimStart, subEnd, subName);
                handleClose();
              }}
              className="px-4 py-2 bg-bg-tertiary hover:bg-accent/20 rounded-lg transition-colors flex items-center gap-2"
              title="Create a sub-soundbite from the current trim selection"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2" />
              </svg>
              Create Sub-Soundbite
            </button>
            )}
          </div>

          {/* Volume */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Volume: {Math.round(volume * 100)}%
              {volume > 1 && <span className="text-yellow-400 ml-2">(Boosted)</span>}
            </label>
            <input
              type="range"
              min="0"
              max="3"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-text-secondary mt-1">
              <span>0%</span>
              <span>100%</span>
              <span>200%</span>
              <span>300%</span>
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="block text-sm font-medium mb-2">Category</label>
            <select
              value={categoryId || ''}
              onChange={(e) => setCategoryId(e.target.value || null)}
              className="w-full px-3 py-2 bg-bg-tertiary rounded-lg focus:ring-2 focus:ring-accent"
            >
              <option value="">Uncategorized</option>
              {state.categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          {/* Hotkey */}
          <div>
            <label className="block text-sm font-medium mb-2">Hotkey</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={isRecordingHotkey ? 'Press keys...' : hotkey || ''}
                onKeyDown={handleHotkeyKeyDown}
                onFocus={() => setIsRecordingHotkey(true)}
                onBlur={() => setIsRecordingHotkey(false)}
                readOnly
                placeholder="Click to record hotkey"
                className="flex-1 px-3 py-2 bg-bg-tertiary rounded-lg cursor-pointer focus:ring-2 focus:ring-accent"
              />
              <button
                onClick={() => setIsRecordingHotkey(true)}
                className="px-3 py-2 bg-bg-tertiary hover:bg-accent/20 rounded-lg transition-colors"
              >
                Record
              </button>
              {hotkey && (
                <button
                  onClick={() => setHotkey(null)}
                  className="px-3 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Thumbnail */}
          <div>
            <label className="block text-sm font-medium mb-2">Thumbnail</label>
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 bg-bg-tertiary rounded-lg overflow-hidden flex items-center justify-center">
                {sound.thumbnailPath ? (
                  <img
                    src={`local-file://${encodeURIComponent(sound.thumbnailPath)}`}
                    alt="Thumbnail"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <svg className="w-8 h-8 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                )}
              </div>
              <button
                onClick={handleSelectThumbnail}
                className="px-4 py-2 bg-bg-tertiary hover:bg-accent/20 rounded-lg transition-colors"
              >
                Choose Image
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-bg-tertiary flex justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-4 py-2 bg-bg-tertiary hover:bg-bg-primary rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}
