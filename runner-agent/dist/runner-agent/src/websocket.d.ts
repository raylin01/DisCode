/**
 * WebSocket Manager for Runner Agent
 *
 * Handles connection to Discord bot, auto-reconnection, and heartbeats.
 */
import { EventEmitter } from 'events';
import type { WebSocketMessage } from '../../shared/types.js';
import type { RunnerConfig } from './config.js';
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
export declare class WebSocketManager extends EventEmitter {
    private ws;
    private _isConnected;
    private heartbeatTimer;
    private readonly config;
    readonly runnerId: string;
    constructor(config: WebSocketManagerConfig);
    get isConnected(): boolean;
    connect(): void;
    send(message: WebSocketMessage): boolean;
    private startHeartbeat;
    private stopHeartbeat;
    private sendHeartbeat;
    close(): void;
}
export declare function createWebSocketManager(config: RunnerConfig): WebSocketManager;
