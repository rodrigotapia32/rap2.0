import {
  FFT_SIZE, HOP_SIZE, BATCH_SIZE, BPM_MIN, BPM_MAX,
  BEATS_PER_BAR, LAGUNA_THRESHOLD,
  type AnalyzeMessage, type Bar, type LagunaZone, type BeatAnalysisResult,
} from '../lib/beat-analysis-types';
import {
  fft, createHanningWindow, magnitudeSpectrum,
  rms, spectralFlux, detectBPM, buildBeatGrid,
} from '../lib/dsp';

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<AnalyzeMessage>) => {
  if (e.data.type !== 'analyze') return;
  try {
    analyze(e.data.samples, e.data.sampleRate);
  } catch (err: any) {
    ctx.postMessage({ type: 'analysis-error', error: err.message || 'Unknown error' });
  }
};

function analyze(samples: Float32Array, sampleRate: number): void {
  const bins = FFT_SIZE / 2;
  const totalFrames = Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1;
  if (totalFrames <= 0) {
    ctx.postMessage({ type: 'analysis-error', error: 'Audio too short for analysis' });
    return;
  }

  const duration = samples.length / sampleRate;
  const window = createHanningWindow(FFT_SIZE);

  // Allocations
  const energyEnvelope = new Float32Array(totalFrames);
  const allColumns: Uint8Array[] = [];
  const fluxValues: number[] = [];
  let prevMag: Uint8Array | null = null;
  let batchBuffer: Uint8Array[] = [];
  let lastProgress = -1;

  // ─── Phase 1: Spectrogram + Energy + Onsets ───
  ctx.postMessage({ type: 'progress', phase: 'Spectrogram', percent: 0 });

  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);

  for (let frame = 0; frame < totalFrames; frame++) {
    const offset = frame * HOP_SIZE;

    // Apply window and copy to FFT buffers
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = (samples[offset + i] || 0) * window[i];
      imag[i] = 0;
    }

    fft(real, imag);
    const mag = magnitudeSpectrum(real, imag, bins);
    allColumns.push(mag);

    // Energy (RMS)
    energyEnvelope[frame] = rms(samples, offset, FFT_SIZE);

    // Spectral flux
    if (prevMag) {
      fluxValues.push(spectralFlux(prevMag, mag));
    } else {
      fluxValues.push(0);
    }
    prevMag = mag;

    // Batch spectrogram columns
    batchBuffer.push(mag);
    if (batchBuffer.length >= BATCH_SIZE) {
      ctx.postMessage({
        type: 'spectrogram-batch',
        columns: batchBuffer,
        startIndex: frame - batchBuffer.length + 1,
      });
      batchBuffer = [];
    }

    // Progress (every 10%)
    const pct = Math.floor((frame / totalFrames) * 100);
    if (pct >= lastProgress + 10) {
      lastProgress = pct;
      ctx.postMessage({ type: 'progress', phase: 'Spectrogram', percent: pct });
    }
  }

  // Flush remaining batch
  if (batchBuffer.length > 0) {
    ctx.postMessage({
      type: 'spectrogram-batch',
      columns: batchBuffer,
      startIndex: totalFrames - batchBuffer.length,
    });
  }

  ctx.postMessage({ type: 'progress', phase: 'Spectrogram', percent: 100 });

  // ─── Phase 2: BPM Detection ───
  ctx.postMessage({ type: 'progress', phase: 'BPM', percent: 0 });
  const bpm = detectBPM(energyEnvelope, HOP_SIZE, sampleRate, BPM_MIN, BPM_MAX);
  ctx.postMessage({ type: 'progress', phase: 'BPM', percent: 100 });

  // ─── Phase 3: Beat Grid + Bars ───
  ctx.postMessage({ type: 'progress', phase: 'Beats', percent: 0 });

  // Peak-pick onsets: adaptive threshold (median + 1.5x MAD)
  const sortedFlux = [...fluxValues].sort((a, b) => a - b);
  const median = sortedFlux[Math.floor(sortedFlux.length / 2)];
  let madSum = 0;
  for (const v of fluxValues) madSum += Math.abs(v - median);
  const mad = madSum / fluxValues.length;
  const threshold = median + 1.5 * mad;

  const onsetTimes: number[] = [];
  for (let i = 1; i < fluxValues.length - 1; i++) {
    if (fluxValues[i] > threshold && fluxValues[i] > fluxValues[i - 1] && fluxValues[i] > fluxValues[i + 1]) {
      onsetTimes.push((i * HOP_SIZE) / sampleRate);
    }
  }

  const beats = buildBeatGrid(bpm, onsetTimes, duration);

  // Group into bars
  const bars: Bar[] = [];
  const frameDuration = HOP_SIZE / sampleRate;
  for (let i = 0; i < beats.length; i += BEATS_PER_BAR) {
    const startTime = beats[i];
    const endIdx = Math.min(i + BEATS_PER_BAR, beats.length) - 1;
    const endTime = i + BEATS_PER_BAR < beats.length
      ? beats[i + BEATS_PER_BAR]
      : Math.min(beats[endIdx] + 60 / bpm, duration);
    bars.push({
      index: bars.length,
      startTime,
      endTime,
      startColumn: Math.floor(startTime / frameDuration),
      endColumn: Math.min(Math.floor(endTime / frameDuration), totalFrames - 1),
      isLaguna: false,
    });
  }

  ctx.postMessage({ type: 'progress', phase: 'Beats', percent: 100 });

  // ─── Phase 4: Laguna Detection ───
  ctx.postMessage({ type: 'progress', phase: 'Lagunas', percent: 0 });

  // Global mean energy
  let globalEnergy = 0;
  for (let i = 0; i < energyEnvelope.length; i++) globalEnergy += energyEnvelope[i];
  globalEnergy /= energyEnvelope.length;

  const lagunas: LagunaZone[] = [];
  for (const bar of bars) {
    const startCol = Math.max(0, bar.startColumn);
    const endCol = Math.min(bar.endColumn, totalFrames - 1);
    let barEnergy = 0;
    let count = 0;
    for (let c = startCol; c <= endCol; c++) {
      barEnergy += energyEnvelope[c];
      count++;
    }
    const avgEnergy = count > 0 ? barEnergy / count : 0;
    if (avgEnergy < LAGUNA_THRESHOLD * globalEnergy) {
      bar.isLaguna = true;
      lagunas.push({
        barIndex: bar.index,
        startTime: bar.startTime,
        endTime: bar.endTime,
        startColumn: bar.startColumn,
        endColumn: bar.endColumn,
        avgEnergy,
      });
    }
  }

  ctx.postMessage({ type: 'progress', phase: 'Lagunas', percent: 100 });

  // ─── Complete ───
  const result: BeatAnalysisResult = {
    bpm,
    beats,
    bars,
    lagunas,
    energyEnvelope,
    spectrogramColumns: allColumns,
    totalColumns: totalFrames,
    sampleRate,
    duration,
  };

  ctx.postMessage({ type: 'analysis-complete', result });
}
