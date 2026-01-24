import { useEffect, useRef, useState, useCallback } from 'react';
import type { BeatAnalysisResult, WorkerOutMessage } from '@/lib/beat-analysis-types';

interface UseBeatAnalysisProps {
  beatUrl: string;
}

interface UseBeatAnalysisReturn {
  analysisResult: BeatAnalysisResult | null;
  spectrogramColumns: Uint8Array[];
  totalColumns: number;
  isAnalyzing: boolean;
  progress: { phase: string; percent: number };
  error: string | null;
}

export function useBeatAnalysis({ beatUrl }: UseBeatAnalysisProps): UseBeatAnalysisReturn {
  const [analysisResult, setAnalysisResult] = useState<BeatAnalysisResult | null>(null);
  const [spectrogramColumns, setSpectrogramColumns] = useState<Uint8Array[]>([]);
  const [totalColumns, setTotalColumns] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; percent: number }>({ phase: '', percent: 0 });
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const columnsRef = useRef<Uint8Array[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushColumns = useCallback(() => {
    setSpectrogramColumns([...columnsRef.current]);
  }, []);

  useEffect(() => {
    // Reset state
    setAnalysisResult(null);
    setSpectrogramColumns([]);
    setTotalColumns(0);
    setIsAnalyzing(true);
    setProgress({ phase: 'Loading', percent: 0 });
    setError(null);
    columnsRef.current = [];

    // Terminate previous worker
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    let cancelled = false;

    (async () => {
      try {
        // Fetch and decode audio
        const response = await fetch(beatUrl);
        if (!response.ok) throw new Error(`Failed to fetch beat: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        if (cancelled) return;

        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        await audioCtx.close();

        if (cancelled) return;

        // Extract mono channel
        const channelData = audioBuffer.getChannelData(0);
        const samples = new Float32Array(channelData.length);
        samples.set(channelData);

        // Spawn worker
        const worker = new Worker(
          new URL('../workers/beat-analyzer.worker.ts', import.meta.url)
        );
        workerRef.current = worker;

        worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
          if (cancelled) return;

          switch (e.data.type) {
            case 'spectrogram-batch': {
              columnsRef.current.push(...e.data.columns);
              // Throttle state updates to ~15fps
              if (!flushTimerRef.current) {
                flushTimerRef.current = setTimeout(() => {
                  flushTimerRef.current = null;
                  if (!cancelled) flushColumns();
                }, 66);
              }
              break;
            }
            case 'progress':
              setProgress({ phase: e.data.phase, percent: e.data.percent });
              break;
            case 'analysis-complete': {
              const result = e.data.result;
              setTotalColumns(result.totalColumns);
              setAnalysisResult(result);
              // Final flush with all columns
              columnsRef.current = result.spectrogramColumns;
              setSpectrogramColumns(result.spectrogramColumns);
              setIsAnalyzing(false);
              setProgress({ phase: 'Done', percent: 100 });
              break;
            }
            case 'analysis-error':
              setError(e.data.error);
              setIsAnalyzing(false);
              break;
          }
        };

        worker.onerror = (err) => {
          if (!cancelled) {
            setError(err.message || 'Worker error');
            setIsAnalyzing(false);
          }
        };

        // Post with transferable
        worker.postMessage(
          { type: 'analyze', samples, sampleRate: audioBuffer.sampleRate },
          [samples.buffer]
        );
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Analysis failed');
          setIsAnalyzing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [beatUrl, flushColumns]);

  return { analysisResult, spectrogramColumns, totalColumns, isAnalyzing, progress, error };
}
