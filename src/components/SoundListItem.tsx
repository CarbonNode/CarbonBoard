'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/lib/store';
import type { Sound } from '../../shared/types';

interface SoundListItemProps {
  sound: Sound;
}

export function SoundListItem({ sound }: SoundListItemProps) {
  const { state, dispatch, playSound, stopSound, pauseSound, resumeSound, deleteSound, updateSound } = useApp();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const playingEntry = state.playingSounds.get(sound.id);
  const isPlaying = !!playingEntry && !playingEntry.paused;
  const isPaused = !!playingEntry && playingEntry.paused;
  const isSelected = state.selectedSoundId === sound.id;

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
        className={`flex items-center gap-3 px-3 py-2 bg-bg-secondary rounded-lg cursor-pointer hover:bg-bg-tertiary transition-colors group ${
          isPlaying ? 'ring-2 ring-accent' : ''
        } ${isPaused ? 'ring-2 ring-yellow-500' : ''
        } ${isSelected && !isPlaying && !isPaused ? 'ring-2 ring-blue-500' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Play/Stop button */}
        <button
          className={`w-8 h-8 flex items-center justify-center rounded-full flex-shrink-0 ${
            isPlaying ? 'bg-accent text-white' : isPaused ? 'bg-yellow-500 text-white' : 'bg-bg-tertiary text-text-secondary group-hover:bg-accent group-hover:text-white'
          } transition-colors`}
        >
          {isPlaying ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : isPaused ? (
            <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Thumbnail (small) */}
        <div className="w-10 h-10 bg-bg-tertiary rounded flex-shrink-0 flex items-center justify-center overflow-hidden">
          {sound.thumbnailPath ? (
            <img
              src={`local-file://${encodeURIComponent(sound.thumbnailPath)}`}
              alt={sound.name}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <svg className="w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          )}
        </div>

        {/* Name and duration */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{sound.name}</p>
          {sound.duration > 0 && (
            <p className="text-xs text-text-secondary">
              {formatDuration(sound.trimEnd ?? sound.duration)}
            </p>
          )}
        </div>

        {/* Favorite star */}
        <button
          onClick={handleToggleFavorite}
          className={`p-1 rounded transition-colors flex-shrink-0 ${
            sound.favorite
              ? 'text-yellow-400 hover:text-yellow-300'
              : 'text-text-secondary hover:text-white opacity-0 group-hover:opacity-100'
          }`}
          title={sound.favorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <svg className="w-4 h-4" fill={sound.favorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
        </button>

        {/* Hotkey badge */}
        {sound.hotkey && (
          <div className="px-2 py-0.5 bg-bg-tertiary rounded text-xs font-mono flex-shrink-0">
            {sound.hotkey}
          </div>
        )}

        {/* Volume indicator */}
        {sound.volume !== 1 && (
          <div className={`flex items-center gap-1 text-xs flex-shrink-0 ${sound.volume > 1 ? 'text-yellow-400' : 'text-text-secondary'}`}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
            {Math.round(sound.volume * 100)}%
          </div>
        )}

        {/* Edit button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleEdit();
          }}
          className="p-1 rounded hover:bg-bg-primary transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
          title="Edit"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
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
