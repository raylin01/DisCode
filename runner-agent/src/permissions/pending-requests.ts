import type { PendingApprovalRequestInfo } from '../types.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const parsedTtl = parseInt(process.env.DISCODE_PENDING_APPROVAL_TTL_MS || String(DEFAULT_TTL_MS), 10);

export const PENDING_APPROVAL_TTL_MS = Number.isFinite(parsedTtl) && parsedTtl > 0
    ? parsedTtl
    : DEFAULT_TTL_MS;

export function pruneExpiredPendingApprovalRequests(
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>,
    nowMs: number = Date.now()
): number {
    const cutoff = nowMs - PENDING_APPROVAL_TTL_MS;
    let pruned = 0;

    for (const [requestId, pending] of pendingApprovalRequests.entries()) {
        if (pending.firstSeenAt < cutoff) {
            pendingApprovalRequests.delete(requestId);
            pruned += 1;
        }
    }

    return pruned;
}

export function toApprovalRequestPayload(
    pending: PendingApprovalRequestInfo,
    timestamp: string = new Date().toISOString()
): Record<string, unknown> {
    return {
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
        timestamp
    };
}
