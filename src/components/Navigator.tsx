'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';

// Webview type for Electron
interface WebviewElement extends HTMLElement {
  src: string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  getURL: () => string;
  getTitle: () => string;
  isLoading: () => boolean;
  executeJavaScript: (code: string) => Promise<unknown>;
  setAudioMuted: (muted: boolean) => void;
  isAudioMuted: () => boolean;
  addEventListener: (event: string, callback: (e: unknown) => void) => void;
  removeEventListener: (event: string, callback: (e: unknown) => void) => void;
}

interface NavigatorProps {
  isActive: boolean;
}

export function Navigator({ isActive }: NavigatorProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [url, setUrl] = useState('https://www.youtube.com');
  const [inputUrl, setInputUrl] = useState('https://www.youtube.com');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  // Monitor refs - for hearing CABLE output locally
  const monitorStreamRef = useRef<MediaStream | null>(null);
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null);

  // Navigate to URL
  const navigateTo = useCallback((targetUrl: string) => {
    let finalUrl = targetUrl.trim();
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      // Check if it looks like a domain
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = 'https://' + finalUrl;
      } else {
        // Search on YouTube
        finalUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(finalUrl)}`;
      }
    }
    setUrl(finalUrl);
    setInputUrl(finalUrl);
  }, []);

  // Handle URL input
  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateTo(inputUrl);
  };

  // Update webview event handlers
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDidStartLoading = () => setIsLoading(true);
    const handleDidStopLoading = () => {
      setIsLoading(false);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    const handleDidNavigate = (e: { url: string }) => {
      setInputUrl(e.url);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    const handleDidFailLoad = (e: { errorDescription: string }) => {
      console.error('Webview failed to load:', e.errorDescription);
      setIsLoading(false);
    };

    webview.addEventListener('did-start-loading', handleDidStartLoading);
    webview.addEventListener('did-stop-loading', handleDidStopLoading);
    webview.addEventListener('did-navigate', handleDidNavigate as (e: unknown) => void);
    webview.addEventListener('did-navigate-in-page', handleDidNavigate as (e: unknown) => void);
    webview.addEventListener('did-fail-load', handleDidFailLoad as (e: unknown) => void);

    return () => {
      webview.removeEventListener('did-start-loading', handleDidStartLoading);
      webview.removeEventListener('did-stop-loading', handleDidStopLoading);
      webview.removeEventListener('did-navigate', handleDidNavigate as (e: unknown) => void);
      webview.removeEventListener('did-navigate-in-page', handleDidNavigate as (e: unknown) => void);
      webview.removeEventListener('did-fail-load', handleDidFailLoad as (e: unknown) => void);
    };
  }, []);

  // Start monitoring CABLE Output so user can hear locally
  const startMonitoring = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cableOutput = devices.find(d =>
        d.kind === 'audioinput' &&
        (d.label.toLowerCase().includes('cable output') || d.label.toLowerCase().includes('cable-output'))
      );

      if (!cableOutput) {
        console.log('CABLE Output not found for monitoring');
        return;
      }

      console.log('Found CABLE Output for monitoring:', cableOutput.label);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: cableOutput.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
      monitorStreamRef.current = stream;

      const audio = new Audio();
      audio.srcObject = stream;
      monitorAudioRef.current = audio;
      await audio.play();
      console.log('CABLE monitoring started');
    } catch (error) {
      console.error('Failed to start CABLE monitoring:', error);
    }
  }, []);

  // Stop monitoring CABLE Output
  const stopMonitoring = useCallback(() => {
    if (monitorAudioRef.current) {
      monitorAudioRef.current.pause();
      monitorAudioRef.current.srcObject = null;
      monitorAudioRef.current = null;
    }

    if (monitorStreamRef.current) {
      monitorStreamRef.current.getTracks().forEach(track => track.stop());
      monitorStreamRef.current = null;
    }

    console.log('CABLE monitoring stopped');
  }, []);

  // Toggle streaming - redirect video audio to CABLE
  const toggleStreaming = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (!isStreaming) {
      const script = `
        (async function() {
          // Clean up previous observer/interval if any
          if (window.__audioRedirectObserver) {
            window.__audioRedirectObserver.disconnect();
          }
          if (window.__audioRedirectInterval) {
            clearInterval(window.__audioRedirectInterval);
          }

          // Find CABLE Input device by name
          let cableDeviceId = null;
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cableDevice = devices.find(d =>
              d.kind === 'audiooutput' &&
              (d.label.toLowerCase().includes('cable input') || d.label.toLowerCase().includes('cable-input'))
            );
            if (cableDevice) {
              cableDeviceId = cableDevice.deviceId;
              console.log('Found CABLE device:', cableDevice.label, cableDeviceId);
            } else {
              console.log('Available audio outputs:', devices.filter(d => d.kind === 'audiooutput').map(d => d.label));
              console.log('CABLE Input not found');
            }
          } catch(e) {
            console.error('Failed to enumerate devices:', e);
          }

          window.__audioRedirectActive = true;

          const redirectAudio = async (el) => {
            if (!window.__audioRedirectActive) return;
            if (!el || el.__sinkSet || !cableDeviceId) return;
            try {
              if (el.setSinkId) {
                await el.setSinkId(cableDeviceId);
                el.__sinkSet = true;
                console.log('Audio redirected to CABLE');
              }
            } catch(e) {
              console.log('setSinkId failed:', e.message);
            }
          };

          document.querySelectorAll('video, audio').forEach(redirectAudio);

          window.__audioRedirectObserver = new MutationObserver((mutations) => {
            if (!window.__audioRedirectActive) return;
            mutations.forEach(m => {
              m.addedNodes.forEach(node => {
                if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO') {
                  redirectAudio(node);
                }
                if (node.querySelectorAll) {
                  node.querySelectorAll('video, audio').forEach(redirectAudio);
                }
              });
            });
          });
          window.__audioRedirectObserver.observe(document.body, { childList: true, subtree: true });

          window.__audioRedirectInterval = setInterval(() => {
            if (!window.__audioRedirectActive) return;
            document.querySelectorAll('video, audio').forEach(redirectAudio);
          }, 1000);

          console.log('Audio redirect enabled');
        })();
      `;

      webview.executeJavaScript(script).catch(console.error);
      startMonitoring();
      setIsStreaming(true);
    } else {
      stopMonitoring();
      const stopScript = `
        (function() {
          // Stop the observer and interval first
          window.__audioRedirectActive = false;

          if (window.__audioRedirectObserver) {
            window.__audioRedirectObserver.disconnect();
            window.__audioRedirectObserver = null;
          }
          if (window.__audioRedirectInterval) {
            clearInterval(window.__audioRedirectInterval);
            window.__audioRedirectInterval = null;
          }

          // Reset all audio elements to default output
          document.querySelectorAll('video, audio').forEach(el => {
            if (el.setSinkId) {
              el.setSinkId('').catch(() => {});
              el.__sinkSet = false;
            }
          });
          console.log('Audio redirect disabled');
        })();
      `;

      webview.executeJavaScript(stopScript).catch(console.error);
      setIsStreaming(false);
    }
  }, [isStreaming, startMonitoring, stopMonitoring]);

  // YouTube adblocker script
  const injectAdBlocker = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const adBlockScript = `
      (function() {
        // Skip video ads
        const skipAd = () => {
          // Click skip button if available
          const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
          if (skipBtn) {
            skipBtn.click();
            return;
          }

          // Fast-forward unskippable ads
          const video = document.querySelector('video');
          const adOverlay = document.querySelector('.ad-showing, .ytp-ad-player-overlay');
          if (video && adOverlay) {
            video.currentTime = video.duration || 999;
            video.playbackRate = 16;
          }
        };

        // Remove ad containers
        const removeAds = () => {
          const adSelectors = [
            'ytd-ad-slot-renderer',
            'ytd-banner-promo-renderer',
            'ytd-statement-banner-renderer',
            'ytd-in-feed-ad-layout-renderer',
            'ytd-display-ad-renderer',
            'ytd-promoted-sparkles-web-renderer',
            'ytd-player-legacy-desktop-watch-ads-renderer',
            '.ytd-merch-shelf-renderer',
            'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
            '#masthead-ad',
            '#player-ads',
            '.ytp-ad-module',
            '.ytp-ad-overlay-slot',
            '.ytp-ad-text-overlay'
          ];

          adSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => el.remove());
          });
        };

        // Run periodically
        setInterval(skipAd, 500);
        setInterval(removeAds, 1000);

        // Also run on mutations
        const observer = new MutationObserver(() => {
          skipAd();
          removeAds();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        console.log('YouTube AdBlocker active');
      })();
    `;

    webview.executeJavaScript(adBlockScript).catch(() => {});
  }, []);

  // Inject adblocker when YouTube loads
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDomReady = () => {
      const currentUrl = webview.getURL();
      if (currentUrl.includes('youtube.com')) {
        injectAdBlocker();
      }
    };

    webview.addEventListener('dom-ready', handleDomReady);
    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
    };
  }, [injectAdBlocker]);

  if (!isActive) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
      {/* Navigation Bar */}
      <div className="flex items-center gap-2 p-2 bg-bg-secondary border-b border-border">
        {/* Navigation Buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => webviewRef.current?.goBack()}
            disabled={!canGoBack}
            className="p-1.5 rounded hover:bg-bg-tertiary disabled:opacity-30 disabled:cursor-not-allowed"
            title="Go Back"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={() => webviewRef.current?.goForward()}
            disabled={!canGoForward}
            className="p-1.5 rounded hover:bg-bg-tertiary disabled:opacity-30 disabled:cursor-not-allowed"
            title="Go Forward"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={() => isLoading ? webviewRef.current?.stop() : webviewRef.current?.reload()}
            className="p-1.5 rounded hover:bg-bg-tertiary"
            title={isLoading ? 'Stop' : 'Reload'}
          >
            {isLoading ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
          </button>
        </div>

        {/* URL Bar */}
        <form onSubmit={handleUrlSubmit} className="flex-1">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="Enter URL or search YouTube..."
            className="w-full px-3 py-1.5 rounded bg-bg-primary border border-border text-sm focus:outline-none focus:border-accent"
          />
        </form>

        {/* Quick Links */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigateTo('https://www.youtube.com')}
            className="px-2 py-1.5 rounded text-xs hover:bg-bg-tertiary"
            title="YouTube"
          >
            YT
          </button>
          <button
            onClick={() => navigateTo('https://www.twitch.tv')}
            className="px-2 py-1.5 rounded text-xs hover:bg-bg-tertiary"
            title="Twitch"
          >
            TTV
          </button>
          <button
            onClick={() => navigateTo('https://soundcloud.com')}
            className="px-2 py-1.5 rounded text-xs hover:bg-bg-tertiary"
            title="SoundCloud"
          >
            SC
          </button>
        </div>

        {/* Stream to Soundboard Toggle */}
        <div className="flex items-center gap-2 ml-2 pl-2 border-l border-border">
          <button
            onClick={toggleStreaming}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              isStreaming
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'bg-accent/20 text-accent hover:bg-accent/30'
            }`}
            title={isStreaming ? 'Stop streaming to soundboard' : 'Stream audio to soundboard (CABLE)'}
          >
            {isStreaming ? (
              <>
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                LIVE
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
                Stream
              </>
            )}
          </button>
        </div>
      </div>

      {/* Webview Container */}
      <div className="flex-1 relative">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {React.createElement('webview', {
          ref: webviewRef,
          src: url,
          className: 'absolute inset-0 w-full h-full',
          partition: 'persist:navigator',
          allowpopups: 'true',
          webpreferences: 'autoplayPolicy=no-user-gesture-required'
        } as any)}

        {/* Loading Overlay */}
        {isLoading && (
          <div className="absolute top-0 left-0 right-0 h-1 bg-bg-tertiary overflow-hidden">
            <div className="h-full bg-accent animate-loading-bar" />
          </div>
        )}
      </div>
    </div>
  );
}
