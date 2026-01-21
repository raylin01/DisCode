/**
 * Terminal Handlers
 * 
 * Handles list_terminals and watch_terminal WebSocket messages.
 */

import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata } from '../types.js';
import type { WebSocketManager } from '../websocket.js';

export interface TerminalHandlerDeps {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
}

export async function handleListTerminals(
    deps: TerminalHandlerDeps
): Promise<void> {
    const { wsManager, pluginManager } = deps;

    console.log('Received list_terminals request');

    if (pluginManager) {
        const tmuxPlugin = pluginManager.getPlugin('tmux');
        if (tmuxPlugin && tmuxPlugin.listSessions) {
            try {
                const sessions = await tmuxPlugin.listSessions();
                wsManager.send({
                    type: 'terminal_list',
                    data: {
                        runnerId: wsManager.runnerId,
                        terminals: sessions
                    }
                });
            } catch (e) {
                console.error('Error listing terminals:', e);
            }
        }
    }
}

export async function handleWatchTerminal(
    data: { sessionId: string },
    deps: TerminalHandlerDeps
): Promise<void> {
    const { wsManager, pluginManager, cliSessions, sessionMetadata } = deps;

    console.log(`[Watch] Received watch_terminal request for ${data.sessionId}`);

    if (!pluginManager) {
        console.error(`[Watch] PluginManager not initialized`);
        return;
    }

    const tmuxPlugin = pluginManager.getPlugin('tmux');
    if (!tmuxPlugin || !tmuxPlugin.watchSession) {
        console.error(`[Watch] TmuxPlugin not found or doesn't have watchSession method`);
        return;
    }

    try {
        console.log(`[Watch] Calling tmuxPlugin.watchSession(${data.sessionId})...`);
        const session = await tmuxPlugin.watchSession(data.sessionId);
        console.log(`[Watch] Session created, isReady=${session.isReady}, status=${session.status}`);

        // Register session
        cliSessions.set(data.sessionId, session);
        sessionMetadata.set(data.sessionId, {
            sessionId: data.sessionId,
            cliType: 'claude', // Default
            runnerId: wsManager.runnerId,
            folderPath: 'watched'
        });

        console.log(`[Watch] Registered watched session in cliSessions: ${data.sessionId}`);
        console.log(`[Watch] Current cliSessions keys: ${Array.from(cliSessions.keys()).join(', ')}`);

        wsManager.send({
            type: 'session_ready',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId
            }
        });
        console.log(`[Watch] Sent session_ready to Discord bot`);

    } catch (e: any) {
        console.error(`[Watch] Error watching terminal ${data.sessionId}:`, e);
        wsManager.send({
            type: 'output',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                content: `Failed to watch terminal: ${e.message}`,
                outputType: 'error',
                timestamp: new Date().toISOString()
            }
        });
    }
}
