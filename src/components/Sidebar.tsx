'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '@/lib/store';
import type { Category } from '../../shared/types';

export function Sidebar() {
  const { state, dispatch, createCategory, updateCategory, deleteCategory, importSounds, reorderCategories } = useApp();
  const [isCreating, setIsCreating] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; category: Category } | null>(null);
  const [draggedCategoryId, setDraggedCategoryId] = useState<string | null>(null);
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Focus input when creating
  useEffect(() => {
    if (isCreating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  // Focus input when editing
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleCreateCategory = async () => {
    if (newCategoryName.trim()) {
      await createCategory(newCategoryName.trim());
      setNewCategoryName('');
      setIsCreating(false);
    }
  };

  const handleUpdateCategory = async () => {
    if (editingId && editingName.trim()) {
      await updateCategory(editingId, editingName.trim());
      setEditingId(null);
      setEditingName('');
    }
  };

  const handleContextMenu = (e: React.MouseEvent, category: Category) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, category });
  };

  const handleAddSounds = async () => {
    const files = await window.electronAPI?.selectSoundFiles();
    if (files && files.length > 0) {
      await importSounds(files);
    }
  };

  const filteredSoundsCount = (categoryId: string | null) => {
    if (categoryId === null) {
      return state.sounds.length;
    }
    return state.sounds.filter((s) => s.categoryId === categoryId).length;
  };

  // Category drag handlers
  const handleCategoryDragStart = useCallback((e: React.DragEvent, categoryId: string) => {
    setDraggedCategoryId(categoryId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', categoryId);
    setTimeout(() => {
      (e.target as HTMLElement).style.opacity = '0.5';
    }, 0);
  }, []);

  const handleCategoryDragEnd = useCallback((e: React.DragEvent) => {
    (e.target as HTMLElement).style.opacity = '1';
    setDraggedCategoryId(null);
    setDragOverCategoryId(null);
  }, []);

  const handleCategoryDragOver = useCallback((e: React.DragEvent, categoryId: string) => {
    e.preventDefault();
    if (draggedCategoryId && draggedCategoryId !== categoryId) {
      setDragOverCategoryId(categoryId);
    }
  }, [draggedCategoryId]);

  const handleCategoryDragLeave = useCallback(() => {
    setDragOverCategoryId(null);
  }, []);

  const handleCategoryDrop = useCallback(async (e: React.DragEvent, targetCategoryId: string) => {
    e.preventDefault();
    if (!draggedCategoryId || draggedCategoryId === targetCategoryId) {
      setDraggedCategoryId(null);
      setDragOverCategoryId(null);
      return;
    }

    const categoryIds = state.categories.map((c) => c.id);
    const draggedIndex = categoryIds.indexOf(draggedCategoryId);
    const targetIndex = categoryIds.indexOf(targetCategoryId);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      // Remove dragged item and insert at target position
      categoryIds.splice(draggedIndex, 1);
      categoryIds.splice(targetIndex, 0, draggedCategoryId);
      await reorderCategories(categoryIds);
    }

    setDraggedCategoryId(null);
    setDragOverCategoryId(null);
  }, [draggedCategoryId, state.categories, reorderCategories]);

  return (
    <aside className="w-64 bg-bg-secondary border-r border-bg-tertiary flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-bg-tertiary">
        <input
          type="text"
          placeholder="Search sounds..."
          value={state.searchQuery}
          onChange={(e) => dispatch({ type: 'SET_SEARCH_QUERY', payload: e.target.value })}
          className="w-full px-3 py-2 bg-bg-tertiary rounded-lg text-sm placeholder-text-secondary focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          {/* All Sounds */}
          <button
            onClick={() => dispatch({ type: 'SET_SELECTED_CATEGORY', payload: null })}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between ${
              state.selectedCategoryId === null
                ? 'bg-accent text-white'
                : 'hover:bg-bg-tertiary'
            }`}
          >
            <span className="font-medium">All Sounds</span>
            <span className="text-xs opacity-70">{filteredSoundsCount(null)}</span>
          </button>

          {/* Favorites */}
          <button
            onClick={() => dispatch({ type: 'SET_SELECTED_CATEGORY', payload: 'favorites' })}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between mt-1 ${
              state.selectedCategoryId === 'favorites'
                ? 'bg-accent text-white'
                : 'hover:bg-bg-tertiary'
            }`}
          >
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              Favorites
            </span>
            <span className="text-xs opacity-70">
              {state.sounds.filter((s) => s.favorite).length}
            </span>
          </button>

          {/* Uncategorized */}
          <button
            onClick={() => dispatch({ type: 'SET_SELECTED_CATEGORY', payload: 'uncategorized' })}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between mt-1 ${
              state.selectedCategoryId === 'uncategorized'
                ? 'bg-accent text-white'
                : 'hover:bg-bg-tertiary'
            }`}
          >
            <span>Uncategorized</span>
            <span className="text-xs opacity-70">
              {state.sounds.filter((s) => !s.categoryId).length}
            </span>
          </button>

          {/* Divider */}
          <div className="border-t border-bg-tertiary my-2" />

          {/* Category List */}
          {state.categories.map((category) => (
            <div
              key={category.id}
              draggable={editingId !== category.id}
              onDragStart={(e) => handleCategoryDragStart(e, category.id)}
              onDragEnd={handleCategoryDragEnd}
              onDragOver={(e) => handleCategoryDragOver(e, category.id)}
              onDragLeave={handleCategoryDragLeave}
              onDrop={(e) => handleCategoryDrop(e, category.id)}
              className={`${
                dragOverCategoryId === category.id ? 'border-t-2 border-accent' : ''
              }`}
            >
              {editingId === category.id ? (
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleUpdateCategory();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={handleUpdateCategory}
                  className="w-full px-3 py-2 bg-bg-tertiary rounded-lg text-sm"
                />
              ) : (
                <button
                  onClick={() => dispatch({ type: 'SET_SELECTED_CATEGORY', payload: category.id })}
                  onContextMenu={(e) => handleContextMenu(e, category)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between cursor-grab active:cursor-grabbing ${
                    state.selectedCategoryId === category.id
                      ? 'bg-accent text-white'
                      : 'hover:bg-bg-tertiary'
                  } ${draggedCategoryId === category.id ? 'opacity-50' : ''}`}
                >
                  <span>{category.name}</span>
                  <span className="text-xs opacity-70">{filteredSoundsCount(category.id)}</span>
                </button>
              )}
            </div>
          ))}

          {/* New Category Input */}
          {isCreating && (
            <input
              ref={inputRef}
              type="text"
              placeholder="Category name..."
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateCategory();
                if (e.key === 'Escape') setIsCreating(false);
              }}
              onBlur={() => {
                if (!newCategoryName.trim()) setIsCreating(false);
                else handleCreateCategory();
              }}
              className="w-full px-3 py-2 bg-bg-tertiary rounded-lg text-sm mt-1"
            />
          )}

          {/* Add Category Button */}
          {!isCreating && (
            <button
              onClick={() => setIsCreating(true)}
              className="w-full text-left px-3 py-2 text-text-secondary hover:text-text-primary hover:bg-bg-tertiary rounded-lg transition-colors mt-1 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Category
            </button>
          )}
        </div>
      </div>

      {/* Add Sound Button */}
      <div className="p-4 border-t border-bg-tertiary">
        <button
          onClick={handleAddSounds}
          className="w-full py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Sounds
        </button>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              setEditingId(contextMenu.category.id);
              setEditingName(contextMenu.category.name);
              setContextMenu(null);
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Rename
          </button>
          <button
            className="context-menu-item danger"
            onClick={async () => {
              await deleteCategory(contextMenu.category.id);
              setContextMenu(null);
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </aside>
  );
}
