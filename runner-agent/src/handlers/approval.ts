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

export interface ApprovalHandlerDeps {
    pendingApprovals: Map<string, PendingApproval>;
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
    cliSessions: Map<string, PluginSession>;
    wsManager: WebSocketManager;
    assistantManager: AssistantManager | null;
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
    const { pendingApprovals, pendingApprovalRequests, cliSessions, wsManager } = deps;

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

    // Recover sessionId from requestId if missing (Runner generates requestId as `${sessionId}-${timestamp}`)
    let sessionId = data.sessionId;
    if (!sessionId && data.requestId && data.requestId.includes('-')) {
        const lastDashIndex = data.requestId.lastIndexOf('-');
        // Basic validation: ensure we have a timestamp part and the rest looks like a UUID (or at least substantial)
        if (lastDashIndex > 0 && lastDashIndex < data.requestId.length - 1) {
             const probableSessionId = data.requestId.substring(0, lastDashIndex);
             // Verify if this session actually exists
             if (cliSessions.has(probableSessionId) || (deps.assistantManager && deps.assistantManager.getSessionId() === probableSessionId)) {
                 sessionId = probableSessionId;
                 console.log(`[Approval] Recovered sessionId ${sessionId} from requestId ${data.requestId}`);
             }
        }
    }

    // Flow 2: TmuxPlugin/SDK approval (Discord buttons)
    if (sessionId) {
        const derivedAllow =
            data.approved ??
            data.allow ??
            (data.optionNumber ? data.optionNumber === '1' || data.optionNumber === '3' : false);
        console.log(`[Approval] Received approval response for session ${sessionId}: ${derivedAllow ? 'APPROVED' : 'DENIED'}, Option: ${data.optionNumber}, Message: ${data.message || 'none'}`);

        let approvalSession: { sendApproval: (opt: string, message?: string, requestId?: string) => Promise<void> } | undefined = cliSessions.get(sessionId);

        // Use assistant manager if session not found in standard sessions
        const { assistantManager } = deps;
        if (!approvalSession && assistantManager && assistantManager.getSessionId() === sessionId) {
            approvalSession = assistantManager;
        }

        if (approvalSession) {
            // Map boolean to option number if not provided
            // 1 = Yes (approve), 2 = No (deny), 3 = Always
            const option = data.optionNumber || (derivedAllow ? '1' : '2');
            try {
                console.log(`[Approval] Dispatching to session ${sessionId}: option=${option}, message=${data.message || 'none'}`);
                // Pass option number and optional custom message (for "Other" option)
                await approvalSession.sendApproval(option, data.message, data.requestId);
                console.log(`[Approval] Sent option ${option} to session ${sessionId}`);

                // Send status update to Discord - mark as 'working' since approval was handled
                wsManager.send({
                    type: 'status',
                    data: {
                        runnerId: wsManager.runnerId,
                        sessionId: data.sessionId,
                        status: 'working',
                        currentTool: undefined
                    }
                });
                console.log(`[Approval] Sent status update (working) for session ${data.sessionId}`);
            } catch (error) {
                console.error(`[Approval] Failed to send option ${option} to session ${data.sessionId}:`, error);
            }
        } else {
            console.error(`Session ${data.sessionId} not found for approval response`);
        }
    }
}
