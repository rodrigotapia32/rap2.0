/**
 * Hook for managing WebRTC peer connections in a multi-peer mesh.
 * Each remote peer gets its own RTCPeerConnection. The local audio stream
 * is shared across all connections.
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

interface PeerConnectionEntry {
  pc: RTCPeerConnection;
  sessionId: string;
  isInitiator: boolean;
  reconnectAttempts: number;
  pendingIceCandidates: { candidate: RTCIceCandidateInit; timestamp: number }[];
  disconnectedTimer: ReturnType<typeof setTimeout> | null;
}

interface UseWebRTCOptions {
  roomId: string;
  userId: string;
  sendSignalingMessage?: (message: SignalingMessage) => void;
  onRemoteStream?: (userId: string, stream: MediaStream | null) => void;
  onPeerConnectionState?: (userId: string, state: WebRTCState) => void;
}

export function useWebRTC({
  roomId,
  userId,
  sendSignalingMessage,
  onRemoteStream,
  onPeerConnectionState,
}: UseWebRTCOptions) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const peersRef = useRef<Map<string, PeerConnectionEntry>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const sendMessageRef = useRef(sendSignalingMessage);
  const mountedRef = useRef(true);
  const onRemoteStreamRef = useRef(onRemoteStream);
  const onPeerConnectionStateRef = useRef(onPeerConnectionState);
  const rtcConfigRef = useRef<RTCConfiguration | null>(null);
  const startConnectionInternalRef = useRef<(remoteUserId: string, isInitiator: boolean, sessionId?: string) => Promise<void>>();

  // Keep refs in sync
  useEffect(() => { sendMessageRef.current = sendSignalingMessage; }, [sendSignalingMessage]);
  useEffect(() => { onRemoteStreamRef.current = onRemoteStream; }, [onRemoteStream]);
  useEffect(() => { onPeerConnectionStateRef.current = onPeerConnectionState; }, [onPeerConnectionState]);

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
  const initializeLocalStream = useCallback(async (deviceId?: string): Promise<MediaStream | null> => {
    if (localStreamRef.current && !deviceId &&
        localStreamRef.current.getAudioTracks().some(t => t.readyState === 'live')) {
      return localStreamRef.current;
    }

    for (let i = 0; i < CONSTRAINT_LEVELS.length; i++) {
      try {
        const constraints = structuredClone(CONSTRAINT_LEVELS[i]);
        if (deviceId && typeof constraints.audio === 'object') {
          (constraints.audio as MediaTrackConstraints).deviceId = { exact: deviceId };
        } else if (deviceId) {
          constraints.audio = { deviceId: { exact: deviceId } };
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getAudioTracks().forEach(track => { track.enabled = true; });
        localStreamRef.current = stream;
        setLocalStream(stream);
        return stream;
      } catch (err: unknown) {
        const error = err as DOMException;
        if (error.name === 'NotAllowedError' || error.name === 'NotFoundError') {
          console.warn('Microphone unavailable:', error.name);
          return null;
        }
        if (error.name === 'OverconstrainedError' && deviceId) {
          // Device not available, fall back without deviceId constraint
          break;
        }
        if (i === CONSTRAINT_LEVELS.length - 1) {
          console.warn('All audio constraint levels failed:', error.message);
          return null;
        }
      }
    }
    // If deviceId caused OverconstrainedError, retry without it
    if (deviceId) return initializeLocalStream();
    return null;
  }, []);

  /**
   * Replace the audio track in all active peer connections (no renegotiation)
   */
  const replaceLocalStream = useCallback((newStream: MediaStream) => {
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return;

    for (const [, entry] of peersRef.current) {
      const sender = entry.pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) {
        sender.replaceTrack(newTrack);
      }
    }

    localStreamRef.current = newStream;
    setLocalStream(newStream);
  }, []);

  /**
   * Flush pending ICE candidates for a specific peer
   */
  const flushPendingCandidates = useCallback(async (entry: PeerConnectionEntry) => {
    const now = Date.now();
    const valid = entry.pendingIceCandidates.filter(
      e => now - e.timestamp < ICE_CANDIDATE_TIMEOUT_MS
    );
    entry.pendingIceCandidates = [];

    for (const { candidate } of valid) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Discard invalid candidates
      }
    }
  }, []);

  /**
   * Close and clean up a single peer's connection
   */
  const closeConnection = useCallback((remoteUserId: string) => {
    const entry = peersRef.current.get(remoteUserId);
    if (!entry) return;

    if (entry.disconnectedTimer) {
      clearTimeout(entry.disconnectedTimer);
    }

    try {
      entry.pc.ontrack = null;
      entry.pc.onicecandidate = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      entry.pc.close();
    } catch { /* already closed */ }

    peersRef.current.delete(remoteUserId);
    onRemoteStreamRef.current?.(remoteUserId, null);
    onPeerConnectionStateRef.current?.(remoteUserId, 'idle');
  }, []);

  /**
   * Close all peer connections (room leave)
   */
  const resetAll = useCallback(() => {
    for (const [remoteUserId] of peersRef.current) {
      closeConnection(remoteUserId);
    }
    peersRef.current.clear();
  }, [closeConnection]);

  /**
   * Trigger reconnection for a specific peer
   */
  const triggerReconnect = useCallback((remoteUserId: string) => {
    const entry = peersRef.current.get(remoteUserId);
    if (!entry) return;

    if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      onPeerConnectionStateRef.current?.(remoteUserId, 'failed');
      return;
    }

    entry.reconnectAttempts++;
    onPeerConnectionStateRef.current?.(remoteUserId, 'reconnecting');

    // Generate new session ID for this peer
    entry.sessionId = generateSessionId();

    // Notify peer we want to renegotiate
    sendMessageRef.current?.({
      type: 'webrtc-renegotiate',
      userId,
      sessionId: entry.sessionId,
    });

    // Re-create the connection (initiator role stays the same)
    startConnectionInternalRef.current?.(remoteUserId, entry.isInitiator, entry.sessionId);
  }, [userId]);

  /**
   * Internal: create a peer connection for a specific remote user
   */
  const startConnectionInternal = useCallback(async (
    remoteUserId: string,
    isInitiator: boolean,
    sessionId?: string
  ) => {
    if (!mountedRef.current) return;

    // Close existing connection to this peer if any
    const existing = peersRef.current.get(remoteUserId);
    if (existing) {
      if (existing.disconnectedTimer) clearTimeout(existing.disconnectedTimer);
      try {
        existing.pc.ontrack = null;
        existing.pc.onicecandidate = null;
        existing.pc.onconnectionstatechange = null;
        existing.pc.oniceconnectionstatechange = null;
        existing.pc.close();
      } catch { /* already closed */ }
    }

    onPeerConnectionStateRef.current?.(remoteUserId, 'connecting');

    // Ensure local stream
    const stream = await initializeLocalStream();

    const config = await fetchRtcConfig();
    const pc = new RTCPeerConnection(config);

    const peerSessionId = sessionId || generateSessionId();
    const entry: PeerConnectionEntry = {
      pc,
      sessionId: peerSessionId,
      isInitiator,
      reconnectAttempts: existing?.reconnectAttempts ?? 0,
      pendingIceCandidates: [],
      disconnectedTimer: null,
    };
    peersRef.current.set(remoteUserId, entry);

    if (!mountedRef.current) {
      pc.close();
      peersRef.current.delete(remoteUserId);
      return;
    }

    // Handle remote track
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      onRemoteStreamRef.current?.(remoteUserId, remoteStream);
    };

    // Handle connection state
    pc.onconnectionstatechange = () => {
      const currentEntry = peersRef.current.get(remoteUserId);
      if (!currentEntry || currentEntry.pc !== pc) return; // stale PC

      const state = pc.connectionState;

      if (state === 'connected') {
        currentEntry.reconnectAttempts = 0;
        if (currentEntry.disconnectedTimer) {
          clearTimeout(currentEntry.disconnectedTimer);
          currentEntry.disconnectedTimer = null;
        }
        onPeerConnectionStateRef.current?.(remoteUserId, 'connected');
      } else if (state === 'disconnected') {
        if (!currentEntry.disconnectedTimer) {
          currentEntry.disconnectedTimer = setTimeout(() => {
            currentEntry.disconnectedTimer = null;
            const stillEntry = peersRef.current.get(remoteUserId);
            if (stillEntry?.pc?.connectionState === 'disconnected') {
              triggerReconnect(remoteUserId);
            }
          }, DISCONNECTED_TIMEOUT_MS);
        }
      } else if (state === 'failed') {
        triggerReconnect(remoteUserId);
      }
    };

    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
      const currentEntry = peersRef.current.get(remoteUserId);
      if (!currentEntry || currentEntry.pc !== pc) return;
      if (pc.iceConnectionState === 'failed') {
        pc.restartIce();
      }
    };

    // Handle ICE candidates - directed to specific peer
    pc.onicecandidate = (event) => {
      if (event.candidate && sendMessageRef.current) {
        sendMessageRef.current({
          type: 'ice-candidate',
          candidate: event.candidate,
          sessionId: peerSessionId,
          targetUserId: remoteUserId,
        });
      }
    };

    // Add local tracks
    if (stream) {
      const audioTracks = stream.getAudioTracks();
      for (const track of audioTracks) {
        track.enabled = true;
        pc.addTrack(track, stream);
      }
    }

    // If initiator, create and send offer
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
          sessionId: peerSessionId,
          targetUserId: remoteUserId,
        });
      } catch (err) {
        console.error(`Error creating offer for ${remoteUserId}:`, err);
        onPeerConnectionStateRef.current?.(remoteUserId, 'failed');
      }
    }
  }, [initializeLocalStream, fetchRtcConfig, triggerReconnect]);

  // Keep ref in sync to break circular dependency with triggerReconnect
  useEffect(() => { startConnectionInternalRef.current = startConnectionInternal; }, [startConnectionInternal]);

  /**
   * Start a connection to a specific remote peer
   */
  const startConnection = useCallback(async (remoteUserId: string, isInitiator: boolean) => {
    await startConnectionInternal(remoteUserId, isInitiator);
  }, [startConnectionInternal]);

  /**
   * Handle incoming signaling messages (routed by userId)
   */
  const handleSignalingMessage = useCallback(async (message: SignalingMessage) => {
    const fromUserId = message.userId;
    if (!fromUserId) return;

    switch (message.type) {
      case 'offer': {
        let entry = peersRef.current.get(fromUserId);

        // Accept new session from this peer
        if (message.sessionId && entry && message.sessionId !== entry.sessionId) {
          entry.sessionId = message.sessionId;
        }

        if (!entry || entry.pc.signalingState === 'closed') {
          // Create a new connection for this peer as responder
          await initializeLocalStream();
          const config = await fetchRtcConfig();
          const pc = new RTCPeerConnection(config);

          const peerSessionId = message.sessionId || generateSessionId();
          entry = {
            pc,
            sessionId: peerSessionId,
            isInitiator: false,
            reconnectAttempts: 0,
            pendingIceCandidates: [],
            disconnectedTimer: null,
          };
          peersRef.current.set(fromUserId, entry);

          // Wire up handlers
          pc.ontrack = (event) => {
            const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
            onRemoteStreamRef.current?.(fromUserId, remoteStream);
          };

          pc.onconnectionstatechange = () => {
            const currentEntry = peersRef.current.get(fromUserId);
            if (!currentEntry || currentEntry.pc !== pc) return;
            const state = pc.connectionState;
            if (state === 'connected') {
              currentEntry.reconnectAttempts = 0;
              if (currentEntry.disconnectedTimer) {
                clearTimeout(currentEntry.disconnectedTimer);
                currentEntry.disconnectedTimer = null;
              }
              onPeerConnectionStateRef.current?.(fromUserId, 'connected');
            } else if (state === 'disconnected') {
              if (!currentEntry.disconnectedTimer) {
                currentEntry.disconnectedTimer = setTimeout(() => {
                  currentEntry.disconnectedTimer = null;
                  const stillEntry = peersRef.current.get(fromUserId);
                  if (stillEntry?.pc?.connectionState === 'disconnected') {
                    triggerReconnect(fromUserId);
                  }
                }, DISCONNECTED_TIMEOUT_MS);
              }
            } else if (state === 'failed') {
              triggerReconnect(fromUserId);
            }
          };

          pc.oniceconnectionstatechange = () => {
            const currentEntry = peersRef.current.get(fromUserId);
            if (!currentEntry || currentEntry.pc !== pc) return;
            if (pc.iceConnectionState === 'failed') pc.restartIce();
          };

          pc.onicecandidate = (event) => {
            if (event.candidate && sendMessageRef.current) {
              sendMessageRef.current({
                type: 'ice-candidate',
                candidate: event.candidate,
                sessionId: entry!.sessionId,
                targetUserId: fromUserId,
              });
            }
          };

          // Add local tracks
          if (localStreamRef.current) {
            const audioTracks = localStreamRef.current.getAudioTracks();
            for (const track of audioTracks) {
              track.enabled = true;
              pc.addTrack(track, localStreamRef.current);
            }
          }

          onPeerConnectionStateRef.current?.(fromUserId, 'connecting');
        }

        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(message.offer));
          await flushPendingCandidates(entry);

          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);

          sendMessageRef.current?.({
            type: 'answer',
            answer,
            sessionId: entry.sessionId,
            targetUserId: fromUserId,
          });
        } catch (err: unknown) {
          const error = err as DOMException;
          console.error(`Error handling offer from ${fromUserId}:`, error);
          if (error.name === 'InvalidStateError') {
            closeConnection(fromUserId);
          }
        }
        break;
      }

      case 'answer': {
        const entry = peersRef.current.get(fromUserId);
        if (!entry) return;

        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(message.answer));
          await flushPendingCandidates(entry);
        } catch (err) {
          console.error(`Error handling answer from ${fromUserId}:`, err);
        }
        break;
      }

      case 'ice-candidate': {
        const entry = peersRef.current.get(fromUserId);
        if (!entry) return;

        if (!entry.pc.remoteDescription) {
          entry.pendingIceCandidates.push({
            candidate: message.candidate,
            timestamp: Date.now(),
          });
          return;
        }

        try {
          await entry.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (err: unknown) {
          const error = err as DOMException;
          if (error.name === 'InvalidStateError') {
            entry.pendingIceCandidates.push({
              candidate: message.candidate,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }
    }
  }, [initializeLocalStream, fetchRtcConfig, flushPendingCandidates, closeConnection, triggerReconnect]);

  /**
   * Get the connection state for a specific peer
   */
  const getPeerState = useCallback((remoteUserId: string): WebRTCState => {
    const entry = peersRef.current.get(remoteUserId);
    if (!entry) return 'idle';
    const state = entry.pc.connectionState;
    if (state === 'connected') return 'connected';
    if (state === 'connecting' || state === 'new') return 'connecting';
    if (state === 'failed' || state === 'closed') return 'failed';
    return 'connecting';
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const [, entry] of peersRef.current) {
        if (entry.disconnectedTimer) clearTimeout(entry.disconnectedTimer);
        try { entry.pc.close(); } catch { /* noop */ }
      }
      peersRef.current.clear();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
    };
  }, []);

  return {
    localStream,
    startConnection,
    closeConnection,
    resetAll,
    handleSignalingMessage,
    initializeLocalStream,
    replaceLocalStream,
    getPeerState,
  };
}

// ─── Helpers ───────────────────────────────────────────────

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
