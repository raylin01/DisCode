/**
 * Permission Sync Handler
 *
 * Re-sends pending approval requests when the bot asks for a refresh
 * (or after reconnect).
 */

import type { PendingApprovalRequestInfo } from '../types.js';
import type { WebSocketManager } from '../websocket.js';

export interface PermissionSyncHandlerDeps {
    wsManager: WebSocketManager;
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
}

export interface PermissionSyncRequestData {
    requestId?: string;
    sessionId?: string;
    reason?: string;
}

const PENDING_APPROVAL_TTL_MS = parseInt(process.env.DISCODE_PENDING_APPROVAL_TTL_MS || String(30 * 60 * 1000), 10);

function pruneExpiredPendingRequests(pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>): void {
    const cutoff = Date.now() - PENDING_APPROVAL_TTL_MS;
    for (const [requestId, pending] of pendingApprovalRequests.entries()) {
        if (pending.firstSeenAt < cutoff) {
            pendingApprovalRequests.delete(requestId);
        }
    }
}

export async function handlePermissionSyncRequest(
    data: PermissionSyncRequestData | undefined,
    deps: PermissionSyncHandlerDeps
): Promise<void> {
    const { wsManager, pendingApprovalRequests } = deps;
    pruneExpiredPendingRequests(pendingApprovalRequests);

    const requestId = data?.requestId;
    const sessionId = data?.sessionId;
    const reason = data?.reason || 'manual';

    let resent = 0;
    for (const pending of pendingApprovalRequests.values()) {
        if (requestId && pending.requestId !== requestId) continue;
        if (sessionId && pending.sessionId !== sessionId) continue;

        wsManager.send({
            type: 'approval_request',
            data: {
                runnerId: pending.runnerId,
                sessionId: pending.sessionId,
                requestId: pending.requestId,
                toolName: pending.toolName,
                toolInput: pending.toolInput,
                options: pending.options,
                isMultiSelect: pending.isMultiSelect,
                hasOther: pending.hasOther,
                suggestions: pending.suggestions,
                blockedPath: pending.blockedPath,
                decisionReason: pending.decisionReason,
                timestamp: new Date().toISOString()
            }
        });

        pending.lastSentAt = Date.now();
        pending.resendCount += 1;
        resent += 1;
    }

    console.log(`[PermissionSync] Re-sent ${resent} pending approval request(s) (reason=${reason})`);
}
