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

const PERMISSION_SYNC_RESEND_COOLDOWN_MS = parseInt(process.env.DISCODE_PERMISSION_SYNC_RESEND_COOLDOWN_MS || '3000', 10);

export async function handlePermissionSyncRequest(
    data: PermissionSyncRequestData | undefined,
    deps: PermissionSyncHandlerDeps
): Promise<void> {
    const { wsManager, pendingApprovalRequests } = deps;
    pruneExpiredPendingApprovalRequests(pendingApprovalRequests);

    const requestId = data?.requestId;
    const sessionId = data?.sessionId;
    const reason = data?.reason || 'manual';
    const now = Date.now();

    let resent = 0;
    let skippedCooldown = 0;
    for (const pending of pendingApprovalRequests.values()) {
        if (requestId && pending.requestId !== requestId) continue;
        if (sessionId && pending.sessionId !== sessionId) continue;
        if (pending.lastSentAt && now - pending.lastSentAt < PERMISSION_SYNC_RESEND_COOLDOWN_MS) {
            skippedCooldown += 1;
            continue;
        }

        wsManager.send({
            type: 'approval_request',
            data: toApprovalRequestPayload(pending)
        });

        pending.lastSentAt = now;
        pending.resendCount += 1;
        resent += 1;
    }

    const suffix = skippedCooldown > 0 ? `, skipped=${skippedCooldown} cooldown` : '';
    console.log(`[PermissionSync] Re-sent ${resent} pending approval request(s) (reason=${reason}${suffix})`);
}
