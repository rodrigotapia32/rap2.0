/**
 * Cliente Pusher para signaling
 * Reemplaza el WebSocket nativo para funcionar en Vercel
 */

import Pusher from 'pusher-js';
import { SignalingMessage } from './websocket';

export class PusherSignalingClient {
  private pusher: Pusher | null = null;
  private channel: any = null;
  private roomId: string;
  private userId: string;
  private nickname: string;
  private onMessage: (message: SignalingMessage) => void;
  private onConnectionChange?: (connected: boolean) => void;
  private isConnected = false;

  constructor(
    roomId: string,
    userId: string,
    nickname: string,
    onMessage: (message: SignalingMessage) => void,
    onConnectionChange?: (connected: boolean) => void
  ) {
    this.roomId = roomId;
    this.userId = userId;
    this.nickname = nickname;
    this.onMessage = onMessage;
    this.onConnectionChange = onConnectionChange;
  }

  /**
   * Conecta a Pusher
   */
  connect() {
    const pusherKey = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const pusherCluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER || 'us2';

    if (!pusherKey) {
      console.error('⚠️ NEXT_PUBLIC_PUSHER_KEY no está configurado');
      console.error('💡 Configura tus variables de entorno en Vercel o .env.local');
      if (this.onConnectionChange) {
        this.onConnectionChange(false);
      }
      return;
    }

    try {
      this.pusher = new Pusher(pusherKey, {
        cluster: pusherCluster,
        // Habilitar client events
        enabledTransports: ['ws', 'wss'],
        // Endpoint de autenticación para canales privados
        authEndpoint: '/api/pusher/auth',
        auth: {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      });

      // Suscribirse al canal de la sala (usando private channel para client events)
      const channelName = `private-room-${this.roomId}`;
      this.channel = this.pusher.subscribe(channelName);

      // IMPORTANTE: Hacer bindings ANTES de que se complete la suscripción
      // para no perder mensajes que lleguen temprano

          // Escuchar mensajes de signaling (client events)
          this.channel.bind('client-signaling', (data: SignalingMessage) => {
            // No procesar nuestros propios mensajes
            if (data.userId && data.userId === this.userId) {
              return;
            }
            // Solo log para mensajes WebRTC importantes
            if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
              console.log('🔵 WebRTC:', data.type);
            }
            this.onMessage(data);
          });

      // Escuchar cuando otros usuarios se unen (client events)
      this.channel.bind('client-user-joined', (data: { userId: string; nickname: string }) => {
        if (data.userId !== this.userId) {
          this.onMessage({
            type: 'user-joined',
            userId: data.userId,
            nickname: data.nickname,
          });
        }
      });

      // Escuchar cuando otros usuarios se van (client events)
      this.channel.bind('client-user-left', (data: { userId: string }) => {
        if (data.userId !== this.userId) {
          this.onMessage({
            type: 'user-left',
            userId: data.userId,
          });
        }
      });

      // Escuchar cuando la suscripción es exitosa
      this.channel.bind('pusher:subscription_succeeded', () => {
        console.log('✅ Suscrito al canal de Pusher');
        this.isConnected = true;
        if (this.onConnectionChange) {
          this.onConnectionChange(true);
        }
        
        // Función para enviar user-joined
        const sendUserJoined = () => {
          console.log('👤 Enviando user-joined:', this.userId, this.nickname);
          const success = this.trigger('user-joined', {
            userId: this.userId,
            nickname: this.nickname,
          });
          if (!success) {
            console.warn('⚠️ No se pudo enviar user-joined (canal no listo)');
          }
        };
        
        // Notificar que el usuario se unió inmediatamente
        sendUserJoined();
        
        // Reenviar periódicamente para asegurar que el otro usuario lo reciba
        // (útil si hay problemas de timing)
        let retryCount = 0;
        const maxRetries = 5;
        const retryInterval = setInterval(() => {
          if (retryCount < maxRetries && this.isConnected) {
            console.log(`👤 Reenviando user-joined (intento ${retryCount + 1}/${maxRetries})`);
            sendUserJoined();
            retryCount++;
          } else {
            if (retryCount >= maxRetries) {
              console.log('👤 Finalizado reintentos de user-joined');
            }
            clearInterval(retryInterval);
          }
        }, 1000); // Cada segundo, hasta 5 veces
      });

      // Eventos de conexión
      this.pusher.connection.bind('connected', () => {
        console.log('Pusher conectado');
      });

      this.pusher.connection.bind('disconnected', () => {
        console.log('Pusher desconectado');
        this.isConnected = false;
        if (this.onConnectionChange) {
          this.onConnectionChange(false);
        }
      });

      this.pusher.connection.bind('error', (err: any) => {
        console.error('Error de conexión Pusher:', err);
        this.isConnected = false;
        if (this.onConnectionChange) {
          this.onConnectionChange(false);
        }
      });
    } catch (error) {
      console.error('Error conectando a Pusher:', error);
      if (this.onConnectionChange) {
        this.onConnectionChange(false);
      }
    }
  }

  /**
   * Envía un mensaje a través de Pusher
   */
  send(message: SignalingMessage) {
    if (!this.channel || !this.isConnected) {
      console.warn('Pusher no está conectado');
      return;
    }

      try {
        // Agregar userId al mensaje para identificar el remitente
        const messageWithUser = {
          ...message,
          userId: this.userId,
        };

        // Solo log para mensajes WebRTC importantes
        if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
          console.log('🔵 WebRTC enviando:', message.type);
        }
        // Enviar a través del canal usando client events
        this.trigger('signaling', messageWithUser);
      } catch (error) {
        console.error('❌ Error enviando mensaje a Pusher:', error);
      }
  }

  /**
   * Trigger un evento en el canal usando client events
   * Nota: Client events están limitados a 10 eventos/minuto en plan gratis de Pusher
   * Para producción, considera usar un servidor backend
   */
  private trigger(event: string, data: any): boolean {
    if (!this.channel) {
      console.warn('⚠️ No hay canal para trigger');
      return false;
    }
    if (!this.isConnected) {
      console.warn('⚠️ Canal no conectado para trigger');
      return false;
    }
    if (!this.channel.trigger) {
      console.warn('⚠️ Canal no tiene método trigger (client events no habilitados?)');
      return false;
    }
    try {
      this.channel.trigger(`client-${event}`, data);
      return true;
    } catch (error) {
      console.error('❌ Error trigger event:', error);
      return false;
    }
  }

  /**
   * Cierra la conexión
   */
  disconnect() {
    if (this.channel) {
      this.channel.unbind_all();
      this.pusher?.unsubscribe(this.channel.name);
    }
    if (this.pusher) {
      this.pusher.disconnect();
      this.pusher = null;
    }
    this.isConnected = false;
    if (this.onConnectionChange) {
      this.onConnectionChange(false);
    }
  }
}
