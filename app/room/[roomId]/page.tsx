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

  const userIdRef = useRef(`user-${Date.now()}-${Math.random()}`);
  const signalingRef = useRef<PusherSignalingClient | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const webrtcHandleMessageRef = useRef<((message: SignalingMessage) => void) | null>(null);
  const webrtcStartedRef = useRef(false); // Prevenir múltiples inicios de WebRTC
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null); // Ref para el interval del countdown
  const countdownStartedRef = useRef(false); // Ref para rastrear si el countdown ya se inició

  /**
   * Inicia la batalla cuando ambos están listos
   */
  const startBattle = (serverTimestamp: number) => {
    setBattleStarted(true);
    setCountdown(null);

    // Calcular delay basado en el timestamp del servidor
    const now = Date.now();
    const delay = Math.max(0, serverTimestamp - now);

    setTimeout(() => {
      if (beatAudio) {
        beatAudio.currentTime = 0;
        beatAudio.play().catch((error) => {
          console.error('Error reproduciendo beat:', error);
        });
      }
    }, delay);
  };

  /**
   * Maneja el click en "Estoy listo"
   */
  const handleReady = () => {
    setIsReady(true);
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
        // Filtrar nuestros propios mensajes (excepto user-joined que se maneja diferente)
        if (message.type !== 'user-joined' && message.userId === userIdRef.current) {
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
            console.log('🔵 user-joined recibido:', message.userId, message.nickname);
            if (message.userId !== userIdRef.current) {
              console.log('🔵 Estableciendo remoteNickname:', message.nickname);
              setRemoteNickname(message.nickname);
              // Si es host, enviar el beat seleccionado y iniciar WebRTC (solo una vez)
              if (isHost && signalingRef.current && !webrtcStartedRef.current) {
                console.log('🔵 Host: Iniciando WebRTC...');
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
                    console.warn('⚠️ startWebRTC no está disponible');
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
    setBeatAudio(audio);

    return () => {
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
  } = useAudioControls({
    localStream,
    remoteStream,
    beatAudio,
  });

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
      console.log('🔵 Iniciando countdown...');
      countdownStartedRef.current = true;
      let count = 3;
      setCountdown(count);

      countdownIntervalRef.current = setInterval(() => {
        count--;
        console.log(`🔵 Countdown: ${count}`);
        if (count > 0) {
          setCountdown(count);
        } else {
          setCountdown(0);
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
          }
          countdownStartedRef.current = false;
          console.log('🔵 Countdown terminado');

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
