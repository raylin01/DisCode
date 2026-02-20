/**
 * Permission Sync Handler
 *
 * Re-sends pending approval requests when the bot asks for a refresh
 * (or after reconnect).
 */

import type { PendingApprovalRequestInfo } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import type { PluginSession } from '../plugins/index.js';
import {
    pruneExpiredPendingApprovalRequests,
    toApprovalRequestPayload
} from '../permissions/pending-requests.js';

export interface PermissionSyncHandlerDeps {
    wsManager: WebSocketManager;
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
    cliSessions?: Map<string, PluginSession>;
}

export interface PermissionSyncRequestData {
    requestId?: string;
    sessionId?: string;
    reason?: string;
}

const PERMISSION_SYNC_RESEND_COOLDOWN_MS = parseInt(process.env.DISCODE_PERMISSION_SYNC_RESEND_COOLDOWN_MS || '3000', 10);

// Interface for sessions that expose pending permissions
interface SessionWithPendingPermissions extends PluginSession {
    getPendingPermissions?(): Map<string, {
        requestId: string;
        toolName: string;
        input: Record<string, any>;
        suggestions?: any[];
        blockedPath?: string;
        decisionReason?: string;
        createdAt: number;
    }>;
}

export async function handlePermissionSyncRequest(
    data: PermissionSyncRequestData | undefined,
    deps: PermissionSyncHandlerDeps
): Promise<void> {
    const { wsManager, pendingApprovalRequests, cliSessions } = deps;
    pruneExpiredPendingApprovalRequests(pendingApprovalRequests);

    const requestId = data?.requestId;
    const sessionId = data?.sessionId;
    const reason = data?.reason || 'manual';
    const now = Date.now();

    let resent = 0;
    let skippedCooldown = 0;

    // First, check the traditional pendingApprovalRequests Map
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

    // If nothing found in pendingApprovalRequests, check sessions directly
    // This handles cases where the Map was cleared but sessions still have pending permissions
    if (resent === 0 && cliSessions && (requestId || sessionId)) {
        for (const [sessionKey, session] of cliSessions) {
            // Filter by sessionId if provided
            if (sessionId && sessionKey !== sessionId) continue;

            // Check if session exposes pending permissions
            const sessionWithPerms = session as SessionWithPendingPermissions;
            if (!sessionWithPerms.getPendingPermissions) continue;

            const pendingPerms = sessionWithPerms.getPendingPermissions();
            if (!pendingPerms || pendingPerms.size === 0) continue;

            for (const [approvalId, perm] of pendingPerms) {
                // Filter by requestId if provided
                if (requestId && approvalId !== requestId) continue;

                console.log(`[PermissionSync] Found pending permission in session ${sessionKey}: approvalId=${approvalId} tool=${perm.toolName}`);

                // Send the approval request
                wsManager.send({
                    type: 'approval_request',
                    data: {
                        runnerId: wsManager.runnerId,
                        sessionId: sessionKey,
                        requestId: approvalId,
                        toolName: perm.toolName,
                        toolInput: perm.input,
                        options: undefined,
                        timestamp: new Date().toISOString(),
                        suggestions: perm.suggestions,
                        blockedPath: perm.blockedPath,
                        decisionReason: perm.decisionReason
                    }
                });

                // Also add to pendingApprovalRequests for future lookups
                pendingApprovalRequests.set(approvalId, {
                    runnerId: wsManager.runnerId,
                    sessionId: sessionKey,
                    requestId: approvalId,
                    toolName: perm.toolName,
                    toolInput: perm.input,
                    origin: 'native',
                    timestamp: new Date().toISOString(),
                    firstSeenAt: perm.createdAt || now,
                    lastSentAt: now,
                    resendCount: 1,
                    suggestions: perm.suggestions,
                    blockedPath: perm.blockedPath,
                    decisionReason: perm.decisionReason
                });

                resent += 1;
            }
        }
    }

    const suffix = skippedCooldown > 0 ? `, skipped=${skippedCooldown} cooldown` : '';
    console.log(`[PermissionSync] Re-sent ${resent} pending approval request(s) (reason=${reason}${suffix})`);
}
