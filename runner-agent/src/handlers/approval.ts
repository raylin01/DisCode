/**
 * Approval Handler
 * 
 * Handles approval_response WebSocket messages.
 */

import type { PluginSession } from '../plugins/index.js';
import type { PendingApproval } from '../types.js';

export interface ApprovalHandlerDeps {
    pendingApprovals: Map<string, PendingApproval>;
    cliSessions: Map<string, PluginSession>;
}

export async function handleApprovalResponse(
    data: {
        requestId?: string;
        sessionId?: string;
        allow?: boolean;
        approved?: boolean;
        optionNumber?: string;
        message?: string;
    },
    deps: ApprovalHandlerDeps
): Promise<void> {
    const { pendingApprovals, cliSessions } = deps;

    // Flow 1: HTTP approval (legacy, for PrintPlugin)
    if (data.requestId) {
        const pending = pendingApprovals.get(data.requestId);
        if (pending) {
            pending.resolve({
                allow: data.allow ?? false,
                message: data.message
            });
            pendingApprovals.delete(data.requestId);
        }
    }

    // Flow 2: TmuxPlugin approval (Discord buttons)
    if (data.sessionId) {
        console.log(`[Approval] Received approval response for session ${data.sessionId}: ${data.approved ? 'APPROVED' : 'DENIED'}`);
        const approvalSession = cliSessions.get(data.sessionId);
        if (approvalSession) {
            // Map boolean to option number if not provided
            // 1 = Yes (approve), 3 = No (deny)
            const option = data.optionNumber || (data.approved ? '1' : '3');
            try {
                await approvalSession.sendApproval(option);
                console.log(`[Approval] Sent option ${option} to session ${data.sessionId}`);
            } catch (error) {
                console.error(`[Approval] Failed to send option ${option} to session ${data.sessionId}:`, error);
            }
        } else {
            console.error(`Session ${data.sessionId} not found for approval response`);
        }
    }
}
