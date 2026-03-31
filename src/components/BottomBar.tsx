'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { SettingsModal } from './SettingsModal';

export function BottomBar() {
  const {
    state,
    dispatch,
    updateSettings,
    refreshAudioDevices,
    startMicPassthrough,
    stopMicPassthrough,
    setMicVolume,
  } = useApp();
  const [showSettings, setShowSettings] = useState(false);

  const handleMasterVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const volume = parseFloat(e.target.value);
    updateSettings({ masterVolume: volume });
  };

  const handleMonitorVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const volume = parseFloat(e.target.value);
    updateSettings({ monitorVolume: volume });
  };

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const deviceId = e.target.value || null;
    updateSettings({ outputDeviceId: deviceId });
  };

  const handleMonitorChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const deviceId = e.target.value || null;
    try {
      await updateSettings({ monitorDeviceId: deviceId });
    } catch (error) {
      console.error('Failed to update monitor device:', error);
    }
  };

  const handleMicInputChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const deviceId = e.target.value || null;
    updateSettings({ micInputDeviceId: deviceId });
  };

  const handleMicVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const volume = parseFloat(e.target.value);
    updateSettings({ micVolume: volume });
    setMicVolume(volume);
  };

  const handleMicToggle = async () => {
    console.log('Mic toggle clicked, current state:', state.micPassthroughActive);
    if (state.micPassthroughActive) {
      console.log('Stopping mic passthrough');
      stopMicPassthrough();
      await updateSettings({ micPassthroughEnabled: false });
    } else {
      console.log('Starting mic passthrough');
      await startMicPassthrough();
      await updateSettings({ micPassthroughEnabled: true });
    }
  };

  const handleLockToCableToggle = async () => {
    const newValue = !state.settings.lockOutputToCable;
    await updateSettings({ lockOutputToCable: newValue });

    // If enabling lock, find and select CABLE Input
    if (newValue) {
      const cableDevice = state.audioDevices.find((d) =>
        d.label.toLowerCase().includes('cable input') ||
        d.label.toLowerCase().includes('vb-audio')
      );
      if (cableDevice) {
        await updateSettings({ outputDeviceId: cableDevice.deviceId });
      }
    }
  };

  return (
    <>
      <div className="bg-bg-secondary border-t border-bg-tertiary flex-shrink-0">
        {/* Main controls - scrollable on small screens */}
        <div className="h-14 flex items-center gap-2 px-3 overflow-x-auto">
          {/* Output device selector (for Discord) */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <div className="flex items-center gap-1">
              <svg className="w-3 h-3 text-text-secondary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
              <span className="text-[10px] text-text-secondary">OUT</span>
            </div>
            <select
              value={state.settings.outputDeviceId || ''}
              onChange={handleDeviceChange}
              className="bg-bg-tertiary px-2 py-1 rounded text-xs max-w-[120px] focus:ring-2 focus:ring-accent"
              title="Output device (for Discord/streaming)"
              disabled={state.settings.lockOutputToCable}
            >
              <option value="">Default</option>
              {state.audioDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              onClick={handleLockToCableToggle}
              className={`p-1 rounded transition-colors flex-shrink-0 ${
                state.settings.lockOutputToCable
                  ? 'bg-accent text-white'
                  : 'hover:bg-bg-tertiary text-text-secondary'
              }`}
              title={state.settings.lockOutputToCable ? 'Locked to CABLE Input (click to unlock)' : 'Lock to CABLE Input'}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {state.settings.lockOutputToCable ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                )}
              </svg>
            </button>
          </div>

          {/* Monitor device selector (for you to hear) */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <div className="flex items-center gap-1">
              <svg className="w-3 h-3 text-text-secondary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <span className="text-[10px] text-text-secondary">MONITOR</span>
            </div>
            <select
              value={state.settings?.monitorDeviceId ?? 'default'}
              onChange={handleMonitorChange}
              className="bg-bg-tertiary px-2 py-1 rounded text-xs max-w-[120px] focus:ring-2 focus:ring-accent"
              title="Monitor device (for you to hear sounds)"
            >
              <option value="default">Default</option>
              <option value="off">Off</option>
              {(state.audioDevices || []).map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              onClick={refreshAudioDevices}
              className="p-1 hover:bg-bg-tertiary rounded transition-colors flex-shrink-0"
              title="Refresh devices"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-bg-tertiary flex-shrink-0" />

          {/* Mic Passthrough Controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleMicToggle}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors flex-shrink-0 ${
                state.micPassthroughActive
                  ? 'bg-green-600 hover:bg-green-700 text-white'
                  : 'bg-bg-tertiary hover:bg-accent/20 text-text-secondary'
              }`}
              title={state.micPassthroughActive ? 'Mic passthrough ON' : 'Mic passthrough OFF'}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              {state.micPassthroughActive ? 'ON' : 'OFF'}
            </button>

            <select
              value={state.settings.micInputDeviceId || ''}
              onChange={handleMicInputChange}
              className="bg-bg-tertiary px-2 py-1 rounded text-xs max-w-[120px] focus:ring-2 focus:ring-accent"
              title="Microphone input"
            >
              <option value="">Default Mic</option>
              {state.micInputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              onClick={async () => {
                await refreshAudioDevices();
                if (state.micPassthroughActive) {
                  stopMicPassthrough();
                  setTimeout(() => startMicPassthrough(), 100);
                }
              }}
              className="p-1 hover:bg-bg-tertiary rounded transition-colors flex-shrink-0"
              title="Refresh mic devices & restart passthrough"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>

            {/* Audio processing toggles */}
            <button
              onClick={async () => {
                await updateSettings({ micNoiseSuppression: !state.settings.micNoiseSuppression });
                if (state.micPassthroughActive) { stopMicPassthrough(); setTimeout(() => startMicPassthrough(), 100); }
              }}
              className={`p-1 flex-shrink-0 rounded transition-colors ${state.settings.micNoiseSuppression ? 'bg-accent text-white' : 'text-text-secondary opacity-50 hover:opacity-80'}`}
              title={`Noise Suppression: ${state.settings.micNoiseSuppression ? 'ON' : 'OFF'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            </button>
            <button
              onClick={async () => {
                await updateSettings({ micEchoCancellation: !state.settings.micEchoCancellation });
                if (state.micPassthroughActive) { stopMicPassthrough(); setTimeout(() => startMicPassthrough(), 100); }
              }}
              className={`p-1 flex-shrink-0 rounded transition-colors ${state.settings.micEchoCancellation ? 'bg-accent text-white' : 'text-text-secondary opacity-50 hover:opacity-80'}`}
              title={`Echo Cancellation: ${state.settings.micEchoCancellation ? 'ON' : 'OFF'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4l16 16" />
              </svg>
            </button>
            <button
              onClick={async () => {
                await updateSettings({ micAutoGainControl: !state.settings.micAutoGainControl });
                if (state.micPassthroughActive) { stopMicPassthrough(); setTimeout(() => startMicPassthrough(), 100); }
              }}
              className={`p-1 flex-shrink-0 rounded transition-colors ${state.settings.micAutoGainControl ? 'bg-accent text-white' : 'text-text-secondary opacity-50 hover:opacity-80'}`}
              title={`Auto Gain Control: ${state.settings.micAutoGainControl ? 'ON' : 'OFF'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
            </button>

            <div className="flex items-center gap-1 flex-shrink-0">
              <svg className="w-3 h-3 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <span className="text-[10px] text-text-secondary">VOL</span>
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={state.settings.micVolume ?? 1}
              onChange={handleMicVolumeChange}
              className="w-12 flex-shrink-0"

            />
            <span className="text-xs text-text-secondary w-7 flex-shrink-0">
              {Math.round((state.settings.micVolume ?? 1) * 100)}%
            </span>
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-bg-tertiary flex-shrink-0" />

          {/* Output volume (what others hear) */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-1 flex-shrink-0">
              <svg className="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
              <span className="text-[10px] text-text-secondary">OUTPUT</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={state.settings.masterVolume}
              onChange={handleMasterVolumeChange}
              className="w-16 flex-shrink-0"
              title="Volume others hear (Discord/streaming)"
            />
            <span className="text-xs text-text-secondary w-7 flex-shrink-0">
              {Math.round(state.settings.masterVolume * 100)}%
            </span>
          </div>

          {/* Monitor volume (what you hear) */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="text-[10px] text-text-secondary">MON</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={state.settings.monitorVolume ?? 1}
              onChange={handleMonitorVolumeChange}
              className="w-12 flex-shrink-0"
              title="Monitor volume (what you hear locally)"
            />
            <span className="text-xs text-text-secondary w-7 flex-shrink-0">
              {Math.round((state.settings.monitorVolume ?? 1) * 100)}%
            </span>
          </div>

          {/* Concurrent Playback toggle */}
          <button
            onClick={() => updateSettings({ allowConcurrentPlayback: !state.settings.allowConcurrentPlayback })}
            className={`p-1.5 rounded transition-colors flex-shrink-0 ml-auto ${
              state.settings.allowConcurrentPlayback
                ? 'bg-accent text-white'
                : 'hover:bg-bg-tertiary text-text-secondary'
            }`}
            title={state.settings.allowConcurrentPlayback ? 'Multi-sound ON (click to play one at a time)' : 'Single sound mode (click to allow multiple)'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {state.settings.allowConcurrentPlayback ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
              )}
            </svg>
          </button>

          {/* Playback Lock button */}
          <button
            onClick={() => dispatch({ type: 'SET_PLAYBACK_LOCKED', payload: !state.playbackLocked })}
            className={`p-1.5 rounded transition-colors flex-shrink-0 ${
              state.playbackLocked
                ? 'bg-yellow-600 text-white'
                : 'hover:bg-bg-tertiary text-text-secondary'
            }`}
            title={state.playbackLocked ? 'Playback locked (click to unlock)' : 'Lock playback (click sounds without playing)'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {state.playbackLocked ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
              )}
            </svg>
          </button>

          {/* Settings button */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 hover:bg-bg-tertiary rounded transition-colors flex-shrink-0"
            title="Settings"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}
