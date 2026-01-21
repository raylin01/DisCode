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
    cliTypes: ('claude' | 'gemini')[];
    defaultWorkspace?: string;
    heartbeatInterval: number;
    reconnectDelay: number;
    assistantEnabled: boolean;
}

export class WebSocketManager extends EventEmitter {
    private ws: WebSocket | null = null;
    private _isConnected: boolean = false;
    private heartbeatTimer: NodeJS.Timeout | null = null;
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


        this.ws = new WebSocket(this.config.botWsUrl);

        this.ws.on('open', () => {

            this._isConnected = true;

            // Send registration message
            this.send({
                type: 'register',
                data: {
                    runnerId: this.runnerId,
                    runnerName: this.config.runnerName,
                    token: this.config.token,
                    cliTypes: this.config.cliTypes,
                    defaultWorkspace: this.config.defaultWorkspace,
                    assistantEnabled: this.config.assistantEnabled
                }
            });

            // Emit connected event for assistant startup
            this.emit('connected');

            // Start heartbeat
            this.startHeartbeat();
        });

        this.ws.on('message', async (rawData: Buffer) => {
            try {
                const message: WebSocketMessage = JSON.parse(rawData.toString());


                this.emit('message', message);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        });

        this.ws.on('close', () => {

            this._isConnected = false;
            this.stopHeartbeat();

            // Reconnect after delay
            setTimeout(() => {

                this.connect();
            }, this.config.reconnectDelay);
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            this._isConnected = false;
        });
    }

    send(message: WebSocketMessage): boolean {
        if (this.ws && this._isConnected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
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
    });
}
