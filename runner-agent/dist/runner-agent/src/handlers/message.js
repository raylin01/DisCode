/**
 * User Message Handler
 *
 * Handles user_message WebSocket messages.
 */
import * as fs from 'fs';
import * as path from 'path';
export async function handleUserMessage(data, deps) {
    const { wsManager, pluginManager, cliSessions, sessionMetadata } = deps;
    console.log(`[UserMessage] Received from ${data.username} for session ${data.sessionId}`);
    // Get CLI session
    let session = cliSessions.get(data.sessionId);
    // Auto-recovery: If session not found but exists in tmux, restore it
    if (!session && pluginManager) {
        const tmuxPlugin = pluginManager.getPlugin('tmux');
        if (tmuxPlugin && tmuxPlugin.listSessions && tmuxPlugin.watchSession) {
            try {
                const existingSessions = await tmuxPlugin.listSessions();
                if (existingSessions.includes(data.sessionId)) {
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
            }
            catch (e) {
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
    // Handle attachments
    if (data.attachments && data.attachments.length > 0) {
        const metadata = sessionMetadata.get(data.sessionId);
        if (metadata && metadata.folderPath && metadata.folderPath !== 'recovered') {
            for (const att of data.attachments) {
                try {
                    const filePath = path.join(metadata.folderPath, att.name);
                    console.log(`[UserMessage] Downloading attachment ${att.name} to ${filePath}`);
                    const res = await fetch(att.url);
                    if (!res.ok)
                        throw new Error(`Failed to fetch ${att.url}: ${res.statusText}`);
                    const buffer = await res.arrayBuffer();
                    await fs.promises.writeFile(filePath, Buffer.from(buffer));
                    // Notify CLI about the upload
                    if (session.isReady) {
                        await session.sendMessage(`(System: User uploaded file '${att.name}' to current directory)`);
                    }
                }
                catch (err) {
                    console.error(`Failed to save attachment ${att.name}:`, err);
                    wsManager.send({
                        type: 'output',
                        data: {
                            runnerId: wsManager.runnerId,
                            sessionId: data.sessionId,
                            content: `❌ Error downloading file '${att.name}': ${err}`,
                            timestamp: new Date().toISOString(),
                            outputType: 'error'
                        }
                    });
                }
            }
        }
        else {
            console.warn(`[UserMessage] Cannot save attachments: Unknown or recovered folderPath for session ${data.sessionId}`);
        }
    }
    const sendMessage = async () => {
        try {
            await session.sendMessage(data.content);
        }
        catch (error) {
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
    }
    else {
        session.once('ready', async () => {
            await sendMessage();
        });
    }
}
