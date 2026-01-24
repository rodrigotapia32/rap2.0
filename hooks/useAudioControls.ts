/**
 * Hook for controlling audio volumes using Web Audio API.
 * Uses the shared audioContextManager singleton for AudioContext lifecycle.
 * Routes remote audio through GainNode -> speakers (primary audio path).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { audioContextManager } from '@/lib/audio-context-manager';

interface UseAudioControlsOptions {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  beatAudio: HTMLAudioElement | null;
}

export function useAudioControls({
  localStream,
  remoteStream,
  beatAudio,
}: UseAudioControlsOptions) {
  const [beatVolume, setBeatVolume] = useState(0.5);
  const [micVolume, setMicVolume] = useState(1.0);
  const [remoteVolume, setRemoteVolume] = useState(1.0);
  const [remoteAudioActive, setRemoteAudioActive] = useState(false);

  const remoteGainNodeRef = useRef<GainNode | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const remoteSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const unsubUnlockRef = useRef<(() => void) | null>(null);

  /**
   * Connect (or reconnect) the remote stream to the audio graph
   */
  const connectRemoteStream = useCallback((stream: MediaStream) => {
    const ctx = audioContextManager.getContext();

    // Disconnect previous source
    if (remoteSourceRef.current) {
      try { remoteSourceRef.current.disconnect(); } catch { /* noop */ }
      remoteSourceRef.current = null;
    }

    // Verify stream has enabled audio tracks
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    // Create gain node if needed
    if (!remoteGainNodeRef.current) {
      remoteGainNodeRef.current = ctx.createGain();
      remoteGainNodeRef.current.gain.value = remoteVolume;
      remoteGainNodeRef.current.connect(ctx.destination);
    }

    // Create source and connect through gain
    try {
      const source = ctx.createMediaStreamSource(stream);
      source.connect(remoteGainNodeRef.current);
      remoteSourceRef.current = source;
      setRemoteAudioActive(true);
    } catch (err) {
      console.error('Error connecting remote stream to AudioContext:', err);
    }

    // Monitor track lifecycle
    for (const track of audioTracks) {
      track.onended = () => {
        setRemoteAudioActive(false);
      };
      track.onmute = () => {
        setRemoteAudioActive(false);
      };
      track.onunmute = () => {
        setRemoteAudioActive(true);
      };
    }
  }, [remoteVolume]);

  /**
   * Register onUnlocked callback to reconnect stream after AudioContext resumes
   */
  useEffect(() => {
    unsubUnlockRef.current = audioContextManager.onUnlocked(() => {
      if (remoteStreamRef.current) {
        connectRemoteStream(remoteStreamRef.current);
      }
    });

    return () => {
      if (unsubUnlockRef.current) {
        unsubUnlockRef.current();
        unsubUnlockRef.current = null;
      }
    };
  }, [connectRemoteStream]);

  /**
   * Beat volume control (direct HTMLAudioElement volume)
   */
  useEffect(() => {
    if (beatAudio) {
      beatAudio.volume = beatVolume;
    }
  }, [beatAudio, beatVolume]);

  /**
   * Mic volume control (gain node for monitoring level)
   */
  useEffect(() => {
    if (micGainNodeRef.current) {
      micGainNodeRef.current.gain.value = micVolume;
    }
  }, [micVolume]);

  /**
   * Remote volume control
   */
  useEffect(() => {
    if (remoteGainNodeRef.current) {
      remoteGainNodeRef.current.gain.value = remoteVolume;
    }
  }, [remoteVolume]);

  /**
   * Connect remote stream when it changes
   */
  useEffect(() => {
    remoteStreamRef.current = remoteStream;

    if (!remoteStream) {
      // Disconnect if stream removed
      if (remoteSourceRef.current) {
        try { remoteSourceRef.current.disconnect(); } catch { /* noop */ }
        remoteSourceRef.current = null;
      }
      setRemoteAudioActive(false);
      return;
    }

    // Only connect if AudioContext is unlocked
    if (audioContextManager.isUnlocked()) {
      connectRemoteStream(remoteStream);
    } else {
      // Try best-effort resume
      audioContextManager.tryResume().then(unlocked => {
        if (unlocked && remoteStreamRef.current === remoteStream) {
          connectRemoteStream(remoteStream);
        }
      });
    }

    return () => {
      if (remoteSourceRef.current) {
        try { remoteSourceRef.current.disconnect(); } catch { /* noop */ }
        remoteSourceRef.current = null;
      }
    };
  }, [remoteStream, connectRemoteStream]);

  /**
   * Connect local stream for mic monitoring (NOT to destination - prevents feedback)
   * The mic gain node is disconnected from destination; it only controls the
   * track enabled state relative to volume.
   */
  useEffect(() => {
    if (!localStream) {
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch { /* noop */ }
        micSourceRef.current = null;
      }
      return;
    }

    // We don't route mic to speakers (that would cause feedback).
    // The micVolume controls the track's gain for WebRTC transmission only.
    // We apply it by adjusting the audio track's enabled state / gain.
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
      if (remoteSourceRef.current) {
        try { remoteSourceRef.current.disconnect(); } catch { /* noop */ }
      }
      if (remoteGainNodeRef.current) {
        try { remoteGainNodeRef.current.disconnect(); } catch { /* noop */ }
      }
      if (micSourceRef.current) {
        try { micSourceRef.current.disconnect(); } catch { /* noop */ }
      }
      if (micGainNodeRef.current) {
        try { micGainNodeRef.current.disconnect(); } catch { /* noop */ }
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
