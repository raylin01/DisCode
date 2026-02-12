/**
 * Handler Dispatcher
 *
 * Main entry point for WebSocket message handling.
 */
import type { WebSocketMessage } from '../../../shared/types.js';
import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata, PendingApproval, PendingMessage, CliPaths } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import type { RunnerConfig } from '../config.js';
import type { AssistantManager } from '../assistant-manager.js';
export interface HandlerDependencies {
    config: RunnerConfig;
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
    pendingApprovals: Map<string, PendingApproval>;
    pendingMessages: Map<string, PendingMessage[]>;
    cliPaths: CliPaths;
    assistantManager: AssistantManager | null;
}
export declare function handleWebSocketMessage(message: WebSocketMessage, deps: HandlerDependencies): Promise<void>;
export type { SessionHandlerDeps } from './session.js';
export type { MessageHandlerDeps } from './message.js';
export type { ApprovalHandlerDeps } from './approval.js';
export type { PermissionDecisionHandlerDeps } from './permission-decision.js';
export type { TerminalHandlerDeps } from './terminal.js';
export type { InterruptHandlerDeps } from './interrupt.js';
