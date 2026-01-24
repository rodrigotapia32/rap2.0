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
          console.log('🎤 Estado de permisos de micrófono:', permissionStatus?.state);
        } catch (e) {
          // La API de permisos no está disponible en todos los navegadores
        }
      }

      console.log('🎤 Intentando obtener stream de micrófono...');
      
      // Intentar obtener el stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      
      console.log('✅ Stream de micrófono obtenido:', {
        id: stream.id,
        active: stream.active,
        tracks: stream.getAudioTracks().length,
      });
      
      // Asegurarse de que el stream se guarde correctamente
      localStreamRef.current = stream;
      setLocalStream(stream);
      
      // Verificar que los tracks estén habilitados
      const audioTracks = stream.getAudioTracks();
      audioTracks.forEach((track, index) => {
        console.log(`🎤 Track ${index}:`, {
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
          label: track.label,
        });
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
        return; // Reutilizar la conexión existente
      }
    }
    
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    // Manejar stream remoto
    pc.ontrack = (event) => {
      console.log('📡 Evento ontrack recibido:', {
        streams: event.streams.length,
        track: {
          kind: event.track.kind,
          enabled: event.track.enabled,
          muted: event.track.muted,
          readyState: event.track.readyState,
          id: event.track.id,
        },
      });
      
      // Asegurarse de que hay un stream y tracks
      if (event.streams && event.streams.length > 0 && onRemoteStream) {
        const stream = event.streams[0];
        console.log('✅ Stream remoto encontrado en evento:', {
          id: stream.id,
          active: stream.active,
          tracks: stream.getTracks().length,
          audioTracks: stream.getAudioTracks().length,
        });
        
        // Verificar que el stream tenga tracks de audio
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          console.log('🎤 Tracks de audio en stream remoto:', audioTracks.map(t => ({
            enabled: t.enabled,
            muted: t.muted,
            readyState: t.readyState,
            label: t.label,
          })));
        }
        
        // Llamar al callback para que el componente pueda procesar el stream
        onRemoteStream(stream);
      } else if (event.track && onRemoteStream) {
        // Si no hay stream pero hay track, crear uno nuevo
        console.log('⚠️ No hay stream en evento, creando uno nuevo con el track');
        const newStream = new MediaStream([event.track]);
        console.log('✅ Stream creado desde track:', {
          id: newStream.id,
          active: newStream.active,
          tracks: newStream.getTracks().length,
        });
        onRemoteStream(newStream);
      } else {
        console.warn('⚠️ Evento ontrack sin stream ni track válido', {
          hasStreams: !!event.streams,
          streamsLength: event.streams?.length || 0,
          hasTrack: !!event.track,
          hasCallback: !!onRemoteStream,
        });
      }
    };


    // Manejar cambios de estado de conexión
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('🔌 Estado de conexión WebRTC:', state);
      if (onConnectionStateChange) {
        onConnectionStateChange(state);
      }
      setIsConnected(state === 'connected');
      
      // Log estados importantes
      if (state === 'connected') {
        console.log('✅ Conexión WebRTC establecida');
      } else if (state === 'failed') {
        console.error('❌ Error de conexión de audio');
      } else if (state === 'disconnected') {
        console.warn('⚠️ Conexión WebRTC desconectada');
      } else if (state === 'connecting') {
        console.log('🔄 Conectando WebRTC...');
      }
    };

    // Manejar cambios de ICE connection state
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log('🧊 Estado ICE:', iceState);
      if (iceState === 'failed') {
        console.error('❌ Error ICE - reiniciando...');
        pc.restartIce();
      } else if (iceState === 'connected') {
        console.log('✅ ICE conectado');
      } else if (iceState === 'checking') {
        console.log('🔍 ICE verificando conexión...');
      } else if (iceState === 'completed') {
        console.log('✅ ICE completado');
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
      const audioTracks = localStreamRef.current.getAudioTracks();
      if (audioTracks.length > 0) {
        console.log('📤 Agregando tracks locales al crear peer connection:', audioTracks.length);
        audioTracks.forEach((track) => {
          // Asegurarse de que el track esté habilitado
          track.enabled = true;
          pc.addTrack(track, localStreamRef.current!);
          console.log('✅ Track local agregado al crear peer connection:', {
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
          });
        });
      } else {
        console.warn('⚠️ Stream local no tiene tracks de audio');
      }
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
        
        console.log('📤 Host creando oferta:', {
          tracksDisponibles: audioTracks.length,
          sendersExistentes: senders.length,
        });
        
        if (audioTracks.length > 0) {
          // Si no hay senders, agregar los tracks
          if (senders.length === 0) {
            console.log('📤 Agregando tracks locales antes de crear oferta (host)');
            audioTracks.forEach((track) => {
              // Asegurarse de que el track esté habilitado
              track.enabled = true;
              pc.addTrack(track, localStreamRef.current!);
              console.log('✅ Track local agregado antes de crear oferta:', {
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
              });
            });
          } else {
            // Verificar que los senders tengan tracks
            console.log('📤 Ya hay senders, verificando tracks:', senders.length);
            senders.forEach((sender, index) => {
              if (sender.track) {
                console.log(`✅ Sender ${index} tiene track:`, {
                  kind: sender.track.kind,
                  enabled: sender.track.enabled,
                  muted: sender.track.muted,
                  readyState: sender.track.readyState,
                });
              } else {
                console.warn(`⚠️ Sender ${index} no tiene track`);
              }
            });
          }
        } else {
          console.warn('⚠️ No hay tracks de audio en el stream local del host');
        }
      } else {
        console.warn('⚠️ No hay stream local disponible en el host');
      }
      
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      
      console.log('📤 Oferta creada:', {
        type: offer.type,
        sdp: offer.sdp?.substring(0, 100) + '...',
      });
      
      await pc.setLocalDescription(offer);
      if (sendMessageRef.current) {
        sendMessageRef.current({
          type: 'offer',
          offer: offer,
        });
        console.log('✅ Oferta enviada al guest');
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
      // Esperar un momento para que se establezca
      await new Promise(resolve => setTimeout(resolve, 100));
      pc = peerConnectionRef.current;
      
      if (!pc) {
        console.error('❌ Guest: No se pudo crear peer connection');
        return;
      }
    }

    try {
      console.log('📥 Guest recibió oferta del host');
      
      // Asegurarse de que el stream local esté agregado antes de crear la respuesta
      if (localStreamRef.current) {
        const audioTracks = localStreamRef.current.getAudioTracks();
        const senders = pc.getSenders();
        
        console.log('📤 Guest preparando respuesta:', {
          tracksDisponibles: audioTracks.length,
          sendersExistentes: senders.length,
        });
        
        if (audioTracks.length > 0) {
          // Si no hay senders, agregar los tracks
          if (senders.length === 0) {
            console.log('📤 Agregando tracks locales antes de crear respuesta (guest)');
            audioTracks.forEach((track) => {
              // Asegurarse de que el track esté habilitado
              track.enabled = true;
              pc.addTrack(track, localStreamRef.current!);
              console.log('✅ Track local agregado antes de crear respuesta:', {
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
              });
            });
          } else {
            console.log('📤 Ya hay senders en la peer connection del guest');
          }
        } else {
          console.warn('⚠️ No hay tracks de audio en el stream local del guest');
        }
      } else {
        console.warn('⚠️ No hay stream local disponible en el guest');
      }
      
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      console.log('✅ Guest estableció descripción remota');
      
      const answer = await pc.createAnswer();
      console.log('📤 Guest creó respuesta');
      
      await pc.setLocalDescription(answer);
      console.log('✅ Guest estableció descripción local');

      if (sendMessageRef.current) {
        sendMessageRef.current({
          type: 'answer',
          answer: answer,
        });
        console.log('✅ Respuesta enviada al host');
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

      // Verificar que el stream local esté disponible antes de continuar
      if (!stream) {
        console.warn('⚠️ No se pudo obtener stream local, continuando en modo solo escucha');
      } else {
        console.log('✅ Stream local obtenido:', {
          id: stream.id,
          active: stream.active,
          tracks: stream.getAudioTracks().length,
        });
      }

      // 2. Crear conexión peer solo si no existe
      if (!peerConnectionRef.current) {
        createPeerConnection();
        peerConnectionCreated = true;
        
        // Asegurarse de que el stream local se agregue después de crear la conexión
        if (stream && peerConnectionRef.current) {
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length > 0) {
            console.log('📤 Agregando tracks locales después de crear peer connection');
            audioTracks.forEach((track) => {
              // Asegurarse de que el track esté habilitado
              track.enabled = true;
              if (peerConnectionRef.current) {
                peerConnectionRef.current.addTrack(track, stream);
                console.log('✅ Track local agregado después de crear peer connection');
              }
            });
          }
        }
      }

      // 3. Si es host, crear offer cuando el remoto esté listo
      if (isHost && sendMessageRef.current) {
        if (waitForRemote) {
          // Esperar a que el remoto esté conectado (se llama desde fuera cuando remoteNickname está listo)
          console.log('⏳ Host esperando a que el remoto se conecte antes de crear oferta');
          // La oferta se creará desde el componente padre cuando detecte al remoto
        } else {
          // Fallback: esperar un delay si waitForRemote no está habilitado
          // Pero asegurarse de que el stream local esté disponible
          setTimeout(() => {
            if (mounted && peerConnectionRef.current && sendMessageRef.current) {
              // Verificar que el stream local esté disponible antes de crear la oferta
              if (!localStreamRef.current) {
                console.warn('⚠️ Host: Stream local no disponible, reintentando...');
                // Reintentar después de un momento
                setTimeout(() => {
                  if (mounted && peerConnectionRef.current && sendMessageRef.current && localStreamRef.current) {
                    createOffer();
                  } else {
                    console.error('❌ Host: No se pudo obtener stream local después de reintentar');
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
      // Solo limpiar si realmente creamos la conexión en este efecto
      // No limpiar si la conexión se creó en otro lugar (como startWebRTC)
      if (peerConnectionCreated && peerConnectionRef.current) {
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
    if (!isHost) {
      return;
    }
    
    // Si no hay peer connection, crearla primero
    if (!peerConnectionRef.current) {
      createPeerConnection();
      // Esperar un momento para que se establezca
      setTimeout(() => {
        const pc = peerConnectionRef.current;
        if (pc && sendMessageRef.current) {
          // Verificar que la conexión no esté cerrada
          if (pc.signalingState === 'closed') {
            createPeerConnection();
            setTimeout(() => {
              if (peerConnectionRef.current && sendMessageRef.current) {
                createOffer();
              }
            }, 100);
            return;
          }
          
          createOffer();
        }
      }, 200);
      return;
    }
    
    // Verificar que la conexión existente no esté cerrada
    const pc = peerConnectionRef.current;
    if (pc.signalingState === 'closed') {
      createPeerConnection();
      setTimeout(() => {
        if (peerConnectionRef.current && sendMessageRef.current) {
          createOffer();
        }
      }, 200);
      return;
    }
    
    if (!sendMessageRef.current) {
      return;
    }
    
    createOffer();
  }, [isHost, createOffer, createPeerConnection]);

  return {
    localStream,
    isConnected,
    handleSignalingMessage,
    startWebRTC,
  };
}
