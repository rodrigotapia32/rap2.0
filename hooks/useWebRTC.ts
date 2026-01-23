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

  // Configuración STUN (público de Google)
  // Para localhost, también agregamos configuración sin STUN para conexiones locales
  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // Para conexiones en el mismo PC (localhost), esto ayuda
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    // Configuración adicional para mejorar conexiones locales
    iceCandidatePoolSize: 10,
  };

  /**
   * Inicializa el stream local (micrófono)
   */
  const initializeLocalStream = useCallback(async () => {
    try {
      // Para el mismo PC, puede que necesitemos permisos específicos
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      console.log('Stream local obtenido correctamente');
      return stream;
    } catch (error: any) {
      console.error('Error accediendo al micrófono:', error);
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        alert('Permisos de micrófono denegados. Por favor, permite el acceso al micrófono en la configuración del navegador.');
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        alert('No se encontró ningún micrófono. Verifica que tengas un micrófono conectado.');
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        alert('El micrófono está siendo usado por otra aplicación. Cierra otras aplicaciones que puedan estar usando el micrófono.');
      } else {
        alert('No se pudo acceder al micrófono. Error: ' + error.message);
      }
      return null;
    }
  }, []);

  /**
   * Crea y configura la conexión RTCPeerConnection
   */
  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    // Manejar stream remoto
    pc.ontrack = (event) => {
      if (event.streams[0] && onRemoteStream) {
        onRemoteStream(event.streams[0]);
      }
    };

    // Manejar cambios de estado de conexión
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (onConnectionStateChange) {
        onConnectionStateChange(state);
      }
      setIsConnected(state === 'connected');
      
      // Solo log estados importantes
      if (state === 'connected') {
        console.log('✅ Audio conectado!');
      } else if (state === 'failed') {
        console.error('❌ Error de conexión de audio');
      }
    };

    // Manejar cambios de ICE connection state
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        console.error('❌ Error ICE - reiniciando...');
        pc.restartIce();
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

    // Agregar stream local a la conexión
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    return pc;
  }, [onRemoteStream, onConnectionStateChange]);

  /**
   * Crea una oferta (host)
   */
  const createOffer = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.warn('⚠️ No hay peer connection para crear oferta');
      return;
    }

    try {
      console.log('🔵 Creando oferta WebRTC...');
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      console.log('🔵 Oferta creada, enviando...');

      if (sendMessageRef.current) {
        sendMessageRef.current({
          type: 'offer',
          offer: offer,
        });
        console.log('🔵 Oferta enviada a través de signaling');
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
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error('Guest: No hay peer connection para manejar la oferta');
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (sendMessageRef.current) {
        sendMessageRef.current({
          type: 'answer',
          answer: answer,
        });
      }
    } catch (error) {
      console.error('❌ Error manejando offer:', error);
    }
  }, []);

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
    } catch (error) {
      console.error('❌ Error manejando answer:', error);
    }
  }, []);

  /**
   * Maneja un ICE candidate recibido
   */
  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.warn('⚠️ No hay peer connection para agregar ICE candidate');
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('❌ Error agregando ICE candidate:', error);
    }
  }, []);

  // Actualizar referencia de sendMessage
  useEffect(() => {
    sendMessageRef.current = sendSignalingMessage;
  }, [sendSignalingMessage]);

  /**
   * Inicializa la conexión WebRTC
   */
  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      // 1. Obtener stream local
      const stream = await initializeLocalStream();
      if (!stream || !mounted) return;

      // 2. Crear conexión peer
      createPeerConnection();

      // 3. Si es host, crear offer cuando el remoto esté listo
      if (isHost && sendMessageRef.current) {
        if (waitForRemote) {
          // Esperar a que el remoto esté conectado (se llama desde fuera cuando remoteNickname está listo)
          // La oferta se creará desde el componente padre cuando detecte al remoto
        } else {
          // Fallback: esperar un delay si waitForRemote no está habilitado
          setTimeout(() => {
            if (mounted && peerConnectionRef.current) {
              console.log('🔵 Iniciando WebRTC...');
              createOffer();
            }
          }, 2000);
        }
      }
    };

    setup();

    return () => {
      mounted = false;
      // Limpiar recursos
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, [roomId, userId, nickname, isHost, sendSignalingMessage, initializeLocalStream, createPeerConnection, createOffer]);

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
  const startWebRTC = useCallback(() => {
    console.log('🔵 startWebRTC llamado, verificando condiciones...');
    console.log('  - isHost:', isHost);
    console.log('  - peerConnectionRef.current:', !!peerConnectionRef.current);
    console.log('  - sendMessageRef.current:', !!sendMessageRef.current);
    
    if (!isHost) {
      console.warn('⚠️ startWebRTC llamado pero no es host');
      return;
    }
    
    // Si no hay peer connection, crearla primero
    if (!peerConnectionRef.current) {
      console.log('🔵 Creando peer connection...');
      createPeerConnection();
      // Esperar un momento para que se establezca
      setTimeout(() => {
        if (peerConnectionRef.current && sendMessageRef.current) {
          console.log('🔵 Peer connection creada, creando oferta...');
          createOffer();
        } else {
          console.error('❌ No se pudo crear peer connection o sendMessage no disponible');
        }
      }, 100);
      return;
    }
    
    if (!sendMessageRef.current) {
      console.error('❌ No hay función de envío disponible');
      return;
    }
    
    console.log('🔵 Todas las condiciones cumplidas, creando oferta...');
    createOffer();
  }, [isHost, createOffer, createPeerConnection]);

  return {
    localStream,
    isConnected,
    handleSignalingMessage,
    startWebRTC,
  };
}
