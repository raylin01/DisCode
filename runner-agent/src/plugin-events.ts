/**
 * Plugin Event Wiring
 * 
 * Connects PluginManager events to WebSocket for Discord communication.
 */

import type { PluginManager } from './plugins/index.js';
import type { WebSocketManager } from './websocket.js';

export function wirePluginEvents(
    pluginManager: PluginManager,
    wsManager: WebSocketManager
): void {
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
                    outputType: data.outputType
                }
            });
        }
    });

    // Approval requests -> Discord
    pluginManager.on('approval', (data) => {
        if (wsManager.isConnected) {
            const requestId = data.requestId || `${data.sessionId}-${Date.now()}`;
            const message = {
                type: 'approval_request' as const,
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    requestId,
                    toolName: data.tool,
                    toolInput: data.toolInput ?? data.context,
                    options: data.options?.map((o: any) => o.label || o),
                    timestamp: data.detectedAt.toISOString(),
                    // Multi-select and Other option support for AskUserQuestion
                    isMultiSelect: data.isMultiSelect,
                    hasOther: data.hasOther,
                    suggestions: data.suggestions,
                    blockedPath: data.blockedPath,
                    decisionReason: data.decisionReason
                }
            };
            wsManager.send(message);
        }
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
                    mode: data.mode
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

    // Session discovery -> Discord
    pluginManager.on('session_discovered', (data) => {
        console.log(`[PluginManager] Session discovered: ${data.sessionId} (cwd: ${data.cwd || 'unknown'})`);
        if (wsManager.isConnected) {
            wsManager.send({
                type: 'session_discovered',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    exists: data.exists,
                    cwd: data.cwd
                }
            });
        }
    });
}
