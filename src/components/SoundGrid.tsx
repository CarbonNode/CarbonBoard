'use client';

import { useCallback, useState, useRef, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { SoundCard } from './SoundCard';
import { SoundListItem } from './SoundListItem';
import type { ViewMode, Sound, SubCategory } from '../../shared/types';

export function SoundGrid() {
  const { state, dispatch, importSounds, updateSettings, reorderSounds, updateSound, createSubCategory, updateSubCategory, deleteSubCategory } = useApp();
  const [isDragging, setIsDragging] = useState(false);
  const [draggedSoundId, setDraggedSoundId] = useState<string | null>(null);
  const [dragOverSoundId, setDragOverSoundId] = useState<string | null>(null);
  const [dragOverSubCategoryId, setDragOverSubCategoryId] = useState<string | null>(null);
  const [editingSubCategoryId, setEditingSubCategoryId] = useState<string | null>(null);
  const [editingSubCategoryName, setEditingSubCategoryName] = useState('');
  const dragCounterRef = useRef(0);

  // Get view mode for current category
  const currentCategoryKey = state.selectedCategoryId || 'all';
  const viewMode: ViewMode = state.settings?.categoryViewModes?.[currentCategoryKey] || 'grid';

  // Check if we should show sub-categories (only for regular categories, not special views)
  const showSubCategories = state.selectedCategoryId &&
    state.selectedCategoryId !== 'favorites' &&
    state.selectedCategoryId !== 'uncategorized';

  // Get sub-categories for current category
  const currentSubCategories = showSubCategories
    ? state.subCategories.filter(sc => sc.categoryId === state.selectedCategoryId)
    : [];

  const toggleViewMode = useCallback(() => {
    const newMode: ViewMode = viewMode === 'grid' ? 'list' : 'grid';
    const updatedModes = {
      ...(state.settings?.categoryViewModes || {}),
      [currentCategoryKey]: newMode,
    };
    updateSettings({ categoryViewModes: updatedModes });
  }, [viewMode, currentCategoryKey, state.settings?.categoryViewModes, updateSettings]);

  // Filter sounds based on category and search (exclude sub-soundbites from top level)
  const filteredSounds = useCallback(() => {
    let sounds = state.sounds.filter((s) => !s.parentSoundId);

    // Filter by category
    if (state.selectedCategoryId === 'favorites') {
      sounds = sounds.filter((s) => s.favorite);
    } else if (state.selectedCategoryId === 'uncategorized') {
      sounds = sounds.filter((s) => !s.categoryId);
    } else if (state.selectedCategoryId) {
      sounds = sounds.filter((s) => s.categoryId === state.selectedCategoryId);
    }

    // Filter by search
    if (state.searchQuery.trim()) {
      const query = state.searchQuery.toLowerCase();
      sounds = sounds.filter((s) => s.name.toLowerCase().includes(query));
    }

    return sounds;
  }, [state.sounds, state.selectedCategoryId, state.searchQuery]);

  // Group sounds by sub-category
  const groupedSounds = useCallback(() => {
    const sounds = filteredSounds();
    if (!showSubCategories) {
      return { ungrouped: sounds, groups: [] };
    }

    const ungrouped = sounds.filter(s => !s.subCategoryId);
    const groups = currentSubCategories.map(sc => ({
      subCategory: sc,
      sounds: sounds.filter(s => s.subCategoryId === sc.id)
    }));

    return { ungrouped, groups };
  }, [filteredSounds, showSubCategories, currentSubCategories]);

  // Drag and drop handlers (using counter to handle child element events)
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounterRef.current = 0;

      const files = Array.from(e.dataTransfer.files);
      console.log('Drop detected, files:', files.length, files.map(f => f.name));

      const audioFiles = files.filter((f) =>
        /\.(mp3|wav|ogg|flac|m4a|webm)$/i.test(f.name)
      );
      console.log('Audio files:', audioFiles.length);

      if (audioFiles.length > 0 && window.electronAPI) {
        // Get file paths using Electron's webUtils
        const filePaths = audioFiles.map((f) => window.electronAPI!.getPathForFile(f));
        console.log('File paths:', filePaths);
        await importSounds(filePaths);
      }
    },
    [importSounds]
  );

  // Sound reordering handlers
  const handleSoundDragStart = useCallback((e: React.DragEvent, soundId: string) => {
    setDraggedSoundId(soundId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', soundId);
    // Add a slight delay to show drag effect
    setTimeout(() => {
      (e.target as HTMLElement).style.opacity = '0.5';
    }, 0);
  }, []);

  const handleSoundDragEnd = useCallback((e: React.DragEvent) => {
    (e.target as HTMLElement).style.opacity = '1';
    setDraggedSoundId(null);
    setDragOverSoundId(null);
    setDragOverSubCategoryId(null);
  }, []);

  const handleSoundDragOver = useCallback((e: React.DragEvent, soundId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedSoundId && soundId !== draggedSoundId) {
      setDragOverSoundId(soundId);
    }
  }, [draggedSoundId]);

  const handleSoundDragLeave = useCallback(() => {
    setDragOverSoundId(null);
  }, []);

  // Sub-category drop zone handlers
  const handleSubCategoryDragOver = useCallback((e: React.DragEvent, subCategoryId: string | null) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedSoundId) {
      setDragOverSubCategoryId(subCategoryId);
    }
  }, [draggedSoundId]);

  const handleSubCategoryDragLeave = useCallback(() => {
    setDragOverSubCategoryId(null);
  }, []);

  const handleSubCategoryDrop = useCallback(async (e: React.DragEvent, subCategoryId: string | null) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedSoundId) {
      setDragOverSubCategoryId(null);
      return;
    }

    // Update the sound's sub-category
    await updateSound(draggedSoundId, { subCategoryId });

    setDraggedSoundId(null);
    setDragOverSubCategoryId(null);
  }, [draggedSoundId, updateSound]);

  const handleSoundDrop = useCallback(async (e: React.DragEvent, targetSoundId: string) => {
    e.preventDefault();

    // Check if this is an external file drop (not internal sound reorder)
    if (e.dataTransfer.files.length > 0 && !draggedSoundId) {
      // Let the container handle file imports
      // Don't stopPropagation - but since we're on a child, manually trigger import
      const files = Array.from(e.dataTransfer.files);
      const audioFiles = files.filter((f) =>
        /\.(mp3|wav|ogg|flac|m4a|webm)$/i.test(f.name)
      );
      if (audioFiles.length > 0) {
        if (window.electronAPI) {
          const filePaths = audioFiles.map((f) => window.electronAPI!.getPathForFile(f));
          console.log('File drop on sound card, importing:', filePaths);
          await importSounds(filePaths);
        }
      }
      setDragOverSoundId(null);
      return;
    }

    e.stopPropagation();

    if (!draggedSoundId || draggedSoundId === targetSoundId) {
      setDraggedSoundId(null);
      setDragOverSoundId(null);
      return;
    }

    const sounds = filteredSounds();
    const draggedIndex = sounds.findIndex(s => s.id === draggedSoundId);
    const targetIndex = sounds.findIndex(s => s.id === targetSoundId);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedSoundId(null);
      setDragOverSoundId(null);
      return;
    }

    // Create new order array
    const newSounds = [...sounds];
    const [draggedSound] = newSounds.splice(draggedIndex, 1);
    newSounds.splice(targetIndex, 0, draggedSound);

    // Get the new order of IDs
    const newOrder = newSounds.map(s => s.id);

    // Update order in database
    await reorderSounds(state.selectedCategoryId, newOrder);

    setDraggedSoundId(null);
    setDragOverSoundId(null);
  }, [draggedSoundId, filteredSounds, reorderSounds, state.selectedCategoryId, importSounds]);

  // Sub-category editing handlers
  const handleAddSubCategory = async () => {
    if (!state.selectedCategoryId) return;
    const subCategory = await createSubCategory(state.selectedCategoryId, 'New Group');
    if (subCategory) {
      setEditingSubCategoryId(subCategory.id);
      setEditingSubCategoryName('New Group');
    }
  };

  const handleStartEditSubCategory = (subCategory: SubCategory) => {
    setEditingSubCategoryId(subCategory.id);
    setEditingSubCategoryName(subCategory.name);
  };

  const handleSaveSubCategoryName = async () => {
    if (editingSubCategoryId && editingSubCategoryName.trim()) {
      await updateSubCategory(editingSubCategoryId, editingSubCategoryName.trim());
    }
    setEditingSubCategoryId(null);
    setEditingSubCategoryName('');
  };

  const handleDeleteSubCategory = async (id: string) => {
    if (confirm('Delete this group? Sounds will be moved to ungrouped.')) {
      await deleteSubCategory(id);
    }
  };

  const renderSoundItem = (sound: Sound) => {
    const commonProps = {
      key: sound.id,
      draggable: true,
      onDragStart: (e: React.DragEvent) => handleSoundDragStart(e, sound.id),
      onDragEnd: handleSoundDragEnd,
      onDragOver: (e: React.DragEvent) => handleSoundDragOver(e, sound.id),
      onDragLeave: handleSoundDragLeave,
      onDrop: (e: React.DragEvent) => handleSoundDrop(e, sound.id),
      className: `transition-all ${
        dragOverSoundId === sound.id ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-primary' : ''
      } ${draggedSoundId === sound.id ? 'opacity-50' : ''}`,
    };

    const subs = subSoundsMap.get(sound.id);
    const hasSubs = !!subs && subs.length > 0;

    return (
      <div {...commonProps}>
        {viewMode === 'grid' ? (
          <SoundCard
            sound={sound}
            expanded={state.expandedSoundIds.has(sound.id)}
            hasSubSounds={hasSubs}
            onToggleExpand={hasSubs ? () => toggleExpanded(sound.id) : undefined}
          />
        ) : (
          <SoundListItem sound={sound} />
        )}
      </div>
    );
  };

  const toggleExpanded = useCallback((parentId: string) => {
    dispatch({ type: 'TOGGLE_EXPANDED_SOUND', payload: parentId });
  }, [dispatch]);

  // Get sub-sounds for a parent
  const subSoundsMap = useMemo(() => {
    const map = new Map<string, Sound[]>();
    state.sounds.forEach(s => {
      if (s.parentSoundId) {
        const list = map.get(s.parentSoundId) || [];
        list.push(s);
        map.set(s.parentSoundId, list);
      }
    });
    return map;
  }, [state.sounds]);

  const renderSoundsGrid = (sounds: Sound[]) => {
    if (viewMode === 'grid') {
      return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {sounds.flatMap(sound => {
            const items = [renderSoundItem(sound)];
            const subs = subSoundsMap.get(sound.id);
            if (subs && subs.length > 0 && state.expandedSoundIds.has(sound.id)) {
              items.push(...subs.map(renderSoundItem));
            }
            return items;
          })}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        {sounds.flatMap(sound => {
          const items = [renderSoundItem(sound)];
          const subs = subSoundsMap.get(sound.id);
          if (subs && subs.length > 0 && state.expandedSoundIds.has(sound.id)) {
            items.push(
              <div key={`${sound.id}-subs`} className="ml-6 flex flex-col gap-1 py-1">
                {subs.map(renderSoundItem)}
              </div>
            );
          }
          return items;
        })}
      </div>
    );
  };

  const { ungrouped, groups } = groupedSounds();
  const allSounds = filteredSounds();

  return (
    <div
      className={`flex-1 overflow-y-auto p-4 transition-colors ${
        isDragging ? 'bg-accent/10 border-2 border-dashed border-accent' : ''
      }`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {state.isLoading ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-text-secondary">Loading...</div>
        </div>
      ) : allSounds.length === 0 && currentSubCategories.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-text-secondary">
          <svg
            className="w-16 h-16 mb-4 opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
            />
          </svg>
          <p className="text-lg mb-2">No sounds yet</p>
          <p className="text-sm">
            Drag and drop audio files here or click "Add Sounds" in the sidebar
          </p>
        </div>
      ) : (
        <div className="flex flex-col h-full">
          {/* View toggle header */}
          <div className="flex justify-between items-center mb-3">
            {/* Add sub-category button (only show for regular categories) */}
            {showSubCategories && (
              <button
                onClick={handleAddSubCategory}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-bg-tertiary hover:bg-accent/20 rounded transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Group
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={toggleViewMode}
              className="p-1.5 hover:bg-bg-tertiary rounded transition-colors"
              title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
            >
              {viewMode === 'grid' ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
              )}
            </button>
          </div>

          {/* Render sounds - either grouped or flat */}
          {showSubCategories ? (
            <div className="space-y-6">
              {/* Ungrouped sounds */}
              {ungrouped.length > 0 && (
                <div
                  className={`${dragOverSubCategoryId === null && draggedSoundId ? 'ring-2 ring-accent rounded-lg p-2' : ''}`}
                  onDragOver={(e) => handleSubCategoryDragOver(e, null)}
                  onDragLeave={handleSubCategoryDragLeave}
                  onDrop={(e) => handleSubCategoryDrop(e, null)}
                >
                  <div className="text-xs text-text-secondary mb-2 uppercase tracking-wider">Ungrouped</div>
                  {renderSoundsGrid(ungrouped)}
                </div>
              )}

              {/* Sub-category groups */}
              {groups.map(({ subCategory, sounds }) => (
                <div
                  key={subCategory.id}
                  className={`${dragOverSubCategoryId === subCategory.id ? 'ring-2 ring-accent rounded-lg p-2' : ''}`}
                  onDragOver={(e) => handleSubCategoryDragOver(e, subCategory.id)}
                  onDragLeave={handleSubCategoryDragLeave}
                  onDrop={(e) => handleSubCategoryDrop(e, subCategory.id)}
                >
                  {/* Sub-category header */}
                  <div className="flex items-center gap-2 mb-2 group">
                    {editingSubCategoryId === subCategory.id ? (
                      <input
                        type="text"
                        value={editingSubCategoryName}
                        onChange={(e) => setEditingSubCategoryName(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={handleSaveSubCategoryName}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') handleSaveSubCategoryName();
                          if (e.key === 'Escape') {
                            setEditingSubCategoryId(null);
                            setEditingSubCategoryName('');
                          }
                        }}
                        className="bg-bg-tertiary px-2 py-0.5 rounded text-sm font-medium focus:ring-2 focus:ring-accent"
                        autoFocus
                      />
                    ) : (
                      <span
                        className="text-sm font-medium cursor-pointer hover:text-accent"
                        onClick={() => handleStartEditSubCategory(subCategory)}
                        title="Click to rename"
                      >
                        {subCategory.name}
                      </span>
                    )}
                    <span className="text-xs text-text-secondary">({sounds.length})</span>
                    <button
                      onClick={() => handleDeleteSubCategory(subCategory.id)}
                      className="p-0.5 rounded hover:bg-red-600/20 text-text-secondary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Delete group"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  {/* Sounds in this sub-category */}
                  {sounds.length > 0 ? (
                    renderSoundsGrid(sounds)
                  ) : (
                    <div className="text-xs text-text-secondary py-4 text-center border border-dashed border-bg-tertiary rounded">
                      Drag sounds here
                    </div>
                  )}
                </div>
              ))}

              {/* Drop zone for ungrouped if no ungrouped sounds exist */}
              {ungrouped.length === 0 && groups.length > 0 && (
                <div
                  className={`text-xs text-text-secondary py-4 text-center border border-dashed border-bg-tertiary rounded ${
                    dragOverSubCategoryId === null && draggedSoundId ? 'ring-2 ring-accent' : ''
                  }`}
                  onDragOver={(e) => handleSubCategoryDragOver(e, null)}
                  onDragLeave={handleSubCategoryDragLeave}
                  onDrop={(e) => handleSubCategoryDrop(e, null)}
                >
                  Drop here to ungroup
                </div>
              )}
            </div>
          ) : (
            renderSoundsGrid(allSounds)
          )}
        </div>
      )}

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-primary/50 pointer-events-none">
          <div className="text-2xl text-accent font-bold">Drop audio files here</div>
        </div>
      )}
    </div>
  );
}
