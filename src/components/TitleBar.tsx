'use client';

import { useApp } from '@/lib/store';

export function TitleBar() {
  const { state, stopAllSounds } = useApp();

  const handleMinimize = () => window.electronAPI?.minimizeWindow();
  const handleMaximize = () => window.electronAPI?.maximizeWindow();
  const handleClose = () => window.electronAPI?.closeWindow();

  return (
    <div className="titlebar-drag h-10 bg-bg-secondary flex items-center justify-between px-4 border-b border-bg-tertiary">
      <div className="flex items-center gap-3">
        <span className="text-accent font-bold text-lg">CarbonBoard</span>
        {state.playingSounds.size > 0 && (
          <button
            onClick={stopAllSounds}
            className="titlebar-no-drag px-3 py-1 bg-accent hover:bg-accent-hover text-white text-xs rounded font-medium transition-colors"
          >
            Stop All ({state.playingSounds.size})
          </button>
        )}
      </div>

      <div className="titlebar-no-drag flex items-center">
        <button
          onClick={handleMinimize}
          className="w-10 h-10 flex items-center justify-center hover:bg-bg-tertiary transition-colors"
          title="Minimize"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-10 h-10 flex items-center justify-center hover:bg-bg-tertiary transition-colors"
          title="Maximize"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth={2} />
          </svg>
        </button>
        <button
          onClick={handleClose}
          className="w-10 h-10 flex items-center justify-center hover:bg-red-600 transition-colors"
          title="Close"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
