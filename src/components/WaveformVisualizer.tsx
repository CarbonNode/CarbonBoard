'use client';

import { useRef, useEffect, useState, useCallback } from 'react';

interface WaveformVisualizerProps {
  audioBuffer: AudioBuffer | null;
  duration: number;
  trimStart: number;
  trimEnd: number;
  onTrimChange: (start: number, end: number) => void;
  playbackPosition?: number | null;
}

export function WaveformVisualizer({
  audioBuffer,
  duration,
  trimStart,
  trimEnd,
  onTrimChange,
  playbackPosition,
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<'start' | 'end' | null>(null);

  // Zoom state: viewStart/viewEnd define the visible time range
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(duration || 1);

  // Reset view when duration changes (new sound loaded)
  useEffect(() => {
    if (duration > 0) {
      setViewStart(0);
      setViewEnd(duration);
    }
  }, [duration]);

  const zoomLevel = duration > 0 ? duration / (viewEnd - viewStart) : 1;

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const width = rect.width;
    const height = rect.height;

    // Clear
    ctx.fillStyle = '#0f3460';
    ctx.fillRect(0, 0, width, height);

    // Get audio data
    const channelData = audioBuffer.getChannelData(0);
    const samples = channelData.length;
    const sampleRate = audioBuffer.sampleRate;

    // Calculate visible sample range based on zoom
    const visibleStartSample = Math.floor((viewStart / duration) * samples);
    const visibleEndSample = Math.ceil((viewEnd / duration) * samples);
    const visibleSamples = visibleEndSample - visibleStartSample;
    const samplesPerPixel = Math.max(1, Math.ceil(visibleSamples / width));

    // Calculate waveform peaks for visible range
    const peaks: number[] = [];
    for (let i = 0; i < width; i++) {
      const start = visibleStartSample + Math.floor(i * samplesPerPixel);
      const end = Math.min(start + samplesPerPixel, samples);

      let max = 0;
      for (let j = start; j < end; j++) {
        if (j >= 0 && j < samples) {
          const abs = Math.abs(channelData[j]);
          if (abs > max) max = abs;
        }
      }
      peaks.push(max);
    }

    // Helper: convert time to x position within the zoomed view
    const timeToX = (time: number) => ((time - viewStart) / (viewEnd - viewStart)) * width;

    const trimStartX = timeToX(trimStart);
    const trimEndX = timeToX(trimEnd);

    // Draw inactive region (before trim start)
    ctx.fillStyle = 'rgba(100, 100, 100, 0.5)';
    for (let i = 0; i < Math.min(width, Math.max(0, trimStartX)); i++) {
      const peakHeight = peaks[Math.floor(i)] * height * 0.8;
      ctx.fillRect(i, (height - peakHeight) / 2, 1, peakHeight);
    }

    // Draw active region
    ctx.fillStyle = '#e94560';
    const activeStart = Math.max(0, Math.floor(trimStartX));
    const activeEnd = Math.min(width, Math.ceil(trimEndX));
    for (let i = activeStart; i < activeEnd; i++) {
      const peakHeight = peaks[Math.floor(i)] * height * 0.8;
      ctx.fillRect(i, (height - peakHeight) / 2, 1, peakHeight);
    }

    // Draw inactive region (after trim end)
    ctx.fillStyle = 'rgba(100, 100, 100, 0.5)';
    for (let i = Math.max(0, Math.floor(trimEndX)); i < width; i++) {
      const peakHeight = peaks[Math.floor(i)] * height * 0.8;
      ctx.fillRect(i, (height - peakHeight) / 2, 1, peakHeight);
    }

    // Draw trim markers (only if visible)
    ctx.fillStyle = '#ffffff';

    if (trimStartX >= 0 && trimStartX <= width) {
      ctx.fillRect(trimStartX - 2, 0, 4, height);
      ctx.beginPath();
      ctx.moveTo(trimStartX, 0);
      ctx.lineTo(trimStartX + 10, 0);
      ctx.lineTo(trimStartX, 10);
      ctx.fill();
    }

    if (trimEndX >= 0 && trimEndX <= width) {
      ctx.fillRect(trimEndX - 2, 0, 4, height);
      ctx.beginPath();
      ctx.moveTo(trimEndX, 0);
      ctx.lineTo(trimEndX - 10, 0);
      ctx.lineTo(trimEndX, 10);
      ctx.fill();
    }

    // Playback position line
    if (playbackPosition != null && playbackPosition >= 0) {
      const posX = timeToX(playbackPosition);
      if (posX >= 0 && posX <= width) {
        ctx.fillStyle = '#00ff88';
        ctx.fillRect(posX - 1, 0, 2, height);
        ctx.beginPath();
        ctx.moveTo(posX - 5, 0);
        ctx.lineTo(posX + 5, 0);
        ctx.lineTo(posX, 7);
        ctx.fill();
      }
    }
  }, [audioBuffer, duration, trimStart, trimEnd, playbackPosition, viewStart, viewEnd]);

  // Scroll to zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (duration === 0 || !containerRef.current) return;
      e.preventDefault();

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseRatio = mouseX / rect.width;

      // Time at cursor position
      const cursorTime = viewStart + mouseRatio * (viewEnd - viewStart);

      const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const currentRange = viewEnd - viewStart;
      let newRange = currentRange * zoomFactor;

      // Clamp: minimum 0.05s visible, maximum full duration
      newRange = Math.max(0.05, Math.min(duration, newRange));

      // Keep cursor at same position on screen
      let newStart = cursorTime - mouseRatio * newRange;
      let newEnd = cursorTime + (1 - mouseRatio) * newRange;

      // Clamp to valid bounds
      if (newStart < 0) {
        newStart = 0;
        newEnd = Math.min(duration, newRange);
      }
      if (newEnd > duration) {
        newEnd = duration;
        newStart = Math.max(0, duration - newRange);
      }

      setViewStart(newStart);
      setViewEnd(newEnd);
    },
    [duration, viewStart, viewEnd]
  );

  // Convert x position to time within the zoomed view
  const xToTime = useCallback(
    (x: number, rectWidth: number) => {
      return viewStart + (x / rectWidth) * (viewEnd - viewStart);
    },
    [viewStart, viewEnd]
  );

  // Handle mouse events
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration === 0) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;

      const trimStartX = ((trimStart - viewStart) / (viewEnd - viewStart)) * rect.width;
      const trimEndX = ((trimEnd - viewStart) / (viewEnd - viewStart)) * rect.width;

      // Check if clicking near a marker (within 10px)
      if (Math.abs(x - trimStartX) < 10) {
        setIsDragging('start');
      } else if (Math.abs(x - trimEndX) < 10) {
        setIsDragging('end');
      }
    },
    [duration, trimStart, trimEnd, viewStart, viewEnd]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current || duration === 0) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const time = xToTime(x, rect.width);

      if (isDragging === 'start') {
        const newStart = Math.min(time, trimEnd - 0.01);
        onTrimChange(Math.max(0, newStart), trimEnd);
      } else {
        const newEnd = Math.max(time, trimStart + 0.01);
        onTrimChange(trimStart, Math.min(duration, newEnd));
      }
    },
    [isDragging, duration, trimStart, trimEnd, onTrimChange, xToTime]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(null);
  }, []);

  // Add global mouse listeners when dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Handle click to set position
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration === 0 || isDragging) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = xToTime(x, rect.width);

      const distToStart = Math.abs(time - trimStart);
      const distToEnd = Math.abs(time - trimEnd);

      if (distToStart < distToEnd) {
        onTrimChange(Math.max(0, Math.min(time, trimEnd - 0.01)), trimEnd);
      } else {
        onTrimChange(trimStart, Math.min(duration, Math.max(time, trimStart + 0.01)));
      }
    },
    [duration, trimStart, trimEnd, onTrimChange, isDragging, xToTime]
  );

  const handleResetZoom = useCallback(() => {
    setViewStart(0);
    setViewEnd(duration);
  }, [duration]);

  const handleZoomToSelection = useCallback(() => {
    const padding = (trimEnd - trimStart) * 0.1;
    setViewStart(Math.max(0, trimStart - padding));
    setViewEnd(Math.min(duration, trimEnd + padding));
  }, [trimStart, trimEnd, duration]);

  return (
    <div>
      <div
        ref={containerRef}
        className="waveform-container cursor-pointer"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onWheel={handleWheel}
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{ display: audioBuffer ? 'block' : 'none' }}
        />
        {!audioBuffer && (
          <div className="absolute inset-0 flex items-center justify-center text-text-secondary">
            Loading waveform...
          </div>
        )}

        {/* Time markers */}
        <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 text-xs text-text-secondary">
          <span>{formatTime(viewStart)}</span>
          <span>{formatTime(viewEnd)}</span>
        </div>
      </div>

      {/* Zoom controls */}
      {audioBuffer && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-text-secondary">
            {zoomLevel > 1.01 ? `${zoomLevel.toFixed(1)}x zoom` : 'Scroll to zoom'}
          </span>
          {zoomLevel > 1.01 && (
            <>
              <button
                onClick={handleZoomToSelection}
                className="text-xs px-2 py-0.5 bg-bg-tertiary hover:bg-accent/20 rounded transition-colors"
              >
                Zoom to selection
              </button>
              <button
                onClick={handleResetZoom}
                className="text-xs px-2 py-0.5 bg-bg-tertiary hover:bg-accent/20 rounded transition-colors"
              >
                Reset zoom
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
