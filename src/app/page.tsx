'use client';

import { useState } from 'react';
import { AppProvider } from '@/lib/store';
import { TitleBar } from '@/components/TitleBar';
import { Sidebar } from '@/components/Sidebar';
import { SoundGrid } from '@/components/SoundGrid';
import { BottomBar } from '@/components/BottomBar';
import { PlaybackBar } from '@/components/PlaybackBar';
import { SoundEditor } from '@/components/SoundEditor';
import { Navigator } from '@/components/Navigator';

type TabType = 'sounds' | 'navigator';

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabType>('sounds');

  return (
    <AppProvider>
      <div className="h-screen flex flex-col bg-bg-primary text-text-primary">
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 flex flex-col overflow-hidden">
            {/* Tab Bar */}
            <div className="flex items-center bg-bg-secondary border-b border-border">
              <button
                onClick={() => setActiveTab('sounds')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'sounds'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                Sounds
              </button>
              <button
                onClick={() => setActiveTab('navigator')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                  activeTab === 'navigator'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                Navigator
              </button>
            </div>

            {/* Content */}
            {activeTab === 'sounds' ? (
              <>
                <SoundGrid />
                <PlaybackBar />
              </>
            ) : (
              <Navigator isActive={activeTab === 'navigator'} />
            )}
            <BottomBar />
          </main>
        </div>
        <SoundEditor />
      </div>
    </AppProvider>
  );
}
