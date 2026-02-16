/**
 * Plugin Event Wiring
 *
 * Connects PluginManager events to WebSocket for Discord communication.
 */

import type { PluginManager } from './plugins/index.js';
import type { WebSocketManager } from './websocket.js';
import type { PendingApprovalRequestInfo, SessionMetadata } from './types.js';
import { pruneExpiredPendingApprovalRequests } from './permissions/pending-requests.js';
import { sessionStorage } from './storage.js';

export function wirePluginEvents(
    pluginManager: PluginManager,
    wsManager: WebSocketManager,
    options?: {
        pendingApprovalRequests?: Map<string, PendingApprovalRequestInfo>;
        sessionMetadata?: Map<string, SessionMetadata>;
    }
): void {
    const pendingApprovalRequests = options?.pendingApprovalRequests;
    const sessionMetadata = options?.sessionMetadata;

    // Output events -> Discord
    pluginManager.on('output', (data) => {
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'output',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    content: data.content,
                    timestamp: data.timestamp.toISOString(),
                    outputType: data.outputType,
                    isComplete: data.isComplete,
                    structuredData: data.structuredData
                }
            });
        }
    });

    // Approval requests -> Discord
    pluginManager.on('approval', (data) => {
        if (wsManager.isConnected) {
            const requestId = data.requestId || `${data.sessionId}-${Date.now()}`;
            const approvalData = {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                requestId,
                toolName: data.tool,
                toolInput: data.toolInput ?? data.context,
                options: data.options?.map((o: any) => o.label || o),
                timestamp: data.detectedAt.toISOString(),
                isMultiSelect: data.isMultiSelect,
                hasOther: data.hasOther,
                suggestions: data.suggestions,
                blockedPath: data.blockedPath,
                decisionReason: data.decisionReason
            };

            if (pendingApprovalRequests) {
                pruneExpiredPendingApprovalRequests(pendingApprovalRequests);
                pendingApprovalRequests.set(requestId, {
                    ...approvalData,
                    origin: 'native',
                    firstSeenAt: Date.now(),
                    lastSentAt: Date.now(),
                    resendCount: 0
                });
            }

            wsManager.send({
                type: 'approval_request',
                data: approvalData
            });
        }
    });

    pluginManager.on('approval_canceled', (data: { requestId?: string }) => {
        if (!pendingApprovalRequests || !data?.requestId) return;
        pendingApprovalRequests.delete(data.requestId);
    });

    // Status changes -> Discord
    pluginManager.on('status', (data) => {
        console.log(`[PluginManager] Status change for ${data.sessionId}: ${data.status}`);
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'status',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    status: data.status,
                    currentTool: data.currentTool
                }
            });
        }
    });

    // Metadata updates -> Discord
    pluginManager.on('metadata', (data) => {
        console.log(`[PluginManager] Metadata for ${data.sessionId}: tokens=${data.tokens} activity=${data.activity} mode=${data.mode}`);
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'metadata',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    tokens: data.tokens,
                    cumulativeTokens: data.cumulativeTokens,
                    activity: data.activity,
                    mode: data.mode,
                    permissionMode: data.permissionMode,
                    model: data.model,
                    mcpServers: data.mcpServers
                }
            });
        }
    });

    // Error events -> Discord (as output)
    pluginManager.on('error', (data) => {
        console.error(`[PluginManager] Error for ${data.sessionId}: ${data.error}`);
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'output',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    content: `❌ Error: ${data.error}`,
                    timestamp: new Date().toISOString(),
                    outputType: 'stderr'
                }
            });
        }
    });


    // Tool execution events -> Discord (includes auto-approved tools)
    pluginManager.on('tool_execution', (data) => {
        console.log(`[PluginManager] Tool execution for ${data.sessionId}: ${data.toolName}`);
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'tool_execution',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    toolName: data.toolName,
                    toolId: data.toolId,
                    input: data.input,
                    timestamp: data.timestamp.toISOString()
                }
            });
        }
    });

    // Tool result events -> Discord (shows success/failure status)
    pluginManager.on('tool_result', (data) => {
        console.log(`[PluginManager] Tool result for ${data.sessionId}: ${data.toolUseId} (error: ${data.isError})`);
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'tool_result',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    toolUseId: data.toolUseId,
                    content: data.content,
                    isError: data.isError,
                    timestamp: data.timestamp.toISOString()
                }
            });
        }
    });

    // Result events -> Discord (final session summary)
    pluginManager.on('result', (data) => {
        console.log(`[PluginManager] Result for ${data.sessionId}: ${data.subtype}`);
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'result',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    result: data.result,
                    subtype: data.subtype,
                    durationMs: data.durationMs,
                    durationApiMs: data.durationApiMs,
                    numTurns: data.numTurns,
                    isError: data.isError,
                    error: data.error,
                    timestamp: data.timestamp.toISOString()
                }
            });
        }
    });

    // CLI session ID events -> Persist to storage for resume after restart
    pluginManager.on('cli_session_id', (data: { sessionId: string; cliSessionId: string }) => {
        console.log(`[PluginManager] CLI session ID for ${data.sessionId.slice(0, 8)}: ${data.cliSessionId.slice(0, 8)}`);

        // Update in-memory metadata
        if (sessionMetadata) {
            const metadata = sessionMetadata.get(data.sessionId);
            if (metadata) {
                metadata.cliSessionId = data.cliSessionId;

                // Persist to storage
                sessionStorage.saveSession({
                    sessionId: data.sessionId,
                    cliSessionId: data.cliSessionId,
                    cliType: metadata.cliType,
                    plugin: metadata.plugin as any,
                    folderPath: metadata.folderPath,
                    runnerId: metadata.runnerId,
                    createdAt: new Date().toISOString(),
                    lastActivityAt: new Date().toISOString()
                });
            }
        }
    });
}
