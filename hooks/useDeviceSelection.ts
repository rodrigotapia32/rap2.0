import { useState, useEffect, useCallback } from 'react';

const LS_KEY_INPUT = 'rap2-audio-input';
const LS_KEY_OUTPUT = 'rap2-audio-output';

export interface UseDeviceSelectionReturn {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  selectedInputId: string;
  selectedOutputId: string;
  setSelectedInputId: (id: string) => void;
  setSelectedOutputId: (id: string) => void;
  /** Vuelve a listar dispositivos (útil tras conceder permiso de micrófono). */
  refreshDevices: () => Promise<void>;
}

export function useDeviceSelection(): UseDeviceSelectionReturn {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInputId, setSelectedInputIdState] = useState<string>('');
  const [selectedOutputId, setSelectedOutputIdState] = useState<string>('');

  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      setAudioInputs(inputs);
      setAudioOutputs(outputs);

      // Validate stored selections still exist
      setSelectedInputIdState(prev => {
        if (prev && !inputs.some(d => d.deviceId === prev)) return '';
        return prev;
      });
      setSelectedOutputIdState(prev => {
        if (prev && !outputs.some(d => d.deviceId === prev)) return '';
        return prev;
      });
    } catch {
      // Enumeration not available
    }
  }, []);

  // Load from localStorage on mount + enumerate
  useEffect(() => {
    const storedInput = localStorage.getItem(LS_KEY_INPUT) || '';
    const storedOutput = localStorage.getItem(LS_KEY_OUTPUT) || '';
    setSelectedInputIdState(storedInput);
    setSelectedOutputIdState(storedOutput);

    enumerateDevices();

    navigator.mediaDevices.addEventListener('devicechange', enumerateDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', enumerateDevices);
    };
  }, [enumerateDevices]);

  const setSelectedInputId = useCallback((id: string) => {
    setSelectedInputIdState(id);
    localStorage.setItem(LS_KEY_INPUT, id);
  }, []);

  const setSelectedOutputId = useCallback((id: string) => {
    setSelectedOutputIdState(id);
    localStorage.setItem(LS_KEY_OUTPUT, id);
  }, []);

  return {
    audioInputs,
    audioOutputs,
    selectedInputId,
    selectedOutputId,
    setSelectedInputId,
    setSelectedOutputId,
    refreshDevices: enumerateDevices,
  };
}
