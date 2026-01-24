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
    }

    const audioContext = audioContextRef.current;

    // Activar AudioContext si está suspendido
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch((error) => {
        console.error('❌ Error activando AudioContext:', error);
      });
    }

    // Crear nodos de ganancia
    if (!gainNodeRef.current) {
      gainNodeRef.current = audioContext.createGain();
      gainNodeRef.current.connect(audioContext.destination);
    }

    if (!remoteGainNodeRef.current) {
      remoteGainNodeRef.current = audioContext.createGain();
      remoteGainNodeRef.current.gain.value = 1.0;
      remoteGainNodeRef.current.connect(audioContext.destination);
    } else {
      // Verificar que esté conectado si ya existe
      if (remoteGainNodeRef.current.numberOfOutputs === 0) {
        remoteGainNodeRef.current.connect(audioContext.destination);
      }
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
      const connectStream = async () => {
        try {
          // Asegurarse de que el AudioContext esté activo
          if (audioContextRef.current!.state === 'suspended') {
            try {
              await audioContextRef.current!.resume();
            } catch (error) {
              console.error('❌ Error activando AudioContext:', error);
            }
          }

          // Limpiar fuente anterior si existe
          if (remoteSourceRef.current) {
            remoteSourceRef.current.disconnect();
            remoteSourceRef.current = null;
          }

          // Verificar que el stream tenga tracks de audio
          const audioTracks = remoteStream.getAudioTracks();
          if (audioTracks.length === 0) {
            return;
          }

          const enabledTracks = audioTracks.filter(t => t.enabled && !t.muted);
          if (enabledTracks.length === 0) {
            return;
          }

          // Verificar que el AudioContext esté en estado 'running'
          if (audioContextRef.current!.state !== 'running') {
            await audioContextRef.current!.resume();
          }

          // Asegurarse de que el remoteGainNode esté conectado
          if (remoteGainNodeRef.current!.numberOfOutputs === 0) {
            try {
              remoteGainNodeRef.current!.disconnect();
            } catch (e) {
              // Ignorar error si no estaba conectado
            }
            remoteGainNodeRef.current!.connect(audioContextRef.current!.destination);
          }

          const source = audioContextRef.current!.createMediaStreamSource(remoteStream);
          source.connect(remoteGainNodeRef.current!);
          remoteSourceRef.current = source;
          console.log('✅ Stream remoto conectado al AudioContext');
          
          // Verificar que hay datos de audio después de un momento
          setTimeout(() => {
            if (remoteSourceRef.current && remoteGainNodeRef.current) {
              const analyser = audioContextRef.current!.createAnalyser();
              analyser.fftSize = 256;
              const analyserSource = audioContextRef.current!.createMediaStreamSource(remoteStream);
              analyserSource.connect(analyser);
              
              const dataArray = new Uint8Array(analyser.frequencyBinCount);
              analyser.getByteFrequencyData(dataArray);
              const maxAmplitude = Math.max(...dataArray);
              
              if (maxAmplitude === 0) {
                console.warn('⚠️ No se detectan datos de audio en el stream remoto');
              } else {
                console.log('✅ Se detectan datos de audio en el stream remoto');
              }
            }
          }, 2000);
        } catch (error) {
          console.error('❌ Error conectando stream remoto al AudioContext:', error);
        }
      };

      connectStream();
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

  /**
   * Obtiene la referencia al AudioContext para uso compartido
   */
  const getAudioContext = () => {
    return audioContextRef.current;
  };

  return {
    beatVolume,
    setBeatVolume,
    micVolume,
    setMicVolume,
    remoteVolume,
    setRemoteVolume,
    getAudioContext,
  };
}
