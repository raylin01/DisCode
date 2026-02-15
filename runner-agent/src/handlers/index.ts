/**
 * Handler Dispatcher
 * 
 * Main entry point for WebSocket message handling.
 */

import type { WebSocketMessage } from '../../../shared/types.js';
import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata, PendingApproval, PendingMessage, CliPaths, PendingApprovalRequestInfo } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import type { RunnerConfig } from '../config.js';
import type { AssistantManager } from '../assistant-manager.js';

import { handleSessionStart, handleSessionEnd } from './session.js';
import { handleUserMessage } from './message.js';
import { handleApprovalResponse } from './approval.js';
import { handlePermissionDecision } from './permission-decision.js';
import { handlePermissionSyncRequest } from './permission-sync.js';
import { handleListTerminals, handleWatchTerminal } from './terminal.js';
import { handleInterrupt } from './interrupt.js';
import { handleSyncProjects, handleSyncSessions, handleSyncStatusRequest, handleSyncSessionMessages } from './sync.js';
import { handleSessionControl } from './session-control.js';
import { handleRunnerConfigUpdate } from './runner-config.js';
import { handleRunnerHealthRequest, handleRunnerLogsRequest } from './runner-health.js';
import { handleCodexThreadListRequest } from './codex-threads.js';
import { handleModelListRequest } from './models.js';

export interface HandlerDependencies {
    config: RunnerConfig;
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
    pendingApprovals: Map<string, PendingApproval>;
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
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
                cliTypes: ('claude' | 'gemini' | 'codex')[];
                reclaimed?: boolean;
            };

            if (data.reclaimed) {
                console.log(`✅ Runner reclaimed token successfully: ${data.runnerId}`);
                console.log(`   (Previous offline runner was replaced)`);
            } else {
                console.log(`✅ Runner registered successfully: ${data.runnerId}`);
            }

            console.log(`   Supported CLI types: ${data.cliTypes.join(', ')}`);

            if (deps.pendingApprovalRequests.size > 0) {
                await handlePermissionSyncRequest({
                    reason: 'runner_reconnect'
                }, {
                    wsManager: deps.wsManager,
                    pendingApprovalRequests: deps.pendingApprovalRequests
                });
            }
            break;
        }

        case 'approval_response': {
            await handleApprovalResponse(message.data as any, {
                pendingApprovals: deps.pendingApprovals,
                pendingApprovalRequests: deps.pendingApprovalRequests,
                cliSessions: deps.cliSessions,
                wsManager: deps.wsManager,
                assistantManager: deps.assistantManager
            });
            break;
        }

        case 'permission_decision': {
            await handlePermissionDecision(message.data as any, {
                cliSessions: deps.cliSessions,
                wsManager: deps.wsManager,
                pendingApprovalRequests: deps.pendingApprovalRequests
            });
            break;
        }

        case 'permission_sync_request': {
            await handlePermissionSyncRequest(message.data as any, {
                wsManager: deps.wsManager,
                pendingApprovalRequests: deps.pendingApprovalRequests
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
                pendingMessages: deps.pendingMessages,
                pendingApprovalRequests: deps.pendingApprovalRequests
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
        
        case 'session_control': {
            await handleSessionControl(message.data as any, {
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

        case 'sync_session_messages': {
            await handleSyncSessionMessages(message.data as any);
            break;
        }

        case 'sync_status_request': {
            await handleSyncStatusRequest(message.data as any);
            break;
        }

        case 'runner_health_request': {
            handleRunnerHealthRequest(message.data as any, {
                config: deps.config,
                wsManager: deps.wsManager,
                cliPaths: deps.cliPaths
            });
            break;
        }

        case 'runner_logs_request': {
            handleRunnerLogsRequest(message.data as any, {
                wsManager: deps.wsManager
            });
            break;
        }

        case 'runner_config_update': {
            await handleRunnerConfigUpdate(message.data as any, {
                config: deps.config,
                wsManager: deps.wsManager
            });
            break;
        }

        case 'codex_thread_list_request': {
            await handleCodexThreadListRequest(message.data as any, {
                wsManager: deps.wsManager,
                cliPaths: deps.cliPaths,
                pluginManager: deps.pluginManager
            });
            break;
        }

        case 'model_list_request': {
            void handleModelListRequest(message.data as any, {
                wsManager: deps.wsManager,
                config: deps.config,
                cliPaths: deps.cliPaths,
                pluginManager: deps.pluginManager
            }).catch((error) => {
                console.error('[ModelList] Failed to handle model_list_request:', error);
            });
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
