/**
 * Permission Decision Handler
 *
 * Handles permission_decision WebSocket messages from Discord bot.
 * This is the new permission system that supports scopes and suggestions.
 */

import type { PluginSession } from '../plugins/index.js';
import type { PendingApprovalRequestInfo } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import { resolveSessionIdForRequest } from './approval-request-utils.js';

export interface PermissionDecisionHandlerDeps {
    cliSessions: Map<string, PluginSession>;
    wsManager: WebSocketManager;
    pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
}

export interface PermissionDecisionData {
    requestId: string;
    sessionId?: string; // Explicit session ID from newer bots
    behavior: 'allow' | 'deny';
    scope?: 'session' | 'localSettings' | 'userSettings' | 'projectSettings';
    updatedPermissions?: any[];
    customMessage?: string;
}

interface PermissionDecisionPayload {
    behavior: 'allow' | 'deny';
    scope?: 'session' | 'localSettings' | 'userSettings' | 'projectSettings';
    updatedPermissions?: any[];
    updatedInput?: Record<string, any>;
    message?: string;
}

interface PermissionDecisionCapableSession extends PluginSession {
    sendPermissionDecision(requestId: string, decision: PermissionDecisionPayload): Promise<void>;
}

function isPermissionDecisionCapableSession(session: PluginSession): session is PermissionDecisionCapableSession {
    return typeof (session as PermissionDecisionCapableSession).sendPermissionDecision === 'function';
}

function sendDecisionAck(
    wsManager: WebSocketManager,
    payload: {
        requestId: string;
        sessionId?: string;
        success: boolean;
        error?: string;
    }
): void {
    wsManager.send({
        type: 'permission_decision_ack',
        data: {
            requestId: payload.requestId,
            sessionId: payload.sessionId || '',
            success: payload.success,
            error: payload.error,
            timestamp: new Date().toISOString()
        }
    });
}

/**
 * Handle permission decision from Discord bot
 */
export async function handlePermissionDecision(
    data: PermissionDecisionData,
    deps: PermissionDecisionHandlerDeps
): Promise<void> {
    const { cliSessions, wsManager, pendingApprovalRequests } = deps;
    const { requestId, behavior, scope, updatedPermissions, customMessage } = data;

    console.log(`[PermissionDecision] Received decision for request ${requestId}: ${behavior}`);
    const sessionId = resolveSessionIdForRequest(data, pendingApprovalRequests);
    if (!sessionId) {
        console.error(`[PermissionDecision] Could not resolve session for requestId ${requestId}`);
        sendDecisionAck(wsManager, {
            requestId,
            success: false,
            error: 'Session could not be resolved'
        });
        return;
    }

    const session = cliSessions.get(sessionId);
    if (!session) {
        console.error(`[PermissionDecision] Session ${sessionId} not found for requestId ${requestId}`);
        sendDecisionAck(wsManager, {
            requestId,
            sessionId,
            success: false,
            error: 'Session not found'
        });
        return;
    }

    if (!isPermissionDecisionCapableSession(session)) {
        console.error(`[PermissionDecision] Session ${sessionId} does not support sendPermissionDecision`);
        sendDecisionAck(wsManager, {
            requestId,
            sessionId,
            success: false,
            error: 'Session does not support sendPermissionDecision'
        });
        return;
    }

    try {
        await session.sendPermissionDecision(requestId, {
            behavior,
            scope,
            updatedPermissions,
            updatedInput: undefined,
            message: customMessage
        });
        pendingApprovalRequests.delete(requestId);
        sendDecisionAck(wsManager, {
            requestId,
            sessionId,
            success: true
        });
        console.log(`[PermissionDecision] Sent decision to session ${sessionId}`);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[PermissionDecision] Failed to send decision to session ${sessionId}:`, error);
        sendDecisionAck(wsManager, {
            requestId,
            sessionId,
            success: false,
            error
        });
    }
}
