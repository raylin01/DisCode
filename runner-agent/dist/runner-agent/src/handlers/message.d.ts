/**
 * User Message Handler
 *
 * Handles user_message WebSocket messages.
 */
import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
export interface MessageHandlerDeps {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
}
export declare function handleUserMessage(data: {
    sessionId: string;
    userId: string;
    username: string;
    content: string;
    attachments?: {
        name: string;
        url: string;
    }[];
    timestamp: string;
}, deps: MessageHandlerDeps): Promise<void>;
