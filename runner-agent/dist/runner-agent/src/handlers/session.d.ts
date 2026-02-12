/**
 * Session Handlers
 *
 * Handles session_start and session_end WebSocket messages.
 */
import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import type { RunnerConfig } from '../config.js';
import type { CliPaths } from '../types.js';
export interface SessionHandlerDeps {
    config: RunnerConfig;
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
    cliPaths: CliPaths;
}
export declare function handleSessionStart(data: {
    sessionId: string;
    runnerId: string;
    cliType: 'claude' | 'gemini' | 'terminal' | 'generic';
    plugin?: 'tmux' | 'print';
    folderPath?: string;
    create?: boolean;
}, deps: SessionHandlerDeps): Promise<void>;
export declare function handleSessionEnd(data: {
    sessionId: string;
}, deps: Pick<SessionHandlerDeps, 'cliSessions' | 'sessionMetadata'> & {
    pendingMessages: Map<string, any[]>;
}): Promise<void>;
