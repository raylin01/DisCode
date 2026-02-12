/**
 * HTTP Server for Runner Agent
 *
 * Handles approval requests, session events, and hook events from CLI plugins.
 */
import http from 'http';
import type { PendingApproval, PendingMessage } from './types.js';
import type { WebSocketManager } from './websocket.js';
import type { PluginManager } from './plugins/index.js';
export interface HttpServerConfig {
    port: number;
    runnerId: string;
    runnerName: string;
    cliTypes: ('claude' | 'gemini')[];
    approvalTimeout: number;
}
export interface HttpServerDependencies {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    pendingApprovals: Map<string, PendingApproval>;
    pendingMessages: Map<string, PendingMessage[]>;
}
export declare function createHttpServer(config: HttpServerConfig, deps: HttpServerDependencies): http.Server;
