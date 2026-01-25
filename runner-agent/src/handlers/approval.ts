/**
 * Approval Handler
 * 
 * Handles approval_response WebSocket messages.
 */

import type { PluginSession } from '../plugins/index.js';
import type { PendingApproval } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import type { AssistantManager } from '../assistant-manager.js';

export interface ApprovalHandlerDeps {
    pendingApprovals: Map<string, PendingApproval>;
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
    const { pendingApprovals, cliSessions, wsManager } = deps;

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

        let approvalSession: { sendApproval: (opt: string) => Promise<void> } | undefined = cliSessions.get(data.sessionId);

        // Use assistant manager if session not found in standard sessions
        const { assistantManager } = deps;
        if (!approvalSession && assistantManager && assistantManager.getSessionId() === data.sessionId) {
            approvalSession = assistantManager;
        }

        if (approvalSession) {
            // Map boolean to option number if not provided
            // 1 = Yes (approve), 3 = No (deny)
            const option = data.optionNumber || (data.approved ? '1' : '3');
            try {
                // Pass option number and optional custom message (for "Other" option)
                await approvalSession.sendApproval(option, data.message);
                console.log(`[Approval] Sent option ${option} to session ${data.sessionId}`);

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
