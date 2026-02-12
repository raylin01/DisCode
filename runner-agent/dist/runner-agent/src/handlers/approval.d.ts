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
export declare function handleApprovalResponse(data: {
    requestId?: string;
    sessionId?: string;
    allow?: boolean;
    approved?: boolean;
    optionNumber?: string;
    message?: string;
}, deps: ApprovalHandlerDeps): Promise<void>;
