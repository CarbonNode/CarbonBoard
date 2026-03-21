'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '@/lib/store';

interface PlayingSound {
  id: string;
  name: string;
  progress: number;
  duration: number;
  currentTime: number;
  trimStart: number;
  paused: boolean;
}

export function PlaybackBar() {
  const { state, stopSound, stopAllSounds, seekSound, pauseSound, resumeSound } = useApp();
  const [playingSounds, setPlayingSounds] = useState<PlayingSound[]>([]);

  // Update progress for all playing sounds
  useEffect(() => {
    if (state.playingSounds.size === 0) {
      setPlayingSounds([]);
      return;
    }

    const updateProgress = () => {
      const sounds: PlayingSound[] = [];

      state.playingSounds.forEach((playing, id) => {
        const sound = state.sounds.find(s => s.id === id);
        if (sound && playing.audio) {
          const currentTime = playing.audio.currentTime;
          const startTime = sound.trimStart || 0;
          const endTime = sound.trimEnd || playing.audio.duration || sound.duration;
          const duration = endTime - startTime;
          const elapsed = currentTime - startTime;
          const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

          sounds.push({
            id,
            name: sound.name,
            progress,
            duration,
            currentTime: elapsed,
            trimStart: startTime,
            paused: playing.paused,
          });
        }
      });

      setPlayingSounds(sounds);
    };

    // Update immediately and then every 50ms
    updateProgress();
    const interval = setInterval(updateProgress, 50);

    return () => clearInterval(interval);
  }, [state.playingSounds, state.sounds]);

  if (playingSounds.length === 0) {
    return null;
  }

  return (
    <div className="bg-bg-tertiary border-t border-bg-secondary">
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-xs text-text-secondary">Now Playing</span>
        {playingSounds.length > 1 && (
          <button
            onClick={stopAllSounds}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            Stop All
          </button>
        )}
      </div>

      <div className="max-h-32 overflow-y-auto">
        {playingSounds.map((sound) => (
          <div
            key={sound.id}
            className="flex items-center gap-3 px-4 py-2 hover:bg-bg-secondary/50 group"
          >
            {/* Pause/Resume button */}
            <button
              onClick={() => sound.paused ? resumeSound(sound.id) : pauseSound(sound.id)}
              className="w-6 h-6 flex items-center justify-center rounded-full bg-accent/20 hover:bg-accent text-accent hover:text-white transition-colors"
              title={sound.paused ? 'Resume' : 'Pause'}
            >
              {sound.paused ? (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              )}
            </button>

            {/* Stop button */}
            <button
              onClick={() => stopSound(sound.id)}
              className="w-6 h-6 flex items-center justify-center rounded-full bg-red-500/20 hover:bg-red-500 text-red-400 hover:text-white transition-colors"
              title="Stop"
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
            </button>

            {/* Sound info and progress */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium truncate">{sound.name}</span>
                <span className="text-xs text-text-secondary ml-2">
                  {formatTime(sound.currentTime)} / {formatTime(sound.duration)}
                </span>
              </div>

              {/* Progress bar - clickable to seek */}
              <div
                className="h-1.5 bg-bg-primary rounded-full overflow-hidden cursor-pointer hover:h-2 transition-all"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const percent = x / rect.width;
                  const seekTime = sound.trimStart + (percent * sound.duration);
                  seekSound(sound.id, seekTime);
                }}
              >
                <div
                  className={`h-full transition-all duration-75 ease-linear pointer-events-none ${sound.paused ? 'bg-yellow-500' : 'bg-accent'}`}
                  style={{ width: `${sound.progress}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
