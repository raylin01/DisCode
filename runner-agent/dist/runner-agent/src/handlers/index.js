/**
 * Handler Dispatcher
 *
 * Main entry point for WebSocket message handling.
 */
import { handleSessionStart, handleSessionEnd } from './session.js';
import { handleUserMessage } from './message.js';
import { handleApprovalResponse } from './approval.js';
import { handlePermissionDecision } from './permission-decision.js';
import { handleListTerminals, handleWatchTerminal } from './terminal.js';
import { handleInterrupt } from './interrupt.js';
import { handleSyncProjects, handleSyncSessions } from './sync.js';
export async function handleWebSocketMessage(message, deps) {
    console.log(`[handleWebSocketMessage] Processing type: '${message.type}'`);
    const type = message.type.trim();
    switch (type) {
        case 'error': {
            const data = message.data;
            console.error(`❌ Error from Discord bot: ${data.message}`);
            console.error('   Runner agent will exit. Please fix the issue and restart.');
            process.exit(1);
        }
        case 'registered': {
            const data = message.data;
            if (data.reclaimed) {
                console.log(`✅ Runner reclaimed token successfully: ${data.runnerId}`);
                console.log(`   (Previous offline runner was replaced)`);
            }
            else {
                console.log(`✅ Runner registered successfully: ${data.runnerId}`);
            }
            console.log(`   Supported CLI types: ${data.cliTypes.join(', ')}`);
            break;
        }
        case 'approval_response': {
            await handleApprovalResponse(message.data, {
                pendingApprovals: deps.pendingApprovals,
                cliSessions: deps.cliSessions,
                wsManager: deps.wsManager,
                assistantManager: deps.assistantManager
            });
            break;
        }
        case 'permission_decision': {
            await handlePermissionDecision(message.data, {
                cliSessions: deps.cliSessions,
                wsManager: deps.wsManager
            });
            break;
        }
        case 'session_start': {
            await handleSessionStart(message.data, {
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
            await handleSessionEnd(message.data, {
                cliSessions: deps.cliSessions,
                sessionMetadata: deps.sessionMetadata,
                pendingMessages: deps.pendingMessages
            });
            break;
        }
        case 'user_message': {
            await handleUserMessage(message.data, {
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
            await handleWatchTerminal(message.data, {
                wsManager: deps.wsManager,
                pluginManager: deps.pluginManager,
                cliSessions: deps.cliSessions,
                sessionMetadata: deps.sessionMetadata
            });
            break;
        }
        case 'interrupt': {
            await handleInterrupt(message.data, {
                cliSessions: deps.cliSessions
            });
            break;
        }
        case 'assistant_message': {
            const data = message.data;
            if (deps.assistantManager && deps.assistantManager.isRunning()) {
                await deps.assistantManager.sendMessage(data.content, data.username);
                console.log(`[AssistantMessage] Forwarded from ${data.username}`);
            }
            else {
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
            await handleSyncProjects(message.data);
            break;
        }
        case 'sync_sessions': {
            await handleSyncSessions(message.data);
            break;
        }
        default:
            console.log('Unknown message type:', message.type);
    }
}
