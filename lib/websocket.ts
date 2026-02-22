/**
 * Cliente WebSocket para signaling
 * Maneja la conexión y el intercambio de mensajes entre peers
 * 
 * NOTA: Para producción en Vercel, usar PusherSignalingClient de pusher-client.ts
 */

import { BattleFormat } from './battle-formats';
import { CachipumChoice, CachipumRoundResult } from './cachipum';

export type SignalingMessage =
  | { type: 'offer'; offer: RTCSessionDescriptionInit; userId?: string; targetUserId?: string; sessionId?: string }
  | { type: 'answer'; answer: RTCSessionDescriptionInit; userId?: string; targetUserId?: string; sessionId?: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit; userId?: string; targetUserId?: string; sessionId?: string }
  | { type: 'peer-hello'; userId: string; nickname: string; sessionId: string }
  | { type: 'peer-hello-ack'; userId: string; targetUserId: string; nickname: string; sessionId: string }
  | { type: 'webrtc-initiate'; userId: string; sessionId: string }
  | { type: 'webrtc-renegotiate'; userId: string; sessionId: string }
  | { type: 'peer-disconnected'; userId: string }
  | { type: 'ready'; userId: string }
  | { type: 'not-ready'; userId: string }
  | { type: 'start-battle'; timestamp: number; userId?: string }
  | { type: 'battle-reset'; userId?: string }
  | { type: 'user-joined'; userId: string; nickname: string }
  | { type: 'user-left'; userId: string }
  | { type: 'beat-selected'; beatNumber: number; userId?: string }
  | { type: 'beat-play'; timestamp?: number; userId?: string }
  | { type: 'beat-pause'; userId?: string }
  | { type: 'beat-restart'; userId?: string }
  | { type: 'battle-format-selected'; format: BattleFormat; totalEntries: number; customTurnSeconds?: number; userId?: string }
  | { type: 'turn-started'; userId: string; turnNumber: number; startTime: number; format: BattleFormat; nickname?: string }
  | { type: 'turn-ended'; userId: string; turnNumber: number }
  | { type: 'beat-intro-offset'; beatNumber: number; offsetSeconds: number; userId?: string }
  | { type: 'cachipum-choice'; userId: string; choice: CachipumChoice; round: number }
  | { type: 'cachipum-round-result'; round: number; choices: Record<string, CachipumChoice>; winners: string[]; userId?: string }
  | { type: 'cachipum-winner'; winnerId: string; userId?: string }
  | { type: 'cachipum-starter-selected'; starterId: string; userId?: string }
  | { type: 'cachipum-restart'; userId?: string }
  | { type: 'cachipum-start'; userId?: string };

export class SignalingClient {
  private ws: WebSocket | null = null;
  private roomId: string;
  private userId: string;
  private nickname: string;
  private onMessage: (message: SignalingMessage) => void;
  private onConnectionChange?: (connected: boolean) => void;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

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
   * Conecta al servidor WebSocket
   * Nota: En producción, usar un servicio WebSocket real (ej: Pusher, Ably, o servidor propio)
   */
  connect() {
    // Para desarrollo local, usar ws://localhost:3001
    // En producción, necesitarías un servidor WebSocket real
    // Por ahora, usamos un enfoque que funciona con el servidor de desarrollo
    
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001';
    
    try {
      // Codificar correctamente los parámetros de la URL
      const params = new URLSearchParams({
        room: this.roomId,
        userId: this.userId,
        nickname: this.nickname,
      });
      this.ws = new WebSocket(`${wsUrl}?${params.toString()}`);

      this.ws.onopen = () => {
        console.log('WebSocket conectado');
        this.reconnectAttempts = 0;
        if (this.onConnectionChange) {
          this.onConnectionChange(true);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message: SignalingMessage = JSON.parse(event.data);
          this.onMessage(message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        // Mostrar mensaje más descriptivo en la consola
        if (this.reconnectAttempts === 0) {
          console.error('⚠️ No se pudo conectar al servidor WebSocket. Asegúrate de que el servidor esté corriendo en el puerto 3001.');
          console.error('💡 Ejecuta: npm run ws');
        }
      };

      this.ws.onclose = (event) => {
        console.log('WebSocket desconectado', event.code, event.reason);
        if (this.onConnectionChange) {
          this.onConnectionChange(false);
        }
        // Intentar reconectar solo si no fue un cierre intencional
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Intentando reconectar... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          setTimeout(() => this.connect(), 1000 * this.reconnectAttempts);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('❌ Se agotaron los intentos de reconexión. Verifica que el servidor WebSocket esté corriendo.');
        }
      };
    } catch (error) {
      console.error('Error connecting WebSocket:', error);
    }
  }

  /**
   * Envía un mensaje al servidor
   */
  send(message: SignalingMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket no está conectado');
    }
  }

  /**
   * Cierra la conexión
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
