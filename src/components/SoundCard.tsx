'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/lib/store';
import type { Sound } from '../../shared/types';

interface SoundCardProps {
  sound: Sound;
  expanded?: boolean;
  hasSubSounds?: boolean;
  onToggleExpand?: () => void;
}

export function SoundCard({ sound, expanded = false, hasSubSounds = false, onToggleExpand }: SoundCardProps) {
  const { state, dispatch, playSound, stopSound, pauseSound, resumeSound, deleteSound, updateSound } = useApp();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const playingEntry = state.playingSounds.get(sound.id);
  const isPlaying = !!playingEntry && !playingEntry.paused;
  const isPaused = !!playingEntry && playingEntry.paused;
  const isSelected = state.selectedSoundId === sound.id;
  const isSubSound = !!sound.parentSoundId;

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleClick = () => {
    // Always select this sound for copy/paste
    dispatch({ type: 'SET_SELECTED_SOUND', payload: sound.id });

    // If playback is locked, only select - don't play
    if (state.playbackLocked) {
      return;
    }

    if (isPlaying) {
      pauseSound(sound.id);
    } else if (isPaused) {
      stopSound(sound.id);
    } else {
      playSound(sound);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleEdit = () => {
    dispatch({ type: 'SET_EDITING_SOUND', payload: sound });
    setContextMenu(null);
  };

  const handleDelete = async () => {
    if (confirm(`Delete "${sound.name}"?`)) {
      await deleteSound(sound.id);
    }
    setContextMenu(null);
  };

  const handleToggleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await updateSound(sound.id, { favorite: !sound.favorite });
  };

  return (
    <>
      <div
        className={`sound-card relative bg-bg-secondary rounded-lg overflow-hidden cursor-pointer group ${
          isPlaying ? 'ring-2 ring-accent playing-pulse' : ''
        } ${isPaused ? 'ring-2 ring-yellow-500' : ''
        } ${isSelected && !isPlaying && !isPaused ? 'ring-2 ring-blue-500' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Thumbnail */}
        <div className="aspect-square bg-bg-tertiary flex items-center justify-center relative">
          {sound.thumbnailPath ? (
            <img
              src={`local-file://${encodeURIComponent(sound.thumbnailPath)}`}
              alt={sound.name}
              className="w-full h-full object-cover"
              onError={(e) => {
                // Hide broken image, show default icon
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <svg
              className="w-12 h-12 text-text-secondary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
              />
            </svg>
          )}

          {/* Play/Pause/Resume overlay */}
          <div
            className={`absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity ${
              isPlaying || isPaused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            {isPlaying ? (
              <svg className="w-10 h-10 text-white" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : isPaused ? (
              <svg className="w-10 h-10 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg className="w-10 h-10 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </div>

          {/* Favorite star */}
          <button
            onClick={handleToggleFavorite}
            className={`absolute top-1 left-1 p-1 rounded transition-colors ${
              sound.favorite
                ? 'text-yellow-400 hover:text-yellow-300'
                : 'text-white/40 hover:text-white/80 opacity-0 group-hover:opacity-100'
            }`}
            title={sound.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <svg className="w-4 h-4" fill={sound.favorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          </button>

          {/* Hotkey badge */}
          {sound.hotkey && (
            <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-bg-primary/80 rounded text-xs font-mono">
              {sound.hotkey}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="p-2">
          <div className="flex items-center gap-1">
            {hasSubSounds && onToggleExpand && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
                className="p-0.5 hover:bg-bg-tertiary rounded transition-colors flex-shrink-0"
                title={expanded ? 'Collapse sub-soundbites' : 'Expand sub-soundbites'}
              >
                <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
            <p className="text-sm font-medium truncate" title={sound.name}>
              {isSubSound ? '  ' : ''}{sound.name}
            </p>
          </div>
          {sound.duration > 0 && (
            <p className="text-xs text-text-secondary">
              {formatDuration(sound.trimStart)} - {formatDuration(sound.trimEnd ?? sound.duration)}
            </p>
          )}
        </div>

        {/* Volume indicator */}
        {sound.volume !== 1 && (
          <div
            className={`absolute bottom-0 left-0 h-1 ${sound.volume > 1 ? 'bg-yellow-400' : 'bg-accent'}`}
            style={{ width: `${Math.min(sound.volume * 100, 100)}%` }}
            title={`${Math.round(sound.volume * 100)}%`}
          />
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={handleEdit}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
            Edit
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              playSound(sound);
              setContextMenu(null);
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Play
          </button>
          <div className="border-t border-bg-tertiary my-1" />
          <button className="context-menu-item danger" onClick={handleDelete}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Delete
          </button>
        </div>
      )}
    </>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
