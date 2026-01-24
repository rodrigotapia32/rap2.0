/**
 * Pusher signaling client for WebRTC handshake and game events.
 * Uses server-triggered events for reliability (no client event rate limits).
 */

import Pusher from 'pusher-js';
import { SignalingMessage } from './websocket';

export class PusherSignalingClient {
  private pusher: Pusher | null = null;
  private channel: any = null;
  private roomId: string;
  private userId: string;
  private nickname: string;
  private sessionId: string;
  private onMessage: (message: SignalingMessage) => void;
  private onConnectionChange?: (connected: boolean) => void;
  private isConnected = false;
  private beforeUnloadHandler: (() => void) | null = null;

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
    this.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.onMessage = onMessage;
    this.onConnectionChange = onConnectionChange;
  }

  connect() {
    const pusherKey = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const pusherCluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER || 'us2';

    if (!pusherKey) {
      console.error('NEXT_PUBLIC_PUSHER_KEY not configured');
      this.onConnectionChange?.(false);
      return;
    }

    try {
      this.pusher = new Pusher(pusherKey, {
        cluster: pusherCluster,
        enabledTransports: ['ws', 'wss'],
        authEndpoint: '/api/pusher/auth',
        auth: {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      });

      const channelName = `private-room-${this.roomId}`;
      this.channel = this.pusher.subscribe(channelName);

      // ─── Bind message handlers BEFORE subscription completes ───

      // Server-triggered signaling (WebRTC + handshake)
      this.channel.bind('server-signaling', (data: SignalingMessage) => {
        if (data.userId && data.userId === this.userId) return;
        this.onMessage(data);
      });

      // Client-triggered signaling (beat controls, ready, etc.)
      this.channel.bind('client-signaling', (data: SignalingMessage) => {
        const isBeatControl = data.type === 'beat-play' || data.type === 'beat-pause' || data.type === 'beat-restart';
        if (!isBeatControl && data.userId && data.userId === this.userId) return;
        this.onMessage(data);
      });

      // Peer hello (new handshake)
      this.channel.bind('peer-hello', (data: { userId: string; nickname: string; sessionId: string }) => {
        if (data.userId === this.userId) return;
        this.onMessage({ type: 'peer-hello', ...data });
      });

      // Peer hello ack
      this.channel.bind('peer-hello-ack', (data: { userId: string; targetUserId: string; sessionId: string }) => {
        if (data.userId === this.userId) return;
        if (data.targetUserId !== this.userId) return; // Not for us
        this.onMessage({ type: 'peer-hello-ack', ...data });
      });

      // WebRTC initiate
      this.channel.bind('webrtc-initiate', (data: { userId: string; sessionId: string }) => {
        if (data.userId === this.userId) return;
        this.onMessage({ type: 'webrtc-initiate', ...data });
      });

      // WebRTC renegotiate
      this.channel.bind('webrtc-renegotiate', (data: { userId: string; sessionId: string }) => {
        if (data.userId === this.userId) return;
        this.onMessage({ type: 'webrtc-renegotiate', ...data });
      });

      // Peer disconnected
      this.channel.bind('peer-disconnected', (data: { userId: string }) => {
        if (data.userId === this.userId) return;
        this.onMessage({ type: 'peer-disconnected', ...data });
      });

      // Legacy user-joined (backwards compat during transition)
      this.channel.bind('user-joined', (data: { userId: string; nickname: string }) => {
        if (data.userId !== this.userId) {
          this.onMessage({ type: 'user-joined', userId: data.userId, nickname: data.nickname });
        }
      });

      // User left via client event
      this.channel.bind('client-user-left', (data: { userId: string }) => {
        if (data.userId !== this.userId) {
          this.onMessage({ type: 'user-left', userId: data.userId });
        }
      });

      // ─── Subscription succeeded ───
      this.channel.bind('pusher:subscription_succeeded', () => {
        this.isConnected = true;
        this.onConnectionChange?.(true);

        // Send a single peer-hello via server trigger (no retry loop)
        this.serverTrigger('peer-hello', {
          userId: this.userId,
          nickname: this.nickname,
          sessionId: this.sessionId,
        });
      });

      // ─── Connection lifecycle ───
      this.pusher.connection.bind('connected', () => {
        // Connection established
      });

      this.pusher.connection.bind('disconnected', () => {
        this.isConnected = false;
        this.onConnectionChange?.(false);
      });

      this.pusher.connection.bind('error', () => {
        this.isConnected = false;
        this.onConnectionChange?.(false);
      });

      // ─── beforeunload: notify peer of disconnect ───
      this.beforeUnloadHandler = () => {
        // Use sendBeacon for reliable delivery on page close
        const channelName = `private-room-${this.roomId}`;
        const payload = new Blob(
          [JSON.stringify({
            channel: channelName,
            event: 'peer-disconnected',
            data: { userId: this.userId },
          })],
          { type: 'application/json' }
        );
        navigator.sendBeacon('/api/pusher/trigger', payload);
      };
      window.addEventListener('beforeunload', this.beforeUnloadHandler);

    } catch (error) {
      console.error('Error connecting to Pusher:', error);
      this.onConnectionChange?.(false);
    }
  }

  /**
   * Send a signaling message.
   * WebRTC and handshake messages use server trigger; game events use client events.
   */
  async send(message: SignalingMessage) {
    if (!this.channel || !this.isConnected) return;

    const messageWithUser = { ...message, userId: this.userId };

    // Messages that must go through server (reliable, no rate limit)
    const serverTypes = ['offer', 'answer', 'ice-candidate', 'peer-hello', 'peer-hello-ack',
      'webrtc-initiate', 'webrtc-renegotiate', 'peer-disconnected'];

    if (serverTypes.includes(message.type)) {
      await this.serverTrigger('server-signaling', messageWithUser);
    } else {
      // Game events via client events
      this.trigger('signaling', messageWithUser);
    }
  }

  /**
   * Send via server trigger endpoint (reliable, no client event rate limit)
   */
  private async serverTrigger(event: string, data: any): Promise<boolean> {
    const channelName = `private-room-${this.roomId}`;
    try {
      const response = await fetch('/api/pusher/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channelName, event, data }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Trigger a client event on the channel
   */
  private trigger(event: string, data: any): boolean {
    if (!this.channel || !this.isConnected || !this.channel.trigger) return false;
    try {
      this.channel.trigger(`client-${event}`, data);
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    // Remove beforeunload listener
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }

    if (this.channel) {
      this.channel.unbind_all();
      this.pusher?.unsubscribe(this.channel.name);
    }
    if (this.pusher) {
      this.pusher.disconnect();
      this.pusher = null;
    }
    this.isConnected = false;
    this.onConnectionChange?.(false);
  }
}
