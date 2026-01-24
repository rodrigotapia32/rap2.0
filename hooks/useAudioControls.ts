/**
 * Hook for controlling audio volumes using Web Audio API.
 * Uses the shared audioContextManager singleton for AudioContext lifecycle.
 * Routes multiple remote audio streams through a shared GainNode -> speakers.
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
  const [micVolume, setMicVolume] = useState(1.0);
  const [remoteVolume, setRemoteVolume] = useState(1.0);
  const [remoteAudioActive, setRemoteAudioActive] = useState(false);

  const remoteGainNodeRef = useRef<GainNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteSourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const unsubUnlockRef = useRef<(() => void) | null>(null);

  /**
   * Ensure the shared remote gain node exists
   */
  const ensureGainNode = useCallback((): GainNode | null => {
    if (remoteGainNodeRef.current) return remoteGainNodeRef.current;

    const ctx = audioContextManager.getContext();
    const gain = ctx.createGain();
    gain.gain.value = remoteVolume;
    gain.connect(ctx.destination);
    remoteGainNodeRef.current = gain;
    return gain;
  }, [remoteVolume]);

  /**
   * Connect a single remote stream to the shared gain node
   */
  const connectPeerStream = useCallback((userId: string, stream: MediaStream) => {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const gainNode = ensureGainNode();
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
  }, [ensureGainNode]);

  /**
   * Disconnect a single peer's audio source
   */
  const disconnectPeerStream = useCallback((userId: string) => {
    const source = remoteSourcesRef.current.get(userId);
    if (source) {
      try { source.disconnect(); } catch { /* noop */ }
      remoteSourcesRef.current.delete(userId);
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

  /**
   * Beat volume control (direct HTMLAudioElement volume)
   */
  useEffect(() => {
    if (beatAudio) {
      beatAudio.volume = beatVolume;
    }
  }, [beatAudio, beatVolume]);

  /**
   * Mic volume control
   */
  useEffect(() => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      for (const track of audioTracks) {
        track.enabled = micVolume > 0;
      }
    }
  }, [localStream, micVolume]);

  /**
   * Remote volume control - applies to shared gain node
   */
  useEffect(() => {
    if (remoteGainNodeRef.current) {
      remoteGainNodeRef.current.gain.value = remoteVolume;
    }
  }, [remoteVolume]);

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
      }
    }

    // Connect new or changed peers
    for (const [userId, stream] of nextStreams) {
      const prev = prevStreams.get(userId);
      if (prev !== stream) {
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
      track.enabled = micVolume > 0;
    }

    return () => {
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch { /* noop */ }
        micSourceRef.current = null;
      }
    };
  }, [localStream, micVolume]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      for (const [, source] of remoteSourcesRef.current) {
        try { source.disconnect(); } catch { /* noop */ }
      }
      remoteSourcesRef.current.clear();
      if (remoteGainNodeRef.current) {
        try { remoteGainNodeRef.current.disconnect(); } catch { /* noop */ }
      }
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch { /* noop */ }
      }
    };
  }, []);

  return {
    beatVolume,
    setBeatVolume,
    micVolume,
    setMicVolume,
    remoteVolume,
    setRemoteVolume,
    remoteAudioActive,
  };
}
