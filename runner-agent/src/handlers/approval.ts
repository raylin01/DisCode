/**
 * Approval Handler
 * 
 * Handles approval_response WebSocket messages.
 */

import type { PluginSession } from '../plugins/index.js';
import type { PendingApproval } from '../types.js';
import type { PendingApprovalRequestInfo } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import type { AssistantManager } from '../assistant-manager.js';
import { resolveSessionIdForRequest } from './approval-request-utils.js';

export interface ApprovalHandlerDeps {
    pendingApprovals: Map<string, PendingApproval>;
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
    cliSessions: Map<string, PluginSession>;
    wsManager: WebSocketManager;
    assistantManager: AssistantManager | null;
}

type ApprovalTarget = Pick<PluginSession, 'sendApproval'>;

function getApprovalTarget(
    sessionId: string,
    cliSessions: Map<string, PluginSession>,
    assistantManager: AssistantManager | null
): ApprovalTarget | undefined {
    const session = cliSessions.get(sessionId);
    if (session) return session;

    if (assistantManager && assistantManager.getSessionId() === sessionId) {
        return assistantManager;
    }

    return undefined;
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
    const { pendingApprovals, pendingApprovalRequests, cliSessions, wsManager, assistantManager } = deps;
    const sessionId = resolveSessionIdForRequest(data, pendingApprovalRequests);

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
        pendingApprovalRequests.delete(data.requestId);
    }

    if (!sessionId) {
        if (data.requestId) {
            console.warn(`[Approval] Could not resolve session for requestId ${data.requestId}`);
        }
        return;
    }

    // Flow 2: TmuxPlugin/SDK approval (Discord buttons)
    const derivedAllow =
        data.approved ??
        data.allow ??
        (data.optionNumber ? data.optionNumber === '1' || data.optionNumber === '3' : false);
    console.log(`[Approval] Received approval response for session ${sessionId}: ${derivedAllow ? 'APPROVED' : 'DENIED'}, option=${data.optionNumber || 'auto'}, message=${data.message || 'none'}`);

    const approvalTarget = getApprovalTarget(sessionId, cliSessions, assistantManager);

    if (!approvalTarget) {
        console.error(`[Approval] Session ${sessionId} not found for approval response`);
        return;
    }

    // Map boolean to option number if not provided:
    // 1 = Yes (approve), 2 = No (deny), 3 = Always
    const option = data.optionNumber || (derivedAllow ? '1' : '2');

    try {
        await approvalTarget.sendApproval(option, data.message, data.requestId);

        wsManager.send({
            type: 'status',
            data: {
                runnerId: wsManager.runnerId,
                sessionId,
                status: 'working',
                currentTool: undefined
            }
        });
    } catch (error) {
        console.error(`[Approval] Failed to send option ${option} to session ${sessionId}:`, error);
    }
}
