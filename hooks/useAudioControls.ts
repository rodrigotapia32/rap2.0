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
      console.log('✅ Nodo de ganancia remoto creado y conectado al destination:', {
        gain: remoteGainNodeRef.current.gain.value,
        connected: remoteGainNodeRef.current.numberOfOutputs > 0,
        destination: audioContext.destination,
      });
    } else {
      // Verificar que esté conectado si ya existe
      if (remoteGainNodeRef.current.numberOfOutputs === 0) {
        console.warn('⚠️ remoteGainNode existe pero no está conectado, reconectando...');
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
      console.log('🎵 useAudioControls: Stream remoto recibido, conectando al AudioContext');
      
      const connectStream = async () => {
        try {
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
            console.log('🧹 Limpiando fuente anterior de stream remoto');
            remoteSourceRef.current.disconnect();
            remoteSourceRef.current = null;
          }

          // Verificar que el stream tenga tracks de audio
          const audioTracks = remoteStream.getAudioTracks();
          if (audioTracks.length === 0) {
            console.warn('⚠️ Stream remoto no tiene tracks de audio para AudioContext');
            return;
          }

          const enabledTracks = audioTracks.filter(t => t.enabled && !t.muted);
          console.log('🎵 Conectando stream remoto al AudioContext:', {
            streamId: remoteStream.id,
            streamActive: remoteStream.active,
            tracks: audioTracks.length,
            enabledTracks: enabledTracks.length,
            audioContextState: audioContextRef.current!.state,
            remoteGainValue: remoteGainNodeRef.current!.gain.value,
          });

          if (enabledTracks.length === 0) {
            console.warn('⚠️ No hay tracks habilitados y no muteados en el stream remoto');
            audioTracks.forEach((track, index) => {
              console.log(`Track ${index}:`, {
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
              });
            });
            return;
          }

          // Verificar que el AudioContext esté en estado 'running'
          if (audioContextRef.current!.state !== 'running') {
            console.warn('⚠️ AudioContext no está en estado running:', audioContextRef.current!.state);
            await audioContextRef.current!.resume();
            console.log('✅ AudioContext resumido a estado:', audioContextRef.current!.state);
          }

          // Verificar que el nodo de ganancia esté conectado
          if (remoteGainNodeRef.current!.numberOfOutputs === 0) {
            console.warn('⚠️ Nodo de ganancia remoto no está conectado, reconectando...');
            remoteGainNodeRef.current!.connect(audioContextRef.current!.destination);
          }

          // Asegurarse de que el remoteGainNode esté conectado al destination
          if (remoteGainNodeRef.current!.numberOfOutputs === 0) {
            console.warn('⚠️ remoteGainNode no está conectado, reconectando...');
            remoteGainNodeRef.current!.disconnect();
            remoteGainNodeRef.current!.connect(audioContextRef.current!.destination);
          }

          const source = audioContextRef.current!.createMediaStreamSource(remoteStream);
          source.connect(remoteGainNodeRef.current!);
          remoteSourceRef.current = source;
          console.log('✅ Stream remoto conectado al AudioContext, reproduciendo audio');
          
          // Verificar que el nodo de ganancia esté conectado correctamente
          console.log('🔊 Estado del nodo de ganancia remoto:', {
            gain: remoteGainNodeRef.current!.gain.value,
            connected: remoteGainNodeRef.current!.numberOfOutputs > 0,
            audioContextState: audioContextRef.current!.state,
            destinationConnected: remoteGainNodeRef.current!.numberOfOutputs > 0,
            sourceConnected: source.numberOfOutputs > 0,
            sourceChannelCount: source.channelCount,
            sourceChannelCountMode: source.channelCountMode,
            gainNodeChannelCount: remoteGainNodeRef.current!.channelCount,
          });
          
          // Verificar que el stream tenga datos activos
          const activeTracks = remoteStream.getAudioTracks().filter(t => t.readyState === 'live' && t.enabled && !t.muted);
          console.log('🎵 Tracks activos en stream remoto:', activeTracks.length);
          
          // Escuchar eventos de los tracks para verificar que hay datos
          activeTracks.forEach((track, index) => {
            track.onended = () => {
              console.warn(`⚠️ Track remoto ${index} terminó`);
            };
            track.onmute = () => {
              console.warn(`⚠️ Track remoto ${index} fue muteado`);
            };
            track.onunmute = () => {
              console.log(`✅ Track remoto ${index} fue desmuteado`);
            };
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

          // Crear AnalyserNode para verificar que hay datos de audio fluyendo
          const analyser = audioContextRef.current!.createAnalyser();
          analyser.fftSize = 256;
          const analyserGain = audioContextRef.current!.createGain();
          analyserGain.gain.value = 1.0;
          remoteGainNodeRef.current!.connect(analyserGain);
          analyserGain.connect(analyser);
          analyser.connect(audioContextRef.current!.destination);
          
          // Verificar que hay datos de audio después de un momento
          setTimeout(() => {
            if (remoteSourceRef.current && remoteGainNodeRef.current) {
              const dataArray = new Uint8Array(analyser.frequencyBinCount);
              analyser.getByteFrequencyData(dataArray);
              const maxAmplitude = Math.max(...dataArray);
              const avgAmplitude = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
              
              console.log('🔍 Verificación después de conectar:', {
                sourceOutputs: remoteSourceRef.current.numberOfOutputs,
                gainNodeOutputs: remoteGainNodeRef.current.numberOfOutputs,
                audioContextState: audioContextRef.current!.state,
                maxAmplitude: maxAmplitude,
                avgAmplitude: avgAmplitude.toFixed(2),
                hasAudioData: maxAmplitude > 0,
              });
              
              if (maxAmplitude === 0) {
                console.warn('⚠️ No se detectan datos de audio en el stream remoto');
                console.warn('💡 Esto podría indicar que el micrófono del oponente no está transmitiendo datos');
              } else {
                console.log('✅ Se detectan datos de audio en el stream remoto');
              }
            }
          }, 1000);
        } catch (error) {
          console.error('❌ Error conectando stream remoto al AudioContext:', error);
        }
      };

      connectStream();
    } else {
      if (!remoteStream) {
        console.log('⚠️ useAudioControls: No hay stream remoto disponible');
      }
      if (!audioContextRef.current) {
        console.log('⚠️ useAudioControls: No hay AudioContext disponible');
      }
      if (!remoteGainNodeRef.current) {
        console.log('⚠️ useAudioControls: No hay nodo de ganancia remoto disponible');
      }
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
