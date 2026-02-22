'use client';

import { useSearchParams, useParams, useRouter } from 'next/navigation';
import React, { useEffect, useState, useRef, Suspense, useCallback } from 'react';
import { useWebRTC, WebRTCState } from '@/hooks/useWebRTC';
import { useAudioControls } from '@/hooks/useAudioControls';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { SignalingMessage } from '@/lib/websocket';
import { PusherSignalingClient } from '@/lib/pusher-client';
import { audioContextManager } from '@/lib/audio-context-manager';
import { BattleFormat, getBeatIntroOffset, getBattleFormatConfig, BATTLE_FORMATS, BEAT_INTRO_OFFSETS } from '@/lib/battle-formats';
import { CachipumChoice, CachipumRoundResult, determineRoundWinners, determineCachipumWinner, getCachipumEmoji, getCachipumLabel } from '@/lib/cachipum';
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
  const router = useRouter();
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
  const [battleStarted, setBattleStarted] = useState(false);
  const [beatAudio, setBeatAudio] = useState<HTMLAudioElement | null>(null);
  const [selectedBeat, setSelectedBeat] = useState<number>(1);
  const [websocketConnected, setWebsocketConnected] = useState(false);
  const [isBeatPlaying, setIsBeatPlaying] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [battleFormat, setBattleFormat] = useState<BattleFormat | null>(null);
  const [battleEntries, setBattleEntries] = useState<number | null>(null);
  const [customTurnSeconds, setCustomTurnSeconds] = useState<number | null>(null); // Segundos personalizados por turno
  const [customTurnSecondsInput, setCustomTurnSecondsInput] = useState<string>(''); // Estado local para el input
  const [completedTurns, setCompletedTurns] = useState<Set<number>>(new Set());
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>(0);
  const [currentTurn, setCurrentTurn] = useState<{ userId: string; turnNumber: number; startTime: number; beatStartTime: number } | null>(null);
  const [turnProgress, setTurnProgress] = useState<{ verses: number; lines: number } | { timeRemaining: number } | null>(null);
  const [beatIntroOffset, setBeatIntroOffset] = useState<number>(0);
  const [beatOffsets, setBeatOffsets] = useState<Map<number, number>>(new Map());
  const [cachipumChoices, setCachipumChoices] = useState<Map<string, CachipumChoice[]>>(new Map());
  const [cachipumRound, setCachipumRound] = useState<number>(1);
  const [cachipumResults, setCachipumResults] = useState<CachipumRoundResult[]>([]);
  const [cachipumWinner, setCachipumWinner] = useState<string | null>(null);
  const [cachipumStarter, setCachipumStarter] = useState<string | null>(null);
  const [showCachipum, setShowCachipum] = useState<boolean>(false);
  const [showCachipumDecision, setShowCachipumDecision] = useState<boolean>(false);
  const [showCachipumLoser, setShowCachipumLoser] = useState<boolean>(false);
  const [showCachipumAnimation, setShowCachipumAnimation] = useState<boolean>(false);
  const [currentCachipumRoundDisplay, setCurrentCachipumRoundDisplay] = useState<number>(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isBeatModalOpen, setIsBeatModalOpen] = useState<boolean>(false);
  const [isFormatModalOpen, setIsFormatModalOpen] = useState<boolean>(false);
  const [previewingBeat, setPreviewingBeat] = useState<number | null>(null);
  const [previewBeatTime, setPreviewBeatTime] = useState<number>(0);
  const [isPreviewPaused, setIsPreviewPaused] = useState<boolean>(false);
  const [activeBeatTab, setActiveBeatTab] = useState<number>(1);
  const [localMicLevel, setLocalMicLevel] = useState<number>(0);
  const [remoteMicLevels, setRemoteMicLevels] = useState<Map<string, number>>(new Map());

  // ─── Cambiar pestaña de beat ───
  const handleBeatTabChange = useCallback((beatNum: number) => {
    // Si hay un beat reproduciéndose y cambiamos a otra pestaña, detenerlo
    if (previewingBeat !== null && previewingBeat !== beatNum) {
      const audio = previewAudioRefs.current.get(previewingBeat);
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      setPreviewingBeat(null);
      setPreviewBeatTime(0);
      setIsPreviewPaused(false);
    }
    setActiveBeatTab(beatNum);
  }, [previewingBeat]);

  // ─── Refs ───
  const userIdRef = useRef(`user-${Date.now()}-${Math.random()}`);
  const signalingRef = useRef<PusherSignalingClient | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const webrtcHandleMessageRef = useRef<((message: SignalingMessage) => void) | null>(null);
  const beatAudioRef = useRef<HTMLAudioElement | null>(null);
  const beatGainNodeRef = useRef<GainNode | null>(null);
  const beatSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const previewAudioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
  const peersRef = useRef<Map<string, { nickname: string }>>(new Map());
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
  const pausedTimeRef = useRef<number | null>(null); // Tiempo cuando se pausó
  const elapsedBeforePauseRef = useRef<number>(0); // Tiempo transcurrido antes de pausar
  const cachipumStarterRef = useRef<string | null>(null); // Ref para cachipumStarter
  const cachipumProcessingRef = useRef<boolean>(false); // Evitar doble procesamiento en host
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const localMicSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteMicAnalyserRefs = useRef<Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode }>>(new Map());
  const micLevelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    // Usar peersRef para obtener la información más reciente
    const currentPeers = peersRef.current || peers;
    // Usar cachipumStarterRef para obtener el valor más reciente
    const currentCachipumStarter = cachipumStarterRef.current || cachipumStarter;
    const allUsers = [userIdRef.current, ...Array.from(currentPeers.keys())];
    
    // Si hay un cachipumStarter, debe ir primero sin importar el orden alfabético
    if (currentCachipumStarter) {
      // Crear un Set para eliminar duplicados
      const uniqueUsers = new Set(allUsers);
      // Asegurarse de que el cachipumStarter esté en la lista
      uniqueUsers.add(currentCachipumStarter);
      // Convertir a array, ordenar alfabéticamente
      const sorted = Array.from(uniqueUsers).sort();
      // Mover el cachipumStarter al principio
      const starterIndex = sorted.indexOf(currentCachipumStarter);
      if (starterIndex > 0) {
        sorted.splice(starterIndex, 1);
        sorted.unshift(currentCachipumStarter);
      }
      return sorted;
    }
    
    // Si no hay cachipumStarter, simplemente ordenar alfabéticamente
    return Array.from(new Set(allUsers)).sort();
  }, [peers, cachipumStarter]);

  const startTurn = useCallback((userId: string, turnNumber: number, format: BattleFormat) => {
    if (!isHost) return;

    // Si es el primer turno, SIEMPRE usar el cachipumStarter si está disponible
    let finalUserId = userId;
    if (turnNumber === 1) {
      // Priorizar el ref (más actualizado), luego el state
      const currentCachipumStarter = cachipumStarterRef.current || cachipumStarter;
      if (currentCachipumStarter) {
        // Forzar el uso del cachipumStarter, ignorar el userId pasado como parámetro
        finalUserId = currentCachipumStarter;
      }
    }

    // El tiempo del turno comienza desde el offset del beat
    // startTime es el timestamp del sistema cuando el beat llegará al offset
    const beatStartTime = beatIntroOffset;
    // Calcular cuándo el beat llegará al offset (ahora + tiempo hasta el offset)
    const now = Date.now();
    const audio = beatAudioRef.current || beatAudio;
    const currentBeatTime = audio ? audio.currentTime : 0;
    const timeUntilOffset = Math.max(0, (beatIntroOffset - currentBeatTime) * 1000);
    const startTime = now + timeUntilOffset;
    
    // Resetear referencias de pausa cuando comienza un nuevo turno
    pausedTimeRef.current = null;
    elapsedBeforePauseRef.current = 0;
    
    // Obtener el nickname del usuario que tiene el turno
    // Para el primer turno, SIEMPRE usar el cachipumStarter y obtener su nickname
    let turnNickname: string | undefined;
    if (turnNumber === 1) {
      // Si es el primer turno, usar el cachipumStarter para obtener el nickname correcto
      const currentCachipumStarter = cachipumStarterRef.current || cachipumStarter;
      if (currentCachipumStarter) {
        if (currentCachipumStarter === userIdRef.current) {
          turnNickname = nickname;
        } else {
          const peerInfo = peersRef.current?.get(currentCachipumStarter) || peers.get(currentCachipumStarter);
          if (peerInfo) {
            turnNickname = 'nickname' in peerInfo ? peerInfo.nickname : (peerInfo as any).nickname;
          }
        }
      }
    }
    
    // Si no se obtuvo el nickname (turnos siguientes o fallback), usar la lógica normal
    if (!turnNickname) {
      if (finalUserId === userIdRef.current) {
        turnNickname = nickname;
      } else {
        const peerInfo = peersRef.current?.get(finalUserId) || peers.get(finalUserId);
        if (peerInfo) {
          turnNickname = 'nickname' in peerInfo ? peerInfo.nickname : (peerInfo as any).nickname;
        }
      }
    }

    // Actualizar ref primero para evitar problemas de timing
    // Incluir el nickname en turnData para que todos (host y oponentes) usen la misma fuente
    const turnData: any = { 
      userId: finalUserId, 
      turnNumber, 
      startTime, 
      beatStartTime,
      nickname: turnNickname, // Guardar el nickname para renderizado consistente
    };
    currentTurnRef.current = turnData;
    
    // Actualizar estados de forma batch para evitar múltiples re-renderizados
    setCurrentTurn(turnData);
    setActiveSegmentIndex(turnNumber - 1);
    
    const config = getBattleFormatConfig(format);
    const turnDuration = customTurnSeconds || config.timePerTurnSeconds || 60;
    setTurnProgress({ timeRemaining: turnDuration });

    // Enviar mensaje después de actualizar estados
    signalingRef.current?.send({
      type: 'turn-started',
      userId: finalUserId,
      turnNumber,
      startTime,
      format,
      nickname: turnNickname,
    });
  }, [isHost, beatIntroOffset, beatAudio, cachipumStarter]);

  const endTurn = useCallback((userId: string, turnNumber: number) => {
    if (!isHost) return;

    signalingRef.current?.send({
      type: 'turn-ended',
      userId,
      turnNumber,
    });

    // Marcar turno como completado en el diagrama
    setCompletedTurns(prev => new Set(prev).add(turnNumber));

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

    const currentTurnData = currentTurnRef.current;
    if (!currentTurnData) return;
    
    const currentTurnNum = currentTurnData.turnNumber;
    const currentUserId = currentTurnData.userId;
    
    // Verificar si se alcanzó el número máximo de turnos según battleEntries
    if (battleEntries && currentTurnNum >= battleEntries) {
      // Batalla terminada - finalizar turno actual y no iniciar siguiente
      endTurn(currentUserId, currentTurnNum);
      return;
    }
    
    // Encontrar índice del usuario actual en la lista ordenada
    const currentIndex = orderedUsers.indexOf(currentUserId);
    if (currentIndex === -1) {
      // Si el usuario actual no está en la lista, usar el primero
      const nextUserId = orderedUsers[0];
      const nextTurnNum = currentTurnNum + 1;
      endTurn(currentUserId, currentTurnNum);
      if (!battleEntries || nextTurnNum <= battleEntries) {
        setTimeout(() => {
          startTurn(nextUserId, nextTurnNum, battleFormatRef.current!);
        }, 500);
      }
      return;
    }
    
    const nextIndex = (currentIndex + 1) % orderedUsers.length;
    const nextUserId = orderedUsers[nextIndex];
    const nextTurnNum = currentTurnNum + 1;

    // Finalizar turno actual
    endTurn(currentUserId, currentTurnNum);

    // Iniciar siguiente turno solo si no se excedió el límite
    if (!battleEntries || nextTurnNum <= battleEntries) {
      setTimeout(() => {
        startTurn(nextUserId, nextTurnNum, battleFormatRef.current!);
      }, 500);
    }
  }, [isHost, getOrderedUserIds, startTurn, endTurn, battleEntries]);

  // ─── Battle Logic ───
  const startBattle = useCallback(async (serverTimestamp: number) => {
    setBattleStarted(true);
    // Resetear estados del diagrama al iniciar batalla
    setCompletedTurns(new Set());
    setActiveSegmentIndex(0);
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
            // Esperar un poco para asegurar que el cachipumStarter esté disponible
            const waitForStarter = (attempts: number = 0) => {
              // Priorizar el ref (más actualizado), luego el state
              const currentCachipumStarter = cachipumStarterRef.current || cachipumStarter;
              if (currentCachipumStarter) {
                // Usar directamente el cachipumStarter
                setTimeout(() => {
                  // startTurn() validará nuevamente, pero pasamos el cachipumStarter para ser explícitos
                  startTurn(currentCachipumStarter, 1, battleFormatRef.current!);
                }, 100);
              } else if (attempts < 20) {
                // Esperar un poco más si no está disponible (hasta 2 segundos)
                setTimeout(() => waitForStarter(attempts + 1), 100);
              } else {
                // Fallback después de 2 segundos: usar getOrderedUserIds()
                // Pero esto no debería pasar si el cachipum se completó correctamente
                const orderedUsers = getOrderedUserIds();
                if (orderedUsers.length > 0) {
                  setTimeout(() => {
                    startTurn(orderedUsers[0], 1, battleFormatRef.current!);
                  }, 100);
                }
              }
            };
            waitForStarter();
          }
        }
      }
    }, delay);
  }, [beatAudio, isHost, playBeat, beatIntroOffset, getOrderedUserIds, startTurn]);

  const toggleBeat = useCallback(async () => {
    if (!isHost) return;
    if (isBeatPlaying) {
      // Guardar el tiempo transcurrido antes de pausar
      if (currentTurnRef.current) {
        const now = Date.now();
        const elapsed = (now - currentTurnRef.current.startTime) / 1000;
        elapsedBeforePauseRef.current = elapsed;
        pausedTimeRef.current = now;
      }
      pauseBeat();
      signalingRef.current?.send({ type: 'beat-pause' });
    } else {
      // Ajustar el startTime cuando se reanuda
      if (currentTurnRef.current && pausedTimeRef.current !== null) {
        const now = Date.now();
        const pauseDuration = (now - pausedTimeRef.current) / 1000;
        // Ajustar startTime para compensar el tiempo pausado
        const newStartTime = currentTurnRef.current.startTime + (pauseDuration * 1000);
        currentTurnRef.current.startTime = newStartTime;
        setCurrentTurn({
          ...currentTurnRef.current,
          startTime: newStartTime,
        });
        pausedTimeRef.current = null;
      }
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
      // Reiniciar el turno al primero si hay un turno activo
      if (currentTurnRef.current && battleFormatRef.current) {
        const currentUserId = currentTurnRef.current.userId;
        const currentTurnNum = currentTurnRef.current.turnNumber;
        
        // Finalizar turno actual
        endTurn(currentUserId, currentTurnNum);
        
        // Reiniciar al primer turno del primer usuario
        const orderedUsers = getOrderedUserIds();
        if (orderedUsers.length > 0) {
          setTimeout(() => {
            startTurn(orderedUsers[0], 1, battleFormatRef.current!);
          }, 500);
        }
      }
      signalingRef.current?.send({ type: 'beat-restart' });
    })();
  }, [isHost, restartBeatInternal, getOrderedUserIds, startTurn, endTurn]);

  // ─── Reset Battle (reiniciar completamente la batalla) ───
  const resetBattle = useCallback(async () => {
    if (!isHost) return;
    
    // Detener el beat
    if (beatAudioRef.current) {
      beatAudioRef.current.pause();
      beatAudioRef.current.currentTime = 0;
    }
    setIsBeatPlaying(false);
    
    // Limpiar intervalos
    if (turnProgressIntervalRef.current) {
      clearInterval(turnProgressIntervalRef.current);
      turnProgressIntervalRef.current = null;
    }
    
    // Resetear todos los estados de la batalla
    setBattleStarted(false);
    setCurrentTurn(null);
    currentTurnRef.current = null;
    setTurnProgress(null);
    setCompletedTurns(new Set());
    setActiveSegmentIndex(0);
    setIsReady(false);
    
    // Resetear referencias de pausa
    pausedTimeRef.current = null;
    elapsedBeforePauseRef.current = 0;
    
    // Enviar mensaje a los peers para sincronizar
    signalingRef.current?.send({ type: 'battle-reset' });
  }, [isHost]);

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

  // Mantener peersRef actualizado con el estado de peers
  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  // Mantener cachipumStarterRef actualizado con el estado de cachipumStarter
  useEffect(() => {
    cachipumStarterRef.current = cachipumStarter;
  }, [cachipumStarter]);

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

          case 'not-ready':
            if (message.userId !== userIdRef.current) {
              setPeers(prev => {
                const next = new Map(prev);
                const peer = next.get(message.userId);
                if (peer) next.set(message.userId, { ...peer, isReady: false });
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
              // Ajustar el startTime cuando se reanuda
              if (currentTurnRef.current && pausedTimeRef.current !== null) {
                const now = Date.now();
                const pauseDuration = (now - pausedTimeRef.current) / 1000;
                // Ajustar startTime para compensar el tiempo pausado
                const newStartTime = currentTurnRef.current.startTime + (pauseDuration * 1000);
                currentTurnRef.current.startTime = newStartTime;
                setCurrentTurn({
                  ...currentTurnRef.current,
                  startTime: newStartTime,
                });
                pausedTimeRef.current = null;
              }
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
            if (!isHostRef.current) {
              // Guardar el tiempo transcurrido antes de pausar
              if (currentTurnRef.current) {
                const now = Date.now();
                const elapsed = (now - currentTurnRef.current.startTime) / 1000;
                elapsedBeforePauseRef.current = elapsed;
                pausedTimeRef.current = now;
              }
              pauseBeatRef.current?.();
            }
            break;

          case 'beat-restart':
            if (!isHostRef.current) {
              (async () => {
                await restartBeatInternalRef.current?.();
                // Reiniciar el turno al primero si hay un turno activo
                // El host enviará el nuevo turn-started después de reiniciar
                if (currentTurnRef.current) {
                  setCurrentTurn(null);
                  currentTurnRef.current = null;
                  setTurnProgress(null);
                }
              })();
            }
            break;

          case 'battle-reset':
            if (message.userId !== userIdRef.current) {
              // Detener el beat
              if (beatAudioRef.current) {
                beatAudioRef.current.pause();
                beatAudioRef.current.currentTime = 0;
              }
              setIsBeatPlaying(false);
              
              // Limpiar intervalos
              if (turnProgressIntervalRef.current) {
                clearInterval(turnProgressIntervalRef.current);
                turnProgressIntervalRef.current = null;
              }
              
              // Resetear todos los estados de la batalla
              setBattleStarted(false);
              setCurrentTurn(null);
              currentTurnRef.current = null;
              setTurnProgress(null);
              setCompletedTurns(new Set());
              setActiveSegmentIndex(0);
              setIsReady(false);
              
              // Resetear referencias de pausa
              pausedTimeRef.current = null;
              elapsedBeforePauseRef.current = 0;
            }
            break;

          case 'battle-format-selected':
            if (message.userId !== userIdRef.current) {
              setBattleFormat(message.format);
              battleFormatRef.current = message.format;
              setBattleEntries(message.totalEntries);
              if (message.customTurnSeconds !== undefined) {
                setCustomTurnSeconds(message.customTurnSeconds);
                setCustomTurnSecondsInput(message.customTurnSeconds.toString());
              }
              // NO iniciar cachipum automáticamente - se hace manualmente con el botón
            }
            break;

          case 'cachipum-start':
            cachipumProcessingRef.current = false;
            if (message.userId && message.userId !== userIdRef.current) {
              // Iniciar cachipum cuando el host lo solicita
              setShowCachipum(true);
              setCachipumRound(1);
              setCachipumChoices(new Map());
              setCachipumResults([]);
              setCachipumWinner(null);
              setCachipumStarter(null);
            }
            break;

          case 'turn-started':
            // El tiempo del turno comienza desde el offset del beat
            // Asegurarse de usar el offset actual del beat seleccionado
            const beatStartTime = beatIntroOffset;
            // Resetear referencias de pausa cuando comienza un nuevo turno
            pausedTimeRef.current = null;
            elapsedBeforePauseRef.current = 0;
            
            // Para el primer turno, SIEMPRE usar el cachipumStarter si está disponible
            // Esto asegura que todos vean el nombre del ganador del cachipum
            let finalUserId = message.userId;
            let finalNickname = message.nickname;
            
            if (message.turnNumber === 1) {
              const currentCachipumStarter = cachipumStarterRef.current || cachipumStarter;
              if (currentCachipumStarter) {
                finalUserId = currentCachipumStarter;
                // Obtener el nickname del cachipumStarter
                if (currentCachipumStarter === userIdRef.current) {
                  finalNickname = nickname;
                } else {
                  const peerInfo = peersRef.current?.get(currentCachipumStarter) || peers.get(currentCachipumStarter);
                  if (peerInfo) {
                    finalNickname = 'nickname' in peerInfo ? peerInfo.nickname : (peerInfo as any).nickname;
                  }
                }
              }
            }
            
            // Actualizar ref primero
            const turnData: any = {
              userId: finalUserId,
              turnNumber: message.turnNumber,
              startTime: message.startTime,
              beatStartTime,
            };
            // Agregar nickname (priorizar el del cachipumStarter para turno 1, o el del mensaje)
            if (finalNickname) {
              turnData.nickname = finalNickname;
            }
            currentTurnRef.current = turnData;
            
            // Actualizar estados de forma batch para evitar múltiples re-renderizados
            setCurrentTurn(turnData);
            setBattleFormat(message.format);
            battleFormatRef.current = message.format;
            setActiveSegmentIndex(message.turnNumber - 1);
            
            const config = getBattleFormatConfig(message.format);
            const turnDuration = customTurnSeconds || config.timePerTurnSeconds || 60;
            setTurnProgress({ timeRemaining: turnDuration });
            break;

          case 'turn-ended':
            if (message.userId === currentTurnRef.current?.userId) {
              // Marcar turno como completado en el diagrama
              setCompletedTurns(prev => new Set(prev).add(message.turnNumber));
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

          case 'cachipum-choice':
            if (message.userId !== userIdRef.current) {
              setCachipumChoices(prev => {
                const next = new Map(prev);
                const existing = next.get(message.userId) || [];
                const updated = [...existing, message.choice];
                next.set(message.userId, updated);
                
                // Si es host, verificar si todos han completado después de actualizar el estado
                // Solo procesar si el usuario que envió la opción tiene exactamente 3 opciones
                if (isHostRef.current && updated.length === 3) {
                  setTimeout(() => {
                    const allUsers = [userIdRef.current, ...Array.from(peers.keys())];
                    const allComplete = allUsers.every(userId => {
                      const choices = next.get(userId);
                      return choices && choices.length === 3;
                    });
                    
                    if (allComplete) {
                      // Usar checkAllCachipumChoicesComplete para procesar (evitar duplicación)
                      setTimeout(() => {
                        checkAllCachipumChoicesComplete();
                      }, 100);
                    }
                  }, 200);
                }
                
                return next;
              });
            }
            break;

          case 'cachipum-round-result':
            // Procesar resultados siempre (para que todos puedan ver la animación)
            const roundChoices = new Map<string, CachipumChoice>();
            Object.entries(message.choices).forEach(([userId, choice]) => {
              roundChoices.set(userId, choice);
            });
            
            const roundResult: CachipumRoundResult = {
              round: message.round,
              choices: roundChoices,
              winners: message.winners,
            };
            
            setCachipumResults(prev => {
              const next = [...prev];
              const index = next.findIndex(r => r.round === message.round);
              if (index >= 0) {
                next[index] = roundResult;
              } else {
                next.push(roundResult);
              }
              return next.sort((a, b) => a.round - b.round);
            });
            break;

          case 'cachipum-winner':
            // Solo guardar ganador; la animación se abrirá cuando tengamos también los 3 resultados (useEffect)
            setCachipumWinner(message.winnerId);
            break;

          case 'cachipum-restart':
            cachipumProcessingRef.current = false;
            // Reiniciar cachipum si hay empate en las 3 rondas
            setCachipumChoices(new Map());
            setCachipumResults([]);
            setCachipumRound(1);
            setCachipumWinner(null);
            setShowCachipumAnimation(false);
            setCurrentCachipumRoundDisplay(0);
            setShowCachipum(true); // Reabrir modal para jugar de nuevo
            break;

          case 'cachipum-starter-selected':
            setCachipumStarter(message.starterId);
            // Actualizar el ref inmediatamente para evitar problemas de timing
            cachipumStarterRef.current = message.starterId;
            setShowCachipumDecision(false);
            setShowCachipumLoser(false); // Cerrar también el mensaje del perdedor
            setShowCachipum(false);
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

  // ─── Medidor de nivel de micrófono (local + remotos) ───
  useEffect(() => {
    const ctx = audioContextManager.getContext();
    const dataArray = new Uint8Array(256);

    function getLevel(analyser: AnalyserNode): number {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      return Math.min(1, (avg / 128) * 1.5);
    }

    if (localStream && localStream.getAudioTracks().length > 0) {
      try {
        const source = ctx.createMediaStreamSource(localStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        localMicSourceRef.current = source;
        audioAnalyserRef.current = analyser;
      } catch {
        localMicSourceRef.current = null;
        audioAnalyserRef.current = null;
      }
    } else {
      localMicSourceRef.current = null;
      audioAnalyserRef.current = null;
    }

    const prevRemote = remoteMicAnalyserRefs.current;
    remoteMicAnalyserRefs.current = new Map();
    remoteStreams.forEach((stream, userId) => {
      if (stream.getAudioTracks().length === 0) return;
      try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        remoteMicAnalyserRefs.current.set(userId, { source, analyser });
      } catch {
        // skip this peer
      }
    });
    prevRemote.forEach(({ source }) => {
      try { source.disconnect(); } catch { /* already disconnected */ }
    });

    micLevelIntervalRef.current = setInterval(() => {
      const localAnalyser = audioAnalyserRef.current;
      if (localAnalyser) {
        setLocalMicLevel(getLevel(localAnalyser));
      } else {
        setLocalMicLevel(0);
      }
      const next = new Map<string, number>();
      remoteMicAnalyserRefs.current.forEach(({ analyser }, userId) => {
        next.set(userId, getLevel(analyser));
      });
      setRemoteMicLevels(next);
    }, 50);

    return () => {
      if (micLevelIntervalRef.current) {
        clearInterval(micLevelIntervalRef.current);
        micLevelIntervalRef.current = null;
      }
      if (localMicSourceRef.current) {
        try { localMicSourceRef.current.disconnect(); } catch { /* ok */ }
        localMicSourceRef.current = null;
      }
      audioAnalyserRef.current = null;
      remoteMicAnalyserRefs.current.forEach(({ source }) => {
        try { source.disconnect(); } catch { /* ok */ }
      });
      remoteMicAnalyserRefs.current = new Map();
    };
  }, [localStream, remoteStreams]);

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

  // ─── Handle Not Ready ───
  const handleNotReady = useCallback(() => {
    if (!isReady) return;
    setIsReady(false);

    signalingRef.current?.send({
      type: 'not-ready',
      userId: userIdRef.current,
    });
  }, [isReady]);

  // ─── Salir de la sala (notificar a otros, desconectar y volver al inicio) ───
  const handleLeaveRoom = useCallback(() => {
    const channelName = `private-room-${roomId}`;
    const payload = new Blob(
      [JSON.stringify({
        channel: channelName,
        event: 'peer-disconnected',
        data: { userId: userIdRef.current },
      })],
      { type: 'application/json' }
    );
    navigator.sendBeacon('/api/pusher/trigger', payload);
    signalingRef.current?.disconnect();
    signalingRef.current = null;
    localStream?.getTracks().forEach(t => t.stop());
    router.push('/');
  }, [roomId, localStream, router]);

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
    if (!battleStarted || !currentTurn || !battleFormat) {
      // Si no hay turno activo, limpiar el intervalo pero mantener el estado
      if (turnProgressIntervalRef.current) {
        clearInterval(turnProgressIntervalRef.current);
        turnProgressIntervalRef.current = null;
      }
      return;
    }

    const format = battleFormat;
    const config = getBattleFormatConfig(format);
    const duration = (customTurnSeconds || config.timePerTurnSeconds || 60); // en segundos

    // Guardar referencia al turno actual para evitar problemas de closure
    const currentTurnData = currentTurnRef.current || currentTurn;

    const updateProgress = () => {
      // Verificar que el turno actual sigue siendo el mismo
      const latestTurn = currentTurnRef.current;
      if (!latestTurn || latestTurn.turnNumber !== currentTurnData.turnNumber || latestTurn.userId !== currentTurnData.userId) {
        // El turno cambió, no actualizar
        return;
      }

      // Solo actualizar si el beat está reproduciéndose
      if (!isBeatPlaying) {
        // Si está pausado, mantener el tiempo actual sin actualizar
        return;
      }

      // Usar el tiempo del sistema para sincronizar entre usuarios
      // startTime es el timestamp cuando el beat llegó al offset
      const now = Date.now();
      const startTime = currentTurnData.startTime;
      
      // Si aún no ha llegado el tiempo del offset, mostrar el tiempo completo
      if (now < startTime) {
        setTurnProgress(prev => {
          // Solo actualizar si el valor cambió para evitar re-renders innecesarios
          if (!prev || !('timeRemaining' in prev) || prev.timeRemaining !== duration) {
            return { timeRemaining: duration };
          }
          return prev;
        });
        return;
      }

      // Calcular tiempo transcurrido desde que el beat llegó al offset
      // Usar tiempo del sistema para sincronización precisa
      const elapsed = (now - startTime) / 1000; // en segundos
      const remaining = Math.max(0, duration - elapsed);
      const remainingSeconds = Math.ceil(remaining);

      // Solo actualizar si el tiempo restante es válido y cambió
      if (remainingSeconds >= 0 && remainingSeconds <= duration) {
        setTurnProgress(prev => {
          // Solo actualizar si el valor cambió para evitar re-renders innecesarios
          if (!prev || !('timeRemaining' in prev) || prev.timeRemaining !== remainingSeconds) {
            return { timeRemaining: remainingSeconds };
          }
          return prev;
        });
      }

      if (remaining <= 0 && isHost) {
        // Verificar que el turno sigue siendo el mismo antes de cambiar
        const finalTurn = currentTurnRef.current;
        if (finalTurn && finalTurn.turnNumber === currentTurnData.turnNumber && finalTurn.userId === currentTurnData.userId) {
          // Verificar si se completaron todos los turnos según battleEntries
          if (battleEntries && currentTurnData.turnNumber >= battleEntries) {
            // Batalla terminada - no iniciar siguiente turno
            endTurn(currentTurnData.userId, currentTurnData.turnNumber);
          } else {
            nextTurn();
          }
        }
      }
    };

    // Limpiar intervalo anterior solo si el turno realmente cambió
    const previousInterval = turnProgressIntervalRef.current;
    if (previousInterval) {
      clearInterval(previousInterval);
      turnProgressIntervalRef.current = null;
    }

    // Actualizar inmediatamente
    updateProgress();

    // Actualizar cada 100ms solo si el beat está reproduciéndose
    turnProgressIntervalRef.current = setInterval(() => {
      if (isBeatPlaying) {
        updateProgress();
      }
    }, 100);

    return () => {
      // Limpiar el intervalo cuando el efecto se desmonte o cambien las dependencias
      if (turnProgressIntervalRef.current) {
        clearInterval(turnProgressIntervalRef.current);
        turnProgressIntervalRef.current = null;
      }
    };
  }, [battleStarted, currentTurn, battleFormat, isHost, nextTurn, isBeatPlaying, beatAudio, beatIntroOffset, customTurnSeconds, battleEntries, endTurn]);

  // ─── Cerrar modal de cachipum cuando el usuario complete sus 3 opciones ───
  useEffect(() => {
    if (!showCachipum) return;
    
    const myChoices = cachipumChoices.get(userIdRef.current) || [];
    
    // Cerrar el modal inmediatamente cuando el usuario complete sus 3 opciones
    if (myChoices.length === 3) {
      setShowCachipum(false);
    }
  }, [showCachipum, cachipumChoices]);

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

  // ─── Beat Preview ───
  const handleBeatPreview = useCallback(async (beatNumber: number) => {
    // Si ya está reproduciendo este beat, pausar/reanudar
    if (previewingBeat === beatNumber) {
      const audio = previewAudioRefs.current.get(beatNumber);
      if (audio) {
        if (isPreviewPaused) {
          await audio.play();
          setIsPreviewPaused(false);
        } else {
          audio.pause();
          setIsPreviewPaused(true);
        }
      }
      return;
    }

    // Detener cualquier otra previsualización
    if (previewingBeat !== null) {
      const prevAudio = previewAudioRefs.current.get(previewingBeat);
      if (prevAudio) {
        prevAudio.pause();
        prevAudio.currentTime = 0;
      }
    }

    // Obtener o crear el audio para este beat
    let audio = previewAudioRefs.current.get(beatNumber);
    if (!audio) {
      audio = new Audio(`/beats/beat${beatNumber}.mp3`);
      audio.loop = true;
      audio.setAttribute('playsinline', 'true');
      audio.setAttribute('preload', 'auto');
      audio.volume = beatVolume;
      
      // Actualizar tiempo cuando el audio se reproduce
      const audioForListener = audio;
      audio.addEventListener('timeupdate', () => {
        setPreviewBeatTime(audioForListener.currentTime);
      });
      
      previewAudioRefs.current.set(beatNumber, audio);
    }

    try {
      await audioContextManager.unlockFromGesture();
      audio.currentTime = 0;
      setPreviewBeatTime(0);
      await audio.play();
      setPreviewingBeat(beatNumber);
      setIsPreviewPaused(false);
    } catch (err) {
      console.error('Error al previsualizar beat:', err);
    }
  }, [previewingBeat, beatVolume, isPreviewPaused]);

  // ─── Formatear tiempo a MM:SS ───
  const formatTime = useCallback((seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }, []);

  // ─── Reiniciar previsualización ───
  const handleBeatPreviewRestart = useCallback(() => {
    if (previewingBeat === null) return;
    const audio = previewAudioRefs.current.get(previewingBeat);
    if (audio) {
      audio.currentTime = 0;
      setPreviewBeatTime(0);
      if (!isPreviewPaused) {
        audio.play();
      }
    }
  }, [previewingBeat, isPreviewPaused]);

  // ─── Actualizar tiempo del beat en previsualización ───
  useEffect(() => {
    if (previewingBeat === null || isPreviewPaused) return;

    const interval = setInterval(() => {
      const audio = previewAudioRefs.current.get(previewingBeat);
      if (audio) {
        setPreviewBeatTime(audio.currentTime);
      }
    }, 100); // Actualizar cada 100ms

    return () => clearInterval(interval);
  }, [previewingBeat, isPreviewPaused]);

  // ─── Sincronizar volumen de previsualización ───
  useEffect(() => {
    previewAudioRefs.current.forEach((audio) => {
      audio.volume = beatVolume;
    });
  }, [beatVolume]);

  // ─── Detener todas las previsualizaciones al cerrar el modal ───
  useEffect(() => {
    if (!isBeatModalOpen && previewingBeat !== null) {
      const audio = previewAudioRefs.current.get(previewingBeat);
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      setPreviewingBeat(null);
      setPreviewBeatTime(0);
      setIsPreviewPaused(false);
    }
  }, [isBeatModalOpen, previewingBeat]);

  // ─── Limpiar audios de previsualización al desmontar ───
  useEffect(() => {
    return () => {
      previewAudioRefs.current.forEach((audio) => {
        audio.pause();
        audio.src = '';
      });
      previewAudioRefs.current.clear();
    };
  }, []);

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
    // Si hay segundos personalizados, usarlos; si no, usar los del formato
    const config = getBattleFormatConfig(format);
    if (customTurnSeconds === null) {
      const defaultSeconds = config.timePerTurnSeconds || 60;
      setCustomTurnSeconds(defaultSeconds);
      setCustomTurnSecondsInput(defaultSeconds.toString());
    }
    // Solo enviar si también hay entradas seleccionadas
    if (battleEntries !== null) {
      signalingRef.current?.send({
        type: 'battle-format-selected',
        format,
        totalEntries: battleEntries,
        customTurnSeconds: customTurnSeconds || config.timePerTurnSeconds || 60,
      });
    }
    // NO iniciar cachipum automáticamente - se hace manualmente con el botón
  }, [isHost, battleEntries, customTurnSeconds]);

  // ─── Battle Entries Change (host only) ───
  const handleEntriesChange = useCallback((entries: number) => {
    if (!isHost) return;
    setBattleEntries(entries);
    // Solo enviar si también hay formato seleccionado
    if (battleFormat) {
      const config = getBattleFormatConfig(battleFormat);
      signalingRef.current?.send({
        type: 'battle-format-selected',
        format: battleFormat,
        totalEntries: entries,
        customTurnSeconds: customTurnSeconds || config.timePerTurnSeconds || 60,
      });
    }
  }, [isHost, battleFormat, customTurnSeconds]);

  // ─── Custom Turn Seconds Change (host only) ───
  const handleCustomTurnSecondsChange = useCallback((seconds: number) => {
    if (!isHost) return;
    setCustomTurnSeconds(seconds);
    setCustomTurnSecondsInput(seconds.toString());
    // Solo enviar si también hay formato y entradas seleccionados
    if (battleFormat && battleEntries !== null) {
      signalingRef.current?.send({
        type: 'battle-format-selected',
        format: battleFormat,
        totalEntries: battleEntries,
        customTurnSeconds: seconds,
      });
    }
  }, [isHost, battleFormat, battleEntries]);

  // ─── Start Cachipum (host only) ───
  const handleStartCachipum = useCallback(() => {
    if (!isHost) return;
    if (!battleFormat) return;
    cachipumProcessingRef.current = false;
    setShowCachipum(true);
    setCachipumRound(1);
    setCachipumChoices(new Map());
    setCachipumResults([]);
    setCachipumWinner(null);
    setCachipumStarter(null);
    // Enviar mensaje a otros clientes para iniciar cachipum
    signalingRef.current?.send({
      type: 'cachipum-start',
    });
  }, [isHost, battleFormat]);

  // ─── Cachipum Logic ───
  const handleCachipumChoice = useCallback((choice: CachipumChoice) => {
    const currentChoices = cachipumChoices.get(userIdRef.current) || [];
    
    // Verificar que no haya elegido ya 3 opciones
    if (currentChoices.length >= 3) return;
    
    // Agregar la nueva opción
    const newChoices = [...currentChoices, choice];
    setCachipumChoices(prev => {
      const next = new Map(prev);
      next.set(userIdRef.current, newChoices);
      return next;
    });
    
    // Enviar la selección
    signalingRef.current?.send({
      type: 'cachipum-choice',
      userId: userIdRef.current,
      choice,
      round: currentChoices.length + 1,
    });
    
    // Si completó las 3 opciones, verificar si todos han terminado (solo host)
    if (newChoices.length === 3 && isHost) {
      setTimeout(() => checkAllCachipumChoicesComplete(), 100);
    }
  }, [cachipumChoices, isHost]);

  const checkAllCachipumChoicesComplete = useCallback(() => {
    setCachipumChoices(currentChoices => {
      const currentPeers = peersRef.current;
      const allUsers = [userIdRef.current, ...Array.from(currentPeers.keys())];
      const allComplete = allUsers.every(userId => {
        const choices = currentChoices.get(userId);
        return choices && choices.length === 3;
      });
      
      if (allComplete && isHost) {
        if (cachipumProcessingRef.current) return currentChoices;
        cachipumProcessingRef.current = true;
        // Procesar rondas inmediatamente cuando todos completan
        setCachipumChoices(finalChoices => {
          const allUsersForProcessing = [userIdRef.current, ...Array.from(peersRef.current.keys())];
          
          // Verificar que todos los usuarios tienen 3 opciones
          const allHave3Choices = allUsersForProcessing.every(userId => {
            const choices = finalChoices.get(userId);
            return choices && choices.length === 3;
          });
          
          if (!allHave3Choices) {
            cachipumProcessingRef.current = false;
            return finalChoices; // No procesar si no todos tienen 3 opciones
          }
          
          const results: CachipumRoundResult[] = [];
          for (let round = 1; round <= 3; round++) {
            const roundChoices = new Map<string, CachipumChoice>();
            
            allUsersForProcessing.forEach(userId => {
              const choices = finalChoices.get(userId);
              if (choices && choices.length >= round && choices[round - 1]) {
                roundChoices.set(userId, choices[round - 1]);
              }
            });
            
            const winners = determineRoundWinners(roundChoices);
            const result: CachipumRoundResult = {
              round,
              choices: roundChoices,
              winners,
            };
            results.push(result);
            signalingRef.current?.send({
              type: 'cachipum-round-result',
              round,
              choices: Object.fromEntries(roundChoices),
              winners,
            });
          }
          
          // Procesar resultados inmediatamente
          setCachipumResults(results);
          const winner = determineCachipumWinner(results);
          if (winner) {
            setCachipumWinner(winner);
            signalingRef.current?.send({
              type: 'cachipum-winner',
              winnerId: winner,
            });
            // La animación se abre en el useEffect cuando cachipumWinner && cachipumResults.length === 3
          } else {
            // Si hay empate en las 3 rondas, reiniciar cachipum
            cachipumProcessingRef.current = false;
            setCachipumChoices(new Map());
            setCachipumResults([]);
            setCachipumRound(1);
            setCachipumWinner(null);
            setShowCachipumAnimation(false);
            setCurrentCachipumRoundDisplay(0);
            setShowCachipum(true); // Reabrir modal para jugar de nuevo
            signalingRef.current?.send({
              type: 'cachipum-restart',
            });
          }
          
          return finalChoices;
        });
      }
      
      return currentChoices;
    });
  }, [isHost]);

  // Animación: mostrar las 3 rondas a la vez en una sola ventana; tras un delay, cerrar y mostrar decisión/perdedor
  const startCachipumAnimation = useCallback((results: CachipumRoundResult[], winner: string) => {
    if (results.length === 0) return () => {};
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      setShowCachipumAnimation(false);
      if (winner === userIdRef.current) {
        setShowCachipumDecision(true);
      } else {
        setShowCachipumLoser(true);
      }
    }, 4000); // 4 segundos para ver las 3 rondas
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, []);

  // ─── Iniciar animación cuando resultados y ganador estén disponibles ───
  useEffect(() => {
    if (showCachipumAnimation && cachipumResults.length > 0 && cachipumWinner) {
      const cleanup = startCachipumAnimation(cachipumResults, cachipumWinner);
      return cleanup;
    }
  }, [showCachipumAnimation, cachipumResults, cachipumWinner, startCachipumAnimation]);

  // Abrir animación solo cuando tengamos ganador y los 3 resultados (evita orden de mensajes en red)
  useEffect(() => {
    if (cachipumWinner && cachipumResults.length === 3) {
      setShowCachipumAnimation(true);
    }
  }, [cachipumWinner, cachipumResults.length]);

  const handleCachipumStarterSelection = useCallback((starterId: string) => {
    if (cachipumWinner !== userIdRef.current) return;
    
    setCachipumStarter(starterId);
    // Actualizar el ref inmediatamente para evitar problemas de timing
    cachipumStarterRef.current = starterId;
    setShowCachipumDecision(false);
    setShowCachipum(false);
    
    // Enviar el mensaje al host y a todos los peers
    if (signalingRef.current) {
      signalingRef.current.send({
        type: 'cachipum-starter-selected',
        starterId,
      });
    }
  }, [cachipumWinner]);

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

  // ─── Start Battle Logic (sin countdown) ───
  useEffect(() => {
    // Iniciar batalla inmediatamente cuando ambos estén listos
    if (isReady && allPeersReady && !battleStarted && isHost && signalingRef.current) {
      const startTime = Date.now() + 500;
      signalingRef.current.send({
        type: 'start-battle',
        timestamp: startTime,
      });
      startBattle(startTime);
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
        <div className={styles.headerRow}>
          <h1 className={styles.title}>Sala: {roomId}</h1>
          <div className={styles.headerActions}>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className={styles.headerIconButton}
              aria-label="Abrir configuración"
              title="Configuración"
            >
              ⚙️
            </button>
            <button
              type="button"
              onClick={handleLeaveRoom}
              className={styles.headerIconButton}
              aria-label="Salir de la sala"
              title="Salir de la sala"
            >
              ✕
            </button>
          </div>
        </div>
        <div className={styles.players}>
          <div className={`${styles.player} ${isReady ? styles.playerReady : ''}`}>
            <div className={styles.micLevelBar} style={{ width: `${localMicLevel * 100}%` }} aria-hidden />
            <div className={styles.playerContent}>
              <span className={styles.playerLabel}>Tu:</span>
              <span className={styles.playerName}>{nickname}</span>
            </div>
          </div>
          {Array.from(peers.values()).map(peer => (
            <div key={peer.userId} className={`${styles.player} ${peer.isReady ? styles.playerReady : ''}`}>
              <div className={styles.micLevelBar} style={{ width: `${(remoteMicLevels.get(peer.userId) ?? 0) * 100}%` }} aria-hidden />
              <div className={styles.playerContent}>
                <span className={styles.playerLabel}>Rival:</span>
                <span className={styles.playerName}>{peer.nickname}</span>
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
            </div>
          ))}
          {peers.size === 0 && (
            <div className={styles.player}>
              <div className={styles.playerContent}>
                <span className={styles.waiting}>Esperando rivales...</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Botón "Iniciar Cachipum" - debajo de participantes, antes de la pantalla (solo host) */}
      {!battleStarted && websocketConnected && isHost && battleFormat && allPeersConnected && hasPeers && !cachipumStarter && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem', marginBottom: '1rem' }}>
          <button
            onClick={handleStartCachipum}
            className={styles.cachipumStartButton}
          >
            Iniciar Cachipum
          </button>
        </div>
      )}

      {/* Pantalla - siempre visible, tamaño fijo */}
      <div className={styles.battleActive}>
        <div className={styles.screenFrame}>
              {battleStarted && currentTurn ? (
                <>
                  <p className={styles.battleText}>
                    {/* Usar SIEMPRE el nickname que viene del mensaje turn-started del host */}
                    {/* Esto garantiza que todos vean exactamente el mismo nombre */}
                    {(currentTurn as any).nickname || currentTurn.userId}
                  </p>
                  <div className={styles.turnInfo}>
                    <p className={styles.turnNumber}>Turno #{currentTurn.turnNumber}</p>
                  </div>
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
                                strokeDashoffset: `${2 * Math.PI * 45 * (1 - ('timeRemaining' in turnProgress ? turnProgress.timeRemaining : 0) / (customTurnSeconds || getBattleFormatConfig(battleFormat).timePerTurnSeconds || 60))}`,
                              }}
                            />
                            <text
                              x="50"
                              y="50"
                              textAnchor="middle"
                              dominantBaseline="middle"
                              className={styles.pieChartText}
                            >
                              {'timeRemaining' in turnProgress ? turnProgress.timeRemaining : 0}s
                            </text>
                          </svg>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {cachipumStarter ? (
                    <p className={styles.battleText}>
                      {cachipumStarter === userIdRef.current 
                        ? nickname 
                        : peersRef.current.get(cachipumStarter)?.nickname || peers.get(cachipumStarter)?.nickname || cachipumStarter}
                    </p>
                  ) : (
                    <p className={styles.battleText} style={{ color: '#888' }}>Esperando...</p>
                  )}
                  {!battleStarted && (
                    <div className={styles.turnInfo}>
                      <p className={styles.turnNumber} style={{ color: '#888' }}>Preparando batalla</p>
                    </div>
                  )}
                  {/* Botones para abrir selectores (solo host) */}
                  {!battleStarted && websocketConnected && isHost && (
                    <div className={styles.screenConfigButtons}>
                      <button
                        onClick={() => setIsBeatModalOpen(true)}
                        className={styles.screenConfigButton}
                      >
                        🎵 Beat: Beat {selectedBeat}
                      </button>
                      <button
                        onClick={() => setIsFormatModalOpen(true)}
                        className={styles.screenConfigButton}
                      >
                        📋 {battleFormat ? (
                          battleFormat === '4x4' ? '4x4' :
                          battleFormat === '8x8' ? '8x8' :
                          'Minuto Libre'
                        ) : 'Formato'}
                      </button>
                    </div>
                  )}

                  {/* Mostrar configuración seleccionada (solo lectura para no-host) */}
                  {!battleStarted && !isHost && (selectedBeat || battleFormat) && (
                    <div className={styles.configDisplay}>
                      {selectedBeat && (
                        <div className={styles.configItem}>
                          <span className={styles.configLabel}>Beat:</span>
                          <span className={styles.configValue}>Beat {selectedBeat}</span>
                        </div>
                      )}
                      {battleFormat && (
                        <div className={styles.configItem}>
                          <span className={styles.configLabel}>Formato:</span>
                          <span className={styles.configValue}>
                            {battleFormat === '4x4' && '4x4 (4 versos de 4 líneas)'}
                            {battleFormat === '8x8' && '8x8 (8 versos de 8 líneas)'}
                            {battleFormat === 'minuto-libre' && 'Minuto Libre (60 segundos)'}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
        </div>
      </div>

      {/* Control de volumen del beat - debajo de la pantalla */}
      {websocketConnected && (
        <div className={styles.beatVolumeControl}>
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
      )}

      {/* Botón "Estoy listo" / "No estoy listo" - siempre visible, entre volumen y footer */}
      {!battleStarted && websocketConnected && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem', marginBottom: '1rem' }}>
          {!isReady ? (
            <button 
              onClick={handleReady}
              className={`${styles.readyButton} ${allPeersConnected && hasPeers && battleFormat && cachipumStarter ? styles.readyButtonAnimated : ''}`}
              disabled={!allPeersConnected || !hasPeers || !battleFormat || !cachipumStarter}
            >
              Estoy listo
            </button>
          ) : (
            <button 
              onClick={handleNotReady}
              className={`${styles.readyButton} ${styles.notReadyButton}`}
            >
              No estoy listo
            </button>
          )}
        </div>
      )}

      {battleStarted && beatAudio && isHost && (
        <div className={styles.beatControls}>
          <label className={styles.label}>Controles del Beat:</label>
          <div className={styles.beatButtons}>
            <button onClick={toggleBeat} className={styles.beatButton}>
              ⏸️ Pausar/Reproducir
            </button>
            <button onClick={restartBeat} className={styles.beatButton}>
              🔄 Reiniciar Beat
            </button>
          </div>
          <div className={styles.battleResetContainer}>
            <button onClick={resetBattle} className={`${styles.beatButton} ${styles.resetBattleButton}`}>
              Reiniciar Batalla
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


      {showCachipum && !cachipumStarter && !showCachipumAnimation && (
        <div className={styles.cachipumContainer}>
          <div>
            <h3 className={styles.cachipumTitle}>Cachipum - Elige tus 3 opciones</h3>
          <p className={styles.cachipumSubtitle}>
            Elige 3 opciones (una por ronda). El ganador decidirá quién parte primero.
          </p>
          {(() => {
            const myChoices = cachipumChoices.get(userIdRef.current) || [];
            const allUsers = [userIdRef.current, ...Array.from(peers.keys())];
            const allComplete = allUsers.every(userId => {
              const choices = cachipumChoices.get(userId);
              return choices && choices.length === 3;
            });
            
            return (
              <>
                <div className={styles.cachipumProgress}>
                  <p>Opciones elegidas: {myChoices.length} / 3</p>
                  <div className={styles.cachipumMyChoices}>
                    {[0, 1, 2].map((index) => (
                      <span key={index} className={styles.cachipumChoiceBadge}>
                        {myChoices[index] ? getCachipumEmoji(myChoices[index]) : <span className={styles.cachipumEmptySlot}>?</span>}
                      </span>
                    ))}
                  </div>
                </div>
                {myChoices.length < 3 && (
                  <div className={styles.cachipumButtons}>
                    <button
                      onClick={() => handleCachipumChoice('piedra')}
                      className={styles.cachipumButton}
                      disabled={myChoices.length >= 3}
                    >
                      <span className={styles.cachipumEmoji}>✊</span>
                      <span className={styles.cachipumLabel}>Piedra</span>
                    </button>
                    <button
                      onClick={() => handleCachipumChoice('papel')}
                      className={styles.cachipumButton}
                      disabled={myChoices.length >= 3}
                    >
                      <span className={styles.cachipumEmoji}>✋</span>
                      <span className={styles.cachipumLabel}>Papel</span>
                    </button>
                    <button
                      onClick={() => handleCachipumChoice('tijera')}
                      className={styles.cachipumButton}
                      disabled={myChoices.length >= 3}
                    >
                      <span className={styles.cachipumEmoji}>✌️</span>
                      <span className={styles.cachipumLabel}>Tijera</span>
                    </button>
                  </div>
                )}
              </>
            );
          })()}
          </div>
        </div>
      )}

      {showCachipumAnimation && cachipumResults.length > 0 && (() => {
        const sorted = [...cachipumResults].sort((a, b) => a.round - b.round);
        const winningRoundIndex = sorted.findIndex(r => r.winners.length === 1);
        const roundsToShow = winningRoundIndex >= 0
          ? sorted.slice(0, winningRoundIndex + 1)
          : sorted;
        return (
          <div className={styles.cachipumAnimation}>
            <div>
              <h3 className={styles.cachipumTitle}>Resultados Cachipum</h3>
              {roundsToShow.map((result, idx) => {
                const roundNumber = idx + 1;
                const hasWinner = result.winners.length === 1;
                const allUsersInRoom = [userIdRef.current, ...Array.from(peersRef.current.keys())];
                return (
                  <div key={`round-${roundNumber}`} className={styles.cachipumRoundContent}>
                    <h4 className={styles.cachipumRoundTitle}>Ronda {roundNumber}</h4>
                    <div className={styles.cachipumRoundResults}>
                      {allUsersInRoom.map((userId, index) => {
                        const choice = result.choices.get(userId);
                        const userNickname = userId === userIdRef.current 
                          ? nickname 
                          : peersRef.current.get(userId)?.nickname || peers.get(userId)?.nickname || userId;
                        const isWinner = hasWinner && result.winners[0] === userId;
                        const isLoser = hasWinner && result.winners[0] !== userId;
                        return (
                          <React.Fragment key={`${roundNumber}-${userId}`}>
                            {index > 0 && (
                              <div className={styles.cachipumRoundVS}>VS</div>
                            )}
                            <div 
                              className={`${styles.cachipumRoundResult} ${isWinner ? styles.cachipumRoundResultWinner : ''} ${isLoser ? styles.cachipumRoundResultLoser : ''} ${!hasWinner ? styles.cachipumRoundResultTie : ''}`}
                            >
                              <div className={styles.cachipumRoundResultName}>{userNickname}</div>
                              {choice && (
                                <div className={styles.cachipumRoundResultChoice}>
                                  <span className={styles.cachipumRoundResultEmoji}>{getCachipumEmoji(choice)}</span>
                                  <span className={styles.cachipumRoundResultLabel}>{getCachipumLabel(choice)}</span>
                                </div>
                              )}
                              {hasWinner && (
                                <div className={styles.cachipumRoundResultStatus}>
                                  {isWinner ? (
                                    <span className={styles.cachipumRoundResultStatusText}>Ganador</span>
                                  ) : (
                                    <span className={styles.cachipumRoundResultStatusText}>Perdedor</span>
                                  )}
                                </div>
                              )}
                              {!hasWinner && (
                                <div className={styles.cachipumRoundResultStatus}>
                                  <span className={styles.cachipumRoundResultStatusText}>Empate</span>
                                </div>
                              )}
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Modal de selección de Beat */}
      {isBeatModalOpen && (
        <div className={styles.modalOverlay} onClick={() => setIsBeatModalOpen(false)}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Seleccionar Beat</h3>
              <button
                className={styles.modalCloseButton}
                onClick={() => setIsBeatModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className={styles.modalBody}>
              {/* Pestañas de beats */}
              <div className={styles.beatTabs}>
                {[1, 2, 3, 4].map(beatNum => {
                  const isSelected = selectedBeat === beatNum;
                  return (
                    <button
                      key={beatNum}
                      onClick={() => handleBeatTabChange(beatNum)}
                      className={`${styles.beatTab} ${activeBeatTab === beatNum ? styles.beatTabActive : ''} ${isSelected ? styles.beatTabSelected : ''}`}
                    >
                      Beat {beatNum}
                    </button>
                  );
                })}
              </div>

              {/* Contenido de la pestaña activa */}
              <div className={styles.beatTabContent}>
                {[1, 2, 3, 4].map(beatNum => {
                  if (activeBeatTab !== beatNum) return null;
                  
                  const currentOffset = beatOffsets.get(beatNum) ?? getBeatIntroOffset(beatNum);
                  const isPreviewing = previewingBeat === beatNum;
                  const isSelected = selectedBeat === beatNum;
                  
                  return (
                    <div key={beatNum} className={styles.beatPreviewCard}>
                      <div className={styles.beatPreviewHeader}>
                        <h4 className={styles.beatPreviewTitle}>Beat {beatNum}</h4>
                      </div>
                      {/* Tiempo actual del beat */}
                      {isPreviewing && (
                        <div className={styles.beatPreviewTime}>
                          <span className={styles.beatPreviewTimeLabel}>Tiempo:</span>
                          <span className={styles.beatPreviewTimeValue}>
                            {formatTime(previewBeatTime)}
                          </span>
                        </div>
                      )}

                      <div className={styles.beatPreviewControls}>
                        <button
                          onClick={() => handleBeatPreview(beatNum)}
                          className={`${styles.beatPreviewButton} ${isPreviewing ? (isPreviewPaused ? styles.beatPreviewButtonPaused : styles.beatPreviewButtonPlaying) : ''}`}
                        >
                          {isPreviewing ? (isPreviewPaused ? '▶️ Reanudar' : '⏸️ Pausar') : '▶️ Escuchar'}
                        </button>
                        {isPreviewing && (
                          <button
                            onClick={handleBeatPreviewRestart}
                            className={styles.beatPreviewRestartButton}
                          >
                            🔄 Reiniciar
                          </button>
                        )}
                      </div>
                      <div className={styles.beatPreviewOffset}>
                        <label className={styles.beatPreviewOffsetLabel}>Offset (segundos):</label>
                        <div className={styles.beatPreviewOffsetInputGroup}>
                          <input
                            type="number"
                            min="0"
                            max="60"
                            step="0.1"
                            value={currentOffset}
                            onChange={(e) => handleOffsetChange(beatNum, parseFloat(e.target.value) || 0)}
                            onTouchStart={() => audioContextManager.unlockFromGesture()}
                            className={styles.beatPreviewOffsetInput}
                          />
                          <span className={styles.beatPreviewOffsetUnit}>s</span>
                        </div>
                        <p className={styles.beatPreviewOffsetHint}>
                          Ajusta el offset mientras escuchas el beat
                        </p>
                      </div>
                      {/* Botón de seleccionar al final */}
                      <div className={styles.beatSelectContainer}>
                        <button
                          onClick={() => {
                            handleBeatChange(beatNum);
                            setIsBeatModalOpen(false);
                          }}
                          className={`${styles.beatSelectButton} ${isSelected ? styles.beatSelectButtonActive : ''}`}
                        >
                          {isSelected ? '✓ Seleccionado' : 'Seleccionar'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de selección de Formato */}
      {isFormatModalOpen && (
        <div className={styles.modalOverlay} onClick={() => setIsFormatModalOpen(false)}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Seleccionar Formato</h3>
              <button
                className={styles.modalCloseButton}
                onClick={() => setIsFormatModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.screenFormatButtons}>
                <div className={styles.screenFormatRow}>
                  <button
                    onClick={() => handleFormatChange('4x4')}
                    className={`${styles.screenFormatButton} ${battleFormat === '4x4' ? styles.screenFormatButtonActive : ''}`}
                  >
                    <div className={styles.screenFormatButtonTitle}>4x4</div>
                    <div className={styles.screenFormatButtonDesc}>4 versos de 4 líneas</div>
                  </button>
                  <button
                    onClick={() => handleFormatChange('8x8')}
                    className={`${styles.screenFormatButton} ${battleFormat === '8x8' ? styles.screenFormatButtonActive : ''}`}
                  >
                    <div className={styles.screenFormatButtonTitle}>8x8</div>
                    <div className={styles.screenFormatButtonDesc}>8 versos de 8 líneas</div>
                  </button>
                </div>
                <button
                  onClick={() => handleFormatChange('minuto-libre')}
                  className={`${styles.screenFormatButton} ${styles.screenFormatButtonFull} ${battleFormat === 'minuto-libre' ? styles.screenFormatButtonActive : ''}`}
                >
                  <div className={styles.screenFormatButtonTitle}>Minuto Libre</div>
                  <div className={styles.screenFormatButtonDesc}>60 segundos por turno</div>
                </button>
              </div>

              {/* Selector de número de entradas - siempre visible */}
              <div className={styles.entriesSelector}>
                <label className={styles.entriesLabel}>Número de entradas:</label>
                <div className={styles.entriesButtons}>
                  {[4, 5, 6].map(entries => (
                    <button
                      key={entries}
                      onClick={() => handleEntriesChange(entries)}
                      className={`${styles.entriesButton} ${battleEntries === entries ? styles.entriesButtonActive : ''}`}
                      disabled={!battleFormat}
                    >
                      {entries}
                    </button>
                  ))}
                </div>
              </div>

              {/* Campo para segundos personalizados - siempre visible */}
              <div className={styles.customSecondsSelector}>
                <label className={styles.entriesLabel}>Segundos por turno:</label>
                <div className={styles.customSecondsInputGroup}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={customTurnSecondsInput || (customTurnSeconds ?? (battleFormat ? getBattleFormatConfig(battleFormat).timePerTurnSeconds : 60) ?? 60).toString()}
                    onChange={(e) => {
                      const value = e.target.value;
                      // Permitir solo números y campo vacío
                      if (value === '' || /^\d+$/.test(value)) {
                        setCustomTurnSecondsInput(value);
                      }
                    }}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      // Si el campo está vacío o inválido, usar el valor por defecto
                      if (value === '' || parseInt(value) <= 0 || parseInt(value) > 300) {
                        const defaultSeconds = battleFormat ? (getBattleFormatConfig(battleFormat).timePerTurnSeconds ?? 60) : 60;
                        setCustomTurnSecondsInput(defaultSeconds.toString());
                        if (battleFormat) {
                          handleCustomTurnSecondsChange(defaultSeconds);
                        }
                      } else {
                        // Validar y actualizar con el valor ingresado
                        const seconds = parseInt(value);
                        if (!isNaN(seconds) && seconds > 0 && seconds <= 300) {
                          setCustomTurnSecondsInput(seconds.toString());
                          if (battleFormat) {
                            handleCustomTurnSecondsChange(seconds);
                          }
                        }
                      }
                    }}
                    onFocus={(e) => {
                      // Seleccionar todo el texto al hacer foco para facilitar la edición
                      e.target.select();
                    }}
                    className={styles.customSecondsInput}
                    placeholder="Segundos"
                    disabled={!battleFormat}
                  />
                  <span className={styles.customSecondsUnit}>seg</span>
                </div>
                <p className={styles.customSecondsHint}>
                  Escucha el beat para determinar la duración correcta
                </p>
              </div>

              {/* Botón Aceptar */}
              <div className={styles.formatModalActions}>
                <button
                  onClick={() => setIsFormatModalOpen(false)}
                  className={styles.formatAcceptButton}
                >
                  Aceptar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCachipumDecision && cachipumWinner === userIdRef.current && (
        <div className={styles.cachipumDecision}>
          <div>
            <h3 className={styles.cachipumTitle}>¡Ganaste el Cachipum!</h3>
            <p className={styles.cachipumSubtitle}>¿Quién parte primero?</p>
            <div className={styles.cachipumDecisionButtons}>
            <button
              onClick={() => handleCachipumStarterSelection(userIdRef.current)}
              className={styles.cachipumDecisionButton}
            >
              Yo parto
            </button>
            {Array.from(peers.keys()).map(opponentId => {
              const opponentNickname = peers.get(opponentId)?.nickname || opponentId;
              return (
                <button
                  key={opponentId}
                  onClick={() => handleCachipumStarterSelection(opponentId)}
                  className={styles.cachipumDecisionButton}
                >
                  Le doy la partida a {opponentNickname}
                </button>
              );
            })}
            </div>
          </div>
        </div>
      )}

      {/* Mensaje para el perdedor del cachipum */}
      {showCachipumLoser && cachipumWinner && cachipumWinner !== userIdRef.current && (
        <div className={styles.cachipumDecision}>
          <div style={{ borderColor: '#f5576c' }}>
            <h3 className={styles.cachipumTitle} style={{ color: '#f5576c' }}>Perdiste el Cachipum</h3>
            <p className={styles.cachipumSubtitle}>El ganador decide quién parte</p>
            <div className={styles.cachipumDecisionButtons}>
              <button
                onClick={() => setShowCachipumLoser(false)}
                className={styles.cachipumDecisionButton}
                style={{ borderColor: '#f5576c' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#f5576c';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#2a2a2a';
                }}
              >
                Aceptar
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Muted audio element - Safari WebRTC keep-alive only, audio routed via Web Audio API */}
      <audio
        ref={remoteAudioRef}
        muted
        playsInline
        style={{ display: 'none' }}
      />

      {/* Settings Sidebar */}
      {isSettingsOpen && (
        <>
          <div 
            className={styles.settingsOverlay}
            onClick={() => setIsSettingsOpen(false)}
          />
          <div className={styles.settingsSidebar}>
            <div className={styles.settingsHeader}>
              <h2 className={styles.settingsTitle}>Configuración</h2>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className={styles.settingsCloseButton}
                aria-label="Cerrar configuración"
              >
                ✕
              </button>
            </div>
            <div className={styles.settingsContent}>
              {/* Audio Controls Section */}
              <div className={styles.settingsSection}>
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
            </div>
          </div>
        </>
      )}

      {/* Footer fijo para mensajes de estado del sistema - siempre visible */}
      <div className={styles.statusFooter}>
        {!websocketConnected && (
          <div>
            <p className={styles.statusFooterText}>Conectando al servidor...</p>
          </div>
        )}
        {websocketConnected && !hasPeers && (
          <p className={styles.statusFooterText}>Esperando que se unan otros jugadores...</p>
        )}
        {websocketConnected && hasPeers && somePeerConnecting && !somePeerFailed && (
          <div>
            <p className={styles.statusFooterText}>Estableciendo conexion de audio...</p>
            {!localStream && (
              <p className={styles.statusFooterText} style={{ fontSize: '0.75rem', color: '#f5576c', marginTop: '0.25rem' }}>
                Microfono no disponible. Podras escuchar pero no hablar.
              </p>
            )}
            {localStream && (
              <p className={styles.statusFooterText} style={{ fontSize: '0.75rem', color: '#10b981', marginTop: '0.25rem' }}>
                Microfono conectado
              </p>
            )}
          </div>
        )}
        {somePeerFailed && (
          <p className={styles.statusFooterText} style={{ color: '#f5576c' }}>
            Error de conexion con un rival. Recarga la pagina para reintentar.
          </p>
        )}
        {isReady && !allPeersReady && (
          <p className={styles.statusFooterText}>Esperando que todos esten listos...</p>
        )}
        {websocketConnected && hasPeers && allPeersConnected && !somePeerConnecting && !somePeerFailed && localStream && (
          <p className={styles.statusFooterText} style={{ color: '#10b981' }}>
            ✓ Conectado y listo
          </p>
        )}
        {websocketConnected && hasPeers && allPeersConnected && !somePeerConnecting && !somePeerFailed && !localStream && (
          <p className={styles.statusFooterText} style={{ color: '#888' }}>
            ✓ Conectado (sin micrófono)
          </p>
        )}
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
