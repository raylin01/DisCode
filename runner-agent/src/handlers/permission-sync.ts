/**
 * Permission Sync Handler
 *
 * Re-sends pending approval requests when the bot asks for a refresh
 * (or after reconnect).
 */

import type { PendingApprovalRequestInfo } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import {
    pruneExpiredPendingApprovalRequests,
    toApprovalRequestPayload
} from '../permissions/pending-requests.js';

export interface PermissionSyncHandlerDeps {
    wsManager: WebSocketManager;
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
}

export interface PermissionSyncRequestData {
    requestId?: string;
    sessionId?: string;
    reason?: string;
}

export async function handlePermissionSyncRequest(
    data: PermissionSyncRequestData | undefined,
    deps: PermissionSyncHandlerDeps
): Promise<void> {
    const { wsManager, pendingApprovalRequests } = deps;
    pruneExpiredPendingApprovalRequests(pendingApprovalRequests);

    const requestId = data?.requestId;
    const sessionId = data?.sessionId;
    const reason = data?.reason || 'manual';

    let resent = 0;
    for (const pending of pendingApprovalRequests.values()) {
        if (requestId && pending.requestId !== requestId) continue;
        if (sessionId && pending.sessionId !== sessionId) continue;

        wsManager.send({
            type: 'approval_request',
            data: toApprovalRequestPayload(pending)
        });

        pending.lastSentAt = Date.now();
        pending.resendCount += 1;
        resent += 1;
    }

    console.log(`[PermissionSync] Re-sent ${resent} pending approval request(s) (reason=${reason})`);
}
