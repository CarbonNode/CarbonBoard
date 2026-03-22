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

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get container dimensions
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
    const samplesPerPixel = Math.ceil(samples / width);

    // Calculate waveform peaks
    const peaks: number[] = [];
    for (let i = 0; i < width; i++) {
      const start = Math.floor(i * samplesPerPixel);
      const end = Math.min(start + samplesPerPixel, samples);

      let max = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks.push(max);
    }

    // Draw inactive region (before trim start)
    const trimStartX = (trimStart / duration) * width;
    ctx.fillStyle = 'rgba(100, 100, 100, 0.5)';
    for (let i = 0; i < trimStartX; i++) {
      const peakHeight = peaks[Math.floor(i)] * height * 0.8;
      ctx.fillRect(i, (height - peakHeight) / 2, 1, peakHeight);
    }

    // Draw active region
    const trimEndX = (trimEnd / duration) * width;
    ctx.fillStyle = '#e94560';
    for (let i = Math.floor(trimStartX); i < trimEndX; i++) {
      const peakHeight = peaks[Math.floor(i)] * height * 0.8;
      ctx.fillRect(i, (height - peakHeight) / 2, 1, peakHeight);
    }

    // Draw inactive region (after trim end)
    ctx.fillStyle = 'rgba(100, 100, 100, 0.5)';
    for (let i = Math.floor(trimEndX); i < width; i++) {
      const peakHeight = peaks[Math.floor(i)] * height * 0.8;
      ctx.fillRect(i, (height - peakHeight) / 2, 1, peakHeight);
    }

    // Draw trim markers
    ctx.fillStyle = '#ffffff';

    // Start marker
    ctx.fillRect(trimStartX - 2, 0, 4, height);
    ctx.beginPath();
    ctx.moveTo(trimStartX, 0);
    ctx.lineTo(trimStartX + 10, 0);
    ctx.lineTo(trimStartX, 10);
    ctx.fill();

    // End marker
    ctx.fillRect(trimEndX - 2, 0, 4, height);
    ctx.beginPath();
    ctx.moveTo(trimEndX, 0);
    ctx.lineTo(trimEndX - 10, 0);
    ctx.lineTo(trimEndX, 10);
    ctx.fill();

    // Playback position line
    if (playbackPosition != null && playbackPosition >= 0) {
      const posX = (playbackPosition / duration) * width;
      ctx.fillStyle = '#00ff88';
      ctx.fillRect(posX - 1, 0, 2, height);
      // Small triangle at top
      ctx.beginPath();
      ctx.moveTo(posX - 5, 0);
      ctx.lineTo(posX + 5, 0);
      ctx.lineTo(posX, 7);
      ctx.fill();
    }
  }, [audioBuffer, duration, trimStart, trimEnd, playbackPosition]);

  // Handle mouse events
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration === 0) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = (x / rect.width) * duration;

      const trimStartX = (trimStart / duration) * rect.width;
      const trimEndX = (trimEnd / duration) * rect.width;

      // Check if clicking near a marker (within 10px)
      if (Math.abs(x - trimStartX) < 10) {
        setIsDragging('start');
      } else if (Math.abs(x - trimEndX) < 10) {
        setIsDragging('end');
      }
    },
    [duration, trimStart, trimEnd]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current || duration === 0) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const time = (x / rect.width) * duration;

      if (isDragging === 'start') {
        // Don't allow start to go past end
        const newStart = Math.min(time, trimEnd - 0.1);
        onTrimChange(Math.max(0, newStart), trimEnd);
      } else {
        // Don't allow end to go before start
        const newEnd = Math.max(time, trimStart + 0.1);
        onTrimChange(trimStart, Math.min(duration, newEnd));
      }
    },
    [isDragging, duration, trimStart, trimEnd, onTrimChange]
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
      const time = (x / rect.width) * duration;

      // Determine if click is closer to start or end
      const distToStart = Math.abs(time - trimStart);
      const distToEnd = Math.abs(time - trimEnd);

      if (distToStart < distToEnd) {
        onTrimChange(Math.max(0, Math.min(time, trimEnd - 0.1)), trimEnd);
      } else {
        onTrimChange(trimStart, Math.min(duration, Math.max(time, trimStart + 0.1)));
      }
    },
    [duration, trimStart, trimEnd, onTrimChange, isDragging]
  );

  return (
    <div
      ref={containerRef}
      className="waveform-container cursor-pointer"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
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
        <span>0:00</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
