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
      } else {
        console.log('✅ AudioContext inicializado:', audioContextRef.current.state);
      }
    }

    const audioContext = audioContextRef.current;

    // Activar AudioContext si está suspendido
    if (audioContext.state === 'suspended') {
      audioContext.resume().then(() => {
        console.log('✅ AudioContext activado');
      }).catch((error) => {
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
      remoteGainNodeRef.current.gain.value = 1.0; // Volumen inicial al máximo
      remoteGainNodeRef.current.connect(audioContext.destination);
      console.log('✅ Nodo de ganancia remoto creado');
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
        // Asegurarse de que el AudioContext esté activo
        if (audioContextRef.current!.state === 'suspended') {
          try {
            await audioContextRef.current!.resume();
            console.log('✅ AudioContext activado para stream remoto');
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
          console.warn('⚠️ Stream remoto no tiene tracks de audio para AudioContext');
          return;
        }

        const enabledTracks = audioTracks.filter(t => t.enabled);
        console.log('🎵 Conectando stream remoto al AudioContext:', {
          streamId: remoteStream.id,
          streamActive: remoteStream.active,
          tracks: audioTracks.length,
          enabledTracks: enabledTracks.length,
          audioContextState: audioContextRef.current!.state,
          remoteGainValue: remoteGainNodeRef.current!.gain.value,
        });

        if (enabledTracks.length === 0) {
          console.warn('⚠️ No hay tracks habilitados en el stream remoto');
          return;
        }

        try {
          // Verificar que el AudioContext esté en estado 'running'
          if (audioContextRef.current!.state !== 'running') {
            console.warn('⚠️ AudioContext no está en estado running:', audioContextRef.current!.state);
            await audioContextRef.current!.resume();
            console.log('✅ AudioContext resumido a estado:', audioContextRef.current!.state);
          }

          const source = audioContextRef.current!.createMediaStreamSource(remoteStream);
          source.connect(remoteGainNodeRef.current!);
          remoteSourceRef.current = source;
          console.log('✅ Stream remoto conectado al AudioContext, reproduciendo audio');
          
          // Verificar que el nodo de ganancia esté conectado correctamente
          console.log('🔊 Estado del nodo de ganancia remoto:', {
            gain: remoteGainNodeRef.current!.gain.value,
            connected: true,
            audioContextState: audioContextRef.current!.state,
            destinationConnected: remoteGainNodeRef.current!.numberOfOutputs > 0,
          });

          // Verificar que los tracks estén realmente activos
          enabledTracks.forEach((track, index) => {
            console.log(`🎤 Track remoto ${index}:`, {
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
              label: track.label,
            });
          });

          // Forzar que el AudioContext esté activo
          if (audioContextRef.current!.state === 'suspended') {
            await audioContextRef.current!.resume();
            console.log('✅ AudioContext activado después de conectar stream remoto');
          }
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
