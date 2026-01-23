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

      // Escuchar cuando la suscripción es exitosa
      this.channel.bind('pusher:subscription_succeeded', () => {
        console.log('Suscrito al canal de Pusher');
        this.isConnected = true;
        if (this.onConnectionChange) {
          this.onConnectionChange(true);
        }
        // Notificar que el usuario se unió
        setTimeout(() => {
          this.trigger('user-joined', {
            userId: this.userId,
            nickname: this.nickname,
          });
        }, 100);
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

      // Escuchar mensajes de signaling (client events)
      this.channel.bind('client-signaling', (data: SignalingMessage) => {
        // No procesar nuestros propios mensajes
        if (data.userId && data.userId === this.userId) {
          return;
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

      // Enviar a través del canal usando client events
      this.trigger('signaling', messageWithUser);
    } catch (error) {
      console.error('Error enviando mensaje a Pusher:', error);
    }
  }

  /**
   * Trigger un evento en el canal usando client events
   * Nota: Client events están limitados a 10 eventos/minuto en plan gratis de Pusher
   * Para producción, considera usar un servidor backend
   */
  private trigger(event: string, data: any) {
    if (this.channel && this.isConnected && this.channel.trigger) {
      try {
        this.channel.trigger(`client-${event}`, data);
      } catch (error) {
        console.error('Error trigger event:', error);
      }
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
