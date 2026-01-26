'use client';

import { useSearchParams, useParams } from 'next/navigation';
import { useEffect, useState, useRef, Suspense, useCallback } from 'react';
import { useWebRTC, WebRTCState } from '@/hooks/useWebRTC';
import { useAudioControls } from '@/hooks/useAudioControls';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { SignalingMessage } from '@/lib/websocket';
import { PusherSignalingClient } from '@/lib/pusher-client';
import { audioContextManager } from '@/lib/audio-context-manager';
import { BattleFormat, getBeatIntroOffset, getBattleFormatConfig, BATTLE_FORMATS, BEAT_INTRO_OFFSETS } from '@/lib/battle-formats';
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
  const [battleFormat, setBattleFormat] = useState<BattleFormat | null>(null);
  const [currentTurn, setCurrentTurn] = useState<{ userId: string; turnNumber: number; startTime: number; beatStartTime: number } | null>(null);
  const [turnProgress, setTurnProgress] = useState<{ verses: number; lines: number } | { timeRemaining: number } | null>(null);
  const [beatIntroOffset, setBeatIntroOffset] = useState<number>(0);
  const [beatOffsets, setBeatOffsets] = useState<Map<number, number>>(new Map());

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
  const battleFormatRef = useRef<BattleFormat | null>(null);
  const currentTurnRef = useRef<{ userId: string; turnNumber: number; startTime: number; beatStartTime: number } | null>(null);
  const turnProgressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

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

  // ─── Turn System Helpers ───
  const getOrderedUserIds = useCallback((): string[] => {
    const allUsers = [userIdRef.current, ...Array.from(peers.keys())];
    return allUsers.sort();
  }, [peers]);

  const startTurn = useCallback((userId: string, turnNumber: number, format: BattleFormat) => {
    if (!isHost) return;

    // El tiempo del turno comienza desde el offset del beat
    // startTime es el timestamp del sistema cuando el beat llegará al offset
    const beatStartTime = beatIntroOffset;
    // Calcular cuándo el beat llegará al offset (ahora + tiempo hasta el offset)
    const now = Date.now();
    const audio = beatAudioRef.current || beatAudio;
    const currentBeatTime = audio ? audio.currentTime : 0;
    const timeUntilOffset = Math.max(0, (beatIntroOffset - currentBeatTime) * 1000);
    const startTime = now + timeUntilOffset;
    
    setCurrentTurn({ userId, turnNumber, startTime, beatStartTime });
    currentTurnRef.current = { userId, turnNumber, startTime, beatStartTime };

    signalingRef.current?.send({
      type: 'turn-started',
      userId,
      turnNumber,
      startTime,
      format,
    });

    // Inicializar progreso según formato
    const config = getBattleFormatConfig(format);
    setTurnProgress({ timeRemaining: config.timePerTurnSeconds || 60 });
  }, [isHost, beatIntroOffset, beatAudio]);

  const endTurn = useCallback((userId: string, turnNumber: number) => {
    if (!isHost) return;

    signalingRef.current?.send({
      type: 'turn-ended',
      userId,
      turnNumber,
    });

    setCurrentTurn(null);
    currentTurnRef.current = null;
    setTurnProgress(null);

    if (turnProgressIntervalRef.current) {
      clearInterval(turnProgressIntervalRef.current);
      turnProgressIntervalRef.current = null;
    }
  }, [isHost]);

  const nextTurn = useCallback(() => {
    if (!isHost || !battleFormatRef.current) return;

    const orderedUsers = getOrderedUserIds();
    if (orderedUsers.length === 0) return;

    const currentTurnNum = currentTurnRef.current?.turnNumber || 0;
    const currentUserId = currentTurnRef.current?.userId;
    
    // Encontrar índice del usuario actual
    const currentIndex = currentUserId ? orderedUsers.indexOf(currentUserId) : -1;
    const nextIndex = (currentIndex + 1) % orderedUsers.length;
    const nextUserId = orderedUsers[nextIndex];
    const nextTurnNum = currentTurnNum + 1;

    // Finalizar turno actual si existe
    if (currentUserId) {
      endTurn(currentUserId, currentTurnNum);
    }

    // Iniciar siguiente turno
    setTimeout(() => {
      startTurn(nextUserId, nextTurnNum, battleFormatRef.current!);
    }, 500);
  }, [isHost, getOrderedUserIds, startTurn, endTurn]);

  // ─── Battle Logic ───
  const startBattle = useCallback(async (serverTimestamp: number) => {
    setBattleStarted(true);
    await audioContextManager.tryResume();

    const now = Date.now();
    const delay = Math.max(0, serverTimestamp - now);

    setTimeout(async () => {
      const audio = beatAudioRef.current || beatAudio;
      if (audio) {
        // El beat se reproduce desde el segundo 0
        audio.currentTime = 0;
        const success = await playBeat();

        if (isHost && success && signalingRef.current) {
          setTimeout(() => {
            signalingRef.current?.send({
              type: 'beat-play',
              timestamp: Date.now() + 50,
            });
          }, 50);

          // Iniciar primer turno inmediatamente (el tiempo comenzará a contar desde el offset)
          if (battleFormatRef.current) {
            const orderedUsers = getOrderedUserIds();
            if (orderedUsers.length > 0) {
              setTimeout(() => {
                startTurn(orderedUsers[0], 1, battleFormatRef.current!);
              }, 100);
            }
          }
        }
      }
    }, delay);
  }, [beatAudio, isHost, playBeat, beatIntroOffset, getOrderedUserIds, startTurn]);

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
    (async () => {
      await restartBeatInternal();
      // Reiniciar el tiempo del turno si hay un turno activo
      // El tiempo comienza desde el offset del beat
      if (currentTurnRef.current && battleFormatRef.current) {
        const newBeatStartTime = beatIntroOffset;
        const updatedTurn = {
          ...currentTurnRef.current,
          beatStartTime: newBeatStartTime,
        };
        setCurrentTurn(updatedTurn);
        currentTurnRef.current = updatedTurn;
      }
      signalingRef.current?.send({ type: 'beat-restart' });
    })();
  }, [isHost, restartBeatInternal, beatIntroOffset]);

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
    // Intentar desbloquear AudioContext cuando el stream local está listo
    if (webrtcLocalStream) {
      audioContextManager.tryResume();
    }
  }, [webrtcLocalStream]);

  // ─── Audio Controls ───
  const {
    beatVolume,
    setBeatVolume,
    remoteVolumes,
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
  useEffect(() => { battleFormatRef.current = battleFormat; }, [battleFormat]);
  useEffect(() => { currentTurnRef.current = currentTurn; }, [currentTurn]);

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
            if (!isHostRef.current) {
              (async () => {
                await restartBeatInternalRef.current?.();
                // Reiniciar el tiempo del turno si hay un turno activo
                // El tiempo comienza desde el offset del beat
                if (currentTurnRef.current && battleFormatRef.current) {
                  const newBeatStartTime = beatIntroOffset;
                  const updatedTurn = {
                    ...currentTurnRef.current,
                    beatStartTime: newBeatStartTime,
                  };
                  setCurrentTurn(updatedTurn);
                  currentTurnRef.current = updatedTurn;
                }
              })();
            }
            break;

          case 'battle-format-selected':
            if (message.userId !== userIdRef.current) {
              setBattleFormat(message.format);
              battleFormatRef.current = message.format;
            }
            break;

          case 'turn-started':
            // El tiempo del turno comienza desde el offset del beat
            // Asegurarse de usar el offset actual del beat seleccionado
            const beatStartTime = beatIntroOffset;
            setCurrentTurn({
              userId: message.userId,
              turnNumber: message.turnNumber,
              startTime: message.startTime,
              beatStartTime,
            });
            currentTurnRef.current = {
              userId: message.userId,
              turnNumber: message.turnNumber,
              startTime: message.startTime,
              beatStartTime,
            };
            setBattleFormat(message.format);
            battleFormatRef.current = message.format;
            // Inicializar el progreso con el tiempo completo
            const config = getBattleFormatConfig(message.format);
            setTurnProgress({ timeRemaining: config.timePerTurnSeconds || 60 });
            break;

          case 'turn-ended':
            if (message.userId === currentTurnRef.current?.userId) {
              setCurrentTurn(null);
              currentTurnRef.current = null;
              setTurnProgress(null);
            }
            break;

          case 'beat-intro-offset':
            // Actualizar el offset en el mapa de offsets
            setBeatOffsets(prev => {
              const next = new Map(prev);
              next.set(message.beatNumber, message.offsetSeconds);
              return next;
            });
            // Si el beat recibido es el actualmente seleccionado, actualizar el offset
            if (message.beatNumber === selectedBeatRef.current) {
              setBeatIntroOffset(message.offsetSeconds);
              // Si hay un turno activo, actualizar el beatStartTime para mantener sincronización
              if (currentTurnRef.current) {
                const updatedTurn = {
                  ...currentTurnRef.current,
                  beatStartTime: message.offsetSeconds,
                };
                setCurrentTurn(updatedTurn);
                currentTurnRef.current = updatedTurn;
              }
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

    // Initialize local stream early (parallel with signaling)
    (async () => {
      const stream = await initializeLocalStreamRef.current?.(selectedInputIdRef.current || undefined);
      // Intentar desbloquear AudioContext después de inicializar el stream
      if (stream) {
        await audioContextManager.tryResume();
      }
    })();

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

  // ─── Handle Click to Unlock AudioContext ───
  const handleContainerClick = useCallback(async () => {
    // Intentar desbloquear AudioContext con gesto del usuario
    if (!audioContextManager.isUnlocked()) {
      await audioContextManager.unlockFromGesture();
    }
  }, []);

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

  // ─── Turn-based microphone control ───
  useEffect(() => {
    if (!battleStarted || !localStream || !currentTurn) return;

    const audioTracks = localStream.getAudioTracks();
    const isMyTurn = currentTurn.userId === userIdRef.current;

    audioTracks.forEach(track => {
      track.enabled = isMyTurn;
    });

    setIsMicMuted(!isMyTurn);
  }, [battleStarted, localStream, currentTurn]);

  // ─── Turn progress tracking ───
  useEffect(() => {
    if (!battleStarted || !currentTurn || !battleFormat) return;

    const format = battleFormat;
    const config = getBattleFormatConfig(format);
    const duration = (config.timePerTurnSeconds || 60); // en segundos

    // Limpiar intervalo anterior si existe
    if (turnProgressIntervalRef.current) {
      clearInterval(turnProgressIntervalRef.current);
      turnProgressIntervalRef.current = null;
    }

    const updateProgress = () => {
      // Solo actualizar si el beat está reproduciéndose
      if (!isBeatPlaying) {
        // Si está pausado, mantener el tiempo actual sin actualizar
        return;
      }

      // Usar el tiempo del sistema para sincronizar entre usuarios
      // startTime es el timestamp cuando el beat llegó al offset
      const now = Date.now();
      const startTime = currentTurn.startTime;
      
      // Si aún no ha llegado el tiempo del offset, mostrar el tiempo completo
      if (now < startTime) {
        setTurnProgress({ timeRemaining: duration });
        return;
      }

      // Calcular tiempo transcurrido desde que el beat llegó al offset
      // Usar tiempo del sistema para sincronización precisa
      const elapsed = (now - startTime) / 1000; // en segundos
      const remaining = Math.max(0, duration - elapsed);
      const remainingSeconds = Math.ceil(remaining);

      // Solo actualizar si el tiempo restante es válido
      if (remainingSeconds >= 0 && remainingSeconds <= duration) {
        setTurnProgress({ timeRemaining: remainingSeconds });
      }

      if (remaining <= 0 && isHost) {
        nextTurn();
      }
    };

    // Actualizar inmediatamente
    updateProgress();

    // Actualizar cada 100ms solo si el beat está reproduciéndose
    turnProgressIntervalRef.current = setInterval(() => {
      if (isBeatPlaying) {
        updateProgress();
      }
    }, 100);

    return () => {
      if (turnProgressIntervalRef.current) {
        clearInterval(turnProgressIntervalRef.current);
        turnProgressIntervalRef.current = null;
      }
    };
  }, [battleStarted, currentTurn, battleFormat, isHost, nextTurn, isBeatPlaying, beatAudio, beatIntroOffset]);

  // ─── Offset Change (host only) ───
  const handleOffsetChange = useCallback((beatNumber: number, offset: number) => {
    if (!isHost) return;
    
    setBeatOffsets(prev => {
      const next = new Map(prev);
      next.set(beatNumber, offset);
      return next;
    });

    // Si el beat seleccionado es el actual, actualizar inmediatamente
    if (beatNumber === selectedBeat) {
      setBeatIntroOffset(offset);
    }

    // Sincronizar con otros usuarios
    signalingRef.current?.send({
      type: 'beat-intro-offset',
      beatNumber,
      offsetSeconds: offset,
    });
  }, [isHost, selectedBeat]);

  // ─── Beat Change (host only) ───
  const handleBeatChange = useCallback((beatNumber: number) => {
    if (!isHost) return;
    setSelectedBeat(beatNumber);
    const offset = beatOffsets.get(beatNumber) ?? getBeatIntroOffset(beatNumber);
    setBeatIntroOffset(offset);
    signalingRef.current?.send({
      type: 'beat-selected',
      beatNumber,
    });
    signalingRef.current?.send({
      type: 'beat-intro-offset',
      beatNumber,
      offsetSeconds: offset,
    });
  }, [isHost, beatOffsets]);

  // ─── Battle Format Change (host only) ───
  const handleFormatChange = useCallback((format: BattleFormat) => {
    if (!isHost) return;
    setBattleFormat(format);
    battleFormatRef.current = format;
    signalingRef.current?.send({
      type: 'battle-format-selected',
      format,
    });
  }, [isHost]);

  // ─── Initialize beat offsets with default values ───
  useEffect(() => {
    const defaultOffsets = new Map<number, number>();
    Object.entries(BEAT_INTRO_OFFSETS).forEach(([beatNum, offset]) => {
      defaultOffsets.set(Number(beatNum), offset);
    });
    setBeatOffsets(defaultOffsets);
  }, []);

  // ─── Initialize beat intro offset ───
  useEffect(() => {
    const offset = beatOffsets.get(selectedBeat) ?? getBeatIntroOffset(selectedBeat);
    setBeatIntroOffset(offset);
  }, [selectedBeat, beatOffsets]);

  // ─── Load Beat Audio (routed through Web Audio API) ───
  useEffect(() => {
    // Guardar el estado de reproducción antes de cambiar el beat
    const wasPlaying = isBeatPlaying;
    const previousAudio = beatAudioRef.current;

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
    const tryPlay = async () => {
      if (wasPlaying && battleStarted) {
        try {
          // Esperar a que el audio esté listo para reproducirse
          let attempts = 0;
          const maxAttempts = 30;
          while (audio.readyState < 2 && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
          }
          
          if (audio.readyState >= 2) {
            await audioContextManager.tryResume();
            await audio.play();
            setIsBeatPlaying(true);
          }
        } catch {
          // Si falla, no reproducir automáticamente
        }
      }
    };

    if (audio.readyState >= 1) {
      setupWebAudio();
      tryPlay();
    } else {
      audio.addEventListener('loadedmetadata', () => {
        setupWebAudio();
        tryPlay();
      }, { once: true });
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
    <div className={styles.container} onClick={handleContainerClick}>
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
              {peer.connectionState === 'connected' && (
                <div className={styles.playerVolumeControl}>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={remoteVolumes.get(peer.userId) ?? 1}
                    onChange={(e) => setRemoteVolume(peer.userId, parseFloat(e.target.value))}
                    onTouchStart={() => audioContextManager.unlockFromGesture()}
                    className={styles.playerVolumeSlider}
                  />
                  <span className={styles.playerVolumeLabel}>
                    {Math.round((remoteVolumes.get(peer.userId) ?? 1) * 100)}%
                  </span>
                </div>
              )}
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
            {currentTurn && (
              <p className={styles.battleText}>
                {currentTurn.userId === userIdRef.current 
                  ? nickname 
                  : peers.get(currentTurn.userId)?.nickname || 'Desconocido'}
              </p>
            )}
            {currentTurn && (
              <div className={styles.turnInfo}>
                <p className={styles.turnNumber}>Turno #{currentTurn.turnNumber}</p>
              </div>
            )}
            {turnProgress && battleFormat && (
              <div className={styles.progressInfo}>
                <div className={styles.timeProgress}>
                  <div className={styles.pieChartContainer}>
                    <svg className={styles.pieChart} viewBox="0 0 100 100">
                      <circle
                        className={styles.pieChartBackground}
                        cx="50"
                        cy="50"
                        r="45"
                      />
                      <circle
                        className={styles.pieChartProgress}
                        cx="50"
                        cy="50"
                        r="45"
                        style={{
                          strokeDasharray: `${2 * Math.PI * 45}`,
                          strokeDashoffset: `${2 * Math.PI * 45 * (1 - (turnProgress.timeRemaining / (getBattleFormatConfig(battleFormat).timePerTurnSeconds || 60)))}`,
                        }}
                      />
                      <text
                        x="50"
                        y="50"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className={styles.pieChartText}
                      >
                        {turnProgress.timeRemaining}s
                      </text>
                    </svg>
                  </div>
                </div>
              </div>
            )}
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

      {isHost && (
        <div className={styles.beatSelector}>
          <label className={styles.label}>Seleccionar beat:</label>
          <div className={styles.beatButtons}>
            {[1, 2, 3, 4].map(beatNum => {
              const currentOffset = beatOffsets.get(beatNum) ?? getBeatIntroOffset(beatNum);
              return (
                <div key={beatNum} className={styles.beatItem}>
                  <button
                    onClick={() => handleBeatChange(beatNum)}
                    className={`${styles.beatButton} ${selectedBeat === beatNum ? styles.beatButtonActive : ''}`}
                  >
                    Beat {beatNum}
                  </button>
                  <div className={styles.beatOffsetControl}>
                    <label className={styles.beatOffsetLabel}>
                      Offset: {currentOffset.toFixed(1)}s
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="60"
                      step="0.1"
                      value={currentOffset}
                      onChange={(e) => handleOffsetChange(beatNum, parseFloat(e.target.value) || 0)}
                      onTouchStart={() => audioContextManager.unlockFromGesture()}
                      className={styles.beatOffsetInput}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!battleStarted && websocketConnected && allPeersConnected && hasPeers && isHost && !battleFormat && (
        <div className={styles.formatSelector}>
          <label className={styles.label}>Seleccionar formato de batalla:</label>
          <div className={styles.formatButtons}>
            <button
              onClick={() => handleFormatChange('4x4')}
              className={styles.formatButton}
            >
              <div className={styles.formatButtonTitle}>4x4</div>
              <div className={styles.formatButtonDesc}>4 versos de 4 líneas</div>
            </button>
            <button
              onClick={() => handleFormatChange('8x8')}
              className={styles.formatButton}
            >
              <div className={styles.formatButtonTitle}>8x8</div>
              <div className={styles.formatButtonDesc}>8 versos de 8 líneas</div>
            </button>
            <button
              onClick={() => handleFormatChange('minuto-libre')}
              className={styles.formatButton}
            >
              <div className={styles.formatButtonTitle}>Minuto Libre</div>
              <div className={styles.formatButtonDesc}>60 segundos por turno</div>
            </button>
          </div>
        </div>
      )}

      {!battleStarted && websocketConnected && allPeersConnected && hasPeers && battleFormat && (
        <div className={styles.formatDisplay}>
          <p className={styles.formatLabel}>Formato seleccionado:</p>
          <p className={styles.formatValue}>
            {battleFormat === '4x4' && '4x4 (4 versos de 4 líneas)'}
            {battleFormat === '8x8' && '8x8 (8 versos de 8 líneas)'}
            {battleFormat === 'minuto-libre' && 'Minuto Libre (60 segundos)'}
          </p>
        </div>
      )}

      {!battleStarted && websocketConnected && allPeersConnected && hasPeers && !isReady && battleFormat && (
        <button onClick={handleReady} className={styles.readyButton}>
          Estoy listo
        </button>
      )}

      {!isHost && (
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
