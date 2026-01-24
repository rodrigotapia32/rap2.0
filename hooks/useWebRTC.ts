/**
 * Hook for managing WebRTC peer connections.
 * Handles offer/answer, ICE candidates, progressive constraint fallback,
 * session tracking, and automatic reconnection.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { SignalingMessage } from '@/lib/websocket';

const MAX_RECONNECT_ATTEMPTS = 3;
const ICE_CANDIDATE_TIMEOUT_MS = 30_000;
const DISCONNECTED_TIMEOUT_MS = 5_000;

// Progressive getUserMedia constraint levels (most restrictive -> least)
const CONSTRAINT_LEVELS: MediaStreamConstraints[] = [
  { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false },
  { audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }, video: false },
  { audio: { echoCancellation: true }, video: false },
  { audio: true, video: false },
];

export type WebRTCState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

interface UseWebRTCOptions {
  roomId: string;
  userId: string;
  sendSignalingMessage?: (message: SignalingMessage) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: WebRTCState) => void;
}

export function useWebRTC({
  roomId,
  userId,
  sendSignalingMessage,
  onRemoteStream,
  onConnectionStateChange,
}: UseWebRTCOptions) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [webrtcState, setWebrtcState] = useState<WebRTCState>('idle');

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const sendMessageRef = useRef(sendSignalingMessage);
  const sessionIdRef = useRef<string>(generateSessionId());
  const isInitiatorRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const pendingIceCandidatesRef = useRef<{ candidate: RTCIceCandidateInit; timestamp: number }[]>([]);
  const disconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onRemoteStreamRef = useRef(onRemoteStream);
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  const rtcConfigRef = useRef<RTCConfiguration | null>(null);
  const triggerReconnectRef = useRef<() => void>();

  // Keep refs in sync
  useEffect(() => { sendMessageRef.current = sendSignalingMessage; }, [sendSignalingMessage]);
  useEffect(() => { onRemoteStreamRef.current = onRemoteStream; }, [onRemoteStream]);
  useEffect(() => { onConnectionStateChangeRef.current = onConnectionStateChange; }, [onConnectionStateChange]);

  const updateState = useCallback((state: WebRTCState) => {
    setWebrtcState(state);
    onConnectionStateChangeRef.current?.(state);
  }, []);

  /**
   * Fetch TURN credentials from server-side endpoint
   */
  const fetchRtcConfig = useCallback(async (): Promise<RTCConfiguration> => {
    if (rtcConfigRef.current) return rtcConfigRef.current;

    const baseConfig: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 10,
    };

    try {
      const res = await fetch('/api/turn-credentials');
      if (res.ok) {
        const { username, credential, urls } = await res.json();
        baseConfig.iceServers!.push(
          { urls: urls[0] }, // STUN
          { urls: urls[1], username, credential }, // TURN
        );
      }
    } catch {
      // Continue without TURN - STUN only
    }

    rtcConfigRef.current = baseConfig;
    return baseConfig;
  }, []);

  /**
   * Initialize local stream with progressive constraint fallback
   */
  const initializeLocalStream = useCallback(async (): Promise<MediaStream | null> => {
    if (localStreamRef.current) return localStreamRef.current;

    for (let i = 0; i < CONSTRAINT_LEVELS.length; i++) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINT_LEVELS[i]);
        stream.getAudioTracks().forEach(track => { track.enabled = true; });
        localStreamRef.current = stream;
        setLocalStream(stream);
        return stream;
      } catch (err: unknown) {
        const error = err as DOMException;
        // If permission denied or no device, don't try lower constraints
        if (error.name === 'NotAllowedError' || error.name === 'NotFoundError') {
          console.warn('Microphone unavailable:', error.name);
          return null;
        }
        // Otherwise try next constraint level
        if (i === CONSTRAINT_LEVELS.length - 1) {
          console.warn('All audio constraint levels failed:', error.message);
          return null;
        }
      }
    }
    return null;
  }, []);

  /**
   * Creates a fresh RTCPeerConnection, always closing any existing one first.
   */
  const createFreshPeerConnection = useCallback(async (): Promise<RTCPeerConnection> => {
    // Tear down existing connection
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.ontrack = null;
        peerConnectionRef.current.onicecandidate = null;
        peerConnectionRef.current.onconnectionstatechange = null;
        peerConnectionRef.current.oniceconnectionstatechange = null;
        peerConnectionRef.current.close();
      } catch { /* already closed */ }
      peerConnectionRef.current = null;
    }

    // Clear pending ICE candidates
    pendingIceCandidatesRef.current = [];

    // Clear disconnected timer
    if (disconnectedTimerRef.current) {
      clearTimeout(disconnectedTimerRef.current);
      disconnectedTimerRef.current = null;
    }

    const config = await fetchRtcConfig();
    const pc = new RTCPeerConnection(config);
    peerConnectionRef.current = pc;

    // Handle remote track
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);

      // Monitor track lifecycle
      const track = event.track;
      track.onended = () => {
        console.warn('Remote track ended');
      };
      track.onmute = () => {
        console.warn('Remote track muted');
      };
      track.onunmute = () => {
        console.log('Remote track unmuted');
      };

      onRemoteStreamRef.current?.(stream);
    };

    // Handle connection state
    pc.onconnectionstatechange = () => {
      if (pc !== peerConnectionRef.current) return; // stale PC
      const state = pc.connectionState;

      if (state === 'connected') {
        reconnectAttemptsRef.current = 0;
        if (disconnectedTimerRef.current) {
          clearTimeout(disconnectedTimerRef.current);
          disconnectedTimerRef.current = null;
        }
        updateState('connected');
      } else if (state === 'disconnected') {
        // Wait before reconnecting - transient network issues
        if (!disconnectedTimerRef.current) {
          disconnectedTimerRef.current = setTimeout(() => {
            disconnectedTimerRef.current = null;
            if (peerConnectionRef.current?.connectionState === 'disconnected') {
              triggerReconnectRef.current?.();
            }
          }, DISCONNECTED_TIMEOUT_MS);
        }
      } else if (state === 'failed') {
        // Immediate reconnect on failure
        triggerReconnectRef.current?.();
      }
    };

    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
      if (pc !== peerConnectionRef.current) return;
      if (pc.iceConnectionState === 'failed') {
        pc.restartIce();
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && sendMessageRef.current) {
        sendMessageRef.current({
          type: 'ice-candidate',
          candidate: event.candidate,
          sessionId: sessionIdRef.current,
        });
      }
    };

    return pc;
  }, [fetchRtcConfig, updateState]);

  /**
   * Start the WebRTC connection as initiator or responder.
   * Sequential: await stream -> create PC -> add tracks -> offer/answer
   */
  const startConnection = useCallback(async (isInitiator: boolean) => {
    if (!mountedRef.current) return;

    isInitiatorRef.current = isInitiator;
    updateState('connecting');

    // 1. Ensure we have a local stream (non-blocking for listen-only)
    const stream = await initializeLocalStream();

    // 2. Create fresh peer connection
    const pc = await createFreshPeerConnection();
    if (!mountedRef.current) return;

    // 3. Add local tracks if available
    if (stream) {
      const audioTracks = stream.getAudioTracks();
      for (const track of audioTracks) {
        track.enabled = true;
        pc.addTrack(track, stream);
      }
    }

    // 4. If initiator, create and send offer
    if (isInitiator) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false,
        });
        await pc.setLocalDescription(offer);
        sendMessageRef.current?.({
          type: 'offer',
          offer,
          sessionId: sessionIdRef.current,
        });
      } catch (err) {
        console.error('Error creating offer:', err);
        updateState('failed');
      }
    }
    // If responder, we wait for the offer to arrive via handleSignalingMessage
  }, [initializeLocalStream, createFreshPeerConnection, updateState]);

  /**
   * Trigger a reconnection attempt
   */
  const triggerReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      updateState('failed');
      return;
    }

    reconnectAttemptsRef.current++;
    updateState('reconnecting');

    // Generate new session ID
    sessionIdRef.current = generateSessionId();

    // Notify peer we want to renegotiate
    sendMessageRef.current?.({
      type: 'webrtc-renegotiate',
      userId,
      sessionId: sessionIdRef.current,
    });

    // Re-run startConnection with same role
    startConnection(isInitiatorRef.current);
  }, [userId, startConnection, updateState]);

  // Keep triggerReconnect ref in sync (used by createFreshPeerConnection callbacks)
  useEffect(() => { triggerReconnectRef.current = triggerReconnect; }, [triggerReconnect]);

  /**
   * Flush pending ICE candidates that haven't expired
   */
  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const now = Date.now();
    const valid = pendingIceCandidatesRef.current.filter(
      entry => now - entry.timestamp < ICE_CANDIDATE_TIMEOUT_MS
    );
    pendingIceCandidatesRef.current = [];

    for (const { candidate } of valid) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Discard invalid candidates
      }
    }
  }, []);

  /**
   * Handle incoming signaling messages
   */
  const handleSignalingMessage = useCallback(async (message: SignalingMessage) => {
    switch (message.type) {
      case 'offer': {
        // If we receive an offer with a different sessionId and we have an active connection,
        // it means the peer reconnected - accept it
        if (message.sessionId && message.sessionId !== sessionIdRef.current) {
          sessionIdRef.current = message.sessionId;
        }

        let pc = peerConnectionRef.current;
        if (!pc || pc.signalingState === 'closed') {
          // Ensure we have stream first
          await initializeLocalStream();
          pc = await createFreshPeerConnection();

          // Add local tracks
          if (localStreamRef.current) {
            const audioTracks = localStreamRef.current.getAudioTracks();
            for (const track of audioTracks) {
              track.enabled = true;
              pc.addTrack(track, localStreamRef.current);
            }
          }
        }

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(message.offer));

          // Process pending ICE candidates
          await flushPendingCandidates(pc);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          sendMessageRef.current?.({
            type: 'answer',
            answer,
            sessionId: sessionIdRef.current,
          });
        } catch (err: unknown) {
          const error = err as DOMException;
          console.error('Error handling offer:', error);
          if (error.name === 'InvalidStateError') {
            // PC in bad state, recreate on next attempt
            peerConnectionRef.current?.close();
            peerConnectionRef.current = null;
          }
        }
        break;
      }

      case 'answer': {
        const pc = peerConnectionRef.current;
        if (!pc) return;

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
          await flushPendingCandidates(pc);
        } catch (err) {
          console.error('Error handling answer:', err);
        }
        break;
      }

      case 'ice-candidate': {
        const pc = peerConnectionRef.current;
        if (!pc) return;

        // If remote description is not set yet, queue the candidate
        if (!pc.remoteDescription) {
          pendingIceCandidatesRef.current.push({
            candidate: message.candidate,
            timestamp: Date.now(),
          });
          return;
        }

        try {
          await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (err: unknown) {
          const error = err as DOMException;
          if (error.name === 'InvalidStateError') {
            pendingIceCandidatesRef.current.push({
              candidate: message.candidate,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }
    }
  }, [initializeLocalStream, createFreshPeerConnection, flushPendingCandidates]);

  /**
   * Reset all WebRTC state (for reconnection)
   */
  const resetState = useCallback(() => {
    if (disconnectedTimerRef.current) {
      clearTimeout(disconnectedTimerRef.current);
      disconnectedTimerRef.current = null;
    }

    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.ontrack = null;
        peerConnectionRef.current.onicecandidate = null;
        peerConnectionRef.current.onconnectionstatechange = null;
        peerConnectionRef.current.oniceconnectionstatechange = null;
        peerConnectionRef.current.close();
      } catch { /* already closed */ }
      peerConnectionRef.current = null;
    }

    pendingIceCandidatesRef.current = [];
    sessionIdRef.current = generateSessionId();
    reconnectAttemptsRef.current = 0;
    updateState('idle');
  }, [updateState]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (disconnectedTimerRef.current) {
        clearTimeout(disconnectedTimerRef.current);
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
    };
  }, []);

  return {
    localStream,
    webrtcState,
    startConnection,
    resetState,
    handleSignalingMessage,
    initializeLocalStream,
  };
}

// ─── Helpers ───────────────────────────────────────────────

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
