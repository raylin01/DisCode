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

import { handleSessionStart, handleSessionEnd } from './session.js';
import { handleUserMessage } from './message.js';
import { handleApprovalResponse } from './approval.js';
import { handlePermissionDecision } from './permission-decision.js';
import { handleListTerminals, handleWatchTerminal } from './terminal.js';
import { handleInterrupt } from './interrupt.js';
import { handleSyncProjects, handleSyncSessions } from './sync.js';

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

export async function handleWebSocketMessage(
    message: WebSocketMessage,
    deps: HandlerDependencies
): Promise<void> {
    console.log(`[handleWebSocketMessage] Processing type: '${message.type}'`);
    const type = message.type.trim();

    switch (type) {
        case 'error': {
            const data = message.data as { message: string };
            console.error(`❌ Error from Discord bot: ${data.message}`);
            console.error('   Runner agent will exit. Please fix the issue and restart.');
            process.exit(1);
        }

        case 'registered': {
            const data = message.data as {
                runnerId: string;
                cliTypes: ('claude' | 'gemini')[];
                reclaimed?: boolean;
            };

            if (data.reclaimed) {
                console.log(`✅ Runner reclaimed token successfully: ${data.runnerId}`);
                console.log(`   (Previous offline runner was replaced)`);
            } else {
                console.log(`✅ Runner registered successfully: ${data.runnerId}`);
            }

            console.log(`   Supported CLI types: ${data.cliTypes.join(', ')}`);
            break;
        }

        case 'approval_response': {
            await handleApprovalResponse(message.data as any, {
                pendingApprovals: deps.pendingApprovals,
                cliSessions: deps.cliSessions,
                wsManager: deps.wsManager,
                assistantManager: deps.assistantManager
            });
            break;
        }

        case 'permission_decision': {
            await handlePermissionDecision(message.data as any, {
                cliSessions: deps.cliSessions,
                wsManager: deps.wsManager
            });
            break;
        }

        case 'session_start': {
            await handleSessionStart(message.data as any, {
                config: deps.config,
                wsManager: deps.wsManager,
                pluginManager: deps.pluginManager,
                cliSessions: deps.cliSessions,
                sessionMetadata: deps.sessionMetadata,
                cliPaths: deps.cliPaths
            });
            break;
        }

        case 'session_end': {
            await handleSessionEnd(message.data as any, {
                cliSessions: deps.cliSessions,
                sessionMetadata: deps.sessionMetadata,
                pendingMessages: deps.pendingMessages
            });
            break;
        }

        case 'user_message': {
            await handleUserMessage(message.data as any, {
                wsManager: deps.wsManager,
                pluginManager: deps.pluginManager,
                cliSessions: deps.cliSessions,
                sessionMetadata: deps.sessionMetadata
            });
            break;
        }

        case 'list_terminals': {
            await handleListTerminals({
                wsManager: deps.wsManager,
                pluginManager: deps.pluginManager,
                cliSessions: deps.cliSessions,
                sessionMetadata: deps.sessionMetadata
            });
            break;
        }

        case 'watch_terminal': {
            await handleWatchTerminal(message.data as any, {
                wsManager: deps.wsManager,
                pluginManager: deps.pluginManager,
                cliSessions: deps.cliSessions,
                sessionMetadata: deps.sessionMetadata
            });
            break;
        }

        case 'interrupt': {
            await handleInterrupt(message.data as any, {
                cliSessions: deps.cliSessions
            });
            break;
        }

        case 'assistant_message': {
            const data = message.data as {
                runnerId: string;
                userId: string;
                username: string;
                content: string;
                timestamp: string;
            };

            if (deps.assistantManager && deps.assistantManager.isRunning()) {
                await deps.assistantManager.sendMessage(data.content, data.username);
                console.log(`[AssistantMessage] Forwarded from ${data.username}`);
            } else {
                console.error('[AssistantMessage] Assistant not running');
                deps.wsManager.send({
                    type: 'assistant_output',
                    data: {
                        runnerId: deps.wsManager.runnerId,
                        content: '❌ Assistant is not running. Please wait for it to start or check the configuration.',
                        timestamp: new Date().toISOString(),
                        outputType: 'error'
                    }
                });
            }
            break;
        }

        case 'sync_projects': {
            await handleSyncProjects(message.data as any);
            break;
        }

        case 'sync_sessions': {
            await handleSyncSessions(message.data as any);
            break;
        }

        default:
            console.log('Unknown message type:', message.type);
    }
}

// Re-export handler types for convenience
export type { SessionHandlerDeps } from './session.js';
export type { MessageHandlerDeps } from './message.js';
export type { ApprovalHandlerDeps } from './approval.js';
export type { PermissionDecisionHandlerDeps } from './permission-decision.js';
export type { TerminalHandlerDeps } from './terminal.js';
export type { InterruptHandlerDeps } from './interrupt.js';
