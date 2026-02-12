/**
 * Permission Decision Handler
 *
 * Handles permission_decision WebSocket messages from Discord bot.
 * This is the new permission system that supports scopes and suggestions.
 */
import type { PluginSession } from '../plugins/index.js';
import type { WebSocketManager } from '../websocket.js';
export interface PermissionDecisionHandlerDeps {
    cliSessions: Map<string, PluginSession>;
    wsManager: WebSocketManager;
}
export interface PermissionDecisionData {
    requestId: string;
    sessionId?: string;
    behavior: 'allow' | 'deny';
    scope?: 'session' | 'localSettings' | 'userSettings' | 'projectSettings';
    updatedPermissions?: any[];
    customMessage?: string;
}
/**
 * Handle permission decision from Discord bot
 */
export declare function handlePermissionDecision(data: PermissionDecisionData, deps: PermissionDecisionHandlerDeps): Promise<void>;
