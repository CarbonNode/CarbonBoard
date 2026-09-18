'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { SoundCard } from './SoundCard';
import type { Sound, SubCategory } from '../../shared/types';

/**
 * A group as ONE tile on the board. Click it and its sounds fly out beside it,
 * each a normal SoundCard, so a whole family of clips ("Dog", "Peter", "Trump")
 * costs one square until it is wanted. Shift-click (or the dice) plays a random
 * member without opening anything, which is the point of a group of variations:
 * the same dog never barks the same way twice.
 */

interface GroupStackProps {
  group: SubCategory;
  sounds: Sound[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  /** The grid just created this group and wants its name typed now. */
  renameRequested?: boolean;
  onRenameDone?: () => void;
  onExpandInline: () => void;
  onDelete: () => void;
  /** Wrapper drag events so a sound dragged onto the tile joins the group. */
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
  dragOver?: boolean;
  variant?: 'card' | 'row';
}

const thumbSrc = (s: Sound) => `local-file://${encodeURIComponent(s.thumbnailPath ?? '')}`;

/** A deterministic muted colour so placeholder squares differ per sound. */
function hue(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 35%, 22%)`;
}

export function GroupStack({
  group, sounds, open, onOpen, onClose, onRename, onExpandInline, onDelete,
  dragProps, dragOver, variant = 'card', renameRequested = false, onRenameDone,
}: GroupStackProps) {
  const { state, playSound } = useApp();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const tileRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const lastRandomRef = useRef<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const playingCount = sounds.filter(s => state.playingSounds.has(s.id)).length;

  useEffect(() => {
    if (renameRequested) { setDraft(group.name); setRenaming(true); }
  }, [renameRequested, group.name]);

  // Close the context menu on any click, like every other menu in the app.
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // The flyout closes on a click outside it (a click on its own tile toggles)
  // and on Escape. Playing a sound inside it keeps it open on purpose.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (flyoutRef.current?.contains(t) || tileRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  // Anchor the flyout to the tile: below it when there is room, above it
  // otherwise, and never past the right edge of the window.
  const place = useCallback(() => {
    const tile = tileRef.current;
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    const cols = Math.min(4, Math.max(2, sounds.length || 2));
    const width = Math.min(window.innerWidth - 24, cols * 128 + 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const rows = Math.max(1, Math.ceil(Math.max(1, sounds.length) / cols));
    const estHeight = 44 + rows * 160 + 16;
    const below = r.bottom + 8;
    const top = below + estHeight <= window.innerHeight || r.top < estHeight
      ? below
      : Math.max(12, r.top - 8 - estHeight);
    setPos({ left, top, width });
  }, [sounds.length]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place]);

  const playRandom = useCallback(() => {
    if (sounds.length === 0) return;
    let pool = sounds;
    if (sounds.length > 1 && lastRandomRef.current) {
      pool = sounds.filter(s => s.id !== lastRandomRef.current);
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    lastRandomRef.current = pick.id;
    void playSound(pick);
  }, [sounds, playSound]);

  const handleClick = (e: React.MouseEvent) => {
    if (renaming) return;
    if (e.shiftKey) { playRandom(); return; }
    if (open) onClose(); else onOpen();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const startRename = () => {
    setDraft(group.name);
    setRenaming(true);
    setContextMenu(null);
  };

  const commitRename = () => {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== group.name) onRename(name);
    onRenameDone?.();
  };

  const preview = sounds.slice(0, 4);

  const nameEl = renaming ? (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commitRename}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') { setRenaming(false); setDraft(group.name); onRenameDone?.(); }
      }}
      className="w-full bg-bg-tertiary px-1.5 py-0.5 rounded text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
      autoFocus
    />
  ) : (
    <p className="text-sm font-medium truncate" title={group.name}>{group.name}</p>
  );

  const ring = playingCount > 0
    ? 'ring-2 ring-accent playing-pulse'
    : open ? 'ring-2 ring-blue-500' : dragOver ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-primary' : '';

  return (
    <>
      {variant === 'row' ? (
        <div
          ref={tileRef}
          {...dragProps}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-secondary cursor-pointer hover:bg-bg-tertiary/60 transition-colors ${ring} ${dragProps?.className ?? ''}`}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title="Click to open, shift-click for a random one"
        >
          <StackGlyph />
          <div className="flex-1 min-w-0">{nameEl}</div>
          <span className="text-xs text-text-secondary">{sounds.length}</span>
          <button
            onClick={(e) => { e.stopPropagation(); playRandom(); }}
            className="p-1 rounded hover:bg-bg-tertiary text-text-secondary hover:text-text-primary"
            title="Play a random one"
          >
            <DiceGlyph />
          </button>
        </div>
      ) : (
        <div
          ref={tileRef}
          {...dragProps}
          className={`sound-card relative bg-bg-secondary rounded-lg cursor-pointer group ${ring} ${dragProps?.className ?? ''}`}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title="Click to open, shift-click for a random one"
        >
          {/* The stacked-paper edges that say "there is more than one in here". */}
          <div className="absolute -top-1 left-1.5 right-1.5 h-2 rounded-t-lg bg-bg-tertiary/60 pointer-events-none" />
          <div className="absolute -top-0.5 left-0.5 right-0.5 h-2 rounded-t-lg bg-bg-tertiary pointer-events-none" />

          <div className="relative rounded-lg overflow-hidden">
            <div className="aspect-square bg-bg-tertiary relative">
              {preview.length === 0 ? (
                <div className="w-full h-full flex items-center justify-center text-text-secondary">
                  <StackGlyph large />
                </div>
              ) : (
                <div className={`w-full h-full grid gap-0.5 ${preview.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                  {preview.map((s) => (
                    <div key={s.id} className="relative overflow-hidden" style={{ background: hue(s.name) }}>
                      {s.thumbnailPath ? (
                        <img
                          src={thumbSrc(s)}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-lg font-bold text-white/25">
                          {s.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                  ))}
                  {preview.length === 3 && <div className="bg-bg-secondary/60" />}
                </div>
              )}

              {/* Count badge */}
              <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-bg-primary/80 rounded text-xs font-mono">
                {sounds.length}
              </div>

              {/* Random-one button */}
              <button
                onClick={(e) => { e.stopPropagation(); playRandom(); }}
                onMouseDown={(e) => e.stopPropagation()}
                className="absolute bottom-1 right-1 p-1 rounded bg-bg-primary/80 text-white/70 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                title="Play a random one (shift-click the tile does the same)"
              >
                <DiceGlyph />
              </button>

              {/* Hover hint */}
              <div className={`absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity pointer-events-none ${open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                <StackGlyph large light />
              </div>
            </div>

            <div className="p-2">
              {nameEl}
              <p className="text-xs text-text-secondary">
                {sounds.length === 1 ? '1 sound' : `${sounds.length} sounds`}
                {playingCount > 0 ? ' · playing' : ''}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Flyout */}
      {open && pos && (
        <div
          ref={flyoutRef}
          className="fixed z-[900] bg-bg-secondary border border-bg-tertiary rounded-xl shadow-2xl p-3 group-flyout"
          style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 mb-2">
            <StackGlyph />
            <span className="text-sm font-medium truncate flex-1" title={group.name}>{group.name}</span>
            <span className="text-xs text-text-secondary">{sounds.length}</span>
            <button
              onClick={playRandom}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-bg-tertiary hover:bg-accent/30 rounded transition-colors"
              title="Play a random one"
            >
              <DiceGlyph /> Random
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-bg-tertiary text-text-secondary hover:text-text-primary"
              title="Close (Esc)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {sounds.length === 0 ? (
            <div className="text-xs text-text-secondary py-6 text-center border border-dashed border-bg-tertiary rounded">
              Empty group. Drag sounds onto the tile.
            </div>
          ) : (
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.min(4, Math.max(2, sounds.length))}, minmax(0, 1fr))` }}
            >
              {sounds.map((s) => <SoundCard key={s.id} sound={s} />)}
            </div>
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => { setContextMenu(null); onOpen(); }}>
            <StackGlyph /> Open
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); playRandom(); }}>
            <DiceGlyph /> Play random
          </button>
          <button className="context-menu-item" onClick={startRename}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Rename
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); onExpandInline(); }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
            Show inline
          </button>
          <div className="border-t border-bg-tertiary my-1" />
          <button className="context-menu-item danger" onClick={() => { setContextMenu(null); onDelete(); }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete group
          </button>
        </div>
      )}
    </>
  );
}

function StackGlyph({ large = false, light = false }: { large?: boolean; light?: boolean }) {
  return (
    <svg
      className={`${large ? 'w-10 h-10' : 'w-4 h-4'} ${light ? 'text-white' : ''} flex-shrink-0`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4l8 4-8 4-8-4 8-4z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 12l8 4 8-4M4 16l8 4 8-4" />
    </svg>
  );
}

function DiceGlyph() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="4" y="4" width="16" height="16" rx="3" strokeWidth={1.5} />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
