/**
 * User Message Handler
 *
 * Handles user_message WebSocket messages.
 */

import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import * as fs from 'fs';
import * as path from 'path';

// Image MIME types that can be sent to vision-capable CLIs
const IMAGE_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp'
];

// Attachment type from Discord bot
interface Attachment {
    name: string;
    url: string;
    contentType?: string;
    size: number;
}

export interface MessageHandlerDeps {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
}

/**
 * Check if an attachment is an image
 */
function isImageAttachment(att: Attachment): boolean {
    return IMAGE_MIME_TYPES.includes(att.contentType || '');
}

/**
 * Download an attachment and convert to base64
 */
async function downloadAsBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
}

export async function handleUserMessage(
    data: {
        sessionId: string;
        userId: string;
        username: string;
        content: string;
        attachments?: Attachment[];
        timestamp: string;
    },
    deps: MessageHandlerDeps
): Promise<void> {
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

    // Separate image and non-image attachments
    const imageAttachments: Attachment[] = [];
    const fileAttachments: Attachment[] = [];

    if (data.attachments && data.attachments.length > 0) {
        for (const att of data.attachments) {
            if (isImageAttachment(att)) {
                imageAttachments.push(att);
            } else {
                fileAttachments.push(att);
            }
        }
    }

    // Handle non-image file attachments (download to working directory)
    if (fileAttachments.length > 0) {
        const metadata = sessionMetadata.get(data.sessionId);
        if (metadata && metadata.folderPath && metadata.folderPath !== 'recovered') {
            for (const att of fileAttachments) {
                try {
                    const filePath = path.join(metadata.folderPath, att.name);
                    console.log(`[UserMessage] Downloading file attachment ${att.name} to ${filePath}`);

                    const res = await fetch(att.url);
                    if (!res.ok) throw new Error(`Failed to fetch ${att.url}: ${res.statusText}`);

                    const buffer = await res.arrayBuffer();
                    await fs.promises.writeFile(filePath, Buffer.from(buffer));

                    // Notify CLI about the upload
                    wsManager.send({
                        type: 'output',
                        data: {
                            runnerId: wsManager.runnerId,
                            sessionId: data.sessionId,
                            content: `📁 File saved: ${att.name}`,
                            timestamp: new Date().toISOString(),
                            outputType: 'stdout'
                        }
                    });
                } catch (err) {
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
        } else {
            console.warn(`[UserMessage] Cannot save file attachments: Unknown or recovered folderPath for session ${data.sessionId}`);
        }
    }

    const sendMessage = async () => {
        try {
            // If we have images and the session supports sendMessageWithImages, use that
            if (imageAttachments.length > 0 && session!.sendMessageWithImages) {
                console.log(`[UserMessage] Sending ${imageAttachments.length} image(s) with text to CLI`);

                const images: Array<{ data: string; mediaType: string }> = [];
                for (const att of imageAttachments) {
                    try {
                        const base64Data = await downloadAsBase64(att.url);
                        images.push({
                            data: base64Data,
                            mediaType: att.contentType || 'image/png'
                        });
                        console.log(`[UserMessage] Downloaded image ${att.name} (${base64Data.length} bytes base64)`);
                    } catch (err) {
                        console.error(`Failed to download image ${att.name}:`, err);
                        wsManager.send({
                            type: 'output',
                            data: {
                                runnerId: wsManager.runnerId,
                                sessionId: data.sessionId,
                                content: `⚠️ Could not load image '${att.name}': ${err}`,
                                timestamp: new Date().toISOString(),
                                outputType: 'stderr'
                            }
                        });
                    }
                }

                if (images.length > 0) {
                    await session!.sendMessageWithImages!(data.content, images);
                    console.log(`[UserMessage] Message with ${images.length} image(s) sent successfully to session ${data.sessionId}`);
                } else {
                    // All images failed to download, send text only
                    await session!.sendMessage(data.content);
                }
            } else {
                // No images or session doesn't support images
                if (imageAttachments.length > 0) {
                    console.log(`[UserMessage] Session does not support images, sending text only (${imageAttachments.length} images ignored)`);
                }
                console.log(`[UserMessage] Sending to CLI: ${data.content.slice(0, 50)}...`);
                await session!.sendMessage(data.content);
                console.log(`[UserMessage] Message sent successfully to session ${data.sessionId}`);
            }
        } catch (error) {
            console.error(`[UserMessage] Error sending message to CLI:`, error);
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

    console.log(`[UserMessage] Session ${data.sessionId} isReady=${session.isReady}, status=${session.status || 'unknown'}`);

    if (session.isReady) {
        await sendMessage();
    } else {
        console.log(`[UserMessage] Session ${data.sessionId} not ready, waiting for 'ready' event...`);

        // Set a timeout - if session doesn't become ready in 30s, send anyway with warning
        const readyTimeout = setTimeout(() => {
            console.warn(`[UserMessage] Session ${data.sessionId} ready timeout, attempting to send anyway...`);
            wsManager.send({
                type: 'output',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    content: `⚠️ Session was not ready after 30s, attempting to send message anyway...`,
                    timestamp: new Date().toISOString(),
                    outputType: 'stderr'
                }
            });
            sendMessage();
        }, 30000);

        session.once('ready', () => {
            clearTimeout(readyTimeout);
            console.log(`[UserMessage] Session ${data.sessionId} is now ready, sending message...`);
            sendMessage();
        });
    }
}
