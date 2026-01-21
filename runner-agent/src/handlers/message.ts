/**
 * User Message Handler
 * 
 * Handles user_message WebSocket messages.
 */

import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata } from '../types.js';
import type { WebSocketManager } from '../websocket.js';

export interface MessageHandlerDeps {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
}

export async function handleUserMessage(
    data: {
        sessionId: string;
        userId: string;
        username: string;
        content: string;
        timestamp: string;
    },
    deps: MessageHandlerDeps
): Promise<void> {
    const { wsManager, pluginManager, cliSessions, sessionMetadata } = deps;

    console.log(`[UserMessage] Received from ${data.username} for session ${data.sessionId}`);
    console.log(`[UserMessage] Content: ${data.content}`);
    console.log(`[UserMessage] Available sessions: ${Array.from(cliSessions.keys()).join(', ') || '(none)'}`);

    // Get CLI session
    let session = cliSessions.get(data.sessionId);

    // Auto-recovery: If session not found but exists in tmux, restore it
    if (!session && pluginManager) {
        const tmuxPlugin = pluginManager.getPlugin('tmux');
        if (tmuxPlugin && tmuxPlugin.listSessions && tmuxPlugin.watchSession) {
            try {
                const existingSessions = await tmuxPlugin.listSessions();
                if (existingSessions.includes(data.sessionId)) {
                    console.log(`[Auto-Recovery] Found existing tmux session ${data.sessionId}, restoring watch...`);
                    session = await tmuxPlugin.watchSession(data.sessionId);

                    // Register it
                    cliSessions.set(data.sessionId, session);
                    sessionMetadata.set(data.sessionId, {
                        sessionId: data.sessionId,
                        cliType: 'claude', // Default
                        runnerId: wsManager.runnerId,
                        folderPath: 'recovered'
                    });
                }
            } catch (e) {
                console.error(`[Auto-Recovery] Failed to recover session ${data.sessionId}:`, e);
            }
        }
    }

    if (!session) {
        console.error(`Session ${data.sessionId} not found in CLI sessions`);
        wsManager.send({
            type: 'output',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                content: `❌ Error: Session '${data.sessionId}' not found. It may have been closed or the runner was restarted without recovery. Try /watch again.`,
                timestamp: new Date().toISOString(),
                outputType: 'error'
            }
        });
        return;
    }

    const sendMessage = async () => {
        try {
            console.log(`Sending message to Claude via TmuxPlugin...`);
            await session!.sendMessage(data.content);
            console.log(`Message sent successfully to session ${data.sessionId}`);
        } catch (error) {
            console.error(`Error sending message to CLI:`, error);
            wsManager.send({
                type: 'output',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    content: `❌ Error: ${error}`,
                    timestamp: new Date().toISOString(),
                    outputType: 'stderr'
                }
            });
        }
    };

    if (session.isReady) {
        await sendMessage();
    } else {
        console.log(`Session ${data.sessionId} NOT READY. Queuing message...`);
        session.once('ready', async () => {
            console.log(`Session ${data.sessionId} is now READY. Sending queued message.`);
            await sendMessage();
        });
    }
}
