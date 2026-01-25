/**
 * Hook for controlling audio volumes using Web Audio API.
 * Uses the shared audioContextManager singleton for AudioContext lifecycle.
 * Routes multiple remote audio streams through individual GainNodes -> speakers.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { audioContextManager } from '@/lib/audio-context-manager';

interface UseAudioControlsOptions {
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  beatAudio: HTMLAudioElement | null;
}

export function useAudioControls({
  localStream,
  remoteStreams,
  beatAudio,
}: UseAudioControlsOptions) {
  const [beatVolume, setBeatVolume] = useState(0.5);
  const [remoteVolumes, setRemoteVolumes] = useState<Map<string, number>>(new Map());
  const [remoteAudioActive, setRemoteAudioActive] = useState(false);

  const remoteGainNodesRef = useRef<Map<string, GainNode>>(new Map());
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteSourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const unsubUnlockRef = useRef<(() => void) | null>(null);

  /**
   * Ensure a gain node exists for a specific peer
   */
  const ensurePeerGainNode = useCallback((userId: string): GainNode | null => {
    let gainNode = remoteGainNodesRef.current.get(userId);
    if (gainNode) return gainNode;

    const ctx = audioContextManager.getContext();
    const gain = ctx.createGain();
    // Initialize volume to 1.0 (100%) for new peers
    gain.gain.value = remoteVolumes.get(userId) ?? 1.0;
    gain.connect(ctx.destination);
    remoteGainNodesRef.current.set(userId, gain);
    return gain;
  }, [remoteVolumes]);

  /**
   * Connect a single remote stream to its individual gain node
   */
  const connectPeerStream = useCallback((userId: string, stream: MediaStream) => {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const gainNode = ensurePeerGainNode(userId);
    if (!gainNode) return;

    // Disconnect previous source for this peer if any
    const existing = remoteSourcesRef.current.get(userId);
    if (existing) {
      try { existing.disconnect(); } catch { /* noop */ }
      remoteSourcesRef.current.delete(userId);
    }

    const ctx = audioContextManager.getContext();
    try {
      const source = ctx.createMediaStreamSource(stream);
      source.connect(gainNode);
      remoteSourcesRef.current.set(userId, source);
      setRemoteAudioActive(true);
    } catch (err) {
      console.error(`Error connecting remote stream for ${userId}:`, err);
    }

    // Monitor track lifecycle
    for (const track of audioTracks) {
      track.onended = () => {
        updateActiveState();
      };
      track.onmute = () => {
        updateActiveState();
      };
      track.onunmute = () => {
        setRemoteAudioActive(true);
      };
    }
  }, [ensurePeerGainNode]);

  /**
   * Disconnect a single peer's audio source and clean up gain node
   */
  const disconnectPeerStream = useCallback((userId: string) => {
    const source = remoteSourcesRef.current.get(userId);
    if (source) {
      try { source.disconnect(); } catch { /* noop */ }
      remoteSourcesRef.current.delete(userId);
    }
    
    const gainNode = remoteGainNodesRef.current.get(userId);
    if (gainNode) {
      try { gainNode.disconnect(); } catch { /* noop */ }
      remoteGainNodesRef.current.delete(userId);
    }
    
    updateActiveState();
  }, []);

  /**
   * Update the remoteAudioActive state based on current sources
   */
  function updateActiveState() {
    setRemoteAudioActive(remoteSourcesRef.current.size > 0);
  }

  /**
   * Reconnect all current streams (e.g. after AudioContext unlock)
   */
  const reconnectAllStreams = useCallback(() => {
    for (const [userId, stream] of remoteStreamsRef.current) {
      connectPeerStream(userId, stream);
    }
  }, [connectPeerStream]);

  /**
   * Set volume for a specific peer
   */
  const setRemoteVolume = useCallback((userId: string, volume: number) => {
    setRemoteVolumes(prev => {
      const next = new Map(prev);
      next.set(userId, volume);
      return next;
    });
  }, []);

  /**
   * Register onUnlocked callback to reconnect streams after AudioContext resumes
   */
  useEffect(() => {
    unsubUnlockRef.current = audioContextManager.onUnlocked(() => {
      reconnectAllStreams();
    });

    return () => {
      if (unsubUnlockRef.current) {
        unsubUnlockRef.current();
        unsubUnlockRef.current = null;
      }
    };
  }, [reconnectAllStreams]);

  // Beat volume is controlled via GainNode in page.tsx (Web Audio API routing).
  // Do NOT set beatAudio.volume here — it's multiplicative with the GainNode.

  /**
   * Mic always enabled (maximum volume)
   */
  useEffect(() => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      for (const track of audioTracks) {
        track.enabled = true;
      }
    }
  }, [localStream]);

  /**
   * Remote volume control - applies to individual gain nodes
   */
  useEffect(() => {
    for (const [userId, volume] of remoteVolumes) {
      const gainNode = remoteGainNodesRef.current.get(userId);
      if (gainNode) {
        gainNode.gain.value = volume;
      }
    }
  }, [remoteVolumes]);

  /**
   * Sync remote streams map: connect new, disconnect removed
   */
  useEffect(() => {
    const prevStreams = remoteStreamsRef.current;
    const nextStreams = remoteStreams;

    // Disconnect removed peers
    for (const [userId] of prevStreams) {
      if (!nextStreams.has(userId)) {
        disconnectPeerStream(userId);
        // Clean up volume for disconnected peer
        setRemoteVolumes(prev => {
          const next = new Map(prev);
          next.delete(userId);
          return next;
        });
      }
    }

    // Connect new or changed peers
    for (const [userId, stream] of nextStreams) {
      const prev = prevStreams.get(userId);
      if (prev !== stream) {
        // Initialize volume to 1.0 for new peers
        if (!prevStreams.has(userId)) {
          setRemoteVolumes(prev => {
            const next = new Map(prev);
            if (!next.has(userId)) {
              next.set(userId, 1.0);
            }
            return next;
          });
        }
        if (audioContextManager.isUnlocked()) {
          connectPeerStream(userId, stream);
        } else {
          audioContextManager.tryResume().then(unlocked => {
            if (unlocked) connectPeerStream(userId, stream);
          });
        }
      }
    }

    // Update ref
    remoteStreamsRef.current = new Map(nextStreams);
  }, [remoteStreams, connectPeerStream, disconnectPeerStream]);

  /**
   * Connect local stream for mic monitoring (NOT to destination - prevents feedback)
   * Mic always enabled (maximum volume)
   */
  useEffect(() => {
    if (!localStream) {
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch { /* noop */ }
        micSourceRef.current = null;
      }
      return;
    }

    const audioTracks = localStream.getAudioTracks();
    for (const track of audioTracks) {
      track.enabled = true;
    }

    return () => {
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch { /* noop */ }
        micSourceRef.current = null;
      }
    };
  }, [localStream]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      for (const [, source] of remoteSourcesRef.current) {
        try { source.disconnect(); } catch { /* noop */ }
      }
      remoteSourcesRef.current.clear();
      for (const [, gainNode] of remoteGainNodesRef.current) {
        try { gainNode.disconnect(); } catch { /* noop */ }
      }
      remoteGainNodesRef.current.clear();
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch { /* noop */ }
      }
    };
  }, []);

  return {
    beatVolume,
    setBeatVolume,
    remoteVolumes,
    setRemoteVolume,
    remoteAudioActive,
  };
}
