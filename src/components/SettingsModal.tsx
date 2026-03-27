'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/lib/store';

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { state, updateSettings } = useApp();
  const [stopAllHotkey, setStopAllHotkey] = useState(state.settings.stopAllHotkey);
  const [pauseResumeHotkey, setPauseResumeHotkey] = useState(state.settings.pauseResumeHotkey || '');
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
  const [isRecordingPauseHotkey, setIsRecordingPauseHotkey] = useState(false);
  const [localNoiseGate, setLocalNoiseGate] = useState(state.settings.micNoiseGate ?? 0);

  // Sync local noise gate with settings
  useEffect(() => {
    setLocalNoiseGate(state.settings.micNoiseGate ?? 0);
  }, [state.settings.micNoiseGate]);

  const handleHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecordingHotkey) return;

    e.preventDefault();
    e.stopPropagation();

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');

    // Get the key name
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key.startsWith('Arrow')) key = key.replace('Arrow', '');

    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      parts.push(key);
      const hotkey = parts.join('+');
      setStopAllHotkey(hotkey);
      // Use setTimeout to prevent blur race condition
      setTimeout(() => setIsRecordingHotkey(false), 0);
    }
  };

  const handlePauseHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecordingPauseHotkey) return;

    e.preventDefault();
    e.stopPropagation();

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
      setPauseResumeHotkey(parts.join('+'));
      setTimeout(() => setIsRecordingPauseHotkey(false), 0);
    }
  };

  const handleRecordClick = () => {
    setIsRecordingHotkey(true);
  };

  const handleSave = async () => {
    await updateSettings({
      stopAllHotkey,
      pauseResumeHotkey,
      allowConcurrentPlayback: state.settings.allowConcurrentPlayback,
      minimizeToTray: state.settings.minimizeToTray,
      startMinimized: state.settings.startMinimized,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-bg-secondary rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-bg-tertiary">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-bg-tertiary rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-6 overflow-y-auto flex-1">
          {/* Stop All Hotkey */}
          <div>
            <label className="block text-sm font-medium mb-2">Stop All Hotkey</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={isRecordingHotkey ? 'Press keys...' : stopAllHotkey}
                onKeyDown={handleHotkeyKeyDown}
                onFocus={() => setIsRecordingHotkey(true)}
                onBlur={() => setIsRecordingHotkey(false)}
                readOnly
                className="flex-1 px-3 py-2 bg-bg-tertiary rounded-lg text-sm cursor-pointer focus:ring-2 focus:ring-accent"
                placeholder="Click to record hotkey"
              />
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleRecordClick}
                className="px-3 py-2 bg-bg-tertiary hover:bg-accent/20 rounded-lg text-sm transition-colors"
              >
                Record
              </button>
            </div>
            <p className="text-xs text-text-secondary mt-1">
              Press the key combination to set a new hotkey
            </p>
          </div>

          {/* Pause/Resume Hotkey */}
          <div>
            <label className="block text-sm font-medium mb-2">Pause/Resume Hotkey</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={isRecordingPauseHotkey ? 'Press keys...' : pauseResumeHotkey || ''}
                onKeyDown={handlePauseHotkeyKeyDown}
                onFocus={() => setIsRecordingPauseHotkey(true)}
                onBlur={() => setIsRecordingPauseHotkey(false)}
                readOnly
                className="flex-1 px-3 py-2 bg-bg-tertiary rounded-lg text-sm cursor-pointer focus:ring-2 focus:ring-accent"
                placeholder="Click to record hotkey"
              />
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setIsRecordingPauseHotkey(true)}
                className="px-3 py-2 bg-bg-tertiary hover:bg-accent/20 rounded-lg text-sm transition-colors"
              >
                Record
              </button>
              {pauseResumeHotkey && (
                <button
                  onClick={() => setPauseResumeHotkey('')}
                  className="px-3 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg text-sm transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-xs text-text-secondary mt-1">
              Pauses/resumes the most recently played sound
            </p>
          </div>

          {/* Concurrent Playback */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Allow Concurrent Playback</label>
              <p className="text-xs text-text-secondary">Play multiple sounds at once</p>
            </div>
            <button
              onClick={() =>
                updateSettings({
                  allowConcurrentPlayback: !state.settings.allowConcurrentPlayback,
                })
              }
              className={`w-12 h-6 rounded-full transition-colors ${
                state.settings.allowConcurrentPlayback ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
            >
              <div
                className={`w-5 h-5 bg-white rounded-full transition-transform ${
                  state.settings.allowConcurrentPlayback ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Minimize to Tray */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Minimize to Tray</label>
              <p className="text-xs text-text-secondary">Keep running in system tray when closed</p>
            </div>
            <button
              onClick={() =>
                updateSettings({
                  minimizeToTray: !state.settings.minimizeToTray,
                })
              }
              className={`w-12 h-6 rounded-full transition-colors ${
                state.settings.minimizeToTray ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
            >
              <div
                className={`w-5 h-5 bg-white rounded-full transition-transform ${
                  state.settings.minimizeToTray ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Start with Windows */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Start with Windows</label>
              <p className="text-xs text-text-secondary">Launch app when Windows starts</p>
            </div>
            <button
              onClick={() =>
                updateSettings({
                  startWithWindows: !(state.settings?.startWithWindows ?? false),
                })
              }
              className={`w-12 h-6 rounded-full transition-colors ${
                state.settings?.startWithWindows ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
            >
              <div
                className={`w-5 h-5 bg-white rounded-full transition-transform ${
                  state.settings?.startWithWindows ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Start Minimized */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Start Minimized</label>
              <p className="text-xs text-text-secondary">Start app minimized to tray</p>
            </div>
            <button
              onClick={() =>
                updateSettings({
                  startMinimized: !state.settings.startMinimized,
                })
              }
              className={`w-12 h-6 rounded-full transition-colors ${
                state.settings.startMinimized ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
            >
              <div
                className={`w-5 h-5 bg-white rounded-full transition-transform ${
                  state.settings.startMinimized ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Mic Noise Gate Section */}
          <div className="bg-bg-tertiary rounded-lg p-4 space-y-4">
            <h4 className="text-sm font-medium">Mic Noise Gate</h4>

            {/* Level Meter */}
            <div>
              <label className="block text-xs text-text-secondary mb-1">Current Mic Level</label>
              <div className="relative h-4 bg-bg-primary rounded overflow-hidden">
                {/* Level bar */}
                <div
                  className={`absolute left-0 top-0 h-full transition-all duration-75 ${
                    state.micLevel > 80 ? 'bg-red-500' :
                    state.micLevel > 60 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${state.micLevel}%` }}
                />
                {/* Threshold marker (for manual mode) */}
                {!state.settings.micNoiseGateAuto && localNoiseGate > 0 && (
                  <div
                    className="absolute top-0 h-full w-0.5 bg-white"
                    style={{ left: `${localNoiseGate}%` }}
                  />
                )}
                {/* Level text */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] text-white/80 font-medium drop-shadow">
                    {state.micLevel}%
                  </span>
                </div>
              </div>
            </div>

            {/* Auto/Manual Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium">Auto-Adjust Sensitivity</label>
                <p className="text-xs text-text-secondary">Automatically detect background noise</p>
              </div>
              <button
                onClick={() =>
                  updateSettings({
                    micNoiseGateAuto: !state.settings.micNoiseGateAuto,
                  })
                }
                className={`w-12 h-6 rounded-full transition-colors ${
                  state.settings.micNoiseGateAuto ? 'bg-accent' : 'bg-bg-tertiary'
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full transition-transform ${
                    state.settings.micNoiseGateAuto ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            {/* Manual Threshold Slider */}
            {!state.settings.micNoiseGateAuto && (
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  Manual Threshold: {localNoiseGate > 0 ? `${localNoiseGate}%` : 'Off'}
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={localNoiseGate}
                  onChange={(e) => setLocalNoiseGate(parseInt(e.target.value))}
                  onMouseUp={() => updateSettings({ micNoiseGate: localNoiseGate })}
                  onTouchEnd={() => updateSettings({ micNoiseGate: localNoiseGate })}
                  className="w-full"
                />
                <p className="text-xs text-text-secondary mt-1">
                  Sounds below this level will be muted. Set to 0 to disable.
                </p>
              </div>
            )}

            {state.settings.micNoiseGateAuto && (
              <p className="text-xs text-text-secondary">
                The noise gate will automatically adjust based on your background noise level.
                Speak normally and it will learn to filter out ambient sounds.
              </p>
            )}
          </div>

          {/* Audio Device Note */}
          <div className="bg-bg-tertiary rounded-lg p-3">
            <h4 className="text-sm font-medium mb-1">Audio Output Note</h4>
            <p className="text-xs text-text-secondary">
              To route audio to a virtual audio cable (like VB-CABLE), select it from the output
              device dropdown in the bottom bar. Then set the virtual cable as your microphone
              input in Discord/other apps.
            </p>
          </div>

          {/* Restart VB-CABLE */}
          <div className="bg-bg-tertiary rounded-lg p-3 flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium">Restart VB-CABLE</h4>
              <p className="text-xs text-text-secondary">Disable and re-enable the virtual audio cable device</p>
            </div>
            <button
              onClick={async () => {
                if (!window.electronAPI) return;
                const btn = document.getElementById('restart-cable-btn');
                if (btn) btn.textContent = 'Restarting...';
                const result = await window.electronAPI.restartCable();
                if (btn) btn.textContent = result.success ? 'Done!' : 'Failed (need admin)';
                setTimeout(() => { if (btn) btn.textContent = 'Restart'; }, 3000);
              }}
              id="restart-cable-btn"
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors text-sm whitespace-nowrap"
            >
              Restart
            </button>
          </div>
        </div>

        <div className="p-4 border-t border-bg-tertiary flex justify-end gap-2">
          <button
            onClick={onClose}
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
