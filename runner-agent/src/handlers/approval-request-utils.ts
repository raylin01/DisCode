import type { PendingApprovalRequestInfo } from '../types.js';

const REQUEST_ID_SESSION_PATTERN = /^(.+)-\d{13}(?:-[a-f0-9]{8})?$/i;

export function extractSessionIdFromRequestId(requestId?: string): string | undefined {
    if (!requestId) return undefined;
    const match = requestId.match(REQUEST_ID_SESSION_PATTERN);
    return match ? match[1] : undefined;
}

export function resolveSessionIdForRequest(
    data: { requestId?: string; sessionId?: string },
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>
): string | undefined {
    if (data.sessionId) return data.sessionId;

    if (data.requestId) {
        const pending = pendingApprovalRequests.get(data.requestId);
        if (pending?.sessionId) return pending.sessionId;
    }

    return extractSessionIdFromRequestId(data.requestId);
}
