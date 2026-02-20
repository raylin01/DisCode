/**
 * SquireBot WebSocket Client
 *
 * Connects to SquireBot for Discord channel operations.
 */

import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';

export interface ChannelOperation {
  type: 'create_channel' | 'send_message' | 'rename_channel' | 'set_topic' | 'create_forum_post';
  requestId: string;
  data: Record<string, unknown>;
}

export interface ChannelOperationResult {
  requestId: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export class SquireBotClient {
  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private pendingRequests: Map<string, {
    resolve: (value: ChannelOperationResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log('[SquireBotClient] Connected');

        // Authenticate
        this.ws!.send(JSON.stringify({
          type: 'auth',
          data: { token: this.token }
        }));
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('[SquireBotClient] Failed to parse message:', error);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('[SquireBotClient] WebSocket error:', error);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on('close', () => {
        console.log('[SquireBotClient] Disconnected');
        this.connected = false;
      });

      // Wait for auth confirmation
      const authTimeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 10000);

      const originalResolve = resolve;
      resolve = () => {
        clearTimeout(authTimeout);
        originalResolve();
      };

      // Store resolve for auth response
      this.pendingRequests.set('__auth__', {
        resolve: () => {
          this.connected = true;
          resolve();
        },
        reject,
        timeout: authTimeout,
      });
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;

    // Reject all pending requests
    for (const [id, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      if (id !== '__auth__') {
        reject(new Error('Disconnected'));
      }
    }
    this.pendingRequests.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createChannel(options: {
    name: string;
    guildId: string;
    parentId?: string;
    topic?: string;
  }): Promise<ChannelOperationResult> {
    return this.sendOperation('create_channel', options);
  }

  async sendMessage(options: {
    channelId: string;
    content: string;
    embed?: {
      title?: string;
      description?: string;
      color?: string;
    };
  }): Promise<ChannelOperationResult> {
    return this.sendOperation('send_message', options);
  }

  async renameChannel(options: {
    channelId: string;
    name: string;
  }): Promise<ChannelOperationResult> {
    return this.sendOperation('rename_channel', options);
  }

  async setTopic(options: {
    channelId: string;
    topic: string;
  }): Promise<ChannelOperationResult> {
    return this.sendOperation('set_topic', options);
  }

  async createForumPost(options: {
    forumChannelId: string;
    title: string;
    content: string;
    tags?: string[];
  }): Promise<ChannelOperationResult> {
    return this.sendOperation('create_forum_post', options);
  }

  private async sendOperation(
    type: ChannelOperation['type'],
    data: Record<string, unknown>
  ): Promise<ChannelOperationResult> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to SquireBot');
    }

    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Operation timeout: ${type}`));
      }, 30000);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      const operation: ChannelOperation = { type, requestId, data };
      this.ws!.send(JSON.stringify(operation));
    });
  }

  private handleMessage(message: { type: string; data?: unknown }): void {
    switch (message.type) {
      case 'auth_success':
        this.connected = true;
        const authHandler = this.pendingRequests.get('__auth__');
        if (authHandler) {
          clearTimeout(authHandler.timeout);
          authHandler.resolve({ requestId: '__auth__', success: true });
          this.pendingRequests.delete('__auth__');
        }
        break;

      case 'auth_error':
        const authFailHandler = this.pendingRequests.get('__auth__');
        if (authFailHandler) {
          clearTimeout(authFailHandler.timeout);
          authFailHandler.reject(new Error('Authentication failed'));
          this.pendingRequests.delete('__auth__');
        }
        break;

      case 'operation_result':
        const result = message.data as ChannelOperationResult;
        const handler = this.pendingRequests.get(result.requestId);
        if (handler) {
          clearTimeout(handler.timeout);
          handler.resolve(result);
          this.pendingRequests.delete(result.requestId);
        }
        break;

      case 'event':
        // Handle events from SquireBot (DMs, forum posts, etc.)
        console.log('[SquireBotClient] Event:', message.data);
        // TODO: Emit to event system
        break;

      default:
        console.log('[SquireBotClient] Unknown message type:', message.type);
    }
  }
}
