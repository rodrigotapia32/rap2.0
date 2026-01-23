/**
 * Hook para controlar volúmenes usando Web Audio API
 * Permite ajustar volumen del beat, micrófono propio y audio del oponente
 */

import { useEffect, useRef, useState } from 'react';

interface UseAudioControlsOptions {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  beatAudio: HTMLAudioElement | null;
}

export function useAudioControls({
  localStream,
  remoteStream,
  beatAudio,
}: UseAudioControlsOptions) {
  const [beatVolume, setBeatVolume] = useState(0.5);
  const [micVolume, setMicVolume] = useState(1.0);
  const [remoteVolume, setRemoteVolume] = useState(1.0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const remoteGainNodeRef = useRef<GainNode | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const remoteSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  /**
   * Inicializa el AudioContext y los nodos de ganancia
   */
  useEffect(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      // En móvil, el AudioContext puede estar suspendido y necesita activación
      if (audioContextRef.current.state === 'suspended') {
        console.log('🔵 AudioContext suspendido, se activará con interacción del usuario');
      }
    }

    const audioContext = audioContextRef.current;

    // Crear nodos de ganancia
    if (!gainNodeRef.current) {
      gainNodeRef.current = audioContext.createGain();
      gainNodeRef.current.connect(audioContext.destination);
    }

    if (!remoteGainNodeRef.current) {
      remoteGainNodeRef.current = audioContext.createGain();
      remoteGainNodeRef.current.connect(audioContext.destination);
    }

    if (!micGainNodeRef.current) {
      micGainNodeRef.current = audioContext.createGain();
      micGainNodeRef.current.connect(audioContext.destination);
    }

    return () => {
      // Limpiar al desmontar
      if (remoteSourceRef.current) {
        remoteSourceRef.current.disconnect();
        remoteSourceRef.current = null;
      }
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }
    };
  }, []);

  /**
   * Controla el volumen del beat
   */
  useEffect(() => {
    if (beatAudio) {
      beatAudio.volume = beatVolume;
    }
  }, [beatAudio, beatVolume]);

  /**
   * Controla el volumen del micrófono propio
   */
  useEffect(() => {
    if (micGainNodeRef.current) {
      micGainNodeRef.current.gain.value = micVolume;
    }
  }, [micVolume]);

  /**
   * Controla el volumen del audio remoto (oponente)
   */
  useEffect(() => {
    if (remoteGainNodeRef.current) {
      remoteGainNodeRef.current.gain.value = remoteVolume;
    }
  }, [remoteVolume]);

  /**
   * Conecta el stream remoto al AudioContext
   */
  useEffect(() => {
    if (remoteStream && audioContextRef.current && remoteGainNodeRef.current) {
      // Limpiar fuente anterior si existe
      if (remoteSourceRef.current) {
        remoteSourceRef.current.disconnect();
      }

      const source = audioContextRef.current.createMediaStreamSource(remoteStream);
      source.connect(remoteGainNodeRef.current);
      remoteSourceRef.current = source;
    }

    return () => {
      if (remoteSourceRef.current) {
        remoteSourceRef.current.disconnect();
        remoteSourceRef.current = null;
      }
    };
  }, [remoteStream]);

  /**
   * Conecta el stream local al AudioContext (para monitoreo)
   */
  useEffect(() => {
    if (localStream && audioContextRef.current && micGainNodeRef.current) {
      // Limpiar fuente anterior si existe
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
      }

      const source = audioContextRef.current.createMediaStreamSource(localStream);
      source.connect(micGainNodeRef.current);
      micSourceRef.current = source;
    }

    return () => {
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }
    };
  }, [localStream]);

  return {
    beatVolume,
    setBeatVolume,
    micVolume,
    setMicVolume,
    remoteVolume,
    setRemoteVolume,
  };
}
