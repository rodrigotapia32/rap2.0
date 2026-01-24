/**
 * Pure TypeScript DSP utilities for beat analysis.
 * No external dependencies.
 */

/**
 * Radix-2 Cooley-Tukey FFT, in-place, iterative.
 * @param real - Real part (modified in place)
 * @param imag - Imaginary part (modified in place)
 */
export function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n <= 1) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const angleStep = -2 * Math.PI / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < halfSize; k++) {
        const angle = angleStep * k;
        const twiddleRe = Math.cos(angle);
        const twiddleIm = Math.sin(angle);
        const evenIdx = i + k;
        const oddIdx = i + k + halfSize;
        const tRe = twiddleRe * real[oddIdx] - twiddleIm * imag[oddIdx];
        const tIm = twiddleRe * imag[oddIdx] + twiddleIm * real[oddIdx];
        real[oddIdx] = real[evenIdx] - tRe;
        imag[oddIdx] = imag[evenIdx] - tIm;
        real[evenIdx] += tRe;
        imag[evenIdx] += tIm;
      }
    }
  }
}

/**
 * Create a Hanning window of given size.
 */
export function createHanningWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

/**
 * Compute magnitude spectrum from FFT output.
 * Returns log-scale dB values normalized to 0-255, range -80dB to 0dB.
 * Only returns the first `bins` values (positive frequencies).
 */
export function magnitudeSpectrum(real: Float64Array, imag: Float64Array, bins: number): Uint8Array {
  const result = new Uint8Array(bins);
  const minDb = -80;
  const rangeDb = -minDb; // 80

  for (let i = 0; i < bins; i++) {
    const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    let db = mag > 0 ? 20 * Math.log10(mag) : minDb;
    if (db < minDb) db = minDb;
    if (db > 0) db = 0;
    result[i] = Math.round(((db - minDb) / rangeDb) * 255);
  }
  return result;
}

/**
 * Compute RMS energy of a segment.
 */
export function rms(samples: Float32Array, start: number, length: number): number {
  let sum = 0;
  const end = Math.min(start + length, samples.length);
  for (let i = start; i < end; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / (end - start));
}

/**
 * Spectral flux: half-wave rectified difference between consecutive magnitude spectra.
 */
export function spectralFlux(prevMag: Uint8Array, curMag: Uint8Array): number {
  let flux = 0;
  const len = Math.min(prevMag.length, curMag.length);
  for (let i = 0; i < len; i++) {
    const diff = curMag[i] - prevMag[i];
    if (diff > 0) flux += diff;
  }
  return flux;
}

/**
 * Detect BPM using autocorrelation of the energy envelope.
 * Uses parabolic interpolation around the peak for sub-sample accuracy.
 */
export function detectBPM(
  energyEnvelope: Float32Array,
  hopSize: number,
  sampleRate: number,
  minBPM: number,
  maxBPM: number
): number {
  const n = energyEnvelope.length;
  if (n < 2) return 120;

  // Mean-subtract the envelope
  let mean = 0;
  for (let i = 0; i < n; i++) mean += energyEnvelope[i];
  mean /= n;

  const centered = new Float32Array(n);
  for (let i = 0; i < n; i++) centered[i] = energyEnvelope[i] - mean;

  // Autocorrelation lag range
  const frameDuration = hopSize / sampleRate; // seconds per frame
  const minLag = Math.floor(60 / (maxBPM * frameDuration));
  const maxLag = Math.ceil(60 / (minBPM * frameDuration));
  const safeLag = Math.min(maxLag, n - 1);

  let bestLag = minLag;
  let bestVal = -Infinity;

  for (let lag = minLag; lag <= safeLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += centered[i] * centered[i + lag];
    }
    if (sum > bestVal) {
      bestVal = sum;
      bestLag = lag;
    }
  }

  // Parabolic interpolation around peak
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < safeLag) {
    let prev = 0, next = 0;
    for (let i = 0; i < n - (bestLag - 1); i++) prev += centered[i] * centered[i + bestLag - 1];
    for (let i = 0; i < n - (bestLag + 1); i++) next += centered[i] * centered[i + bestLag + 1];
    const denom = 2 * (2 * bestVal - prev - next);
    if (denom !== 0) {
      refinedLag = bestLag + (prev - next) / denom;
    }
  }

  let bpm = 60 / (refinedLag * frameDuration);

  // Sub-harmonic correction
  if (bpm < 70) bpm *= 2;
  if (bpm > 170) bpm /= 2;

  return Math.round(bpm * 10) / 10;
}

/**
 * Build a beat grid aligned to the strongest onset.
 * @param bpm - Detected BPM
 * @param onsetTimes - Detected onset timestamps (seconds)
 * @param duration - Total duration in seconds
 */
export function buildBeatGrid(bpm: number, onsetTimes: number[], duration: number): number[] {
  const beatInterval = 60 / bpm;

  // Find phase alignment: use the strongest onset (first one if tie)
  let phase = 0;
  if (onsetTimes.length > 0) {
    // Find onset closest to a beat grid position starting from 0
    let bestOffset = 0;
    let bestScore = Infinity;
    for (const onset of onsetTimes.slice(0, 20)) {
      const offset = onset % beatInterval;
      const dist = Math.min(offset, beatInterval - offset);
      if (dist < bestScore) {
        bestScore = dist;
        bestOffset = offset;
      }
    }
    phase = bestOffset;
  }

  // Generate grid
  const beats: number[] = [];
  let t = phase;
  while (t < duration) {
    beats.push(Math.round(t * 1000) / 1000);
    t += beatInterval;
  }

  return beats;
}
