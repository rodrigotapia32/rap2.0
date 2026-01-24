/**
 * Hook personalizado para manejar la conexión WebRTC
 * Gestiona la creación de ofertas, respuestas, ICE candidates y el stream de audio
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { SignalingMessage } from '@/lib/websocket';

interface UseWebRTCOptions {
  roomId: string;
  userId: string;
  nickname: string;
  isHost: boolean;
  sendSignalingMessage?: (message: SignalingMessage) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  waitForRemote?: boolean; // Si es true, espera a que el remoto esté listo antes de crear oferta
}

export function useWebRTC({
  roomId,
  userId,
  nickname,
  isHost,
  sendSignalingMessage,
  onRemoteStream,
  onConnectionStateChange,
  waitForRemote = false,
}: UseWebRTCOptions) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const sendMessageRef = useRef(sendSignalingMessage);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]); // Cola de ICE candidates pendientes

  // Función para generar credenciales efímeras para TURN
  const generateTurnCredentials = async (): Promise<{ username: string; credential: string }> => {
    const TURN_SECRET = 'c94829d333246d94536a2c2df3e8a71ee9d709f6ac50cc7a75c355b863a82575';
    const TURN_USERNAME = 'rap2.0'; // Username fijo o timestamp
    
    // Generar timestamp (válido por 24 horas)
    const timestamp = Math.floor(Date.now() / 1000) + (24 * 3600);
    const username = `${timestamp}:${TURN_USERNAME}`;
    
    try {
      // Generar HMAC-SHA1 usando Web Crypto API
      const encoder = new TextEncoder();
      const keyData = encoder.encode(TURN_SECRET);
      const messageData = encoder.encode(username);
      
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      );
      
      const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
      const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
      
      return { username, credential };
    } catch (error) {
      // Fallback: usar secret directamente como password (si el servidor lo permite)
      console.warn('⚠️ No se pudo generar credenciales efímeras, usando secret directo');
      return { username: TURN_USERNAME, credential: TURN_SECRET };
    }
  };

  // Configuración STUN/TURN
  // Incluye servidores públicos de Google y servidor TURN privado
  const [rtcConfig, setRtcConfig] = useState<RTCConfiguration>({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:159.89.54.229:3478' },
    ],
    iceCandidatePoolSize: 10,
  });

  // Generar credenciales TURN y actualizar configuración
  useEffect(() => {
    generateTurnCredentials().then(({ username, credential }) => {
      setRtcConfig({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:159.89.54.229:3478' },
          {
            urls: 'turn:159.89.54.229:3478',
            username,
            credential,
          },
        ],
        iceCandidatePoolSize: 10,
      });
    });
  }, []);

  /**
   * Inicializa el stream local (micrófono)
   */
  const initializeLocalStream = useCallback(async () => {
    try {
      // Intentar obtener el stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      
      // Asegurarse de que el stream se guarde correctamente
      localStreamRef.current = stream;
      setLocalStream(stream);
      
      // Verificar que los tracks estén habilitados
      const audioTracks = stream.getAudioTracks();
      audioTracks.forEach((track) => {
        // Asegurarse de que el track esté habilitado
        track.enabled = true;
      });
      
      return stream;
    } catch (error: any) {
      console.error('❌ Error accediendo al micrófono:', error);
      
      // Solo mostrar alert si realmente es un error de permisos
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        // Verificar si realmente está denegado (no solo que el usuario canceló el prompt)
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        
        // Solo mostrar alert si el error es persistente (no solo un cancel del prompt)
        // En móvil, a veces el prompt se cancela pero los permisos ya están otorgados
        if (isMobile) {
          // En móvil, verificar si realmente está denegado antes de mostrar el mensaje
          try {
            const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
            if (status?.state === 'denied') {
              alert('Permisos de micrófono denegados.\n\nEn móvil:\n1. Toca el ícono de candado en la barra de direcciones\n2. Permite el acceso al micrófono\n3. Recarga la página\n\nO ve a Configuración del navegador → Permisos → Micrófono');
            }
          } catch (e) {
            // Si no se puede verificar, mostrar el mensaje solo una vez
          }
        } else {
          alert('Permisos de micrófono denegados.\n\nPor favor:\n1. Haz click en el ícono de candado en la barra de direcciones\n2. Permite el acceso al micrófono\n3. Recarga la página');
        }
        // Continuar sin micrófono (solo escucha)
        return null;
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        alert('No se encontró ningún micrófono. Verifica que tengas un micrófono conectado.');
        return null;
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        alert('El micrófono está siendo usado por otra aplicación. Cierra otras aplicaciones que puedan estar usando el micrófono.');
        return null;
      } else {
        // Solo mostrar alert para errores desconocidos si no es un error común
        if (!error.message?.includes('user') && !error.message?.includes('cancel')) {
          console.warn('Error desconocido accediendo al micrófono:', error.message);
        }
        return null;
      }
    }
  }, []);

  /**
   * Crea y configura la conexión RTCPeerConnection
   */
  const createPeerConnection = useCallback(() => {
    // Solo cerrar y recrear si la conexión actual está cerrada
    if (peerConnectionRef.current) {
      const currentState = peerConnectionRef.current.signalingState;
      if (currentState === 'closed') {
        peerConnectionRef.current.close();
      } else {
        return peerConnectionRef.current; // Reutilizar la conexión existente
      }
    }
    
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    // Manejar stream remoto
    pc.ontrack = (event) => {
      console.log('📡 Stream remoto recibido (ontrack)');
      
      // Asegurarse de que hay un stream y tracks
      if (event.streams && event.streams.length > 0 && onRemoteStream) {
        const stream = event.streams[0];
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          console.log('✅ Stream remoto con audio recibido');
          onRemoteStream(stream);
        }
      } else if (event.track && event.track.kind === 'audio' && onRemoteStream) {
        // Si no hay stream pero hay track de audio, crear uno nuevo
        const newStream = new MediaStream([event.track]);
        console.log('✅ Stream remoto creado desde track de audio');
        onRemoteStream(newStream);
      }
    };

    // Manejar cambios de estado de conexión
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (onConnectionStateChange) {
        onConnectionStateChange(state);
      }
      setIsConnected(state === 'connected');
      
      // Log estados importantes
      if (state === 'connected') {
        console.log('✅ Conexión WebRTC establecida');
      } else if (state === 'failed') {
        console.error('❌ Error de conexión WebRTC');
      } else if (state === 'disconnected') {
        console.warn('⚠️ Conexión WebRTC desconectada');
      }
    };

    // Manejar cambios de ICE connection state
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      if (iceState === 'failed') {
        console.error('❌ Error ICE - reiniciando...');
        pc.restartIce();
      } else if (iceState === 'connected') {
        console.log('✅ ICE conectado');
      }
    };

    // Manejar ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && sendMessageRef.current) {
        sendMessageRef.current({
          type: 'ice-candidate',
          candidate: event.candidate,
        });
      }
    };

    // Agregar stream local a la conexión si está disponible
    // Si no está disponible ahora, se agregará cuando se obtenga el stream
    const addLocalTracks = () => {
      if (localStreamRef.current && pc.signalingState !== 'closed') {
        const audioTracks = localStreamRef.current.getAudioTracks();
        const existingSenders = pc.getSenders();
        const hasAudioSender = existingSenders.some(sender => sender.track?.kind === 'audio');
        
        if (audioTracks.length > 0 && !hasAudioSender) {
          audioTracks.forEach((track) => {
            track.enabled = true;
            try {
              pc.addTrack(track, localStreamRef.current!);
            } catch (error) {
              // Ignorar error si el track ya fue agregado
            }
          });
        }
      }
    };
    
    // Intentar agregar tracks ahora
    addLocalTracks();
    
    // También intentar cuando el stream esté disponible (si no lo está ahora)
    if (!localStreamRef.current) {
      const checkInterval = setInterval(() => {
        if (localStreamRef.current) {
          addLocalTracks();
          clearInterval(checkInterval);
        }
      }, 100);
      
      // Limpiar después de 5 segundos
      setTimeout(() => clearInterval(checkInterval), 5000);
    }

    return pc;
  }, [onRemoteStream, onConnectionStateChange]);

  /**
   * Crea una oferta (host)
   */
  const createOffer = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      return;
    }

    try {
      // Asegurarse de que el stream local esté agregado antes de crear la oferta
      if (localStreamRef.current) {
        const audioTracks = localStreamRef.current.getAudioTracks();
        const senders = pc.getSenders();
        
        if (audioTracks.length > 0) {
          // Si no hay senders, agregar los tracks
          if (senders.length === 0) {
            audioTracks.forEach((track) => {
              track.enabled = true;
              pc.addTrack(track, localStreamRef.current!);
            });
          }
        }
      }
      
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      
      await pc.setLocalDescription(offer);
      if (sendMessageRef.current) {
        sendMessageRef.current({
          type: 'offer',
          offer: offer,
        });
      } else {
        console.error('❌ sendMessageRef.current no está disponible');
      }
    } catch (error) {
      console.error('❌ Error creando offer:', error);
    }
  }, []);

  /**
   * Maneja una oferta recibida (guest)
   */
  const handleOffer = useCallback(async (offer: RTCSessionDescriptionInit) => {
    let pc = peerConnectionRef.current;
    
    // Si no hay peer connection, crearla primero
    if (!pc) {
      createPeerConnection();
      await new Promise(resolve => setTimeout(resolve, 100));
      pc = peerConnectionRef.current;
      
      if (!pc) {
        console.error('❌ Guest: No se pudo crear peer connection');
        return;
      }
    }

    try {
      // Asegurarse de que el stream local esté agregado antes de crear la respuesta
      if (localStreamRef.current) {
        const audioTracks = localStreamRef.current.getAudioTracks();
        const senders = pc.getSenders();
        
        if (audioTracks.length > 0) {
          // Si no hay senders, agregar los tracks
          if (senders.length === 0) {
            audioTracks.forEach((track) => {
              track.enabled = true;
              pc.addTrack(track, localStreamRef.current!);
            });
          }
        }
      }
      
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Procesar ICE candidates pendientes después de establecer descripción remota
      while (pendingIceCandidatesRef.current.length > 0) {
        const candidate = pendingIceCandidatesRef.current.shift();
        if (candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (error) {
            console.error('❌ Error agregando ICE candidate pendiente:', error);
          }
        }
      }
      
      // Verificar receivers después de establecer descripción remota
      const receivers = pc.getReceivers();
      console.log('📥 Receivers después de establecer descripción remota:', receivers.length);
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (sendMessageRef.current) {
        sendMessageRef.current({
          type: 'answer',
          answer: answer,
        });
      }
    } catch (error: any) {
      console.error('❌ Error manejando offer:', error);
      if (error.name === 'InvalidStateError') {
        console.error('❌ La peer connection está en un estado inválido:', pc.signalingState);
        createPeerConnection();
      }
    }
  }, [createPeerConnection]);

  /**
   * Maneja una respuesta recibida (host)
   */
  const handleAnswer = useCallback(async (answer: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error('Host: No hay peer connection para manejar la respuesta');
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      
      // Procesar ICE candidates pendientes después de establecer descripción remota
      while (pendingIceCandidatesRef.current.length > 0) {
        const candidate = pendingIceCandidatesRef.current.shift();
        if (candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (error) {
            console.error('❌ Error agregando ICE candidate pendiente:', error);
          }
        }
      }
      
      // Verificar receivers después de establecer descripción remota
      const receivers = pc.getReceivers();
      console.log('📥 Receivers después de establecer descripción remota (host):', receivers.length);
    } catch (error) {
      console.error('❌ Error manejando answer:', error);
    }
  }, []);

  /**
   * Maneja un ICE candidate recibido
   */
  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    let pc = peerConnectionRef.current;
    
    // Si no hay peer connection, crearla primero (puede llegar antes de la oferta)
    if (!pc) {
        createPeerConnection();
      await new Promise(resolve => setTimeout(resolve, 100));
      pc = peerConnectionRef.current;
      
      if (!pc) {
        return;
      }
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error: any) {
      // Si el error es porque la descripción remota no está establecida, guardarlo en la cola
      if (error.name === 'InvalidStateError' && pc.remoteDescription === null) {
        pendingIceCandidatesRef.current.push(candidate);
      } else {
        console.error('❌ Error agregando ICE candidate:', error);
      }
    }
  }, [createPeerConnection]);

  // Actualizar referencia de sendMessage
  useEffect(() => {
    sendMessageRef.current = sendSignalingMessage;
  }, [sendSignalingMessage]);

  /**
   * Inicializa la conexión WebRTC
   */
  useEffect(() => {
    let mounted = true;
    let peerConnectionCreated = false;

    const setup = async () => {
      // 1. Intentar obtener stream local (puede fallar si no hay permisos)
      const stream = await initializeLocalStream();
      if (!mounted) return;

      // Verificar que el stream local esté disponible antes de continuar
      if (!stream) {
        // Continuar en modo solo escucha
      }

      // 2. Crear conexión peer solo si no existe
      if (!peerConnectionRef.current) {
        createPeerConnection();
        peerConnectionCreated = true;
        
        // Asegurarse de que el stream local se agregue después de crear la conexión
        if (stream && peerConnectionRef.current) {
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length > 0) {
            audioTracks.forEach((track) => {
              track.enabled = true;
              if (peerConnectionRef.current) {
                peerConnectionRef.current.addTrack(track, stream);
              }
            });
          }
        }
      }

      // 3. Si es host, crear offer cuando el remoto esté listo
      if (isHost && sendMessageRef.current) {
        if (!waitForRemote) {
          // Fallback: esperar un delay si waitForRemote no está habilitado
          setTimeout(() => {
            if (mounted && peerConnectionRef.current && sendMessageRef.current) {
              if (!localStreamRef.current) {
                setTimeout(() => {
                  if (mounted && peerConnectionRef.current && sendMessageRef.current && localStreamRef.current) {
                    createOffer();
                  }
                }, 1000);
                return;
              }
              createOffer();
            }
          }, 2000);
        }
      }
    };

    setup();

    return () => {
      mounted = false;
      if (peerConnectionCreated && peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }
    };
  }, [roomId, userId, nickname, isHost, sendSignalingMessage, initializeLocalStream, createPeerConnection, createOffer, waitForRemote]);

  // Exponer función para manejar mensajes de signaling
  const handleSignalingMessage = useCallback((message: SignalingMessage) => {
    switch (message.type) {
      case 'offer':
        if (!isHost) {
          handleOffer(message.offer);
        }
        break;
      case 'answer':
        if (isHost) {
          handleAnswer(message.answer);
        }
        break;
      case 'ice-candidate':
        handleIceCandidate(message.candidate);
        break;
    }
  }, [isHost, handleOffer, handleAnswer, handleIceCandidate]);

  // Exponer función para crear oferta manualmente (cuando el remoto esté listo)
  const startWebRTC = useCallback(async () => {
    if (!isHost) {
      return;
    }
    
    // Intentar obtener el stream local si no está disponible
    if (!localStreamRef.current) {
      console.log('⏳ startWebRTC: Obteniendo stream local...');
      const stream = await initializeLocalStream();
      if (!stream) {
        console.error('❌ startWebRTC: No se pudo obtener stream local');
        return;
      }
      // Asegurarse de que el stream se guardó en la ref
      if (!localStreamRef.current) {
        localStreamRef.current = stream;
        setLocalStream(stream);
      }
    }
    
    // Verificar que el stream esté disponible
    if (!localStreamRef.current) {
      console.error('❌ startWebRTC: Stream local no disponible después de obtenerlo');
      return;
    }
    
    // Asegurarse de que hay peer connection
    if (!peerConnectionRef.current) {
      createPeerConnection();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error('❌ startWebRTC: No se pudo crear peer connection');
      return;
    }
    
    // Verificar que la conexión no esté cerrada
    if (pc.signalingState === 'closed') {
      createPeerConnection();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    if (!sendMessageRef.current) {
      console.error('❌ startWebRTC: No hay sendMessage disponible');
      return;
    }
    
    // Asegurarse de que los tracks locales estén agregados
    const senders = pc.getSenders();
    const hasAudioSender = senders.some(sender => sender.track?.kind === 'audio');
    
    if (!hasAudioSender && localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      if (audioTracks.length > 0) {
        audioTracks.forEach((track) => {
          track.enabled = true;
          try {
            pc.addTrack(track, localStreamRef.current!);
          } catch (error) {
            // Ignorar si ya fue agregado
          }
        });
      }
    }
    
    createOffer();
  }, [isHost, createOffer, createPeerConnection, initializeLocalStream]);

  return {
    localStream,
    isConnected,
    handleSignalingMessage,
    startWebRTC,
  };
}
