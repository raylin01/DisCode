/**
 * Session Handlers
 *
 * Handles session_start and session_end WebSocket messages.
 */

import fs from 'fs';
import WebSocket from 'ws';
import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { PluginOptions } from '../plugins/base.js';
import type { SessionMetadata, PendingApprovalRequestInfo } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import type { RunnerConfig } from '../config.js';
import { expandPath, findCliPath, validateOrCreateFolder } from '../utils.js';
import { normalizeClaudeOptions } from '../utils/session-options.js';
import type { CliPaths } from '../types.js';
import { sessionStorage } from '../storage.js';

export interface SessionHandlerDeps {
    config: RunnerConfig;
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
    cliPaths: CliPaths;
}

export async function handleSessionStart(
    data: {
        sessionId: string;
        runnerId: string;
        cliType: 'claude' | 'gemini' | 'codex' | 'terminal' | 'generic';
        plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk';
        folderPath?: string;
        create?: boolean;
        resume?: boolean;
        options?: PluginOptions;
    },
    deps: SessionHandlerDeps
): Promise<void> {
    const { config, wsManager, pluginManager, cliSessions, sessionMetadata, cliPaths } = deps;

    console.log(`Starting session ${data.sessionId} (CLI: ${data.cliType}, Plugin: ${data.plugin || 'default'})`);

    let cliPath: string;

    // Handle terminal/generic type - just use the default shell
    if (data.cliType === 'terminal' || data.cliType === 'generic') {
        // Use the user's default shell or fallback to bash
        cliPath = process.env.SHELL || '/bin/bash';
        console.log(`[SessionStart] Using shell: ${cliPath}`);
    } else {
        // Detect AI CLI path
        cliPath = cliPaths[data.cliType];

        if (!cliPath) {
            // Try fallback detection
            try {
                const detected = await findCliPath(data.cliType, config.cliSearchPaths);
                if (detected) {
                    cliPaths[data.cliType] = detected;
                    cliPath = detected;
                }
            } catch (e) {
                console.error('Failed to detect CLI paths:', e);
            }
        }

        if (!cliPath) {
            console.error(`${data.cliType} CLI not found on runner`);
            return;
        }
    }

    // Resolve working directory
    const rawPath = data.folderPath || process.cwd();
    const cwd = expandPath(rawPath, config.defaultWorkspace);

    console.log(`[SessionStart] Received request for session ${data.sessionId}`);
    console.log(`[SessionStart] CWD: ${cwd}`);

    // Validate folder
    const validation = validateOrCreateFolder(cwd, data.create);
    if (!validation.exists) {
        console.error(`[SessionStart] ${validation.error}`);
        wsManager.send({
            type: 'output',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                content: `❌ Error: ${validation.error}`,
                outputType: 'error',
                timestamp: new Date().toISOString()
            }
        });
        return;
    }

    console.log(`[SessionStart] Folder exists! Proceeding...`);

    try {
        console.log(`[SessionStart] Initializing PluginManager...`);
        if (!pluginManager) {
            console.error('PluginManager not initialized!');
            return;
        }

        const defaultOptions = data.cliType === 'claude'
            ? config.claudeDefaults
            : data.cliType === 'codex'
            ? config.codexDefaults
            : data.cliType === 'gemini'
            ? config.geminiDefaults
            : undefined;
        const mergedOptions: PluginOptions = {
            ...(defaultOptions || {}),
            ...(data.options || {})
        };

        // Only continue conversation if explicitly requested or resuming
        // New sessions should start fresh by default
        if (mergedOptions.continueConversation === undefined) {
            mergedOptions.continueConversation = false;
        }
        if (mergedOptions.skipPermissions === undefined) {
            mergedOptions.skipPermissions = false;
        }
        if (data.resume) {
            // Runner is authoritative for CLI session IDs - always check local storage first
            const persistedCliSessionId = sessionStorage.getCliSessionId(data.sessionId);
            if (persistedCliSessionId) {
                console.log(`[SessionStart] Using persisted CLI session ID from local storage: ${persistedCliSessionId.slice(0, 8)}`);
                mergedOptions.resumeSessionId = persistedCliSessionId;
            } else if (mergedOptions.resumeSessionId) {
                // Bot passed a resumeSessionId and we don't have one locally (external session or first resume)
                console.log(`[SessionStart] Using resumeSessionId from bot: ${mergedOptions.resumeSessionId.slice(0, 8)}`);
            } else {
                // Last resort: use DisCode session ID
                console.log(`[SessionStart] No CLI session ID found, using DisCode session ID: ${data.sessionId.slice(0, 8)}`);
                mergedOptions.resumeSessionId = data.sessionId;
            }
        }

        const normalized = data.cliType === 'claude'
            ? normalizeClaudeOptions(mergedOptions)
            : { options: mergedOptions, warnings: [] };

        if (normalized.warnings.length > 0) {
            console.warn(`[SessionStart] Option warnings for ${data.sessionId}: ${normalized.warnings.join(' ')}`);
            wsManager.send({
                type: 'output',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    content: `⚠️ Some session options were ignored: ${normalized.warnings.join(' ')}`,
                    outputType: 'info',
                    timestamp: new Date().toISOString()
                }
            });
        }

        const session = await pluginManager.createSession({
            cliPath,
            cwd,
            sessionId: data.sessionId,
            cliType: data.cliType,
            options: normalized.options
        }, data.plugin);

        console.log(`Session ${data.sessionId} created with ${data.plugin || 'default'} plugin`);

        // Store session and metadata
        cliSessions.set(data.sessionId, session);
        sessionMetadata.set(data.sessionId, {
            sessionId: data.sessionId,
            cliType: data.cliType,
            plugin: data.plugin,
            folderPath: data.folderPath,
            runnerId: data.runnerId
        });

        // Notify when ready
        let sentReady = false;
        const notifyReady = () => {
            if (sentReady) return;
            sentReady = true;

            wsManager.send({
                type: 'session_ready',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId
                }
            });
            console.log(`Sent session_ready for ${data.sessionId}`);
        };

        if (session.isReady) {
            notifyReady();
        } else {
            console.log(`Waiting for session ${data.sessionId} to be ready...`);

            session.once('ready', () => {
                console.log(`Session ${data.sessionId} is now ready (event detected)!`);
                notifyReady();
            });

            // Fallback timeout
            setTimeout(() => {
                if (!sentReady) {
                    console.log(`Session readiness timeout for ${data.sessionId}. Sending ready signal anyway.`);
                    notifyReady();
                }
            }, config.sessionReadyTimeout);
        }

    } catch (error) {
        console.error('Error creating session:', error);

        wsManager.send({
            type: 'output',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                content: `Error: ${error instanceof Error ? error.message : String(error)}`,
                timestamp: new Date().toISOString(),
                outputType: 'error'
            }
        });
    }
}

export async function handleSessionEnd(
    data: { sessionId: string },
    deps: Pick<SessionHandlerDeps, 'cliSessions' | 'sessionMetadata'> & {
        pendingMessages: Map<string, any[]>;
        pendingApprovalRequests: Map<string, PendingApprovalRequestInfo>;
    }
): Promise<void> {
    const { cliSessions, sessionMetadata, pendingMessages, pendingApprovalRequests } = deps;

    console.log(`Session ended: ${data.sessionId}`);

    // Close CLI session properly
    const sessionToClose = cliSessions.get(data.sessionId);
    if (sessionToClose) {
        await sessionToClose.close();
    }

    cliSessions.delete(data.sessionId);
    sessionMetadata.delete(data.sessionId);
    pendingMessages.delete(data.sessionId);

    // Remove from persistent storage
    sessionStorage.deleteSession(data.sessionId);

    for (const [requestId, pending] of pendingApprovalRequests.entries()) {
        if (pending.sessionId === data.sessionId) {
            pendingApprovalRequests.delete(requestId);
        }
    }

    console.log(`Session ${data.sessionId} cleaned up`);
}
