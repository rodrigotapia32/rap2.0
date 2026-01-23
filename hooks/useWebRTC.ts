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
      // Verificar permisos primero (si está disponible)
      let permissionStatus = null;
      if (navigator.permissions && navigator.permissions.query) {
        try {
          permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (permissionStatus.state === 'granted') {
            console.log('✅ Permisos de micrófono ya otorgados');
          } else if (permissionStatus.state === 'denied') {
            console.warn('⚠️ Permisos de micrófono denegados previamente');
          }
        } catch (e) {
          // La API de permisos no está disponible en todos los navegadores
          console.log('API de permisos no disponible, intentando acceso directo');
        }
      }

      // Intentar obtener el stream
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
      console.log('✅ Stream local obtenido correctamente');
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
            } else {
              // Probablemente solo canceló el prompt, no mostrar alert
              console.log('Usuario canceló el prompt, pero permisos pueden estar otorgados');
            }
          } catch (e) {
            // Si no se puede verificar, mostrar el mensaje solo una vez
            console.warn('⚠️ No se pudo verificar estado de permisos');
          }
        } else {
          alert('Permisos de micrófono denegados.\n\nPor favor:\n1. Haz click en el ícono de candado en la barra de direcciones\n2. Permite el acceso al micrófono\n3. Recarga la página');
        }
        // Continuar sin micrófono (solo escucha)
        console.warn('⚠️ Continuando sin micrófono (solo modo escucha)');
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
        console.log('🔵 Cerrando peer connection anterior (estado: closed)...');
        peerConnectionRef.current.close();
      } else {
        console.log('🔵 Peer connection ya existe y está activa (estado:', currentState, '), reutilizando...');
        return; // Reutilizar la conexión existente
      }
    }
    
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;
    console.log('🔵 Nueva peer connection creada, signalingState:', pc.signalingState);

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
      console.log('🔵 Guest: No hay peer connection, creando una...');
      createPeerConnection();
      // Esperar un momento para que se establezca
      await new Promise(resolve => setTimeout(resolve, 100));
      pc = peerConnectionRef.current;
      
      if (!pc) {
        console.error('❌ Guest: No se pudo crear peer connection');
        return;
      }
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
    } catch (error: any) {
      console.error('❌ Error manejando offer:', error);
      if (error.name === 'InvalidStateError') {
        console.error('❌ La peer connection está en un estado inválido:', pc.signalingState);
        // Recrear la conexión si está en estado inválido
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
      console.log('🔵 No hay peer connection para ICE candidate, creando una...');
      createPeerConnection();
      // Esperar un momento para que se establezca
      await new Promise(resolve => setTimeout(resolve, 100));
      pc = peerConnectionRef.current;
      
      if (!pc) {
        console.warn('⚠️ No se pudo crear peer connection para ICE candidate');
        return;
      }
    }

    try {
      // Intentar agregar el ICE candidate
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error: any) {
      // Si el error es porque la descripción remota no está establecida, guardarlo en la cola
      if (error.name === 'InvalidStateError' && pc.remoteDescription === null) {
        console.log('🔵 ICE candidate llegó antes de la descripción remota, guardando en cola...');
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
      // Continuar incluso si no hay stream (modo solo escucha)
      if (!mounted) return;

      // 2. Crear conexión peer solo si no existe
      if (!peerConnectionRef.current) {
        createPeerConnection();
        peerConnectionCreated = true;
      }

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
      // Solo limpiar si realmente creamos la conexión en este efecto
      // No limpiar si la conexión se creó en otro lugar (como startWebRTC)
      if (peerConnectionCreated && peerConnectionRef.current) {
        console.log('🔵 Limpiando peer connection del useEffect...');
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      // Limpiar stream local
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
  const startWebRTC = useCallback(() => {
    console.log('🔵 startWebRTC llamado, verificando condiciones...');
    console.log('  - isHost:', isHost);
    console.log('  - peerConnectionRef.current:', !!peerConnectionRef.current);
    if (peerConnectionRef.current) {
      console.log('  - signalingState:', peerConnectionRef.current.signalingState);
      console.log('  - connectionState:', peerConnectionRef.current.connectionState);
    }
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
        const pc = peerConnectionRef.current;
        if (pc && sendMessageRef.current) {
          console.log('🔵 Peer connection creada, verificando estado...');
          console.log('  - signalingState:', pc.signalingState);
          console.log('  - connectionState:', pc.connectionState);
          
          // Verificar que la conexión no esté cerrada
          if (pc.signalingState === 'closed') {
            console.error('❌ Peer connection está cerrada, recreando...');
            createPeerConnection();
            setTimeout(() => {
              if (peerConnectionRef.current && sendMessageRef.current) {
                createOffer();
              }
            }, 100);
            return;
          }
          
          console.log('🔵 Estado válido, creando oferta...');
          createOffer();
        } else {
          console.error('❌ No se pudo crear peer connection o sendMessage no disponible');
        }
      }, 200); // Aumentado a 200ms para dar más tiempo
      return;
    }
    
    // Verificar que la conexión existente no esté cerrada
    const pc = peerConnectionRef.current;
    if (pc.signalingState === 'closed') {
      console.error('❌ Peer connection está cerrada, recreando...');
      createPeerConnection();
      setTimeout(() => {
        if (peerConnectionRef.current && sendMessageRef.current) {
          createOffer();
        }
      }, 200);
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
