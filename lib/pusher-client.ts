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

          // Escuchar mensajes de signaling (client events y server events)
          this.channel.bind('client-signaling', (data: SignalingMessage) => {
            // Para eventos de control de beat, no filtrar por userId (el host controla)
            const isBeatControl = data.type === 'beat-play' || data.type === 'beat-pause' || data.type === 'beat-restart';
            // No procesar nuestros propios mensajes (excepto controles de beat)
            if (!isBeatControl && data.userId && data.userId === this.userId) {
              return;
            }
            this.onMessage(data);
          });

          // Escuchar mensajes del servidor (para WebRTC, sin límite de client events)
          this.channel.bind('server-signaling', (data: SignalingMessage) => {
            // No procesar nuestros propios mensajes
            if (data.userId && data.userId === this.userId) {
              return;
            }
            this.onMessage(data);
          });

      // Escuchar cuando otros usuarios se unen (desde servidor)
      this.channel.bind('user-joined', (data: { userId: string; nickname: string }) => {
        if (data.userId !== this.userId) {
          this.onMessage({
            type: 'user-joined',
            userId: data.userId,
            nickname: data.nickname,
          });
        }
      });

      // También escuchar client events como fallback
      this.channel.bind('client-user-joined', (data: { userId: string; nickname: string }) => {
        console.log('🔵 Recibido client-user-joined (fallback):', data);
        if (data.userId !== this.userId) {
          console.log('🔵 Procesando user-joined de otro usuario (fallback)');
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
      this.channel.bind('pusher:subscription_succeeded', async () => {
        const channelName = `private-room-${this.roomId}`;
        console.log('✅ Pusher: Suscripción exitosa al canal:', channelName);
        this.isConnected = true;
        if (this.onConnectionChange) {
          this.onConnectionChange(true);
        }
        
        // Notificar que el usuario se unió usando el servidor (más confiable que client events)
        console.log('📤 Pusher: Enviando user-joined al servidor...', {
          userId: this.userId,
          nickname: this.nickname,
          channel: channelName,
        });
        try {
          const response = await fetch('/api/pusher/trigger', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: channelName,
              event: 'user-joined',
              data: {
                userId: this.userId,
                nickname: this.nickname,
              },
            }),
          });

          if (response.ok) {
            console.log('✅ Pusher: user-joined enviado exitosamente al servidor');
          } else {
            console.warn('⚠️ Pusher: Error al enviar user-joined al servidor, usando fallback');
            // Fallback a client events
            this.trigger('user-joined', {
              userId: this.userId,
              nickname: this.nickname,
            });
          }
        } catch (error) {
          console.error('❌ Pusher: Error al enviar user-joined, usando fallback:', error);
          // Fallback a client events
          this.trigger('user-joined', {
            userId: this.userId,
            nickname: this.nickname,
          });
        }
        
        // Reenviar usando servidor para asegurar que el otro usuario lo reciba
        // Aumentar retries y frecuencia en móviles para mejor confiabilidad
        let retryCount = 0;
        const maxRetries = 5; // Aumentado de 3 a 5
        const retryInterval = setInterval(async () => {
          if (retryCount < maxRetries && this.isConnected) {
            try {
              await fetch('/api/pusher/trigger', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  channel: channelName,
                  event: 'user-joined',
                  data: {
                    userId: this.userId,
                    nickname: this.nickname,
                  },
                }),
              });
            } catch (error) {
              // Silenciar errores de reenvío
            }
            retryCount++;
          } else {
            clearInterval(retryInterval);
          }
        }, 1000); // Reducido de 1500ms a 1000ms para más frecuencia
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
   * Para mensajes WebRTC (offer, answer, ice-candidate) usa el servidor para evitar límites
   */
  async send(message: SignalingMessage) {
    if (!this.channel || !this.isConnected) {
      return;
    }

    try {
      // Agregar userId al mensaje para identificar el remitente
      const messageWithUser = {
        ...message,
        userId: this.userId,
      };


      // Para mensajes WebRTC, usar el servidor para evitar límite de client events
      if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
        const channelName = `private-room-${this.roomId}`;
        try {
          const response = await fetch('/api/pusher/trigger', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: channelName,
              event: 'server-signaling',
              data: messageWithUser,
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.warn(`⚠️ Servidor falló (${response.status}), fallback a client events:`, errorText);
            // Fallback a client events si el servidor falla
            this.trigger('signaling', messageWithUser);
          } else {
          }
        } catch (error) {
          console.warn('⚠️ Error con servidor, fallback a client events:', error);
          // Fallback a client events si hay error
          this.trigger('signaling', messageWithUser);
        }
      } else {
        // Para otros mensajes (ready, beat-selected, beat-play, etc), usar client events
        this.trigger('signaling', messageWithUser);
      }
    } catch (error) {
      console.error('❌ [Pusher] Error enviando mensaje:', error);
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
    } catch (error: any) {
      // Verificar si es error de límite de client events
      if (error?.message?.includes('limit') || error?.message?.includes('rate')) {
        console.error('❌ Límite de client events alcanzado en Pusher (plan gratis: 10/minuto)');
        console.error('💡 Solución: Usar servidor backend o upgrade de plan Pusher');
      } else {
        console.error('❌ Error trigger event:', error);
      }
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
