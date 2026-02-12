/**
 * WebSocket Manager for Runner Agent
 *
 * Handles connection to Discord bot, auto-reconnection, and heartbeats.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { generateRunnerId } from './utils.js';
export class WebSocketManager extends EventEmitter {
    ws = null;
    _isConnected = false;
    heartbeatTimer = null;
    config;
    runnerId;
    constructor(config) {
        super();
        this.config = config;
        this.runnerId = generateRunnerId(config.token, config.runnerName);
    }
    get isConnected() {
        return this._isConnected;
    }
    connect() {
        this.ws = new WebSocket(this.config.botWsUrl, {
            maxPayload: 500 * 1024 * 1024 // 500MB
        });
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
        this.ws.on('message', async (rawData) => {
            try {
                const message = JSON.parse(rawData.toString());
                this.emit('message', message);
            }
            catch (error) {
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
    send(message) {
        if (this.ws && this._isConnected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.config.heartbeatInterval);
        // Send initial heartbeat
        this.sendHeartbeat();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    sendHeartbeat() {
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
    close() {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
export function createWebSocketManager(config) {
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
