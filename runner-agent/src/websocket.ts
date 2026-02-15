/**
 * WebSocket Manager for Runner Agent
 * 
 * Handles connection to Discord bot, auto-reconnection, and heartbeats.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { WebSocketMessage } from '../../shared/types.js';
import type { RunnerConfig } from './config.js';
import { generateRunnerId } from './utils.js';

export interface WebSocketManagerConfig {
    botWsUrl: string;
    token: string;
    runnerName: string;
    cliTypes: ('claude' | 'gemini' | 'codex')[];
    defaultWorkspace?: string;
    heartbeatInterval: number;
    reconnectDelay: number;
    assistantEnabled: boolean;
    claudeDefaults?: Record<string, any>;
    codexDefaults?: Record<string, any>;
    geminiDefaults?: Record<string, any>;
}

export class WebSocketManager extends EventEmitter {
    private ws: WebSocket | null = null;
    private _isConnected: boolean = false;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private lastPongAt: number = 0;
    private readonly config: WebSocketManagerConfig;
    readonly runnerId: string;

    constructor(config: WebSocketManagerConfig) {
        super();
        this.config = config;
        this.runnerId = generateRunnerId(config.token, config.runnerName);
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    connect(): void {


        this.ws = new WebSocket(this.config.botWsUrl, {
            maxPayload: 500 * 1024 * 1024 // 500MB
        });

        this.ws.on('open', () => {

            this._isConnected = true;
            this.lastPongAt = Date.now();

            // Send registration message
            this.send({
                type: 'register',
                data: {
                    runnerId: this.runnerId,
                    runnerName: this.config.runnerName,
                    token: this.config.token,
                    cliTypes: this.config.cliTypes,
                    defaultWorkspace: this.config.defaultWorkspace,
                    assistantEnabled: this.config.assistantEnabled,
                    claudeDefaults: this.config.claudeDefaults,
                    codexDefaults: this.config.codexDefaults,
                    geminiDefaults: this.config.geminiDefaults
                }
            });

            // Emit connected event for assistant startup
            this.emit('connected');

            // Start heartbeat
            this.startHeartbeat();
            this.startPing();
        });

        this.ws.on('message', async (rawData: Buffer) => {
            try {
                const message: WebSocketMessage = JSON.parse(rawData.toString());


                this.emit('message', message);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[WebSocket] Closed. code=${code} reason=${reason ? reason.toString() : ''}`);

            this._isConnected = false;
            this.stopHeartbeat();
            this.stopPing();

            // Reconnect after delay
            setTimeout(() => {

                this.connect();
            }, this.config.reconnectDelay);
        });

        this.ws.on('pong', () => {
            this.lastPongAt = Date.now();
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            this._isConnected = false;
        });
    }

    send(message: WebSocketMessage): boolean {
        if (this.ws && this._isConnected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message), (err) => {
                if (err) {
                    console.error('WebSocket send error:', err);
                }
            });
            return true;
        }
        return false;
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.config.heartbeatInterval);

        // Send initial heartbeat
        this.sendHeartbeat();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private startPing(): void {
        this.stopPing();
        const interval = Math.max(15000, Math.min(this.config.heartbeatInterval, 30000));
        const timeout = Math.max(interval * 3, 90000);

        this.pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const now = Date.now();
            if (this.lastPongAt && now - this.lastPongAt > timeout) {
                console.warn(`[WebSocket] Pong timeout (${Math.round((now - this.lastPongAt) / 1000)}s). Reconnecting...`);
                try {
                    this.ws.terminate();
                } catch (err) {
                    console.error('WebSocket terminate error:', err);
                }
                return;
            }
            try {
                this.ws.ping();
            } catch (err) {
                console.error('WebSocket ping error:', err);
            }
        }, interval);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private sendHeartbeat(): void {
        this.send({
            type: 'heartbeat',
            data: {
                runnerId: this.runnerId,
                runnerName: this.config.runnerName,
                cliTypes: this.config.cliTypes,
                defaultWorkspace: this.config.defaultWorkspace,
                timestamp: new Date().toISOString()
            }
        });
    }

    close(): void {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

export function createWebSocketManager(config: RunnerConfig): WebSocketManager {
    return new WebSocketManager({
        botWsUrl: config.botWsUrl,
        token: config.token,
        runnerName: config.runnerName,
        cliTypes: config.cliTypes,
        defaultWorkspace: config.defaultWorkspace,
        heartbeatInterval: config.heartbeatInterval,
        reconnectDelay: config.reconnectDelay,
        assistantEnabled: config.assistant.enabled,
        claudeDefaults: config.claudeDefaults || {},
        codexDefaults: config.codexDefaults || {},
        geminiDefaults: config.geminiDefaults || {}
    });
}
