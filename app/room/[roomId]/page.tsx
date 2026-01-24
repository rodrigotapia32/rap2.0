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

  const userIdRef = useRef(`user-${Date.now()}-${Math.random()}`);
  const signalingRef = useRef<PusherSignalingClient | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const webrtcHandleMessageRef = useRef<((message: SignalingMessage) => void) | null>(null);
  const webrtcStartedRef = useRef(false); // Prevenir múltiples inicios de WebRTC
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null); // Ref para el interval del countdown
  const countdownStartedRef = useRef(false); // Ref para rastrear si el countdown ya se inició
  const audioContextRef = useRef<AudioContext | null>(null); // Ref para el AudioContext compartido
  const audioUnlockedRef = useRef(false); // Ref para rastrear si el audio está desbloqueado

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
          const originalVolume = beatAudio.volume;
          beatAudio.volume = 0.01; // Muy bajo pero no 0
          await beatAudio.play();
          beatAudio.pause();
          beatAudio.currentTime = 0;
          beatAudio.volume = originalVolume;
          
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
    if (!beatAudio) {
      return false;
    }

    try {
      // Asegurarse de que el AudioContext esté activo
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const playPromise = beatAudio.play();
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
          await beatAudio.play();
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
    if (beatAudio) {
      beatAudio.pause();
      setIsBeatPlaying(false);
    }
  };

  /**
   * Reinicia el beat (usado internamente y por eventos remotos)
   */
  const restartBeatInternal = async () => {
    if (beatAudio) {
      beatAudio.currentTime = 0;
      if (!isBeatPlaying) {
        await playBeat();
      }
    }
  };

  /**
   * Inicia la batalla cuando ambos están listos
   */
  const startBattle = async (serverTimestamp: number) => {
    setBattleStarted(true);
    setCountdown(null);

    // Asegurarse de que el audio esté desbloqueado antes de iniciar
    await unlockAudio();

    // Calcular delay basado en el timestamp del servidor
    const now = Date.now();
    const delay = Math.max(0, serverTimestamp - now);

    setTimeout(async () => {
      if (beatAudio) {
        beatAudio.currentTime = 0;
        const success = await playBeat();
        
        // Si es host y el beat se reprodujo correctamente, enviar evento al guest
        if (isHost && success && signalingRef.current) {
          try {
            await signalingRef.current.send({
              type: 'beat-play',
            });
          } catch (error) {
            console.error('❌ Error enviando beat-play:', error);
          }
        }
      }
    }, delay);
  };

  /**
   * Pausa o reanuda el beat (solo host puede controlar)
   */
  const toggleBeat = async () => {
    if (!isHost || !beatAudio) return;

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
    if (!isHost || !beatAudio) return;

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
    setIsReady(true);
    
    // Desbloquear audio en móvil cuando el usuario interactúa
    await unlockAudio();
    
    if (signalingRef.current) {
      signalingRef.current.send({
        type: 'ready',
        userId: userIdRef.current,
      });
    }
  };

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
        if (message.type !== 'user-joined' && !isBeatControl && message.userId === userIdRef.current) {
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
                    startWebRTC();
                  } else {
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
            if (!isHost && beatAudio) {
              // Desbloquear audio primero (importante en móvil)
              unlockAudio().then(() => {
                playBeat();
              }).catch(() => {
                // Intentar reproducir de todas formas
                playBeat();
              });
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
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
      }
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
          startWebRTC();
        } else {
          webrtcStartedRef.current = false;
        }
      }, 1000);
    }
  }, [isHost, remoteNickname, selectedBeat, startWebRTC]);

  // Sincronizar stream local
  useEffect(() => {
    setLocalStream(webrtcLocalStream);
  }, [webrtcLocalStream]);


  // Configurar audio remoto
  useEffect(() => {
    if (remoteStream) {
      // Crear o actualizar el elemento audio
      if (!remoteAudioRef.current) {
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('playsinline', 'true');
        document.body.appendChild(audio);
        remoteAudioRef.current = audio;
      }
      
      // Asignar el stream y reproducir
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.play().catch((error) => {
        console.error('❌ Error reproduciendo audio remoto:', error);
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
    setBeatAudio(audio);
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
      console.log('🔵 Limpiando interval (condiciones cambiaron)');
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
      countdownStartedRef.current = false;
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
            const startTime = Date.now() + 1000;
            signalingRef.current.send({
              type: 'start-battle',
              timestamp: startTime,
            });
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
        {isReady && remoteReady && countdown !== null && countdown > 0 && (
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
