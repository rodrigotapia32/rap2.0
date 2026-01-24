'use client';

import { useSearchParams, useParams } from 'next/navigation';
import { useEffect, useState, useRef, Suspense, useCallback } from 'react';
import { useWebRTC, WebRTCState } from '@/hooks/useWebRTC';
import { useAudioControls } from '@/hooks/useAudioControls';
import { SignalingMessage } from '@/lib/websocket';
import { PusherSignalingClient } from '@/lib/pusher-client';
import { audioContextManager } from '@/lib/audio-context-manager';
import styles from './room.module.css';

type PeerState = 'alone' | 'handshaking' | 'paired';

function RoomPageContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const rawRoomId = params.roomId as string;
  let roomId = '';
  try {
    roomId = decodeURIComponent(rawRoomId || '').toUpperCase().trim();
  } catch {
    roomId = (rawRoomId || '').toUpperCase().trim();
  }
  const nickname = searchParams.get('nickname') || '';
  const isHost = searchParams.get('isHost') === 'true';

  const isMobile = typeof navigator !== 'undefined' &&
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const isValidRoomId = /^[A-Z0-9]{6}$/.test(roomId);

  // ─── State ───
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
  const [peerState, setPeerState] = useState<PeerState>('alone');
  const [connectionState, setConnectionState] = useState<WebRTCState>('idle');

  // ─── Refs ───
  const userIdRef = useRef(`user-${Date.now()}-${Math.random()}`);
  const signalingRef = useRef<PusherSignalingClient | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const webrtcHandleMessageRef = useRef<((message: SignalingMessage) => void) | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownStartedRef = useRef(false);
  const beatAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteUserIdRef = useRef<string>('');
  // Callback refs for signaling handler (avoid useEffect churn)
  const startConnectionRef = useRef<(isInitiator: boolean) => Promise<void>>();
  const resetStateRef = useRef<() => void>();
  const initializeLocalStreamRef = useRef<() => Promise<MediaStream | null>>();
  const startBattleRef = useRef<(ts: number) => Promise<void>>();
  const playBeatRef = useRef<() => Promise<boolean>>();
  const pauseBeatRef = useRef<() => void>();
  const restartBeatInternalRef = useRef<() => Promise<void>>();
  const isHostRef = useRef(isHost);
  const selectedBeatRef = useRef(selectedBeat);
  const isMobileRef = useRef(isMobile);

  // ─── Beat Playback Helpers ───
  const playBeat = useCallback(async (): Promise<boolean> => {
    const audio = beatAudioRef.current || beatAudio;
    if (!audio) return false;

    try {
      await audioContextManager.tryResume();
      await audio.play();
      setIsBeatPlaying(true);
      return true;
    } catch {
      return false;
    }
  }, [beatAudio]);

  const pauseBeat = useCallback(() => {
    const audio = beatAudioRef.current || beatAudio;
    if (audio) {
      audio.pause();
      setIsBeatPlaying(false);
    }
  }, [beatAudio]);

  const restartBeatInternal = useCallback(async () => {
    const audio = beatAudioRef.current || beatAudio;
    if (audio) {
      audio.currentTime = 0;
      if (!isBeatPlaying) {
        await playBeat();
      }
    }
  }, [beatAudio, isBeatPlaying, playBeat]);

  // ─── Battle Logic ───
  const startBattle = useCallback(async (serverTimestamp: number) => {
    setBattleStarted(true);
    await audioContextManager.tryResume();

    const now = Date.now();
    const delay = Math.max(0, serverTimestamp - now);

    setTimeout(async () => {
      const audio = beatAudioRef.current || beatAudio;
      if (audio) {
        audio.currentTime = 0;
        const success = await playBeat();

        if (isHost && success && signalingRef.current) {
          setTimeout(() => {
            signalingRef.current?.send({
              type: 'beat-play',
              timestamp: Date.now() + 50,
            });
          }, 50);
        }
      }
    }, delay);
  }, [beatAudio, isHost, playBeat]);

  const toggleBeat = useCallback(async () => {
    if (!isHost) return;
    if (isBeatPlaying) {
      pauseBeat();
      signalingRef.current?.send({ type: 'beat-pause' });
    } else {
      const success = await playBeat();
      if (success) {
        signalingRef.current?.send({ type: 'beat-play' });
      }
    }
  }, [isHost, isBeatPlaying, pauseBeat, playBeat]);

  const restartBeat = useCallback(async () => {
    if (!isHost) return;
    await restartBeatInternal();
    signalingRef.current?.send({ type: 'beat-restart' });
  }, [isHost, restartBeatInternal]);

  // ─── WebRTC Hook ───
  const {
    localStream: webrtcLocalStream,
    startConnection,
    resetState,
    handleSignalingMessage,
    initializeLocalStream,
  } = useWebRTC({
    roomId,
    userId: userIdRef.current,
    sendSignalingMessage: (message) => {
      signalingRef.current?.send(message);
    },
    onRemoteStream: (stream) => {
      setRemoteStream(stream);
    },
    onConnectionStateChange: (state) => {
      setConnectionState(state);
    },
  });

  // Keep webrtc message handler ref in sync
  useEffect(() => {
    webrtcHandleMessageRef.current = handleSignalingMessage;
  }, [handleSignalingMessage]);

  // Sync local stream
  useEffect(() => {
    setLocalStream(webrtcLocalStream);
  }, [webrtcLocalStream]);

  // ─── Audio Controls ───
  const {
    beatVolume,
    setBeatVolume,
    micVolume,
    setMicVolume,
    remoteVolume,
    setRemoteVolume,
    remoteAudioActive,
  } = useAudioControls({
    localStream,
    remoteStream,
    beatAudio,
  });

  // ─── Keep callback refs in sync ───
  useEffect(() => { startConnectionRef.current = startConnection; }, [startConnection]);
  useEffect(() => { resetStateRef.current = resetState; }, [resetState]);
  useEffect(() => { initializeLocalStreamRef.current = initializeLocalStream; }, [initializeLocalStream]);
  useEffect(() => { startBattleRef.current = startBattle; }, [startBattle]);
  useEffect(() => { playBeatRef.current = playBeat; }, [playBeat]);
  useEffect(() => { pauseBeatRef.current = pauseBeat; }, [pauseBeat]);
  useEffect(() => { restartBeatInternalRef.current = restartBeatInternal; }, [restartBeatInternal]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { selectedBeatRef.current = selectedBeat; }, [selectedBeat]);
  useEffect(() => { isMobileRef.current = isMobile; }, [isMobile]);

  // ─── Signaling Setup (only re-runs on roomId/nickname change) ───
  useEffect(() => {
    const signaling = new PusherSignalingClient(
      roomId,
      userIdRef.current,
      nickname,
      (message: SignalingMessage) => {
        const isBeatControl = message.type === 'beat-play' || message.type === 'beat-pause' || message.type === 'beat-restart';

        // Filter own messages (except beat controls)
        if (!isBeatControl && message.userId && message.userId === userIdRef.current) {
          return;
        }

        // Forward WebRTC messages to the hook
        if (['offer', 'answer', 'ice-candidate'].includes(message.type)) {
          webrtcHandleMessageRef.current?.(message);
          return;
        }

        // ─── Handshake state machine ───
        switch (message.type) {
          case 'peer-hello': {
            const { userId: remoteId, nickname: remoteNick, sessionId } = message;
            setRemoteNickname(remoteNick);
            remoteUserIdRef.current = remoteId;
            setPeerState('handshaking');

            // Send ack back (include our nickname so peer learns it)
            signalingRef.current?.send({
              type: 'peer-hello-ack',
              userId: userIdRef.current,
              targetUserId: remoteId,
              nickname,
              sessionId,
            });

            // Determine initiator and start connection
            const weInitiate = userIdRef.current < remoteId;
            startConnectionRef.current?.(weInitiate);
            setPeerState('paired');
            break;
          }

          case 'peer-hello-ack': {
            const { userId: remoteId, nickname: remoteNick } = message;
            setRemoteNickname(remoteNick);
            if (!remoteUserIdRef.current) {
              remoteUserIdRef.current = remoteId;
            }
            setPeerState('paired');

            const weInitiate = userIdRef.current < remoteId;
            startConnectionRef.current?.(weInitiate);
            break;
          }

          case 'webrtc-renegotiate': {
            resetStateRef.current?.();
            const remoteId = message.userId;
            const weInitiate = userIdRef.current < remoteId;
            startConnectionRef.current?.(weInitiate);
            break;
          }

          case 'peer-disconnected': {
            setPeerState('alone');
            setRemoteNickname('');
            setRemoteReady(false);
            remoteUserIdRef.current = '';
            resetStateRef.current?.();
            setRemoteStream(null);
            break;
          }

          // ─── Legacy user-joined (backwards compat) ───
          case 'user-joined': {
            if (message.userId !== userIdRef.current) {
              setRemoteNickname(message.nickname);

              if (isHostRef.current && signalingRef.current) {
                signalingRef.current.send({
                  type: 'beat-selected',
                  beatNumber: selectedBeatRef.current,
                });
              }
            }
            break;
          }

          // ─── Game events ───
          case 'ready':
            if (message.userId !== userIdRef.current) {
              setRemoteReady(true);
            }
            break;

          case 'start-battle':
            startBattleRef.current?.(message.timestamp);
            break;

          case 'beat-selected':
            if (!isHostRef.current && message.userId !== userIdRef.current) {
              setSelectedBeat(message.beatNumber);
            }
            break;

          case 'beat-play':
            if (!isHostRef.current) {
              (async () => {
                let attempts = 0;
                const maxAttempts = isMobileRef.current ? 50 : 30;
                while ((!beatAudioRef.current || beatAudioRef.current.readyState < 2) && attempts < maxAttempts) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                  attempts++;
                }

                if (beatAudioRef.current && beatAudioRef.current.readyState >= 2) {
                  let playDelay = 0;
                  if (message.timestamp) {
                    playDelay = Math.max(0, message.timestamp - Date.now());
                  }
                  await audioContextManager.tryResume();
                  if (playDelay > 0) {
                    setTimeout(() => playBeatRef.current?.(), playDelay);
                  } else {
                    playBeatRef.current?.();
                  }
                }
              })();
            }
            break;

          case 'beat-pause':
            if (!isHostRef.current) pauseBeatRef.current?.();
            break;

          case 'beat-restart':
            if (!isHostRef.current) restartBeatInternalRef.current?.();
            break;
        }
      },
      (connected: boolean) => {
        setWebsocketConnected(connected);
      }
    );

    signalingRef.current = signaling;
    signaling.connect();

    // Initialize local stream early (parallel with signaling)
    initializeLocalStreamRef.current?.();

    return () => {
      signaling.disconnect();
    };
  }, [roomId, nickname]);

  // ─── Remote stream -> muted audio element (Safari WebRTC keep-alive) ───
  useEffect(() => {
    if (remoteStream && remoteAudioRef.current) {
      if (remoteAudioRef.current.srcObject !== remoteStream) {
        remoteAudioRef.current.srcObject = remoteStream;
      }
    }
  }, [remoteStream]);

  // ─── Handle Ready ───
  const handleReady = useCallback(async () => {
    if (isReady) return;
    setIsReady(true);

    // Unlock audio from user gesture
    await audioContextManager.unlockFromGesture();

    signalingRef.current?.send({
      type: 'ready',
      userId: userIdRef.current,
    });
  }, [isReady]);

  // ─── Microphone Toggle ───
  const toggleMicrophone = useCallback(() => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length > 0) {
        const newMutedState = !isMicMuted;
        audioTracks.forEach(track => { track.enabled = !newMutedState; });
        setIsMicMuted(newMutedState);
      }
    }
  }, [localStream, isMicMuted]);

  // Sync mic mute state with stream
  useEffect(() => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      setIsMicMuted(audioTracks.length === 0 || !audioTracks[0].enabled);
    } else {
      setIsMicMuted(true);
    }
  }, [localStream]);

  // ─── Beat Change (host only) ───
  const handleBeatChange = useCallback((beatNumber: number) => {
    if (!isHost) return;
    setSelectedBeat(beatNumber);
    signalingRef.current?.send({
      type: 'beat-selected',
      beatNumber,
    });
  }, [isHost]);

  // ─── Load Beat Audio ───
  useEffect(() => {
    const audio = new Audio(`/beats/beat${selectedBeat}.mp3`);
    audio.loop = true;
    audio.volume = 0.5;
    audio.setAttribute('playsinline', 'true');
    audio.setAttribute('preload', 'auto');
    audio.crossOrigin = 'anonymous';
    audio.load();

    setBeatAudio(audio);
    beatAudioRef.current = audio;
    setIsBeatPlaying(false);

    const handlePlay = () => setIsBeatPlaying(true);
    const handlePause = () => setIsBeatPlaying(false);

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.pause();
      audio.src = '';
      if (beatAudioRef.current === audio) {
        beatAudioRef.current = null;
      }
    };
  }, [selectedBeat]);

  // ─── Countdown Logic ───
  useEffect(() => {
    if ((battleStarted || !isReady || !remoteReady) && countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
      countdownStartedRef.current = false;
      if (battleStarted) setCountdown(null);
      return;
    }

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
            const startTime = Date.now() + 500;
            signalingRef.current.send({
              type: 'start-battle',
              timestamp: startTime,
            });
            setCountdown(null);
            startBattle(startTime);
          }
        }
      }, 1000);
    }
  }, [isReady, remoteReady, battleStarted, isHost, startBattle]);

  // ─── Derived state ───
  const isConnected = connectionState === 'connected';
  const hasPeer = peerState !== 'alone' || !!remoteNickname;

  if (!nickname) {
    return <div className={styles.container}>Cargando...</div>;
  }

  if (!isValidRoomId) {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Error</h1>
        <p style={{ color: '#f5576c', marginTop: '1rem' }}>
          Codigo de sala invalido. Por favor, verifica el codigo e intenta nuevamente.
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
            <span className={styles.playerLabel}>Tu:</span>
            <span className={styles.playerName}>{nickname}</span>
            {isReady && <span className={styles.readyBadge}>&#10003; Listo</span>}
          </div>
          {remoteNickname ? (
            <div className={styles.player}>
              <span className={styles.playerLabel}>Oponente:</span>
              <span className={styles.playerName}>{remoteNickname}</span>
              {remoteReady && <span className={styles.readyBadge}>&#10003; Listo</span>}
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
          </div>
        )}
        {websocketConnected && !hasPeer && (
          <p className={styles.statusText}>Esperando que se una otro jugador...</p>
        )}
        {websocketConnected && hasPeer && !isConnected && connectionState !== 'failed' && (
          <div>
            <p className={styles.statusText}>Estableciendo conexion de audio...</p>
            {!localStream && (
              <p className={styles.statusText} style={{ fontSize: '0.85rem', color: '#f5576c', marginTop: '0.5rem' }}>
                Microfono no disponible. Podras escuchar pero no hablar.
              </p>
            )}
            {localStream && (
              <p className={styles.statusText} style={{ fontSize: '0.85rem', color: '#10b981', marginTop: '0.5rem' }}>
                Microfono conectado
              </p>
            )}
          </div>
        )}
        {connectionState === 'failed' && (
          <p className={styles.statusText} style={{ color: '#f5576c' }}>
            Error de conexion. Recarga la pagina para reintentar.
          </p>
        )}
        {connectionState === 'reconnecting' && (
          <p className={styles.statusText}>Reconectando...</p>
        )}
        {isConnected && remoteNickname && !isReady && !remoteReady && (
          <p className={styles.statusText}>Presiona &quot;Estoy listo&quot; cuando estes preparado</p>
        )}
        {isReady && !remoteReady && (
          <p className={styles.statusText}>Esperando que el oponente este listo...</p>
        )}
        {isReady && remoteReady && countdown !== null && countdown > 0 && !battleStarted && (
          <div className={styles.countdown}>{countdown}</div>
        )}
        {isReady && remoteReady && countdown === 0 && !battleStarted && (
          <div className={styles.countdown} style={{ color: '#f5576c', fontSize: '4rem' }}>GO!</div>
        )}
        {battleStarted && (
          <div className={styles.battleActive}>
            <p className={styles.battleText}>BATALLA EN CURSO</p>
          </div>
        )}
      </div>

      {battleStarted && beatAudio && isHost && (
        <div className={styles.beatControls}>
          <label className={styles.label}>Controles del Beat:</label>
          <div className={styles.beatButtons}>
            <button onClick={toggleBeat} className={styles.beatButton}>
              {isBeatPlaying ? 'Pausar' : 'Reproducir'}
            </button>
            <button onClick={restartBeat} className={styles.beatButton}>
              Reiniciar
            </button>
          </div>
        </div>
      )}

      {battleStarted && beatAudio && !isHost && (
        <div className={styles.beatControls}>
          <p style={{ color: '#888', fontSize: '0.9rem', textAlign: 'center' }}>
            {isBeatPlaying ? 'Reproduciendo' : 'Pausado'} - Controlado por el host
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
            onTouchStart={() => audioContextManager.unlockFromGesture()}
            className={styles.slider}
          />
        </div>

        <div className={styles.controlGroup}>
          <label className={styles.controlLabel}>
            Volumen Microfono: {Math.round(micVolume * 100)}%
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
            onTouchStart={() => audioContextManager.unlockFromGesture()}
            className={styles.slider}
          />
        </div>
      </div>

      {/* Muted audio element - Safari WebRTC keep-alive only, audio routed via Web Audio API */}
      <audio
        ref={remoteAudioRef}
        muted
        playsInline
        style={{ display: 'none' }}
      />
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
