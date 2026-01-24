// ─── Constants ───
export const FFT_SIZE = 2048;
export const HOP_SIZE = 512;
export const BATCH_SIZE = 64;
export const BPM_MIN = 60;
export const BPM_MAX = 180;
export const BEATS_PER_BAR = 4;
export const LAGUNA_THRESHOLD = 0.15;

// ─── Result Types ───
export interface BeatAnalysisResult {
  bpm: number;
  beats: number[];
  bars: Bar[];
  lagunas: LagunaZone[];
  energyEnvelope: Float32Array;
  spectrogramColumns: Uint8Array[];
  totalColumns: number;
  sampleRate: number;
  duration: number;
}

export interface Bar {
  index: number;
  startTime: number;
  endTime: number;
  startColumn: number;
  endColumn: number;
  isLaguna: boolean;
}

export interface LagunaZone {
  barIndex: number;
  startTime: number;
  endTime: number;
  startColumn: number;
  endColumn: number;
  avgEnergy: number;
}

// ─── Worker Messages ───
export interface AnalyzeMessage {
  type: 'analyze';
  samples: Float32Array;
  sampleRate: number;
}

export interface SpectrogramBatchMessage {
  type: 'spectrogram-batch';
  columns: Uint8Array[];
  startIndex: number;
}

export interface ProgressMessage {
  type: 'progress';
  phase: string;
  percent: number;
}

export interface AnalysisCompleteMessage {
  type: 'analysis-complete';
  result: BeatAnalysisResult;
}

export interface AnalysisErrorMessage {
  type: 'analysis-error';
  error: string;
}

export type WorkerOutMessage =
  | SpectrogramBatchMessage
  | ProgressMessage
  | AnalysisCompleteMessage
  | AnalysisErrorMessage;
