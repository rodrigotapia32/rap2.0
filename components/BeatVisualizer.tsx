'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { BeatAnalysisResult } from '@/lib/beat-analysis-types';
import styles from './BeatVisualizer.module.css';

interface BeatVisualizerProps {
  spectrogramColumns: Uint8Array[];
  totalColumns: number;
  analysisResult: BeatAnalysisResult | null;
  isAnalyzing: boolean;
  beatAudio: HTMLAudioElement | null;
  isBeatPlaying: boolean;
}

// Color map: dark blue → purple → red → white (256 entries)
const COLOR_MAP = new Uint8Array(256 * 3);
(function buildColorMap() {
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, g: number, b: number;
    if (t < 0.25) {
      // dark blue → blue
      const s = t / 0.25;
      r = 0; g = 0; b = Math.round(40 + s * 120);
    } else if (t < 0.5) {
      // blue → purple
      const s = (t - 0.25) / 0.25;
      r = Math.round(s * 160); g = 0; b = Math.round(160 - s * 20);
    } else if (t < 0.75) {
      // purple → red/orange
      const s = (t - 0.5) / 0.25;
      r = Math.round(160 + s * 95); g = Math.round(s * 80); b = Math.round(140 - s * 140);
    } else {
      // red/orange → white
      const s = (t - 0.75) / 0.25;
      r = Math.round(255); g = Math.round(80 + s * 175); b = Math.round(s * 255);
    }
    COLOR_MAP[i * 3] = r;
    COLOR_MAP[i * 3 + 1] = g;
    COLOR_MAP[i * 3 + 2] = b;
  }
})();

export default function BeatVisualizer({
  spectrogramColumns,
  totalColumns,
  analysisResult,
  isAnalyzing,
  beatAudio,
  isBeatPlaying,
}: BeatVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const drawnColumnsRef = useRef(0);
  const containerWidthRef = useRef(0);

  const CANVAS_HEIGHT = 130;

  // Initialize offscreen canvas
  useEffect(() => {
    if (!offscreenRef.current) {
      offscreenRef.current = document.createElement('canvas');
    }
  }, []);

  // Reset when columns clear (new beat)
  useEffect(() => {
    if (spectrogramColumns.length === 0) {
      drawnColumnsRef.current = 0;
      if (offscreenRef.current) {
        const octx = offscreenRef.current.getContext('2d');
        if (octx) octx.clearRect(0, 0, offscreenRef.current.width, offscreenRef.current.height);
      }
    }
  }, [spectrogramColumns.length === 0]);

  // Draw new spectrogram columns to offscreen canvas
  useEffect(() => {
    const cols = spectrogramColumns;
    if (cols.length === 0) return;
    const offscreen = offscreenRef.current;
    if (!offscreen) return;

    const numBins = cols[0].length;
    const targetWidth = Math.max(cols.length, totalColumns || cols.length);

    // Resize offscreen if needed
    if (offscreen.width !== targetWidth || offscreen.height !== numBins) {
      // Preserve existing content
      const prevData = offscreen.width > 0 && offscreen.height > 0
        ? offscreen.getContext('2d')?.getImageData(0, 0, offscreen.width, offscreen.height)
        : null;
      offscreen.width = targetWidth;
      offscreen.height = numBins;
      if (prevData) {
        offscreen.getContext('2d')?.putImageData(prevData, 0, 0);
      }
    }

    const octx = offscreen.getContext('2d');
    if (!octx) return;

    // Draw only new columns
    const startCol = drawnColumnsRef.current;
    if (startCol >= cols.length) return;

    for (let c = startCol; c < cols.length; c++) {
      const col = cols[c];
      const imgData = octx.createImageData(1, numBins);
      for (let bin = 0; bin < numBins; bin++) {
        // Flip vertically: low freq at bottom
        const srcBin = numBins - 1 - bin;
        const val = col[srcBin];
        const pi = bin * 4;
        imgData.data[pi] = COLOR_MAP[val * 3];
        imgData.data[pi + 1] = COLOR_MAP[val * 3 + 1];
        imgData.data[pi + 2] = COLOR_MAP[val * 3 + 2];
        imgData.data[pi + 3] = 255;
      }
      octx.putImageData(imgData, c, 0);
    }
    drawnColumnsRef.current = cols.length;
  }, [spectrogramColumns, totalColumns]);

  // Container width tracking
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerWidthRef.current = entry.contentRect.width;
        const canvas = canvasRef.current;
        if (canvas && canvas.width !== Math.floor(entry.contentRect.width)) {
          canvas.width = Math.floor(entry.contentRect.width);
          canvas.height = CANVAS_HEIGHT;
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Animation loop
  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const offscreen = offscreenRef.current;
    if (!canvas || !offscreen) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    // Clear
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, w, h);

    // Draw spectrogram from offscreen
    if (offscreen.width > 0 && offscreen.height > 0 && drawnColumnsRef.current > 0) {
      ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, w, h);
    }

    // Leading edge glow during analysis
    if (isAnalyzing && spectrogramColumns.length > 0) {
      const effectiveTotal = totalColumns || spectrogramColumns.length * 2;
      const progressX = (spectrogramColumns.length / effectiveTotal) * w;
      const gradient = ctx.createLinearGradient(progressX - 20, 0, progressX, 0);
      gradient.addColorStop(0, 'rgba(102, 126, 234, 0)');
      gradient.addColorStop(1, 'rgba(102, 126, 234, 0.4)');
      ctx.fillStyle = gradient;
      ctx.fillRect(progressX - 20, 0, 20, h);
    }

    // Overlays (only after analysis complete)
    if (analysisResult) {
      const cols = analysisResult.totalColumns;

      // Laguna zones
      for (const laguna of analysisResult.lagunas) {
        const x1 = (laguna.startColumn / cols) * w;
        const x2 = (laguna.endColumn / cols) * w;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(x1, 0, x2 - x1, h);
        // BREAK label
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        const midX = (x1 + x2) / 2;
        if (x2 - x1 > 30) {
          ctx.fillText('BREAK', midX, h / 2 + 3);
        }
      }

      // Bar markers
      for (const bar of analysisResult.bars) {
        const x = (bar.startColumn / cols) * w;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        // Bar number
        if (bar.index % 2 === 0) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.font = '8px monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`${bar.index + 1}`, x + 2, 10);
        }
      }

      // Beat markers (lighter, thinner)
      for (const beatTime of analysisResult.beats) {
        const beatCol = Math.floor(beatTime / (analysisResult.duration / cols));
        const x = (beatCol / cols) * w;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      // Playhead
      if (beatAudio && (isBeatPlaying || beatAudio.currentTime > 0)) {
        const currentTime = beatAudio.currentTime;
        const duration = analysisResult.duration;
        const playheadX = duration > 0 ? ((currentTime % duration) / duration) * w : 0;

        // Glow
        const glowGrad = ctx.createLinearGradient(playheadX - 4, 0, playheadX + 4, 0);
        glowGrad.addColorStop(0, 'rgba(102, 126, 234, 0)');
        glowGrad.addColorStop(0.5, 'rgba(245, 87, 108, 0.6)');
        glowGrad.addColorStop(1, 'rgba(102, 126, 234, 0)');
        ctx.fillStyle = glowGrad;
        ctx.fillRect(playheadX - 4, 0, 8, h);

        // Line
        ctx.strokeStyle = '#f5576c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, h);
        ctx.stroke();
      }
    }

    animFrameRef.current = requestAnimationFrame(renderFrame);
  }, [isAnalyzing, spectrogramColumns.length, totalColumns, analysisResult, beatAudio, isBeatPlaying]);

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [renderFrame]);

  return (
    <div ref={containerRef} className={styles.visualizerContainer}>
      <canvas ref={canvasRef} className={styles.visualizerCanvas} height={CANVAS_HEIGHT} />
      {analysisResult && (
        <div className={styles.bpmBadge}>{analysisResult.bpm} BPM</div>
      )}
      {isAnalyzing && (
        <div className={styles.analyzingLabel}>Analizando...</div>
      )}
    </div>
  );
}
