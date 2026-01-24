'use client';

import { useSearchParams, useParams } from 'next/navigation';
import { useEffect, useState, useRef, Suspense, useCallback } from 'react';
import { useWebRTC, WebRTCState } from '@/hooks/useWebRTC';
import { useAudioControls } from '@/hooks/useAudioControls';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { useBeatAnalysis } from '@/hooks/useBeatAnalysis';
import BeatVisualizer from '@/components/BeatVisualizer';
import { SignalingMessage } from '@/lib/websocket';
import { PusherSignalingClient } from '@/lib/pusher-client';
import { audioContextManager } from '@/lib/audio-context-manager';
import styles from './room.module.css';

interface PeerInfo {
  userId: string;
  nickname: string;
  isReady: boolean;
  connectionState: WebRTCState;
}

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
  const [peers, setPeers] = useState<Map<string, PeerInfo>>(new Map());
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [battleStarted, setBattleStarted] = useState(false);
  const [beatAudio, setBeatAudio] = useState<HTMLAudioElement | null>(null);
  const [selectedBeat, setSelectedBeat] = useState<number>(1);
  const [websocketConnected, setWebsocketConnected] = useState(false);
  const [isBeatPlaying, setIsBeatPlaying] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);

  // ─── Refs ───
  const userIdRef = useRef(`user-${Date.now()}-${Math.random()}`);
  const signalingRef = useRef<PusherSignalingClient | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const webrtcHandleMessageRef = useRef<((message: SignalingMessage) => void) | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownStartedRef = useRef(false);
  const beatAudioRef = useRef<HTMLAudioElement | null>(null);
  const beatGainNodeRef = useRef<GainNode | null>(null);
  const beatSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  // Callback refs for signaling handler
  const startConnectionRef = useRef<(remoteUserId: string, isInitiator: boolean) => Promise<void>>();
  const closeConnectionRef = useRef<(remoteUserId: string) => void>();
  const resetAllRef = useRef<() => void>();
  const initializeLocalStreamRef = useRef<(deviceId?: string) => Promise<MediaStream | null>>();
  const startBattleRef = useRef<(ts: number) => Promise<void>>();
  const playBeatRef = useRef<() => Promise<boolean>>();
  const pauseBeatRef = useRef<() => void>();
  const restartBeatInternalRef = useRef<() => Promise<void>>();
  const isHostRef = useRef(isHost);
  const selectedBeatRef = useRef(selectedBeat);
  const isMobileRef = useRef(isMobile);

  // ─── Device Selection ───
  const {
    audioInputs,
    audioOutputs,
    selectedInputId,
    selectedOutputId,
    setSelectedInputId,
    setSelectedOutputId,
  } = useDeviceSelection();

  const selectedInputIdRef = useRef(selectedInputId);

  // ─── Beat Analysis ───
  const {
    analysisResult,
    spectrogramColumns,
    totalColumns,
    isAnalyzing,
  } = useBeatAnalysis({ beatUrl: `/beats/beat${selectedBeat}.mp3` });

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
    closeConnection,
    resetAll,
    handleSignalingMessage,
    initializeLocalStream,
    replaceLocalStream,
  } = useWebRTC({
    roomId,
    userId: userIdRef.current,
    sendSignalingMessage: (message) => {
      signalingRef.current?.send(message);
    },
    onRemoteStream: (userId, stream) => {
      setRemoteStreams(prev => {
        const next = new Map(prev);
        if (stream) next.set(userId, stream);
        else next.delete(userId);
        return next;
      });
    },
    onPeerConnectionState: (userId, state) => {
      setPeers(prev => {
        const next = new Map(prev);
        const peer = next.get(userId);
        if (peer) next.set(userId, { ...peer, connectionState: state });
        return next;
      });
    },
  });

  const replaceLocalStreamRef = useRef(replaceLocalStream);

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
    remoteStreams,
    beatAudio,
  });

  // ─── Keep callback refs in sync ───
  useEffect(() => { startConnectionRef.current = startConnection; }, [startConnection]);
  useEffect(() => { closeConnectionRef.current = closeConnection; }, [closeConnection]);
  useEffect(() => { resetAllRef.current = resetAll; }, [resetAll]);
  useEffect(() => { initializeLocalStreamRef.current = initializeLocalStream; }, [initializeLocalStream]);
  useEffect(() => { startBattleRef.current = startBattle; }, [startBattle]);
  useEffect(() => { playBeatRef.current = playBeat; }, [playBeat]);
  useEffect(() => { pauseBeatRef.current = pauseBeat; }, [pauseBeat]);
  useEffect(() => { restartBeatInternalRef.current = restartBeatInternal; }, [restartBeatInternal]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { selectedBeatRef.current = selectedBeat; }, [selectedBeat]);
  useEffect(() => { isMobileRef.current = isMobile; }, [isMobile]);
  useEffect(() => { selectedInputIdRef.current = selectedInputId; }, [selectedInputId]);
  useEffect(() => { replaceLocalStreamRef.current = replaceLocalStream; }, [replaceLocalStream]);

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

        // ─── Handshake state machine (multi-peer) ───
        switch (message.type) {
          case 'peer-hello': {
            const { userId: remoteId, nickname: remoteNick } = message;

            // Add peer to our map
            setPeers(prev => {
              const next = new Map(prev);
              next.set(remoteId, {
                userId: remoteId,
                nickname: remoteNick,
                isReady: false,
                connectionState: 'idle',
              });
              return next;
            });

            // Send ack back (include our nickname so peer learns it)
            signalingRef.current?.send({
              type: 'peer-hello-ack',
              userId: userIdRef.current,
              targetUserId: remoteId,
              nickname,
              sessionId: message.sessionId,
            });

            // Determine initiator and start connection
            const weInitiate = userIdRef.current < remoteId;
            startConnectionRef.current?.(remoteId, weInitiate);
            break;
          }

          case 'peer-hello-ack': {
            const { userId: remoteId, nickname: remoteNick } = message;

            // Add peer to our map
            setPeers(prev => {
              const next = new Map(prev);
              if (!next.has(remoteId)) {
                next.set(remoteId, {
                  userId: remoteId,
                  nickname: remoteNick,
                  isReady: false,
                  connectionState: 'idle',
                });
              }
              return next;
            });

            const weInitiate = userIdRef.current < remoteId;
            startConnectionRef.current?.(remoteId, weInitiate);
            break;
          }

          case 'webrtc-renegotiate': {
            const remoteId = message.userId;
            // Close existing connection to this peer and restart
            closeConnectionRef.current?.(remoteId);
            const weInitiate = userIdRef.current < remoteId;
            startConnectionRef.current?.(remoteId, weInitiate);
            break;
          }

          case 'peer-disconnected': {
            const remoteId = message.userId;
            // Remove peer from map
            setPeers(prev => {
              const next = new Map(prev);
              next.delete(remoteId);
              return next;
            });
            // Remove their stream
            setRemoteStreams(prev => {
              const next = new Map(prev);
              next.delete(remoteId);
              return next;
            });
            // Close WebRTC connection
            closeConnectionRef.current?.(remoteId);
            break;
          }

          // ─── Legacy user-joined (backwards compat) ───
          case 'user-joined': {
            if (message.userId !== userIdRef.current) {
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
              setPeers(prev => {
                const next = new Map(prev);
                const peer = next.get(message.userId);
                if (peer) next.set(message.userId, { ...peer, isReady: true });
                return next;
              });
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
    initializeLocalStreamRef.current?.(selectedInputIdRef.current || undefined);

    return () => {
      signaling.disconnect();
    };
  }, [roomId, nickname]);

  // ─── Remote streams -> muted audio element (Safari WebRTC keep-alive) ───
  useEffect(() => {
    if (remoteStreams.size > 0 && remoteAudioRef.current) {
      // Use the first stream for Safari keep-alive workaround
      const firstStream = remoteStreams.values().next().value;
      if (firstStream && remoteAudioRef.current.srcObject !== firstStream) {
        remoteAudioRef.current.srcObject = firstStream;
      }
    }
  }, [remoteStreams]);

  // ─── Mid-session mic device change ───
  const prevInputIdRef = useRef(selectedInputId);
  useEffect(() => {
    if (prevInputIdRef.current === selectedInputId) return;
    prevInputIdRef.current = selectedInputId;

    if (!localStream) return;

    (async () => {
      // Stop existing tracks
      localStream.getTracks().forEach(t => t.stop());
      const newStream = await initializeLocalStream(selectedInputId || undefined);
      if (newStream) {
        await replaceLocalStream(newStream);
      }
    })();
  }, [selectedInputId, localStream, initializeLocalStream, replaceLocalStream]);

  // ─── Speaker output device change ───
  useEffect(() => {
    const setSink = async (el: HTMLAudioElement | null) => {
      if (!el) return;
      if (typeof (el as any).setSinkId === 'function') {
        try {
          await (el as any).setSinkId(selectedOutputId);
        } catch { /* browser may not support setSinkId */ }
      }
    };
    setSink(remoteAudioRef.current);
    setSink(beatAudioRef.current);
  }, [selectedOutputId, beatAudio]);

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

  // ─── Load Beat Audio (routed through Web Audio API) ───
  useEffect(() => {
    const audio = new Audio(`/beats/beat${selectedBeat}.mp3`);
    audio.loop = true;
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

    // Route through Web Audio API: MediaElementSource → GainNode → destination
    let audioCtx: AudioContext | null = null;
    let sourceNode: MediaElementAudioSourceNode | null = null;
    let gainNode: GainNode | null = null;

    const setupWebAudio = () => {
      try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        sourceNode = audioCtx.createMediaElementSource(audio);
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 0.5;
        sourceNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        beatGainNodeRef.current = gainNode;
        beatSourceNodeRef.current = sourceNode;
      } catch {
        // Fallback: direct volume control if Web Audio fails
        audio.volume = 0.5;
      }
    };

    // Setup after element is ready
    if (audio.readyState >= 1) {
      setupWebAudio();
    } else {
      audio.addEventListener('loadedmetadata', setupWebAudio, { once: true });
    }

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('loadedmetadata', setupWebAudio);
      audio.pause();
      audio.src = '';
      if (beatAudioRef.current === audio) {
        beatAudioRef.current = null;
      }
      beatGainNodeRef.current = null;
      beatSourceNodeRef.current = null;
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close();
      }
    };
  }, [selectedBeat]);

  // ─── Beat Volume Sync (via GainNode) ───
  useEffect(() => {
    if (beatGainNodeRef.current) {
      beatGainNodeRef.current.gain.value = beatVolume;
    } else if (beatAudio) {
      // Fallback if Web Audio not available
      beatAudio.volume = beatVolume;
    }
  }, [beatVolume, beatAudio]);

  // ─── Derived state ───
  const hasPeers = peers.size > 0;
  const allPeersConnected = hasPeers && Array.from(peers.values()).every(p => p.connectionState === 'connected');
  const allPeersReady = hasPeers && Array.from(peers.values()).every(p => p.isReady);
  const somePeerConnecting = Array.from(peers.values()).some(p =>
    p.connectionState === 'connecting' || p.connectionState === 'reconnecting'
  );
  const somePeerFailed = Array.from(peers.values()).some(p => p.connectionState === 'failed');

  // ─── Countdown Logic ───
  useEffect(() => {
    if ((battleStarted || !isReady || !allPeersReady) && countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
      countdownStartedRef.current = false;
      if (battleStarted) setCountdown(null);
      return;
    }

    if (isReady && allPeersReady && !battleStarted && !countdownStartedRef.current) {
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
  }, [isReady, allPeersReady, battleStarted, isHost, startBattle]);

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
          {Array.from(peers.values()).map(peer => (
            <div key={peer.userId} className={styles.player}>
              <span className={styles.playerLabel}>Rival:</span>
              <span className={styles.playerName}>{peer.nickname}</span>
              {peer.isReady && <span className={styles.readyBadge}>&#10003; Listo</span>}
              {peer.connectionState === 'connected' && <span className={styles.connectedBadge}>&#128266;</span>}
            </div>
          ))}
          {peers.size === 0 && (
            <div className={styles.player}>
              <span className={styles.waiting}>Esperando rivales...</span>
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
        {websocketConnected && !hasPeers && (
          <p className={styles.statusText}>Esperando que se unan otros jugadores...</p>
        )}
        {websocketConnected && hasPeers && somePeerConnecting && !somePeerFailed && (
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
        {somePeerFailed && (
          <p className={styles.statusText} style={{ color: '#f5576c' }}>
            Error de conexion con un rival. Recarga la pagina para reintentar.
          </p>
        )}
        {allPeersConnected && !isReady && !allPeersReady && (
          <p className={styles.statusText}>Presiona &quot;Estoy listo&quot; cuando estes preparado</p>
        )}
        {isReady && !allPeersReady && (
          <p className={styles.statusText}>Esperando que todos esten listos...</p>
        )}
        {isReady && allPeersReady && countdown !== null && countdown > 0 && !battleStarted && (
          <div className={styles.countdown}>{countdown}</div>
        )}
        {isReady && allPeersReady && countdown === 0 && !battleStarted && (
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

      {!battleStarted && websocketConnected && allPeersConnected && hasPeers && !isReady && (
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
            <button
              onClick={() => handleBeatChange(3)}
              className={`${styles.beatButton} ${selectedBeat === 3 ? styles.beatButtonActive : ''}`}
            >
              Beat 3
            </button>
            <button
              onClick={() => handleBeatChange(4)}
              className={`${styles.beatButton} ${selectedBeat === 4 ? styles.beatButtonActive : ''}`}
            >
              Beat 4
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

      <BeatVisualizer
        spectrogramColumns={spectrogramColumns}
        totalColumns={totalColumns}
        analysisResult={analysisResult}
        isAnalyzing={isAnalyzing}
        beatAudio={beatAudio}
        isBeatPlaying={isBeatPlaying}
      />

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
            Volumen Rivales: {Math.round(remoteVolume * 100)}%
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

        {audioInputs.length > 0 && (
          <div className={styles.controlGroup}>
            <label className={styles.controlLabel}>Microfono:</label>
            <select
              className={styles.deviceSelect}
              value={selectedInputId}
              onChange={(e) => setSelectedInputId(e.target.value)}
            >
              <option value="">Por defecto del sistema</option>
              {audioInputs.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microfono ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {audioOutputs.length > 0 && (
          <div className={styles.controlGroup}>
            <label className={styles.controlLabel}>Altavoz:</label>
            <select
              className={styles.deviceSelect}
              value={selectedOutputId}
              onChange={(e) => setSelectedOutputId(e.target.value)}
            >
              <option value="">Por defecto del sistema</option>
              {audioOutputs.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Altavoz ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
        )}
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
