/**
 * Session Control Handler
 *
 * Handles per-session control actions like set_model and set_permission_mode.
 */

import type { PluginSession } from '../plugins/index.js';

export interface SessionControlHandlerDeps {
    cliSessions: Map<string, PluginSession>;
}

export interface SessionControlData {
    sessionId: string;
    runnerId: string;
    action: 'set_model' | 'set_permission_mode' | 'set_max_thinking_tokens';
    value: string | number;
}

export async function handleSessionControl(
    data: SessionControlData,
    deps: SessionControlHandlerDeps
): Promise<void> {
    const { sessionId, action, value } = data;
    const { cliSessions } = deps;

    const session = cliSessions.get(sessionId);
    if (!session) {
        console.error(`[SessionControl] Session not found: ${sessionId}`);
        return;
    }

    try {
        if (action === 'set_permission_mode') {
            if ('setPermissionMode' in session && typeof (session as any).setPermissionMode === 'function') {
                await (session as any).setPermissionMode(value as 'default' | 'acceptEdits');
                console.log(`[SessionControl] Set permission mode to ${value} for ${sessionId}`);
            } else {
                console.warn(`[SessionControl] setPermissionMode not supported for ${sessionId}`);
            }
            return;
        }

        if (action === 'set_model') {
            if ('setModel' in session && typeof (session as any).setModel === 'function') {
                await (session as any).setModel(String(value));
                console.log(`[SessionControl] Set model to ${value} for ${sessionId}`);
            } else {
                console.warn(`[SessionControl] setModel not supported for ${sessionId}`);
            }
            return;
        }

        if (action === 'set_max_thinking_tokens') {
            if ('setMaxThinkingTokens' in session && typeof (session as any).setMaxThinkingTokens === 'function') {
                const numeric = typeof value === 'number' ? value : parseInt(String(value), 10);
                await (session as any).setMaxThinkingTokens(numeric);
                console.log(`[SessionControl] Set max thinking tokens to ${numeric} for ${sessionId}`);
            } else {
                console.warn(`[SessionControl] setMaxThinkingTokens not supported for ${sessionId}`);
            }
        }
    } catch (error) {
        console.error(`[SessionControl] Failed ${action} for ${sessionId}:`, error);
    }
}
