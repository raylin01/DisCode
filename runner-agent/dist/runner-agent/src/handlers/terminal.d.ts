/**
 * Terminal Handlers
 *
 * Handles list_terminals and watch_terminal WebSocket messages.
 */
import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
export interface TerminalHandlerDeps {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
}
export declare function handleListTerminals(deps: TerminalHandlerDeps): Promise<void>;
export declare function handleWatchTerminal(data: {
    sessionId: string;
}, deps: TerminalHandlerDeps): Promise<void>;
