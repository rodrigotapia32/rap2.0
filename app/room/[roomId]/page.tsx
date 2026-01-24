'use client';

import { useSearchParams, useParams } from 'next/navigation';
import { useEffect, useState, useRef, Suspense } from 'react';
import { useWebRTC } from '@/hooks/useWebRTC';
import { useAudioControls } from '@/hooks/useAudioControls';
import { SignalingMessage } from '@/lib/websocket';
import { PusherSignalingClient } from '@/lib/pusher-client';
import styles from './room.module.css';

function RoomPageContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  // Decodificar roomId correctamente y validar
  const rawRoomId = params.roomId as string;
  let roomId = '';
  try {
    roomId = decodeURIComponent(rawRoomId || '').toUpperCase().trim();
  } catch (e) {
    // Si falla la decodificación, usar el valor raw
    roomId = (rawRoomId || '').toUpperCase().trim();
  }
  const nickname = searchParams.get('nickname') || '';
  const isHost = searchParams.get('isHost') === 'true';
  
  // Detectar si es un dispositivo móvil
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  // Validar roomId (debe ser alfanumérico, 6 caracteres)
  const isValidRoomId = /^[A-Z0-9]{6}$/.test(roomId);

  const [remoteNickname, setRemoteNickname] = useState<string>('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [battleStarted, setBattleStarted] = useState(false);
  const [beatAudio, setBeatAudio] = useState<HTMLAudioElement | null>(null);
  const [selectedBeat, setSelectedBeat] = useState<number>(1);
  const [websocketConnected, setWebsocketConnected] = useState(false);
  const [isBeatPlaying, setIsBeatPlaying] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);

  const userIdRef = useRef(`user-${Date.now()}-${Math.random()}`);
  const signalingRef = useRef<PusherSignalingClient | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const webrtcHandleMessageRef = useRef<((message: SignalingMessage) => void) | null>(null);
  const webrtcStartedRef = useRef(false); // Prevenir múltiples inicios de WebRTC
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null); // Ref para el interval del countdown
  const countdownStartedRef = useRef(false); // Ref para rastrear si el countdown ya se inició
  const audioContextRef = useRef<AudioContext | null>(null); // Ref para el AudioContext compartido
  const audioUnlockedRef = useRef(false); // Ref para rastrear si el audio está desbloqueado
  const beatAudioRef = useRef<HTMLAudioElement | null>(null); // Ref para acceder al beat actual

  /**
   * Activa el AudioContext y desbloquea el audio en móvil
   */
  const unlockAudio = async (): Promise<boolean> => {
    try {
      // Obtener AudioContext compartido o crear uno nuevo si no existe
      let audioContext = audioContextRef.current;
      if (!audioContext) {
        const sharedContext = getAudioContext();
        if (sharedContext) {
          audioContext = sharedContext;
          audioContextRef.current = sharedContext;
        } else {
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          if (!AudioContextClass) {
            console.warn('⚠️ AudioContext no disponible');
            return false;
          }
          audioContext = new AudioContextClass();
          audioContextRef.current = audioContext;
        }
      }

      if (!audioContext) {
        console.warn('⚠️ No se pudo obtener AudioContext');
        return false;
      }

      // Activar AudioContext si está suspendido
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
        console.log('✅ AudioContext activado');
      }

      // Reproducir un audio silencioso muy corto para desbloquear autoplay en móvil
      if (!audioUnlockedRef.current && beatAudio) {
        try {
          // Crear un buffer de audio silencioso
          const buffer = audioContext.createBuffer(1, 1, 22050);
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          source.connect(audioContext.destination);
          source.start(0);
          source.stop(0.001);
          
          // También intentar reproducir el beat muy brevemente
          const audio = beatAudioRef.current || beatAudio;
          if (audio) {
            const originalVolume = audio.volume;
            audio.volume = 0.01; // Muy bajo pero no 0
            await audio.play();
            audio.pause();
            audio.currentTime = 0;
            audio.volume = originalVolume;
          }
          
          audioUnlockedRef.current = true;
          console.log('✅ Audio desbloqueado para móvil');
          return true;
        } catch (e) {
          console.warn('⚠️ No se pudo desbloquear audio completamente:', e);
          // Continuar de todas formas
          return audioContext.state === 'running';
        }
      }

      return audioContext.state === 'running';
    } catch (error) {
      console.error('❌ Error desbloqueando audio:', error);
      return false;
    }
  };

  /**
   * Reproduce el beat (usado internamente y por eventos remotos)
   */
  const playBeat = async (): Promise<boolean> => {
    const audio = beatAudioRef.current || beatAudio;
    if (!audio) {
      return false;
    }

    try {
      // Asegurarse de que el AudioContext esté activo
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        await playPromise;
        setIsBeatPlaying(true);
        return true;
      }
      return false;
    } catch (error: any) {
      console.error('❌ Error reproduciendo beat:', error);
      // Intentar activar AudioContext una vez más
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        try {
          await audioContextRef.current.resume();
          await audio.play();
          setIsBeatPlaying(true);
          return true;
        } catch (e: any) {
          console.error('❌ Error después de reactivar AudioContext:', e);
        }
      }
      return false;
    }
  };

  /**
   * Pausa el beat (usado internamente y por eventos remotos)
   */
  const pauseBeat = () => {
    const audio = beatAudioRef.current || beatAudio;
    if (audio) {
      audio.pause();
      setIsBeatPlaying(false);
    }
  };

  /**
   * Reinicia el beat (usado internamente y por eventos remotos)
   */
  const restartBeatInternal = async () => {
    const audio = beatAudioRef.current || beatAudio;
    if (audio) {
      audio.currentTime = 0;
      if (!isBeatPlaying) {
        await playBeat();
      }
    }
  };

  /**
   * Inicia la batalla cuando ambos están listos
   */
  const startBattle = async (serverTimestamp: number) => {
    // No limpiar countdown inmediatamente, dejar que termine naturalmente
    // setCountdown(null); // Comentado para que el countdown se vea
    setBattleStarted(true);

    // Asegurarse de que el audio esté desbloqueado antes de iniciar
    await unlockAudio();

    // Calcular delay basado en el timestamp del servidor
    // Reducir buffer en móviles para minimizar delay
    const now = Date.now();
    const baseDelay = Math.max(0, serverTimestamp - now);
    const mobileBuffer = isMobile ? 200 : 0; // Reducido de 1000ms a 200ms
    const delay = baseDelay + mobileBuffer;

    setTimeout(async () => {
      const audio = beatAudioRef.current || beatAudio;
      if (audio) {
        audio.currentTime = 0;
        const success = await playBeat();
        
        // Si es host y el beat se reprodujo correctamente, enviar evento al guest
        // Reducir delay para mejor sincronización
        if (isHost && success && signalingRef.current) {
          const hostDelay = isMobile ? 100 : 50; // Reducido significativamente
          setTimeout(async () => {
            if (signalingRef.current) {
              try {
                // Enviar timestamp junto con beat-play para mejor sincronización
                // Reducir el timestamp futuro para menos delay
                const playTimestamp = Date.now() + 50; // Reducido de 100ms a 50ms
                await signalingRef.current.send({
                  type: 'beat-play',
                  timestamp: playTimestamp, // Timestamp para sincronización
                });
              } catch (error) {
                console.error('❌ Error enviando beat-play:', error);
              }
            }
          }, hostDelay);
        }
      }
    }, delay);
  };

  /**
   * Pausa o reanuda el beat (solo host puede controlar)
   */
  const toggleBeat = async () => {
    const audio = beatAudioRef.current || beatAudio;
    if (!isHost || !audio) return;

    if (isBeatPlaying) {
      pauseBeat();
      // Enviar evento de pausa al guest
      if (signalingRef.current) {
        signalingRef.current.send({
          type: 'beat-pause',
        });
      }
    } else {
      const success = await playBeat();
      if (success) {
        // Enviar evento de reproducción al guest
        if (signalingRef.current) {
          signalingRef.current.send({
            type: 'beat-play',
          });
        }
      }
    }
  };

  /**
   * Reinicia el beat desde el principio (solo host puede controlar)
   */
  const restartBeat = async () => {
    const audio = beatAudioRef.current || beatAudio;
    if (!isHost || !audio) return;

    await restartBeatInternal();
    // Enviar evento de reinicio al guest
    if (signalingRef.current) {
      signalingRef.current.send({
        type: 'beat-restart',
      });
    }
  };

  /**
   * Maneja el click en "Estoy listo"
   */
  const handleReady = async () => {
    // Solo establecer como listo si aún no lo está
    if (!isReady) {
      setIsReady(true);
      
      // Desbloquear audio en móvil cuando el usuario interactúa
      await unlockAudio();
      
      if (signalingRef.current) {
        signalingRef.current.send({
          type: 'ready',
          userId: userIdRef.current,
        });
      }
    }
  };

  /**
   * Activa o desactiva el micrófono
   */
  const toggleMicrophone = () => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length > 0) {
        const newMutedState = !isMicMuted;
        audioTracks.forEach((track) => {
          track.enabled = newMutedState;
        });
        setIsMicMuted(newMutedState);
      }
    }
  };

  /**
   * Verifica el estado del micrófono
   */
  useEffect(() => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length > 0) {
        setIsMicMuted(!audioTracks[0].enabled);
      } else {
        setIsMicMuted(true); // Si no hay tracks, considerar como muteado
      }
    } else {
      setIsMicMuted(true); // Si no hay stream, considerar como muteado
    }
  }, [localStream]);

  // Configurar signaling primero (usando Pusher para producción)
  useEffect(() => {
    const signaling = new PusherSignalingClient(
      roomId,
      userIdRef.current,
      nickname,
      (message: SignalingMessage) => {
        // Para beat-play, beat-pause, beat-restart, no filtrar por userId porque pueden no tenerlo
        const isBeatControl = message.type === 'beat-play' || message.type === 'beat-pause' || message.type === 'beat-restart';
        
        // Filtrar nuestros propios mensajes (excepto user-joined y controles de beat que se manejan diferente)
        // user-joined siempre debe procesarse para detectar cuando otros usuarios se unen
        if (message.type !== 'user-joined' && !isBeatControl && message.userId && message.userId === userIdRef.current) {
          return;
        }

        // Manejar mensajes de WebRTC (solo si no es user-joined)
        if (message.type !== 'user-joined' && webrtcHandleMessageRef.current) {
          webrtcHandleMessageRef.current(message);
        }

        // Manejar mensajes de juego
        switch (message.type) {
          case 'ready':
            if (message.userId !== userIdRef.current) {
              setRemoteReady(true);
              // Si es host y el guest acaba de enviar ready, reenviar user-joined por si acaso
              if (isHost && signalingRef.current && !remoteNickname) {
                const channelName = `private-room-${roomId}`;
                fetch('/api/pusher/trigger', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    channel: channelName,
                    event: 'user-joined',
                    data: {
                      userId: userIdRef.current,
                      nickname: nickname,
                    },
                  }),
                }).catch(() => {
                  // Fallback a client event
                  if (signalingRef.current) {
                    signalingRef.current.send({
                      type: 'user-joined',
                      userId: userIdRef.current,
                      nickname: nickname,
                    });
                  }
                });
              }
            }
            break;
          case 'start-battle':
            startBattle(message.timestamp);
            break;
          case 'user-joined':
            if (message.userId !== userIdRef.current) {
              setRemoteNickname(message.nickname);
              // Si es host, enviar el beat seleccionado y iniciar WebRTC (solo una vez)
              if (isHost && signalingRef.current && !webrtcStartedRef.current) {
                webrtcStartedRef.current = true;
                setTimeout(() => {
                  if (signalingRef.current) {
                    signalingRef.current.send({
                      type: 'beat-selected',
                      beatNumber: selectedBeat,
                    });
                  }
                }, 500);
                setTimeout(() => {
                  if (startWebRTC) {
                    console.log('🎯 Host: Llamando startWebRTC después de recibir user-joined');
                    startWebRTC();
                  } else {
                    console.error('❌ Host: startWebRTC no está disponible');
                    webrtcStartedRef.current = false;
                  }
                }, 1000);
              }
            }
            break;
          case 'beat-selected':
            // El invitado recibe el beat seleccionado por el host
            if (!isHost && message.userId !== userIdRef.current) {
              setSelectedBeat(message.beatNumber);
            }
            break;
          case 'beat-play':
            // El guest recibe la orden de reproducir el beat
            if (!isHost) {
              // Esperar a que el beat esté cargado si aún no lo está
              const tryPlayBeat = async () => {
                // En móviles, esperar más tiempo (máximo 5 segundos)
                const maxAttempts = isMobile ? 50 : 30; // 50 intentos * 100ms = 5 segundos en móvil
                let attempts = 0;
                while ((!beatAudioRef.current || beatAudioRef.current.readyState < 2) && attempts < maxAttempts) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                  attempts++;
                }
                
                if (beatAudioRef.current && beatAudioRef.current.readyState >= 2) {
                  // Si hay timestamp, calcular delay para sincronización
                  let playDelay = 0;
                  if (message.timestamp) {
                    const now = Date.now();
                    playDelay = Math.max(0, message.timestamp - now);
                  }
                  
                  // Desbloquear audio primero (importante en móvil)
                  await unlockAudio();
                  
                  // Reproducir con el delay calculado para sincronización
                  if (playDelay > 0) {
                    setTimeout(() => {
                      playBeat();
                    }, playDelay);
                  } else {
                    playBeat();
                  }
                } else {
                  console.error('❌ Beat no está cargado después de esperar. readyState:', beatAudioRef.current?.readyState);
                  // Intentar cargar el beat manualmente si no está listo
                  if (beatAudioRef.current) {
                    beatAudioRef.current.load();
                    // Esperar un poco más y reintentar
                    setTimeout(async () => {
                      if (beatAudioRef.current) {
                        await unlockAudio();
                        playBeat();
                      }
                    }, 500);
                  }
                }
              };
              
              tryPlayBeat();
            }
            break;
          case 'beat-pause':
            // El guest recibe la orden de pausar el beat
            if (!isHost) {
              pauseBeat();
            }
            break;
          case 'beat-restart':
            // El guest recibe la orden de reiniciar el beat
            if (!isHost) {
              restartBeatInternal();
            }
            break;
        }
      },
      (connected: boolean) => {
        setWebsocketConnected(connected);
      }
    );

    signalingRef.current = signaling;
    signaling.connect();

    return () => {
      signaling.disconnect();
    };
  }, [roomId, nickname, isHost, selectedBeat]);

  // Inicializar WebRTC
  const { localStream: webrtcLocalStream, isConnected, handleSignalingMessage, startWebRTC } = useWebRTC({
    roomId,
    userId: userIdRef.current,
    nickname,
    isHost,
    sendSignalingMessage: (message) => {
      if (signalingRef.current) {
        signalingRef.current.send(message);
      }
    },
    onRemoteStream: (stream) => {
      setRemoteStream(stream);
    },
    onConnectionStateChange: (state) => {
      // El estado se maneja en useWebRTC con logs apropiados
    },
    waitForRemote: true, // Esperar a que el remoto esté conectado
  });

  // Guardar referencia al handler de mensajes WebRTC
  useEffect(() => {
    webrtcHandleMessageRef.current = handleSignalingMessage;
  }, [handleSignalingMessage]);

  // Si el host entra después del guest, el guest ya envió su user-joined
  // Necesitamos verificar si ya hay un remoteNickname y iniciar WebRTC
  useEffect(() => {
    if (isHost && remoteNickname && !webrtcStartedRef.current && signalingRef.current && startWebRTC) {
      webrtcStartedRef.current = true;
      setTimeout(() => {
        if (signalingRef.current) {
          signalingRef.current.send({
            type: 'beat-selected',
            beatNumber: selectedBeat,
          });
        }
      }, 500);
      setTimeout(() => {
        if (startWebRTC) {
          console.log('🎯 Host: Llamando startWebRTC después de detectar guest existente');
          startWebRTC();
        } else {
          console.error('❌ Host: startWebRTC no está disponible');
          webrtcStartedRef.current = false;
        }
      }, 1000);
    }
  }, [isHost, remoteNickname, selectedBeat, startWebRTC]);

  // Si el guest entra después del host, reenviar user-joined para que el host lo detecte
  // También solicitar al host que reenvíe su user-joined si no lo hemos recibido
  useEffect(() => {
    if (!isHost && websocketConnected && !remoteNickname && signalingRef.current) {
      // Reenviar user-joined después de un breve delay para asegurar que el host lo reciba
      const retryTimeout = setTimeout(() => {
        if (signalingRef.current && !remoteNickname) {
          // Reenviar user-joined a través del servidor
          const channelName = `private-room-${roomId}`;
          fetch('/api/pusher/trigger', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: channelName,
              event: 'user-joined',
              data: {
                userId: userIdRef.current,
                nickname: nickname,
              },
            }),
          }).catch(() => {
            // Si falla, intentar con client event
            if (signalingRef.current) {
              signalingRef.current.send({
                type: 'user-joined',
                userId: userIdRef.current,
                nickname: nickname,
              });
            }
          });
        }
      }, 1000);
      
      return () => clearTimeout(retryTimeout);
    }
  }, [isHost, websocketConnected, remoteNickname, roomId, nickname]);
  
  // Si el host recibe un 'ready' y el guest no tiene remoteNickname, reenviar user-joined
  useEffect(() => {
    if (isHost && websocketConnected && signalingRef.current) {
      // Este efecto se ejecutará cuando se reciba un 'ready' del guest
      // El handler de 'ready' ya está en el switch, pero podemos agregar lógica adicional
    }
  }, [isHost, websocketConnected]);

  // Sincronizar stream local
  useEffect(() => {
    setLocalStream(webrtcLocalStream);
  }, [webrtcLocalStream]);

  // El audio remoto se reproduce a través del AudioContext en useAudioControls
  // Solo verificamos que el stream esté disponible y desbloqueamos audio
  useEffect(() => {
    if (remoteStream) {
      console.log('🎧 Stream remoto recibido en componente:', {
        id: remoteStream.id,
        active: remoteStream.active,
        tracks: remoteStream.getTracks().map(t => ({
          kind: t.kind,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
        })),
      });
      
      // Verificar que el stream tenga tracks de audio
      const audioTracks = remoteStream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.warn('⚠️ Stream remoto no tiene tracks de audio');
        return;
      }
      
      // Verificar que los tracks estén habilitados
      const enabledTracks = audioTracks.filter(track => track.enabled);
      if (enabledTracks.length === 0) {
        console.warn('⚠️ Todos los tracks de audio remoto están deshabilitados');
      } else {
        console.log(`✅ ${enabledTracks.length} track(s) de audio remoto habilitado(s)`);
        
        // Desbloquear audio cuando recibimos el stream remoto
        unlockAudio();
        
        // Verificar que el stream esté realmente activo
        if (!remoteStream.active) {
          console.warn('⚠️ Stream remoto no está activo');
        } else {
          console.log('✅ Stream remoto está activo');
        }
      }
      
      // Escuchar cambios en los tracks del stream remoto
      audioTracks.forEach((track) => {
        track.onended = () => {
          console.warn('⚠️ Track de audio remoto terminó');
        };
        track.onmute = () => {
          console.warn('⚠️ Track de audio remoto fue muteado');
        };
        track.onunmute = () => {
          console.log('✅ Track de audio remoto fue desmuteado');
          // Desbloquear audio cuando se desmutea un track
          unlockAudio();
        };
      });
    }
  }, [remoteStream]);

  /**
   * Maneja el cambio de beat (solo host puede cambiar)
   */
  const handleBeatChange = (beatNumber: number) => {
    if (!isHost) return; // Solo el host puede cambiar el beat
    
    setSelectedBeat(beatNumber);
    
    // Enviar el beat seleccionado al invitado
    if (signalingRef.current) {
      signalingRef.current.send({
        type: 'beat-selected',
        beatNumber: beatNumber,
      });
    }
  };

  // Cargar beat
  useEffect(() => {
    const audio = new Audio(`/beats/beat${selectedBeat}.mp3`);
    audio.loop = true;
    audio.volume = 0.5;
    // Atributos importantes para móvil
    audio.setAttribute('playsinline', 'true');
    audio.setAttribute('preload', 'auto');
    audio.crossOrigin = 'anonymous';
    
    // En móviles, precargar más agresivamente
    if (isMobile) {
      audio.setAttribute('preload', 'auto');
    }
    
    // Cargar el audio antes de establecerlo
    audio.load();
    
    // En móviles, esperar a que el audio esté listo antes de continuar
    if (isMobile) {
      audio.addEventListener('canplaythrough', () => {
        // Audio listo para reproducir
      }, { once: true });
    }
    
    setBeatAudio(audio);
    beatAudioRef.current = audio; // Actualizar ref también
    setIsBeatPlaying(false);

    // Escuchar eventos de pausa/reproducción para mantener el estado sincronizado
    const handlePlay = () => setIsBeatPlaying(true);
    const handlePause = () => setIsBeatPlaying(false);
    const handleError = (e: any) => {
      console.error('❌ Error en beat audio:', e);
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
      audio.pause();
      audio.src = '';
      if (beatAudioRef.current === audio) {
        beatAudioRef.current = null;
      }
    };
  }, [selectedBeat]);

  // Controles de audio
  const {
    beatVolume,
    setBeatVolume,
    micVolume,
    setMicVolume,
    remoteVolume,
    setRemoteVolume,
    getAudioContext,
  } = useAudioControls({
    localStream,
    remoteStream,
    beatAudio,
  });

  // Sincronizar AudioContext compartido
  useEffect(() => {
    const sharedContext = getAudioContext();
    if (sharedContext) {
      audioContextRef.current = sharedContext;
    }
  }, [getAudioContext]);

  /**
   * Inicia cuenta regresiva cuando ambos están listos
   */
  useEffect(() => {
    // Limpiar solo si las condiciones cambian y el countdown está activo
    if ((battleStarted || !isReady || !remoteReady) && countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
      countdownStartedRef.current = false;
      if (battleStarted) {
        setCountdown(null);
      }
      return;
    }

    // Solo iniciar countdown si ambos están listos, la batalla no ha empezado, y el countdown no se ha iniciado
    if (isReady && remoteReady && !battleStarted && !countdownStartedRef.current) {
      countdownStartedRef.current = true;
      let count = 3;
      setCountdown(count);

      countdownIntervalRef.current = setInterval(() => {
        count--;
        if (count > 0) {
          setCountdown(count);
        } else {
          setCountdown(0);
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
          }
          countdownStartedRef.current = false;

          if (isHost && signalingRef.current) {
            // Reducir el tiempo de inicio para menos delay
            const startTime = Date.now() + 500; // Reducido de 1000ms a 500ms
            signalingRef.current.send({
              type: 'start-battle',
              timestamp: startTime,
            });
            // Limpiar countdown justo antes de iniciar la batalla
            setCountdown(null);
            startBattle(startTime);
          }
        }
      }, 1000);
    }
  }, [isReady, remoteReady, battleStarted, isHost, startBattle]);

  if (!nickname) {
    return <div className={styles.container}>Cargando...</div>;
  }

  if (!isValidRoomId) {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Error</h1>
        <p style={{ color: '#f5576c', marginTop: '1rem' }}>
          Código de sala inválido. Por favor, verifica el código e intenta nuevamente.
        </p>
        <button
          onClick={() => window.location.href = '/'}
          className={styles.button}
          style={{ marginTop: '2rem' }}
        >
          Volver al inicio
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Sala: {roomId}</h1>
        <div className={styles.players}>
          <div className={styles.player}>
            <span className={styles.playerLabel}>Tú:</span>
            <span className={styles.playerName}>{nickname}</span>
            {isReady && <span className={styles.readyBadge}>✓ Listo</span>}
          </div>
          {remoteNickname ? (
            <div className={styles.player}>
              <span className={styles.playerLabel}>Oponente:</span>
              <span className={styles.playerName}>{remoteNickname}</span>
              {remoteReady && <span className={styles.readyBadge}>✓ Listo</span>}
            </div>
          ) : (
            <div className={styles.player}>
              <span className={styles.waiting}>Esperando rival...</span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.status}>
            {!websocketConnected && (
              <div>
                <p className={styles.statusText}>Conectando al servidor...</p>
                <p className={styles.statusText} style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
                  Estableciendo conexión con Pusher...
                </p>
              </div>
            )}
        {websocketConnected && !isConnected && (
          <div>
            <p className={styles.statusText}>Estableciendo conexión de audio...</p>
            <p className={styles.statusText} style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
              Si estás probando en el mismo PC, asegúrate de permitir el acceso al micrófono en ambas ventanas
            </p>
            {!localStream && (
              <p className={styles.statusText} style={{ fontSize: '0.85rem', color: '#f5576c', marginTop: '0.5rem' }}>
                ⚠️ Micrófono no disponible. Podrás escuchar pero no hablar.
              </p>
            )}
            {localStream && (
              <p className={styles.statusText} style={{ fontSize: '0.85rem', color: '#10b981', marginTop: '0.5rem' }}>
                ✅ Micrófono conectado
              </p>
            )}
          </div>
        )}
        {isConnected && !remoteNickname && (
          <p className={styles.statusText}>Esperando que se una otro jugador...</p>
        )}
        {isConnected && remoteNickname && !isReady && !remoteReady && (
          <p className={styles.statusText}>Presiona "Estoy listo" cuando estés preparado</p>
        )}
        {isReady && !remoteReady && (
          <p className={styles.statusText}>Esperando que el oponente esté listo...</p>
        )}
        {isReady && remoteReady && countdown !== null && countdown > 0 && !battleStarted && (
          <div className={styles.countdown}>{countdown}</div>
        )}
        {isReady && remoteReady && countdown === 0 && !battleStarted && (
          <div className={styles.countdown} style={{ color: '#f5576c', fontSize: '4rem' }}>¡GO!</div>
        )}
        {battleStarted && (
          <div className={styles.battleActive}>
            <p className={styles.battleText}>🔥 BATALLA EN CURSO 🔥</p>
          </div>
        )}
      </div>

      {battleStarted && beatAudio && isHost && (
        <div className={styles.beatControls}>
          <label className={styles.label}>Controles del Beat:</label>
          <div className={styles.beatButtons}>
            <button
              onClick={toggleBeat}
              className={styles.beatButton}
            >
              {isBeatPlaying ? '⏸️ Pausar' : '▶️ Reproducir'}
            </button>
            <button
              onClick={restartBeat}
              className={styles.beatButton}
            >
              🔄 Reiniciar
            </button>
          </div>
        </div>
      )}
      
      {battleStarted && beatAudio && !isHost && (
        <div className={styles.beatControls}>
          <p style={{ color: '#888', fontSize: '0.9rem', textAlign: 'center' }}>
            {isBeatPlaying ? '▶️ Reproduciendo' : '⏸️ Pausado'} - Controlado por el host
          </p>
        </div>
      )}


      {!battleStarted && websocketConnected && isConnected && remoteNickname && !isReady && (
        <button onClick={handleReady} className={styles.readyButton}>
          Estoy listo
        </button>
      )}

      {!battleStarted && isHost && (
        <div className={styles.beatSelector}>
          <label className={styles.label}>Seleccionar beat:</label>
          <div className={styles.beatButtons}>
            <button
              onClick={() => handleBeatChange(1)}
              className={`${styles.beatButton} ${selectedBeat === 1 ? styles.beatButtonActive : ''}`}
            >
              Beat 1
            </button>
            <button
              onClick={() => handleBeatChange(2)}
              className={`${styles.beatButton} ${selectedBeat === 2 ? styles.beatButtonActive : ''}`}
            >
              Beat 2
            </button>
          </div>
        </div>
      )}

      {!battleStarted && !isHost && (
        <div className={styles.beatSelector}>
          <label className={styles.label}>Beat seleccionado:</label>
          <div className={styles.beatInfo}>
            <span className={styles.beatDisplay}>Beat {selectedBeat}</span>
            <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '0.5rem' }}>
              El host ha seleccionado este beat
            </p>
          </div>
        </div>
      )}

      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          <label className={styles.controlLabel}>
            Volumen Beat: {Math.round(beatVolume * 100)}%
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={beatVolume}
            onChange={(e) => setBeatVolume(parseFloat(e.target.value))}
            className={styles.slider}
          />
        </div>

        <div className={styles.controlGroup}>
          <label className={styles.controlLabel}>
            Volumen Micrófono: {Math.round(micVolume * 100)}%
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={micVolume}
            onChange={(e) => setMicVolume(parseFloat(e.target.value))}
            className={styles.slider}
          />
        </div>

        <div className={styles.controlGroup}>
          <label className={styles.controlLabel}>
            Volumen Oponente: {Math.round(remoteVolume * 100)}%
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={remoteVolume}
            onChange={(e) => setRemoteVolume(parseFloat(e.target.value))}
            className={styles.slider}
          />
        </div>
      </div>
    </div>
  );
}

export default function RoomPage() {
  return (
    <Suspense fallback={<div className={styles.container}>Cargando...</div>}>
      <RoomPageContent />
    </Suspense>
  );
}
