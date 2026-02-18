/**
 * WebSocket Handlers
 * 
 * Handles all WebSocket messages from runner agents.
 */

import { WebSocketServer } from 'ws';
import { EmbedBuilder, WebhookClient, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { getConfig } from '../config.js';
import {
    createToolUseEmbed,
    createOutputEmbed,
    createActionItemEmbed,
    createRunnerOfflineEmbed,
    formatContentWithTables,
    createErrorEmbed,
} from '../utils/embeds.js';
import { buildSessionStartOptions } from '../utils/session-options.js';
import { getCategoryManager } from '../services/category-manager.js';
import { getSessionSyncService } from '../services/session-sync.js';
import { clearAttachApprovalFallback } from '../services/synced-session-control.js';
import { permissionStateStore } from '../permissions/state-store.js';
import { rebuildPermissionButtons } from './permission-buttons.js';
import { safeEditReply } from './interaction-safety.js';
import type { WebSocketMessage, RunnerInfo, Session } from '../../../shared/types.ts';

console.log('[DEBUG] websocket.ts MODULE LOADED - Unified UI Version');

const config = getConfig();

const OFFLINE_GRACE_MS = parseInt(process.env.DISCODE_OFFLINE_GRACE_MS || '45000');
const WS_PING_INTERVAL_MS = parseInt(process.env.DISCODE_WS_PING_INTERVAL || '30000');
const WS_PING_TIMEOUT_MS = parseInt(process.env.DISCODE_WS_PING_TIMEOUT || '90000');

const runnerOfflineTimers = new Map<string, NodeJS.Timeout>();

function isInvalidWebhookTokenError(error: any): boolean {
    return (
        error?.code === 50027 ||
        error?.rawError?.code === 50027 ||
        error?.code === 10015 ||
        error?.rawError?.code === 10015
    );
}

function applyDefaultRunnerConfig(runner: RunnerInfo): void {
    if (!runner.config) {
        runner.config = {
            threadArchiveDays: 3,
            autoSync: true,
            thinkingLevel: 'low',
            yoloMode: false,
            claudeDefaults: {},
            codexDefaults: {},
            geminiDefaults: {},
            presets: {}
        };
        return;
    }
    if (runner.config.threadArchiveDays === undefined) runner.config.threadArchiveDays = 3;
    if (runner.config.autoSync === undefined) runner.config.autoSync = true;
    if (runner.config.thinkingLevel === undefined) runner.config.thinkingLevel = 'low';
    if (runner.config.yoloMode === undefined) runner.config.yoloMode = false;
    if (runner.config.claudeDefaults === undefined) runner.config.claudeDefaults = {};
    if (runner.config.codexDefaults === undefined) runner.config.codexDefaults = {};
    if (runner.config.geminiDefaults === undefined) runner.config.geminiDefaults = {};
    if (runner.config.presets === undefined) runner.config.presets = {};
}

function clearOfflineTimer(runnerId: string): void {
    const timer = runnerOfflineTimers.get(runnerId);
    if (timer) {
        clearTimeout(timer);
        runnerOfflineTimers.delete(runnerId);
    }
}

async function finalizeRunnerOffline(runnerId: string, closingWs: any): Promise<void> {
    runnerOfflineTimers.delete(runnerId);

    const currentWs = botState.runnerConnections.get(runnerId);
    if (currentWs && currentWs !== closingWs) {
        // Runner reconnected before grace period expired
        return;
    }

    storage.updateRunnerStatus(runnerId, 'offline');

    // Notify owner about runner going offline
    const runner = storage.getRunner(runnerId);
    if (runner) {
        await endAllRunnerSessions(runner);
        await notifyRunnerOffline(runner);
    }
}

function scheduleRunnerOffline(runnerId: string, closingWs: any): void {
    if (runnerOfflineTimers.has(runnerId)) return;
    const timer = setTimeout(() => {
        void finalizeRunnerOffline(runnerId, closingWs);
    }, OFFLINE_GRACE_MS);
    runnerOfflineTimers.set(runnerId, timer);
}

/**
 * Create and configure the WebSocket server
 */
export function createWebSocketServer(port: number): WebSocketServer {
    const wss = new WebSocketServer({ 
        port, 
        noServer: false,
        maxPayload: 500 * 1024 * 1024 // 500MB
    });

    wss.on('listening', () => {
        console.log(`WebSocket server listening on port ${port}`);
    });

    wss.on('error', (error: Error) => {
        if ((error as any).code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use. Please stop the other process or change DISCODE_WS_PORT.`);
            process.exit(1);
        } else {
            console.error('WebSocket server error:', error);
        }
    });

    const pingInterval = setInterval(() => {
        const now = Date.now();
        for (const client of wss.clients) {
            const ws: any = client as any;
            const lastPong = ws.lastPongAt || 0;
            if (now - lastPong > WS_PING_TIMEOUT_MS) {
                console.warn(`[WebSocket] Terminating unresponsive client (last pong ${Math.round((now - lastPong) / 1000)}s ago)`);
                ws.terminate();
                continue;
            }
            try {
                ws.ping();
            } catch (err) {
                console.error('[WebSocket] Ping failed:', err);
            }
        }
    }, WS_PING_INTERVAL_MS);

    wss.on('close', () => clearInterval(pingInterval));

    wss.on('connection', (ws, req) => {
        (ws as any).lastPongAt = Date.now();

        ws.on('pong', () => {
            (ws as any).lastPongAt = Date.now();
        });

        ws.on('message', async (data: Buffer) => {
            try {
                const message: WebSocketMessage = JSON.parse(data.toString());

                await handleWebSocketMessage(ws, message);
            } catch (error) {
                console.error('Error handling WebSocket message:', error);
            }
        });

        ws.on('close', async (code, reason) => {
            const reasonStr = reason ? reason.toString() : '';
            console.log(`[WebSocket] Connection closed. code=${code} reason=${reasonStr}`);

            // Remove connection
            const runnerId = (ws as any).runnerId;
            if (runnerId && botState.runnerConnections.get(runnerId) === ws) {
                botState.runnerConnections.delete(runnerId);
                scheduleRunnerOffline(runnerId, ws);
                return;
            }

            for (const [entryRunnerId, connection] of botState.runnerConnections.entries()) {
                if (connection === ws) {
                    botState.runnerConnections.delete(entryRunnerId);
                    scheduleRunnerOffline(entryRunnerId, ws);
                    break;
                }
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });

    return wss;
}

/**
 * End all sessions for a runner when it goes offline
 */
async function endAllRunnerSessions(runner: RunnerInfo): Promise<void> {
    const sessions = storage.getRunnerSessions(runner.runnerId);

    for (const session of sessions) {
        if (session.status === 'active') {
            // Mark session as ended
            session.status = 'ended';
            storage.updateSession(session.sessionId, session);

            // Archive the thread
            try {
                const thread = await botState.client.channels.fetch(session.threadId);
                if (thread && thread.isThread()) {
                    await thread.setArchived(true);

                }
            } catch (error) {
                console.error(`Failed to archive thread for session ${session.sessionId}:`, error);
            }
        }
    }
}

/**
 * Notify when a runner goes offline
 */
async function notifyRunnerOffline(runner: RunnerInfo): Promise<void> {
    if (!runner.ownerId) {
        console.error('Runner has no ownerId, cannot notify:', runner.runnerId);
        return;
    }

    // Only send notification if bot is ready
    if (!botState.isBotReady) {

        return;
    }

    // Try to send DM to owner (may fail if user has DMs disabled)
    try {
        const user = await botState.client.users.fetch(runner.ownerId);
        await user.send({
            embeds: [createRunnerOfflineEmbed(runner)]
        });
    } catch (error: any) {
        if (error.code === 50007) {
            console.log(`Could not send DM to user ${runner.ownerId} (DMs disabled or bot blocked)`);
        } else {
            console.error('Failed to send DM to runner owner:', error);
        }
    }

    // Send notification to the runner's private channel
    if (runner.privateChannelId) {
        try {
            const channel = await botState.client.channels.fetch(runner.privateChannelId);
            if (channel && 'send' in channel) {
                const sessions = storage.getRunnerSessions(runner.runnerId);
                const endedSessions = sessions.filter(s => s.status === 'ended');

                const embed = new EmbedBuilder()
                    .setColor(0xFF6600)
                    .setTitle('Runner Offline - Sessions Ended')
                    .setDescription(`The runner \`${runner.name}\` has gone offline.\n\n**${endedSessions.length} active session(s) automatically ended.**`)
                    .addFields(
                        { name: 'Status', value: '🔴 Offline', inline: true },
                        { name: 'Sessions Ended', value: `${endedSessions.length}`, inline: true },
                        { name: 'Action', value: 'Start a new session when the Runner Agent comes back online', inline: false }
                    )
                    .setTimestamp();

                await channel.send({ embeds: [embed] });

            }
        } catch (error) {
            console.error('Failed to send notification to runner channel:', error);
        }
    }

    // Update stats voice channel
    const categoryManager = getCategoryManager();
    if (categoryManager) {
        await categoryManager.updateRunnerStats(runner.runnerId);
    }
}

/**
 * Notify when a runner comes online
 */
export async function notifyRunnerOnline(runner: RunnerInfo, wasReclaimed: boolean = false): Promise<void> {
    if (!runner.privateChannelId) {

        return;
    }

    if (!botState.isBotReady) {

        return;
    }

    if (config.notifications.notifyRunnerOnline) {
        try {
            const channel = await botState.client.channels.fetch(runner.privateChannelId);
            if (channel && 'send' in channel) {
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('🟢 Runner Online')
                    .setDescription(`Runner \`${runner.name}\` is now online and ready.`)
                    .addFields(
                        { name: 'Status', value: '🟢 Online', inline: true },
                        { name: 'CLI Types', value: runner.cliTypes.join(', ') || 'N/A', inline: true }
                    )
                    .setTimestamp();

                if (wasReclaimed) {
                    embed.addFields({
                        name: 'Note',
                        value: 'Runner was restarted and reclaimed from previous offline state.',
                        inline: false
                    });
                }

                await channel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Failed to send runner online notification:', error);
        }
    }

    // Update stats voice channel
    const categoryManager = getCategoryManager();
    if (categoryManager) {
        await categoryManager.updateRunnerStats(runner.runnerId);
    }
    
    // Start session sync
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        // Start syncing (idempotent)
        await sessionSync.startSyncingRunner(runner.runnerId);
    }
}

/**
 * Main WebSocket message handler
 */
async function handleWebSocketMessage(ws: any, message: WebSocketMessage): Promise<void> {
    const data: any = (message as any).data;
    const messageRunnerId = data?.runnerId;
    const wsRunnerId = (ws as any).runnerId;

    // Log session_ready messages specifically for debugging
    if (message.type === 'session_ready') {
        console.log(`[WebSocket] session_ready message received: sessionId=${data?.sessionId}, messageRunnerId=${messageRunnerId}, wsRunnerId=${wsRunnerId}`);
    }

    if (message.type !== 'register' && messageRunnerId && wsRunnerId && wsRunnerId !== messageRunnerId) {
        console.warn(`[WebSocket] Runner mismatch: ws=${wsRunnerId} message=${messageRunnerId} type=${message.type}`);
        return;
    }

    switch (message.type) {
        case 'register':
            await handleRegister(ws, message.data);
            break;

        case 'heartbeat':
            await handleHeartbeat(ws, message.data);
            break;

        case 'approval_request':
            await handleApprovalRequest(ws, message.data);
            break;

        case 'output':
            await handleOutput(message.data);
            break;

        case 'action_item':
            await handleActionItem(message.data);
            break;

        case 'metadata':
            await handleMetadata(message.data);
            break;

        case 'session_ready':
            await handleSessionReady(message.data);
            break;

        case 'status':
            await handleRunnerStatusUpdate(message.data);
            break;


        case 'terminal_list':
            await handleTerminalList(message.data);
            break;

        case 'discord_action':
            await handleDiscordAction(message.data);
            break;

        case 'assistant_output':
            await handleAssistantOutput(message.data);
            break;

        case 'spawn_thread':
            await handleSpawnThread(ws, message.data);
            break;

        case 'tool_execution':
            await handleToolExecution(message.data);
            break;

        case 'tool_result':
            await handleToolResult(message.data);
            break;

        case 'result':
            await handleResult(message.data);
            break;

        case 'sync_projects_response':
            await handleSyncProjectsResponse(message.data);
            break;

        case 'sync_projects_progress':
            await handleSyncProjectsProgress(message.data);
            break;

        case 'sync_projects_complete':
            await handleSyncProjectsComplete(message.data);
            break;

        case 'sync_sessions_response':
            await handleSyncSessionsResponse(message.data);
            break;

        case 'sync_sessions_complete':
            await handleSyncSessionsComplete(message.data);
            break;

        case 'runner_config_updated': {
            const data = message.data as {
                runnerId: string;
                claudeDefaults?: Record<string, any>;
                codexDefaults?: Record<string, any>;
                geminiDefaults?: Record<string, any>;
                requestId?: string;
                warnings?: string[];
            };
            if (data?.requestId) {
                const timeout = botState.pendingRunnerConfigUpdates.get(data.requestId);
                if (timeout) {
                    clearTimeout(timeout);
                    botState.pendingRunnerConfigUpdates.delete(data.requestId);
                }
                if (data.warnings?.length) {
                    console.warn(`[RunnerConfig] Update warnings: ${data.warnings.join(' ')}`);
                }
            }
            if (data?.runnerId && (data.claudeDefaults || data.codexDefaults || data.geminiDefaults)) {
                const runner = storage.getRunner(data.runnerId);
                if (runner) {
                    runner.config = runner.config || {
                        threadArchiveDays: 3,
                        autoSync: true,
                        thinkingLevel: 'low',
                        yoloMode: false,
                        claudeDefaults: {},
                        codexDefaults: {},
                        geminiDefaults: {}
                    };
                    if (data.claudeDefaults) {
                        runner.config.claudeDefaults = { ...data.claudeDefaults };
                    }
                    if (data.codexDefaults) {
                        runner.config.codexDefaults = { ...data.codexDefaults };
                    }
                    if (data.geminiDefaults) {
                        runner.config.geminiDefaults = { ...data.geminiDefaults };
                    }
                    storage.updateRunner(data.runnerId, runner);
                }
            }
            break;
        }

        case 'runner_health_response': {
            const data = message.data as { requestId?: string; info?: any };
            if (data?.requestId) {
                const pending = botState.pendingRunnerHealthRequests.get(data.requestId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    botState.pendingRunnerHealthRequests.delete(data.requestId);
                    pending.resolve(data.info || null);
                }
            }
            break;
        }

        case 'runner_logs_response': {
            const data = message.data as { requestId?: string; content?: string; error?: string; logPath?: string };
            if (data?.requestId) {
                const pending = botState.pendingRunnerLogsRequests.get(data.requestId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    botState.pendingRunnerLogsRequests.delete(data.requestId);
                    pending.resolve(data);
                }
            }
            break;
        }

        case 'codex_thread_list_response': {
            const data = message.data as { requestId?: string; threads?: Array<any>; nextCursor?: string | null; error?: string; runnerId?: string };
            if (data?.requestId) {
                const pending = botState.pendingCodexThreadListRequests.get(data.requestId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    botState.pendingCodexThreadListRequests.delete(data.requestId);
                    pending.resolve(data);
                }
            }

            if (data?.threads?.length && data.runnerId) {
                const now = Date.now();
                for (const thread of data.threads) {
                    if (!thread?.id) continue;
                    botState.codexThreadCache.set(thread.id, {
                        runnerId: data.runnerId,
                        cwd: thread.cwd,
                        preview: thread.preview,
                        updatedAt: thread.updatedAt,
                        createdAt: thread.createdAt,
                        lastSeen: now
                    });
                }
            }
            break;
        }

        case 'model_list_response': {
            const data = message.data as {
                requestId?: string;
                runnerId?: string;
                cliType?: 'claude' | 'codex';
                models?: Array<{ id: string; label: string; description?: string; isDefault?: boolean }>;
                defaultModel?: string | null;
                nextCursor?: string | null;
                error?: string;
            };

            if (data?.requestId) {
                const pending = botState.pendingModelListRequests.get(data.requestId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    botState.pendingModelListRequests.delete(data.requestId);
                    pending.resolve(data);
                }
            }

            if (data?.runnerId && data?.cliType && Array.isArray(data.models) && !data.error) {
                const cacheKey = `${data.runnerId}:${data.cliType}`;
                botState.runnerModelCache.set(cacheKey, {
                    runnerId: data.runnerId,
                    cliType: data.cliType,
                    models: data.models,
                    defaultModel: data.defaultModel ?? null,
                    nextCursor: data.nextCursor ?? null,
                    fetchedAt: Date.now()
                });
            }
            break;
        }

        case 'sync_session_discovered':
            await handleSyncSessionDiscovered(message.data);
            break;

        case 'sync_session_updated':
            await handleSyncSessionUpdated(message.data);
            break;

        case 'sync_status_response':
            await handleSyncStatusResponse(message.data);
            break;

        case 'permission_decision_ack':
            await handlePermissionDecisionAck(message.data);
            break;

        default:
            console.log('Unknown message type:', message.type);
    }
}

/**
 * Handle runner registration
 */
async function handleRegister(ws: any, data: any): Promise<void> {
    (ws as any).runnerId = data.runnerId;
    (ws as any).lastPongAt = Date.now();
    clearOfflineTimer(data.runnerId);
    // Validate token
    const tokenInfo = storage.validateToken(data.token);

    if (!tokenInfo) {
        console.error(`Runner ${data.runnerId} attempted to register with invalid token`);
        ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Invalid token' }
        }));
        ws.close();
        return;
    }

    // Check if this token is already in use by a DIFFERENT runner
    const allRunners = Object.values(storage.data.runners);
    const tokenInUse = allRunners.find(r => r.token === data.token && r.runnerId !== data.runnerId);

    if (tokenInUse) {
        if (tokenInUse.status === 'online') {
            console.error(`Token already in use by ONLINE runner ${tokenInUse.runnerId}, rejecting registration from ${data.runnerId}`);
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: `Token already in use by online runner '${tokenInUse.name}'. Stop the other instance first or wait for it to go offline.` }
            }));
            ws.close();
            return;
        }

        // Allow takeover of offline runner
        console.log(`Token used by OFFLINE runner ${tokenInUse.runnerId}, allowing takeover by ${data.runnerId}`);
        const oldRunnerId = tokenInUse.runnerId;
        storage.deleteRunner(oldRunnerId);

        tokenInUse.runnerId = data.runnerId;
        tokenInUse.name = data.runnerName;
        tokenInUse.status = 'online';
        tokenInUse.lastHeartbeat = new Date().toISOString();
        tokenInUse.cliTypes = data.cliTypes;
        tokenInUse.defaultWorkspace = data.defaultWorkspace;
        tokenInUse.assistantEnabled = data.assistantEnabled ?? tokenInUse.assistantEnabled ?? true;
        if (data.claudeDefaults && typeof data.claudeDefaults === 'object') {
            tokenInUse.config = tokenInUse.config || { threadArchiveDays: 3, autoSync: true, thinkingLevel: 'low', yoloMode: false, claudeDefaults: {}, codexDefaults: {}, geminiDefaults: {} };
            tokenInUse.config.claudeDefaults = { ...data.claudeDefaults };
        }
        if (data.codexDefaults && typeof data.codexDefaults === 'object') {
            tokenInUse.config = tokenInUse.config || { threadArchiveDays: 3, autoSync: true, thinkingLevel: 'low', yoloMode: false, claudeDefaults: {}, codexDefaults: {}, geminiDefaults: {} };
            tokenInUse.config.codexDefaults = { ...data.codexDefaults };
        }
        if (data.geminiDefaults && typeof data.geminiDefaults === 'object') {
            tokenInUse.config = tokenInUse.config || { threadArchiveDays: 3, autoSync: true, thinkingLevel: 'low', yoloMode: false, claudeDefaults: {}, codexDefaults: {}, geminiDefaults: {} };
            tokenInUse.config.geminiDefaults = { ...data.geminiDefaults };
        }
        applyDefaultRunnerConfig(tokenInUse);

        const categoryManager = getCategoryManager();
        if (categoryManager) {
            try {
                // Ensure category exists
                let category = categoryManager.getRunnerCategory(tokenInUse.runnerId);
                if (!category) {
                    category = await categoryManager.createRunnerCategory(tokenInUse.runnerId, data.runnerName, tokenInfo.guildId);
                }
                tokenInUse.privateChannelId = category.controlChannelId;
            } catch (error) {
                console.error(`Failed to create category for reclaimed runner: ${error}`);
                // Fallback or just log
            }
        }

        storage.registerRunner(tokenInUse);
        botState.runnerConnections.set(data.runnerId, ws);
        console.log(`Reclaimed offline runner: ${data.runnerId} (old: ${oldRunnerId}, CLI types: ${data.cliTypes.join(', ')})`);

        await notifyRunnerOnline(tokenInUse, true);

        ws.send(JSON.stringify({
            type: 'registered',
            data: { runnerId: data.runnerId, cliTypes: data.cliTypes, reclaimed: true }
        }));

        // Attempt to reattach active sessions after runner reclaim
        try {
            const activeSessions = storage.getRunnerSessions(data.runnerId).filter(s => s.status === 'active');
            for (const session of activeSessions) {
                const isSdkSession =
                    session.plugin === 'claude-sdk' ||
                    session.plugin === 'codex-sdk' ||
                    session.plugin === 'gemini-sdk';

                if (isSdkSession) {
                    botState.suppressSessionReadyNotification.add(session.sessionId);
                }

                const startOptions = buildSessionStartOptions(
                    tokenInUse,
                    undefined,
                    undefined,
                    session.cliType
                );
                ws.send(JSON.stringify({
                    type: 'session_start',
                    data: {
                        sessionId: session.sessionId,
                        runnerId: data.runnerId,
                        cliType: session.cliType,
                        plugin: session.plugin,
                        folderPath: session.folderPath,
                        resume: true,
                        options: startOptions
                    }
                }));
            }
            if (activeSessions.length > 0) {
                console.log(`[Reclaim] Sent reattach for ${activeSessions.length} active sessions`);
            }
        } catch (error) {
            console.warn('[Reclaim] Failed to reattach active sessions:', error);
        }
        return;
    }

    // Check if runner already exists
    const existingRunner = storage.getRunner(data.runnerId);

    if (existingRunner) {
        existingRunner.cliTypes = data.cliTypes;
        existingRunner.status = 'online';
        existingRunner.lastHeartbeat = new Date().toISOString();
        if (data.defaultWorkspace) existingRunner.defaultWorkspace = data.defaultWorkspace;
        // Update assistantEnabled from registration message
        existingRunner.assistantEnabled = data.assistantEnabled ?? true;
        if (data.claudeDefaults && typeof data.claudeDefaults === 'object') {
            existingRunner.config = existingRunner.config || { threadArchiveDays: 3, autoSync: true, thinkingLevel: 'low', yoloMode: false, claudeDefaults: {}, codexDefaults: {}, geminiDefaults: {} };
            existingRunner.config.claudeDefaults = { ...data.claudeDefaults };
        }
        if (data.codexDefaults && typeof data.codexDefaults === 'object') {
            existingRunner.config = existingRunner.config || { threadArchiveDays: 3, autoSync: true, thinkingLevel: 'low', yoloMode: false, claudeDefaults: {}, codexDefaults: {}, geminiDefaults: {} };
            existingRunner.config.codexDefaults = { ...data.codexDefaults };
        }
        if (data.geminiDefaults && typeof data.geminiDefaults === 'object') {
            existingRunner.config = existingRunner.config || { threadArchiveDays: 3, autoSync: true, thinkingLevel: 'low', yoloMode: false, claudeDefaults: {}, codexDefaults: {}, geminiDefaults: {} };
            existingRunner.config.geminiDefaults = { ...data.geminiDefaults };
        }
        applyDefaultRunnerConfig(existingRunner);

        const categoryManager = getCategoryManager();
        if (categoryManager) {
            try {
                // Ensure category exists
                let category = categoryManager.getRunnerCategory(existingRunner.runnerId);
                if (!category) {
                    category = await categoryManager.createRunnerCategory(existingRunner.runnerId, existingRunner.name, tokenInfo.guildId);
                }
                existingRunner.privateChannelId = category.controlChannelId;
            } catch (error) {
                console.error(`Failed to create category for existing runner: ${error}`);
            }
        }

        storage.registerRunner(existingRunner);
        botState.runnerConnections.set(data.runnerId, ws);
        console.log(`Runner ${data.runnerId} re-registered (CLI types: ${data.cliTypes.join(', ')})`);

        await notifyRunnerOnline(existingRunner, false);
    } else {
        if (!tokenInfo.userId) {
            console.error('Token does not have a valid userId, cannot register runner');
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: 'Invalid token: missing user ID. Please regenerate your token with /generate-token' }
            }));
            ws.close();
            return;
        }

        const newRunner: RunnerInfo = {
            runnerId: data.runnerId,
            name: data.runnerName,
            ownerId: tokenInfo.userId,
            token: data.token,
            status: 'online',
            lastHeartbeat: new Date().toISOString(),
            authorizedUsers: [tokenInfo.userId],
            cliTypes: data.cliTypes,
            defaultWorkspace: data.defaultWorkspace,
            assistantEnabled: data.assistantEnabled ?? true,
            config: {
                threadArchiveDays: 3,
                autoSync: true,
                thinkingLevel: 'low',
                yoloMode: false,
                claudeDefaults: data.claudeDefaults && typeof data.claudeDefaults === 'object' ? { ...data.claudeDefaults } : {},
                codexDefaults: data.codexDefaults && typeof data.codexDefaults === 'object' ? { ...data.codexDefaults } : {},
                geminiDefaults: data.geminiDefaults && typeof data.geminiDefaults === 'object' ? { ...data.geminiDefaults } : {}
            }
        };
        applyDefaultRunnerConfig(newRunner);

        const categoryManager = getCategoryManager();
        if (categoryManager) {
            try {
                const category = await categoryManager.createRunnerCategory(newRunner.runnerId, newRunner.name, tokenInfo.guildId);
                newRunner.privateChannelId = category.controlChannelId;
            } catch (error) {
                console.error(`Failed to create category for new runner: ${error}`);
            }
        }

        storage.registerRunner(newRunner);
        botState.runnerConnections.set(data.runnerId, ws);
        console.log(`New runner registered: ${data.runnerId} (CLI types: ${data.cliTypes.join(', ')})`);

        await notifyRunnerOnline(newRunner, false);
    }

    ws.send(JSON.stringify({
        type: 'registered',
        data: { runnerId: data.runnerId, cliTypes: data.cliTypes }
    }));

    // Attempt to reattach active sessions after runner reconnect
    try {
        const wsConn = botState.runnerConnections.get(data.runnerId);
        if (wsConn) {
            const activeSessions = storage.getRunnerSessions(data.runnerId).filter(s => s.status === 'active');
            for (const session of activeSessions) {
                const isSdkSession =
                    session.plugin === 'claude-sdk' ||
                    session.plugin === 'codex-sdk' ||
                    session.plugin === 'gemini-sdk';

                if (isSdkSession) {
                    botState.suppressSessionReadyNotification.add(session.sessionId);
                }

                // Bot is not authoritative for CLI session IDs - runner handles resume logic
                // Just pass the session ID and let runner look up CLI session ID from its storage
                const startOptions = buildSessionStartOptions(
                    storage.getRunner(data.runnerId),
                    undefined,
                    undefined, // Don't pass resumeSessionId - runner is authoritative
                    session.cliType
                );
                wsConn.send(JSON.stringify({
                    type: 'session_start',
                    data: {
                        sessionId: session.sessionId,
                        runnerId: data.runnerId,
                        cliType: session.cliType,
                        plugin: session.plugin,
                        folderPath: session.folderPath,
                        resume: true, // Always resume for SDK sessions - runner will find CLI ID
                        options: startOptions
                    }
                }));
            }
        }
    } catch (error) {
        console.warn('[WebSocket] Failed to reattach active sessions:', error);
    }
}

/**
 * Handle runner heartbeat
 */
async function handleHeartbeat(ws: any, data: any): Promise<void> {
    storage.updateRunnerStatus(data.runnerId, 'online');
    (ws as any).runnerId = data.runnerId;
    (ws as any).lastPongAt = Date.now();
    clearOfflineTimer(data.runnerId);

    // Store memory usage from heartbeat
    if (typeof data.memoryMb === 'number') {
        botState.runnerMemoryUsage.set(data.runnerId, data.memoryMb);
    }

    if (!botState.runnerConnections.has(data.runnerId)) {
        botState.runnerConnections.set(data.runnerId, ws);

    }
}

/**
 * Create multi-select or single-select buttons for AskUserQuestion
 * @returns Object with rows array and multiSelectState if applicable
 */
function createQuestionButtons(data: any, requestId: string): { rows: ActionRowBuilder<ButtonBuilder>[], multiSelectState: any } {
    let rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let multiSelectState: any = null;

    if (data.options && data.options.length > 0) {
        const isMultiSelect = data.isMultiSelect === true;
        const hasOther = data.hasOther === true;

        // Check if "Other" is already in the options array
        const hasOtherOption = data.options.some((opt: string) =>
            opt.toLowerCase() === 'other'
        );

        if (isMultiSelect) {
            // Multi-select: create toggleable buttons + Submit button
            const optionButtons = data.options.map((option: string, index: number) => {
                const optionNumber = index + 1;
                return new ButtonBuilder()
                    .setCustomId(`multiselect_${requestId}_${optionNumber}`)
                    .setLabel(option)
                    .setStyle(ButtonStyle.Secondary); // Start unselected (gray)
            });

            // Add "Other" button only if hasOther is true AND "Other" is not already in options
            if (hasOther && !hasOtherOption) {
                optionButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`other_${requestId}`)
                        .setLabel('Other...')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            // Add Submit button
            const submitButton = new ButtonBuilder()
                .setCustomId(`multiselect_submit_${requestId}`)
                .setLabel('✅ Submit')
                .setStyle(ButtonStyle.Success);

            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...optionButtons));
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(submitButton));

            // Create multi-select state for caller to store
            multiSelectState = {
                requestId,
                sessionId: data.sessionId,
                runnerId: data.runnerId,
                selectedOptions: new Set(),
                options: data.options,
                isMultiSelect: true,
                hasOther: hasOther,
                toolName: data.toolName,
                timestamp: new Date()
            };
        } else {
            // Single-select: all buttons use consistent gray styling
            const buttons = data.options.map((option: string, index: number) => {
                const optionNumber = index + 1;
                return new ButtonBuilder()
                    .setCustomId(`option_${requestId}_${optionNumber}`)
                    .setLabel(option)
                    .setStyle(ButtonStyle.Secondary);
            });

            // Add "Other" button only if hasOther is true AND "Other" is not already in options
            if (hasOther && !hasOtherOption) {
                buttons.push(
                    new ButtonBuilder()
                        .setCustomId(`other_${requestId}`)
                        .setLabel('Other...')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
        }
    }

    return { rows, multiSelectState };
}

/**
 * Handle approval request from runner
 */
async function handleApprovalRequest(ws: any, data: any): Promise<void> {
    console.log(`[DEBUG] handleApprovalRequest called for ${data.requestId} (tool: ${data.toolName})`);

    if (typeof data.sessionId === 'string' && data.sessionId) {
        clearAttachApprovalFallback(data.sessionId);
    }

    const runner = storage.getRunner(data.runnerId);
    if (!runner) {
        console.error('[Approval] Unknown runner:', data.runnerId);
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: { requestId: data.requestId, allow: false, message: `Unknown runner: ${data.runnerId}` }
        }));
        return;
    }

    // Normalize tool input for permission UI
    let normalizedToolInput: Record<string, any> = {};
    if (data.toolInput && typeof data.toolInput === 'object') {
        normalizedToolInput = data.toolInput;
    } else if (typeof data.toolInput === 'string') {
        try {
            normalizedToolInput = JSON.parse(data.toolInput);
        } catch {
            normalizedToolInput = { raw: data.toolInput };
        }
    }

    const hasSuggestions = Array.isArray(data.suggestions) && data.suggestions.length > 0;
    const isQuestion = data.toolName === 'AskUserQuestion';

    // Check if this is an assistant session
    if (data.sessionId && data.sessionId.startsWith('assistant-')) {
        const channel = await botState.client.channels.fetch(runner.privateChannelId);
        if (!channel || !('send' in channel)) {
            console.error('[Approval] Invalid private channel for assistant');
            return;
        }

        // Create buttons using shared helper
        const { rows, multiSelectState } = createQuestionButtons(data, data.requestId);

        // Store multi-select state if applicable
        if (multiSelectState) {
            botState.multiSelectState.set(data.requestId, multiSelectState);
        }

        // If no options/AskUserQuestion, add default approval buttons
        if (rows.length === 0) {
            // Get user's scope preference
            const userId = (channel as any).recipient?.id;
            const scope = botState.userScopePreferences.get(userId) || 'session';
            const scopeLabel = scope === 'global' ? 'Global' : scope.charAt(0).toUpperCase() + scope.slice(1);

            const allowButton = new ButtonBuilder()
                .setCustomId(`allow_${data.requestId}`)
                .setLabel('Allow')
                .setStyle(ButtonStyle.Success);

            const allowAllButton = new ButtonBuilder()
                .setCustomId(`allow_all_${data.requestId}`)
                .setLabel('Allow All')
                .setStyle(ButtonStyle.Primary);

            const scopeButton = new ButtonBuilder()
                .setCustomId(`scope_${data.requestId}`)
                .setLabel(`Scope: ${scopeLabel} 🔄`)
                .setStyle(ButtonStyle.Secondary);

            const tellButton = new ButtonBuilder()
                .setCustomId(`tell_${data.requestId}`)
                .setLabel('Tell Claude')
                .setStyle(ButtonStyle.Secondary);

            const denyButton = new ButtonBuilder()
                .setCustomId(`deny_${data.requestId}`)
                .setLabel('Deny')
                .setStyle(ButtonStyle.Danger);

            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(allowButton, allowAllButton, scopeButton, tellButton, denyButton));
        }

        // Create embed
        const toolInputStr = typeof data.toolInput === 'string'
            ? data.toolInput
            : JSON.stringify(data.toolInput, null, 2);

        const embed = new EmbedBuilder()
            .setColor(0xFFD700) // Warning color
            .setTitle('Tool Use Approval Required')
            .addFields(
                { name: 'Runner', value: `\`${runner.name}\``, inline: true },
                { name: 'Tool', value: `\`${data.toolName}\``, inline: true },
                { name: 'Input', value: `\`\`\`json\n${toolInputStr.substring(0, 1000)}\n\`\`\``, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Runner ID: ${runner.runnerId}` });

        const message = await channel.send({
            embeds: [embed],
            components: rows
        });

        // Store in unified permission state store
        permissionStateStore.save({
            requestId: data.requestId,
            sessionId: data.sessionId,
            runnerId: data.runnerId,
            toolName: data.toolName,
            toolInput: normalizedToolInput,
            suggestions: data.suggestions || [],
            isPlanMode: data.toolName === 'ExitPlanMode',
            isQuestion: data.toolName === 'AskUserQuestion',
            currentScope: 'session',
            blockedPath: data.blockedPath,
            decisionReason: data.decisionReason,
            timestamp: new Date().toISOString(),
            channelId: runner.privateChannelId,
            messageId: message.id,
            options: data.options,
            isMultiSelect: data.isMultiSelect,
            hasOther: data.hasOther
        });

        return;
    }

    let session = storage.getSession(data.sessionId);
    if (!session) {
        const sessionSync = getSessionSyncService();
        const syncEntry = sessionSync?.getSessionByExternalSessionId(data.runnerId, data.sessionId);
        if (syncEntry?.session?.threadId) {
            session = {
                sessionId: data.sessionId,
                runnerId: data.runnerId,
                channelId: syncEntry.session.threadId,
                threadId: syncEntry.session.threadId,
                createdAt: syncEntry.session.lastSyncedAt?.toISOString?.() || new Date().toISOString(),
                status: 'active',
                cliType: syncEntry.session.cliType,
                creatorId: storage.getRunner(data.runnerId)?.ownerId || ''
            } as any;
            console.log(`[Approval] Routed external session ${data.sessionId} to synced thread ${syncEntry.session.threadId}`);
        }
    }

    if (!session) {
        console.error('[Approval] Unknown session:', data.sessionId);
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: { requestId: data.requestId, allow: false, message: `Unknown session: ${data.sessionId}. Please start a new session in Discord.` }
        }));
        return;
    }

    // Check if this tool is auto-approved for this session
    const sessionAllowedTools = botState.allowedTools.get(data.sessionId);
    if (sessionAllowedTools && sessionAllowedTools.has(data.toolName)) {
        // Send the approval response to runner
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: { 
                requestId: data.requestId, 
                sessionId: data.sessionId,
                optionNumber: '1',  // "Allow" option
                allow: true, 
                message: `Auto-approved (tool ${data.toolName} was previously allowed for all)` 
            }
        }));

        // Also show in Discord so user can see what's being run
        const thread = await botState.client.channels.fetch(session.threadId);
        if (thread && 'send' in thread) {
            const runner = storage.getRunner(data.runnerId);
            const embed = createToolUseEmbed(runner, data.toolName, data.toolInput)
                .setColor(0x00FF00)  // Green for auto-approved
                .setTitle(`✅ Auto-Approved: ${data.toolName}`);
            
            await thread.send({ embeds: [embed] });
        }
        return;
    }

    // Send to the thread
    const thread = await botState.client.channels.fetch(session.threadId);
    if (!thread || !('send' in thread)) {
        console.error('Invalid thread');
        return;
    }

    // Special handling for large context (e.g. Plan Mode)
    // Discord Embed Description limit is 4096. We split if it's large.
    if (data.context && typeof data.context === 'string') {
        const MAX_LENGTH = 3800; // Safe limit below 4096
        const context = data.context;

        if (context.length > MAX_LENGTH) {
            console.log(`[Approval] Context too large (${context.length}), splitting...`);
            const chunks: string[] = [];
            let remaining = context;
            
            while (remaining.length > 0) {
                if (remaining.length <= MAX_LENGTH) {
                    chunks.push(remaining);
                    break;
                }
                
                // Try to split at a newline closest to limit
                let splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
                if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
                    // If no convenient newline, hard split
                    splitIndex = MAX_LENGTH;
                }
                
                chunks.push(remaining.substring(0, splitIndex));
                remaining = remaining.substring(splitIndex).trim();
            }

            // Send all chunks except the last one as separate messages
            for (let i = 0; i < chunks.length - 1; i++) {
                const partEmbed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle(`Plan Review (Part ${i + 1} of ${chunks.length})`)
                    .setDescription(chunks[i]);
                await thread.send({ embeds: [partEmbed] });
            }

            // Update data.context to be only the last chunk for the final embed
            data.context = `**(Part ${chunks.length} of ${chunks.length})**\n\n` + chunks[chunks.length - 1];
        }
    }

    // Create buttons using shared helper
    const { rows, multiSelectState } = createQuestionButtons(data, data.requestId);

    // Store multi-select state if applicable
    if (multiSelectState) {
        botState.multiSelectState.set(data.requestId, multiSelectState);
    }

    // If no options/AskUserQuestion, add default approval buttons for regular sessions
    if (rows.length === 0 && !hasSuggestions) {
        console.log(`[DEBUG] Generating unified buttons for tool: ${data.toolName}`);
        // Get user's scope preference (thread participants not easily avail, default to session)
        // For buttons.ts handler we will have the userId
        const scope = 'session'; 
        const scopeLabel = 'Session';

        const allowButton = new ButtonBuilder()
            .setCustomId(`allow_${data.requestId}`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success);

        const allowAllButton = new ButtonBuilder()
            .setCustomId(`allow_all_${data.requestId}`)
            .setLabel('Allow All')
            .setStyle(ButtonStyle.Primary);

        const scopeButton = new ButtonBuilder()
            .setCustomId(`scope_${data.requestId}`)
            .setLabel(`Scope: ${scopeLabel} 🔄`)
            .setStyle(ButtonStyle.Secondary);

        const tellButton = new ButtonBuilder()
            .setCustomId(`tell_${data.requestId}`)
            .setLabel('Tell Claude')
            .setStyle(ButtonStyle.Secondary);

        const denyButton = new ButtonBuilder()
            .setCustomId(`deny_${data.requestId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger);

        rows.push(new ActionRowBuilder<ButtonBuilder>()
            .addComponents(allowButton, allowAllButton, scopeButton, tellButton, denyButton));
    }

    let embed = createToolUseEmbed(runner, data.toolName, data.toolInput);
    
    // If we have context (Plan Mode), override/append description
    if (data.context) {
        embed.setDescription(data.context);
        // Maybe clear fields if they are redundant or just showing "path"
        // But keep them for now as they might contain metadata
    }
    
    let permissionSaved = false;
    if (rows.length === 0 && hasSuggestions && !isQuestion) {
        // Get initial scope from user preference if available
        let initialScope: any = 'session';
        if (session.creatorId) {
            const pref = botState.userScopePreferences.get(session.creatorId);
            if (pref === 'global') initialScope = 'userSettings';
            else if (pref === 'project') initialScope = 'projectSettings';
            else if (pref === 'session') initialScope = 'session';
        }

        permissionStateStore.save({
            requestId: data.requestId,
            sessionId: data.sessionId,
            runnerId: data.runnerId,
            toolName: data.toolName,
            toolInput: normalizedToolInput,
            suggestions: data.suggestions || [],
            isPlanMode: data.toolName === 'ExitPlanMode',
            isQuestion: false,
            currentScope: initialScope,
            blockedPath: data.blockedPath,
            decisionReason: data.decisionReason,
            timestamp: new Date().toISOString()
        });
        permissionSaved = true;

        const state = permissionStateStore.get(data.requestId);
        if (state) {
            const uiState = state.uiState;
            rows.push(...rebuildPermissionButtons(state.request, uiState));
            
            // Re-use the existing nicely formatted embed (created at line 741)
            // Just updated the fields to include scope info
            // We need to clone it or modify it. EmbedBuilder is mutable? 
            // createToolUseEmbed returns an EmbedBuilder instance.
            
            // Add Scope field to the existing embed
            embed.addFields([
                { name: 'Current Scope', value: `**${uiState.scopeLabel}**\n${uiState.scopeDescription}`, inline: false }
            ]);
            
            // Ensure timestamp and color
            embed.setColor('Yellow').setTimestamp();
        }
    }

    // Build ping content based on config
    const userMention = session.creatorId ? `<@${session.creatorId}>` : '';
    const atHere = config.notifications.useAtHere && config.notifications.pingOnApproval ? '@here ' : '';
    const pingContent = config.notifications.pingOnApproval
        ? `${atHere}${userMention} Approval needed!`
        : 'Approval needed!';

    const message = await thread.send({
        content: pingContent,
        embeds: [embed],
        components: rows
    });

    // Store in unified permission state store
    if (!permissionSaved) {
        permissionStateStore.save({
            requestId: data.requestId,
            sessionId: data.sessionId,
            runnerId: data.runnerId,
            toolName: data.toolName,
            toolInput: normalizedToolInput,
            suggestions: data.suggestions || [],
            isPlanMode: data.toolName === 'ExitPlanMode',
            isQuestion,
            currentScope: 'session',
            blockedPath: data.blockedPath,
            decisionReason: data.decisionReason,
            timestamp: new Date().toISOString(),
            channelId: session.threadId,
            messageId: message.id,
            userId: runner.ownerId,
            options: data.options,
            isMultiSelect: data.isMultiSelect,
            hasOther: data.hasOther
        });
    }

}

/**
 * Handle output from runner
 */
async function handleOutput(data: any): Promise<void> {
    const session = storage.getSession(data.sessionId);
    if (!session) return;

    const thread = await botState.client.channels.fetch(session.threadId);
    if (!thread || !('send' in thread)) return;

    const outputType = data.outputType || 'stdout';
    const now = Date.now();
    const STREAMING_TIMEOUT = 10000;

    const streaming = botState.streamingMessages.get(data.sessionId);

    // Clear streaming state if output type changes (e.g., stdout → thinking)
    // This ensures different output types get separate messages
    if (streaming && streaming.outputType !== outputType) {
        console.log(`[Output] Output type changed from ${streaming.outputType} to ${outputType}, clearing streaming state`);
        botState.streamingMessages.delete(data.sessionId);
    }

    // Re-fetch after potential deletion
    const currentStreaming = botState.streamingMessages.get(data.sessionId);
    
    // Runner output is usually accumulated. Track the full accumulated text separately
    // so split streaming can continue from the current chunk instead of restarting.
    const incomingContent = typeof data.content === 'string' ? data.content : String(data.content ?? '');

    // Check if we should edit existing message or create new one
    // Edit if: we have streaming state, same output type, and within timeout
    const shouldStream = Boolean(currentStreaming &&
        (now - currentStreaming.lastUpdateTime) < STREAMING_TIMEOUT &&
        currentStreaming.outputType === outputType);

    let displayContent = incomingContent;
    if (shouldStream && currentStreaming) {
        const previousAccumulated = currentStreaming.accumulatedContent ?? currentStreaming.content;
        if (previousAccumulated && incomingContent.startsWith(previousAccumulated)) {
            const delta = incomingContent.slice(previousAccumulated.length);
            displayContent = `${currentStreaming.content}${delta}`;
        }
    }

    console.log(`[Output] Session: ${data.sessionId}, Type: ${outputType}, ShouldStream: ${shouldStream}, HasStreaming: ${!!currentStreaming}, ContentLen: ${displayContent.length}`);

    // Check for message length limit (Discord embed description max is 4096)
    const SOFT_LIMIT = 3000;
    const HARD_LIMIT = 3900;

    // Handle message splitting if content exceeds limits
    if (shouldStream && currentStreaming && displayContent.length > SOFT_LIMIT) {
        let splitIndex = -1;

        if (displayContent.length > HARD_LIMIT) {
            console.log(`[Output] Hit hard limit ${displayContent.length}, forcing split`);
            const searchWindow = displayContent.substring(SOFT_LIMIT);
            const lastNewline = searchWindow.lastIndexOf('\n');
            
            if (lastNewline !== -1) {
                splitIndex = SOFT_LIMIT + lastNewline;
            } else {
                const lastSpace = searchWindow.lastIndexOf(' ');
                if (lastSpace !== -1) {
                    splitIndex = SOFT_LIMIT + lastSpace;
                } else {
                    splitIndex = HARD_LIMIT;
                }
            }
        } else if (displayContent.includes('\n')) {
            const searchWindow = displayContent.substring(SOFT_LIMIT);
            const lastNewline = searchWindow.lastIndexOf('\n');
            
            if (lastNewline !== -1) {
                splitIndex = SOFT_LIMIT + lastNewline;
                console.log(`[Output] Soft limit reached, found paragraph break at ${splitIndex}`);
            }
        }

        if (splitIndex !== -1) {
            const contentForOld = displayContent.substring(0, splitIndex);
            const contentForNew = displayContent.substring(splitIndex);

            console.log(`[Output] Splitting message: Old=${contentForOld.length}, New=${contentForNew.length}`);

            // Finalize the old message
            const embedOld = createOutputEmbed(outputType, contentForOld);
            try {
                const message = await thread.messages.fetch(currentStreaming.messageId);
                await message.edit({ embeds: [embedOld] });
            } catch (e) {
                console.error('Failed to finalize old message split:', e);
            }

            // Continue streaming on a new message with the remaining chunk.
            const embedNew = createOutputEmbed(outputType, contentForNew);
            const newMessage = await thread.send({ embeds: [embedNew] });
            botState.streamingMessages.set(data.sessionId, {
                messageId: newMessage.id,
                lastUpdateTime: now,
                content: contentForNew,
                outputType: outputType,
                accumulatedContent: incomingContent
            });

            if (data.isComplete) {
                botState.streamingMessages.delete(data.sessionId);
            }
            return;
        }
    }

    // Format content for display
    let formattedContent = displayContent;
    if (outputType === 'todos') {
        formattedContent = formattedContent.replace(/box /g, '☐ ');
    }

    const embed = createOutputEmbed(outputType, formattedContent);

    if (shouldStream) {
        try {
            const message = await thread.messages.fetch(currentStreaming!.messageId);
            await message.edit({ embeds: [embed] });

            botState.streamingMessages.set(data.sessionId, {
                messageId: currentStreaming!.messageId,
                lastUpdateTime: now,
                content: displayContent,
                outputType: outputType,
                accumulatedContent: incomingContent
            });
        } catch (error) {
            console.error('Error editing message:', error);
            const newMessage = await thread.send({ embeds: [embed] });
            botState.streamingMessages.set(data.sessionId, {
                messageId: newMessage.id,
                lastUpdateTime: now,
                content: displayContent,
                outputType: outputType,
                accumulatedContent: incomingContent
            });
        }
    } else {
        if (outputType === 'error' && data.content.includes('Folder') && data.content.includes('does not exist')) {
            const createFolderButton = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`create_folder_${data.sessionId}`)
                        .setLabel('Create Folder & Retry')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('📁')
                );

            await thread.send({
                embeds: [embed],
                components: [createFolderButton]
            });
        } else {
            const sentMessage = await thread.send({ embeds: [embed] });
            botState.streamingMessages.set(data.sessionId, {
                messageId: sentMessage.id,
                lastUpdateTime: now,
                content: displayContent,
                outputType: outputType,
                accumulatedContent: incomingContent
            });
        }
    }
    
    // Clear streaming state when message is complete
    if (data.isComplete) {
        botState.streamingMessages.delete(data.sessionId);
    }
}

/**
 * Handle action item from runner
 */
async function handleActionItem(data: any): Promise<void> {
    const session = storage.getSession(data.sessionId);
    if (!session) return;

    const channel = await botState.client.channels.fetch(session.channelId);
    if (!channel || !('send' in channel)) return;

    const items = botState.actionItems.get(session.sessionId) || [];
    items.push(data.actionItem);
    botState.actionItems.set(session.sessionId, items);

    const embed = createActionItemEmbed(data.actionItem);
    await channel.send({ embeds: [embed] });
}

/**
 * Handle metadata from runner
 */
async function handleMetadata(data: any): Promise<void> {
    const session = storage.getSession(data.sessionId);
    if (!session) return;

    if (session.plugin === 'gemini-sdk' && typeof data.mode === 'string' && data.mode.startsWith('session:')) {
        const resumeSessionId = data.mode.slice('session:'.length).trim();
        if (resumeSessionId) {
            const currentResume = (session.options as any)?.resumeSessionId;
            if (currentResume !== resumeSessionId) {
                const mergedOptions = { ...(session.options || {}), resumeSessionId };
                session.options = mergedOptions;
                storage.updateSession(session.sessionId, { options: mergedOptions });
            }
        }
    }

    const streaming = botState.streamingMessages.get(data.sessionId);
    if (!streaming || !data.activity) return;

    try {
        const thread = await botState.client.channels.fetch(session.threadId);
        if (!thread || !('messages' in thread)) return;

        const message = await thread.messages.fetch(streaming.messageId);
        if (!message || message.embeds.length === 0) return;

        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setFooter({ text: `Status: ${data.activity}` });

        await message.edit({ embeds: [embed] });
    } catch (error) {
        // Ignore errors
    }
}

/**
 * Handle session ready notification
 */
async function handleSessionReady(data: any): Promise<void> {
    const { runnerId, sessionId } = data;

    console.log(`[handleSessionReady] Received session_ready for ${sessionId} from runner ${runnerId}`);

    let session = storage.getSession(sessionId);
    if (!session) {
        // Race condition: session might not be stored yet - retry with backoff
        console.warn(`[handleSessionReady] Session ${sessionId} not found immediately, retrying...`);

        for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100 * attempt));
            session = storage.getSession(sessionId);
            if (session) {
                console.log(`[handleSessionReady] Session ${sessionId} found on retry attempt ${attempt}`);
                break;
            }
        }

        if (!session) {
            console.error(`[handleSessionReady] Session not found after retries: ${sessionId}`);
            return;
        }
    }

    // Check if this is a one-shot suppression (for reconnect reattach flows)
    const wasInSuppressSet = botState.suppressSessionReadyNotification.delete(sessionId);
    const isSdkPlugin = session.plugin === 'claude-sdk' || session.plugin === 'codex-sdk' || session.plugin === 'gemini-sdk';
    const suppressReadyNotice = wasInSuppressSet && isSdkPlugin;

    console.log(`[handleSessionReady] Session ${sessionId}: wasInSuppressSet=${wasInSuppressSet}, isSdkPlugin=${isSdkPlugin}, suppressReadyNotice=${suppressReadyNotice}`);

    // Check if we've already sent the ready notification for this session
    // This prevents duplicate pings when the CLI emits multiple 'ready' events
    if (botState.sessionReadyNotified.has(sessionId)) {
        console.log(`[handleSessionReady] Session ${sessionId} already notified, skipping duplicate ready notification`);
        return;
    }

    // Mark session as active
    session.status = 'active';
    storage.updateSession(session.sessionId, session);

    const categoryManager = getCategoryManager();
    const runner = storage.getRunner(runnerId);

    try {
        const thread = await botState.client.channels.fetch(session.threadId);
        if (thread && thread.isThread()) {
            const readyEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('Session Ready!')
                .setDescription(`Connected to \`${runner?.name}\`. You can now start typing commands.`)
                .addFields({
                    name: 'Working Directory',
                    value: `\`${session.folderPath}\``,
                    inline: true
                })
                .setTimestamp();

            // Determine ping content
            const userMention = session.creatorId ? `<@${session.creatorId}>` : '';
            const atHere = config.notifications.useAtHere ? '@here ' : '';
            const content = `${atHere}${userMention} Session is ready!`;

            // Create "Go to Thread" button for ephemeral message
            const goToThreadButton = new ButtonBuilder()
                .setLabel('Go to Thread')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${thread.guildId}/${thread.id}`)
                .setEmoji('💬');

            const buttonRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(goToThreadButton);

            if (!suppressReadyNotice) {
                await thread.send({
                    content,
                    embeds: [readyEmbed]
                });
                console.log(`[handleSessionReady] Sent ready notification to thread ${thread.id} for session ${sessionId}`);

                // Mark this session as having received its ready notification
                botState.sessionReadyNotified.add(sessionId);
            } else {
                console.log(`[handleSessionReady] Suppressed ready notification for session ${sessionId}`);
            }

            // Update ephemeral message if we have the token
            if (!suppressReadyNotice && session.interactionToken && botState.client.application) {
                const sessionAgeMs = Date.now() - new Date(session.createdAt).getTime();
                const interactionTokenLikelyExpired = Number.isFinite(sessionAgeMs) && sessionAgeMs > (14 * 60 * 1000);
                if (interactionTokenLikelyExpired) {
                    storage.updateSession(session.sessionId, { interactionToken: '' });
                } else {
                    try {
                        const webhook = new WebhookClient({ id: botState.client.application.id, token: session.interactionToken });
                        await webhook.editMessage('@original', {
                            embeds: [readyEmbed],
                            components: [buttonRow]
                        });

                        // Token is one-shot for this UX flow; clear it after successful use.
                        storage.updateSession(session.sessionId, { interactionToken: '' });

                    } catch (error) {
                        if (isInvalidWebhookTokenError(error)) {
                            // Token expired/invalid: clear it so reconnects don't keep retrying/log-spamming.
                            storage.updateSession(session.sessionId, { interactionToken: '' });
                            console.warn(`[handleSessionReady] Ephemeral token expired for session ${session.sessionId}; skipping ephemeral update.`);
                        } else {
                            console.error('Failed to update ephemeral message:', error);
                        }
                    }
                }
            }
        }
        await upsertSessionSettingsSummary(sessionId);
    } catch (error) {
        console.error(`[handleSessionReady] Failed to notify thread:`, error);
    } finally {
        if (categoryManager) {
            void categoryManager.updateRunnerStats(runnerId).catch((statsError) => {
                console.error('[handleSessionReady] Failed to update runner stats:', statsError);
            });
        }
    }
}


/**
 * Handle runner status update
 */
async function handleRunnerStatusUpdate(data: any): Promise<void> {
    const { runnerId, sessionId, status, currentTool, isCommandRunning } = data;

    const previousStatus = botState.sessionStatuses.get(sessionId);
    botState.sessionStatuses.set(sessionId, status);
    if (previousStatus !== status) {
        await getCategoryManager()?.updateRunnerStats(runnerId);
    }

    const session = storage.getSession(sessionId);
    if (!session) return;

    // Detect command completion (working -> idle)
    if (previousStatus === 'working' && status === 'idle' && config.notifications.pingOnCompletion) {
        try {
            const thread = await botState.client.channels.fetch(session.threadId);
            if (thread && 'send' in thread) {
                const userMention = session.creatorId ? `<@${session.creatorId}>` : '';
                const atHere = config.notifications.useAtHere ? '@here ' : '';

                // Only ping if the command wasn't just "status" or something trivial if we could detect that
                // For now, ping on any return to idle usually means command done

                await thread.send({
                    content: `${atHere}${userMention} Command finished.`
                });
            }
        } catch (error) {
            console.error('[Status] Failed to send completion ping:', error);
        }
    }

    // TODO: Add visual status updates to thread if needed



}

async function upsertSessionSettingsSummary(sessionId: string): Promise<void> {
    const session = storage.getSession(sessionId);
    if (!session) return;
    const runner = storage.getRunner(session.runnerId);
    const thread = await botState.client.channels.fetch(session.threadId).catch(() => null);
    if (!thread || !thread.isThread()) return;

    const options = session.options || {};
    const defaults = runner?.config?.claudeDefaults || {};
    const resolve = (key: string, fallback: any = 'Default') =>
        options[key] !== undefined ? options[key] : (defaults as any)[key] ?? fallback;

    const embed = new EmbedBuilder()
        .setColor(0x2f3136)
        .setTitle('⚙️ Session Settings')
        .addFields(
            { name: 'Model', value: String(resolve('model', 'Auto')), inline: true },
            { name: 'Fallback', value: String(resolve('fallbackModel', 'None')), inline: true },
            { name: 'Max Turns', value: String(resolve('maxTurns', 'Default')), inline: true },
            { name: 'Max Thinking', value: String(resolve('maxThinkingTokens', 'Default')), inline: true },
            { name: 'Max Budget', value: String(resolve('maxBudgetUsd', 'Default')), inline: true },
            { name: 'Permission Mode', value: String(resolve('permissionMode', 'default')), inline: true },
            { name: 'Include Partials', value: resolve('includePartialMessages') === false ? 'Disabled' : 'Enabled', inline: true }
        )
        .setFooter({ text: `Session ${session.sessionId.slice(0, 8)}` });

    if (session.settingsMessageId) {
        const existing = await thread.messages.fetch(session.settingsMessageId).catch(() => null);
        if (existing) {
            await existing.edit({ embeds: [embed] });
            return;
        }
    }

    const message = await thread.send({ embeds: [embed] });
    session.settingsMessageId = message.id;
    storage.updateSession(session.sessionId, session);
}


/**
 * Handle session result (summary)
 */
async function handleResult(data: any): Promise<void> {
    console.log(`[Result] Session: ${data.sessionId}, Subtype: ${data.subtype}`);
    
    const session = storage.getSession(data.sessionId);
    if (!session) return;
    
    // We try/catch fetching the thread in case it was deleted
    let thread: any;
    try {
        thread = await botState.client.channels.fetch(session.threadId);
    } catch (e) {
        console.log(`[Result] Could not fetch thread ${session.threadId}, maybe deleted?`);
        return;
    }

    if (!thread || !('send' in thread)) return;

    // Format tables in result summary
    const formattedResult = formatContentWithTables(data.result || 'No result summary provided.');

    const embed = new EmbedBuilder()
        .setTitle(data.subtype === 'error' ? 'Session Failed ❌' : 'Session Completed ✅')
        .setDescription(formattedResult)
        .addFields([
            { name: 'Duration', value: `${(data.durationMs / 1000).toFixed(1)}s`, inline: true },
            { name: 'API Duration', value: `${(data.durationApiMs / 1000).toFixed(1)}s`, inline: true },
            { name: 'Turns', value: `${data.numTurns}`, inline: true }
        ])
        .setColor(data.subtype === 'error' || data.isError ? 0xFF0000 : 0x00FF00)
        .setTimestamp(new Date(data.timestamp));

    if (data.error) {
        embed.addFields({ name: 'Error', value: data.error.slice(0, 1024), inline: false });
    }

    await thread.send({ embeds: [embed] });
}

/**
 * Handle terminal list response
 */
async function handleTerminalList(data: any): Promise<void> {
    const { runnerId, terminals } = data;


    // Find the pending request for this runner
    const pendingRequest = botState.pendingTerminalListRequests.get(runnerId);
    if (!pendingRequest) {
        console.log(`[handleTerminalList] No pending request for runner ${runnerId}`);
        return;
    }

    // Remove from pending
    botState.pendingTerminalListRequests.delete(runnerId);

    try {
        const webhook = new WebhookClient({
            id: pendingRequest.applicationId,
            token: pendingRequest.interactionToken
        });

        if (!terminals || terminals.length === 0) {
            await webhook.editMessage('@original', {
                content: `📺 **Terminal List for \`${pendingRequest.runnerName}\`**\n\nNo active terminals found.`
            });
        } else {
            const terminalList = terminals.map((t: string) => `• \`${t}\``).join('\n');
            await webhook.editMessage('@original', {
                content: `📺 **Terminal List for \`${pendingRequest.runnerName}\`**\n\n${terminalList}\n\n_Use \`/watch session:<name>\` to connect to a terminal._`
            });
        }


    } catch (error) {
        console.error(`[handleTerminalList] Failed to update response:`, error);
    }
}

/**
 * Handle discord actions triggered from CLI skills
 */
async function handleDiscordAction(data: any): Promise<void> {
    const { action, sessionId, content, name, description } = data;


    const session = storage.getSession(sessionId);
    if (!session) {
        console.error(`[DiscordAction] Session not found: ${sessionId}`);
        return;
    }

    const thread = await botState.client.channels.fetch(session.threadId);
    if (!thread || !('send' in thread)) {
        console.error(`[DiscordAction] Thread not found or invalid: ${session.threadId}`);
        return;
    }

    try {
        if (action === 'send_message') {
            const { embeds, files } = data;

            console.log(`[DiscordAction] send_message - content: ${content?.substring(0, 50)}, embeds: ${embeds?.length || 0}, files: ${files?.length || 0}`);

            // Process files if present
            const messageFiles: { attachment: Buffer; name: string }[] = [];
            if (files && Array.isArray(files)) {
                for (const f of files) {
                    console.log(`[DiscordAction] Processing file: ${f.name}, content length: ${f.content?.length || 0}`);
                    if (f.name && f.content) {
                        try {
                            const buffer = Buffer.from(f.content, 'base64');
                            messageFiles.push({
                                attachment: buffer,
                                name: f.name
                            });
                            console.log(`[DiscordAction] File buffer created: ${buffer.length} bytes`);
                        } catch (bufErr) {
                            console.error(`[DiscordAction] Failed to create buffer for file ${f.name}:`, bufErr);
                        }
                    }
                }
            }

            // Build message options
            const messageOptions: any = {};
            if (content) messageOptions.content = content;
            if (embeds && embeds.length > 0) messageOptions.embeds = embeds;
            if (messageFiles.length > 0) messageOptions.files = messageFiles;

            console.log(`[DiscordAction] Sending message with ${messageFiles.length} files, options:`, JSON.stringify({
                hasContent: !!content,
                hasEmbeds: !!(embeds?.length),
                fileCount: messageFiles.length,
                fileNames: messageFiles.map(f => f.name)
            }));

            await thread.send(messageOptions);
            console.log(`[DiscordAction] Message sent successfully`);
        } else if (action === 'update_channel') {
            console.log(`[DiscordAction] Updating channel ${session.threadId} with name: "${name}"`);

            // Update thread name
            if (name) {
                // Thread names must be 1-100 chars
                const safeName = name.substring(0, 100);
                if ('setName' in thread) {
                    try {
                        await (thread as any).setName(safeName);
                        console.log(`[DiscordAction] Channel renamed to: ${safeName}`);
                    } catch (err: any) {
                        console.error(`[DiscordAction] Failed to rename channel:`, err);
                        // If it's a rate limit error, notify user
                        if (err.code === 20016) { // Slowmode/Rate limit
                            await thread.send({
                                content: `⚠️ Could not rename channel: Rate limited. Please wait a few minutes.`
                            });
                        }
                    }
                } else {
                    console.warn(`[DiscordAction] Channel ${session.threadId} does not support setName`);
                }
            }
            // Update thread description (send as message)
            if (description) {
                await thread.send({
                    embeds: [{
                        title: 'Session Goal Update',
                        description: description,
                        color: 0x3498db
                    }]
                });
            }
        }
    } catch (error) {
        console.error(`[DiscordAction] Failed to execute action ${action}:`, error);
        await thread.send({
            content: `⚠️ Failed to execute skill action: ${error instanceof Error ? error.message : String(error)}`
        });
    }
}

/**
 * Handle assistant output from runner
 * Displays CLI output in the runner's main channel
 */
async function handleAssistantOutput(data: any): Promise<void> {
    const { runnerId, content, outputType, timestamp } = data;

    const runner = storage.getRunner(runnerId);
    if (!runner || !runner.privateChannelId) {
        console.error(`[AssistantOutput] Runner not found or no private channel: ${runnerId}`);
        return;
    }

    const channel = await botState.client.channels.fetch(runner.privateChannelId);
    if (!channel || !('send' in channel)) {
        console.error(`[AssistantOutput] Channel not found or invalid: ${runner.privateChannelId}`);
        return;
    }

    const now = Date.now();
    const STREAMING_TIMEOUT = 10000;

    const streaming = botState.assistantStreamingMessages.get(runnerId);
    
    // Clear streaming state if output type changes (e.g., stdout → thinking)
    if (streaming && streaming.outputType !== (outputType || 'stdout')) {
        console.log(`[AssistantOutput] Output type changed from ${streaming.outputType} to ${outputType}, clearing streaming state`);
        botState.assistantStreamingMessages.delete(runnerId);
    }
    
    // Re-fetch after potential deletion
    const currentStreaming = botState.assistantStreamingMessages.get(runnerId);
    const shouldStream = currentStreaming &&
        (now - currentStreaming.lastUpdateTime) < STREAMING_TIMEOUT &&
        currentStreaming.outputType === (outputType || 'stdout');

    // Content is already accumulated by the runner - use directly
    const embed = createOutputEmbed(outputType || 'stdout', content);

    if (shouldStream) {
        try {
            // Edit the existing streaming message
            const message = await (channel as any).messages.fetch(streaming.messageId);
            await message.edit({ embeds: [embed] });

            botState.assistantStreamingMessages.set(runnerId, {
                messageId: streaming.messageId,
                lastUpdateTime: now,
                content: content,
                outputType: outputType || 'stdout'
            });
        } catch (error) {
            // If editing fails, send a new message
            console.error('[AssistantOutput] Error editing message:', error);
            const newMessage = await channel.send({ embeds: [embed] });
            botState.assistantStreamingMessages.set(runnerId, {
                messageId: newMessage.id,
                lastUpdateTime: now,
                content: content,
                outputType: outputType || 'stdout'
            });
        }
    } else {
        // Send a new message
        const sentMessage = await channel.send({ embeds: [embed] });
        botState.assistantStreamingMessages.set(runnerId, {
            messageId: sentMessage.id,
            lastUpdateTime: now,
            content: content,
            outputType: outputType || 'stdout'
        });
    }
}

/**
 * Handle spawn thread request from assistant
 * Creates a new session and Discord thread
 */
async function handleSpawnThread(ws: any, data: any): Promise<void> {
    const { runnerId, folder, cliType, initialMessage } = data;

    console.log(`[SpawnThread] Received request from runner ${runnerId}`);
    console.log(`[SpawnThread] Folder: ${folder}, CLI: ${cliType}`);

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        console.error(`[SpawnThread] Unknown runner: ${runnerId}`);
        return;
    }

    if (!runner.privateChannelId) {
        console.error(`[SpawnThread] Runner has no private channel: ${runnerId}`);
        return;
    }

    // Determine CLI type
    let resolvedCliType: 'claude' | 'gemini' | 'codex' =
        cliType === 'auto' || !cliType
            ? runner.cliTypes[0]
            : cliType;

    if (!runner.cliTypes.includes(resolvedCliType)) {
        console.error(`[SpawnThread] CLI type '${resolvedCliType}' not available on runner`);
        resolvedCliType = runner.cliTypes[0];
    }

    try {
        // Get the private channel
        const channel = await botState.client.channels.fetch(runner.privateChannelId);
        if (!channel || !('threads' in channel)) {
            console.error(`[SpawnThread] Invalid channel: ${runner.privateChannelId}`);
            return;
        }

        // Generate session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

        // Create Discord thread
        const folderName = folder.split('/').pop() || 'project';
        const threadName = `${resolvedCliType}-${folderName}`.substring(0, 100);

        const thread = await (channel as any).threads.create({
            name: threadName,
            autoArchiveDuration: 1440, // 24 hours
            reason: 'Spawned by assistant'
        });

        console.log(`[SpawnThread] Created thread ${thread.id}: ${threadName}`);

        const startOptions = buildSessionStartOptions(runner, undefined, undefined, resolvedCliType);

        // Create session record
        const session: Session = {
            sessionId,
            runnerId: runner.runnerId,
            channelId: runner.privateChannelId,
            threadId: thread.id,
            createdAt: new Date().toISOString(),
            status: 'active',
            cliType: resolvedCliType,
            plugin: 'tmux',  // Assistant mode always uses tmux plugin
            folderPath: folder,
            creatorId: runner.ownerId,
            options: startOptions
        };

        storage.createSession(session);

        // Send session_start to runner
        ws.send(JSON.stringify({
            type: 'session_start',
            data: {
                sessionId,
                runnerId: runner.runnerId,
                cliType: resolvedCliType,
                plugin: 'tmux',
                folderPath: folder,
                create: true,
                options: startOptions
            }
        }));

        // Send initial message if provided
        if (initialMessage) {
            // Wait a bit for the session to start
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'user_message',
                    data: {
                        sessionId,
                        userId: 'assistant',
                        username: 'Assistant',
                        content: initialMessage,
                        timestamp: new Date().toISOString()
                    }
                }));
            }, 2000);
        }

        // Notify in the thread
        await thread.send({
            embeds: [{
                color: 0x00FF00,
                title: '🧵 Thread Spawned by Assistant',
                description: `The main assistant spawned this dedicated thread for:\n\`${folder}\``,
                fields: [
                    { name: 'CLI', value: resolvedCliType, inline: true },
                    { name: 'Session ID', value: sessionId.slice(0, 8), inline: true }
                ],
                timestamp: new Date().toISOString()
            }]
        });

        console.log(`[SpawnThread] Session ${sessionId} created successfully`);

    } catch (error) {
        console.error('[SpawnThread] Error creating thread:', error);
    }
}

// Track pending tool executions (toolId -> execution data)
const pendingToolExecutions = new Map<string, {
    sessionId: string;
    toolName: string;
    input: any;
    timestamp: string;
}>();

/**
 * Handle tool execution events (for auto-approved tools that bypass permission UI)
 * Just tracks the execution - waits for result to show in Discord
 */
async function handleToolExecution(data: any): Promise<void> {
    const { sessionId, toolName, toolId, input, timestamp } = data;
    
    // Store for when result arrives
    pendingToolExecutions.set(toolId, {
        sessionId,
        toolName,
        input,
        timestamp
    });
    
    // Auto-expire after 60 seconds
    setTimeout(() => pendingToolExecutions.delete(toolId), 60000);
}

/**
 * Format tool input for Discord embed display
 * Parses JSON input and shows each key as a field with value as code block
 */
function formatToolInputForEmbed(input: any, maxValueLength: number = 200): { name: string; value: string; inline: boolean }[] {
    const fields: { name: string; value: string; inline: boolean }[] = [];

    if (!input) return fields;

    // Try to parse as object
    let parsedInput: Record<string, any> | null = null;
    if (typeof input === 'string') {
        try {
            parsedInput = JSON.parse(input);
        } catch {
            // Not valid JSON, treat as single string
        }
    } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
        parsedInput = input;
    }

    // If we have a parsed object, show each key as a field
    if (parsedInput && Object.keys(parsedInput).length > 0) {
        for (const [key, value] of Object.entries(parsedInput)) {
            let valueStr: string;
            if (typeof value === 'string') {
                valueStr = value;
            } else if (value === null || value === undefined) {
                valueStr = '(empty)';
            } else {
                valueStr = JSON.stringify(value);
            }

            // Truncate value if needed
            const truncated = valueStr.length > maxValueLength
                ? valueStr.slice(0, maxValueLength) + '...'
                : valueStr;

            // Escape backticks to prevent code block issues
            const escaped = truncated.replace(/`/g, "'");

            fields.push({
                name: key,
                value: `\`${escaped}\``,
                inline: false
            });

            // Limit to 5 fields to avoid embed limits
            if (fields.length >= 5) break;
        }
        return fields;
    }

    // Fallback: show as single code block (original behavior)
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    const inputDisplay = inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr;
    fields.push({
        name: 'Input',
        value: `\`\`\`json\n${inputDisplay}\n\`\`\``,
        inline: false
    });

    return fields;
}

/**
 * Handle tool result events - show success (green) or failure (red)
 */
async function handleToolResult(data: any): Promise<void> {
    const { sessionId, toolUseId, content, isError, timestamp } = data;

    // Get the original execution info
    const execution = pendingToolExecutions.get(toolUseId);
    pendingToolExecutions.delete(toolUseId);

    const toolName = execution?.toolName || 'Tool';
    const input = execution?.input;

    const session = storage.getSession(sessionId);
    if (!session) {
        console.log(`[ToolResult] No session found for ${sessionId}, skipping display`);
        return;
    }

    try {
        const thread = await botState.client.channels.fetch(session.threadId);
        if (!thread || !('send' in thread)) {
            return;
        }

        // Choose color and emoji based on success/failure
        const color = isError ? 0xFF0000 : 0x00FF00;  // Red for error, Green for success
        const statusEmoji = isError ? '🔴' : '🟢';
        const statusText = isError ? 'Failed' : 'Success';

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${statusEmoji} ${toolName}`)
            .setDescription(`**${statusText}** - Auto-executed tool`)
            .setTimestamp(new Date(timestamp));

        // Show input with improved formatting
        if (input) {
            const inputFields = formatToolInputForEmbed(input);
            for (const field of inputFields) {
                embed.addFields(field);
            }
        }

        // Show output/error (truncated)
        if (content) {
            // Handle objects/arrays that would display as [object Object]
            let contentStr: string;
            if (typeof content === 'string') {
                contentStr = content;
            } else if (Array.isArray(content)) {
                // Extract text from content blocks or stringify
                contentStr = content.map((item: any) => {
                    if (typeof item === 'string') return item;
                    if (item?.text) return item.text;
                    return JSON.stringify(item);
                }).join('\n');
            } else {
                contentStr = JSON.stringify(content, null, 2);
            }
            const contentDisplay = contentStr.length > 300 ? contentStr.slice(0, 300) + '...' : contentStr;
            embed.addFields({
                name: isError ? 'Error' : 'Output',
                value: `\`\`\`\n${contentDisplay}\n\`\`\``,
                inline: false
            });
        }

        await thread.send({ embeds: [embed] });
    } catch (error) {
        console.error('[ToolResult] Error displaying tool result:', error);
    }
}

// Export action items for external access
export { botState };

/**
 * Handle sync projects response
 */
async function handleSyncProjectsResponse(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        await sessionSync.handleProjectSyncResponse(data.runnerId, data.projects);
    }
}

async function handleSyncProjectsProgress(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        sessionSync.handleSyncProjectsProgress(data);
    }
}

async function handleSyncProjectsComplete(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        sessionSync.handleSyncProjectsComplete(data);
    }
}

/**
 * Handle sync sessions response
 */
async function handleSyncSessionsResponse(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        await sessionSync.handleSyncSessionsResponse(
            data.runnerId,
            data.projectPath,
            data.sessions,
            data.syncFormatVersion
        );
    }
}

async function handleSyncSessionsComplete(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        sessionSync.handleSyncSessionsComplete(data);
    }
}

/**
 * Handle sync session discovered push
 */
async function handleSyncSessionDiscovered(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        await sessionSync.handleSessionDiscovered(data.runnerId, {
            ...data.session,
            syncFormatVersion: data.syncFormatVersion
        });
    }
}

/**
 * Handle sync session updated push
 */
async function handleSyncSessionUpdated(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        await sessionSync.handleSessionUpdated(data.runnerId, data);
    }
}

async function handleSyncStatusResponse(data: any): Promise<void> {
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        sessionSync.handleSyncStatusResponse(data);
    }
}

/**
 * Handle permission decision acknowledgment from runner
 */
async function handlePermissionDecisionAck(data: any): Promise<void> {
    const { requestId, success, error } = data;

    console.log(`[PermissionAck] Received acknowledgment for ${requestId}: ${success ? 'SUCCESS' : 'FAILED'}`);

    const pending = botState.pendingPermissionConfirmations.get(requestId);

    if (!pending) {
        console.log(`[PermissionAck] No pending confirmation for ${requestId} (may have timed out)`);
        return;
    }

    // Clear timeout
    clearTimeout(pending.timeout);
    botState.pendingPermissionConfirmations.delete(requestId);

    // Import helper functions
    const { createConfirmedSuccessEmbed } = await import('./permission-buttons.js');

    if (success) {
        // Update UI to show confirmed success
        const embed = createConfirmedSuccessEmbed(pending.toolName, pending.username || pending.userId || 'Unknown', pending.scope);

        const resultButton = new ButtonBuilder()
            .setCustomId(`result_${requestId}`)
            .setLabel(pending.behavior === 'deny' ? '❌ Denied' : `✅ ${pending.scope ? `Always (${pending.scope})` : 'Approved'}`)
            .setStyle(pending.behavior === 'deny' ? ButtonStyle.Danger : ButtonStyle.Success)
            .setDisabled(true);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);

        await safeEditReply(pending.interaction, {
            embeds: [embed],
            components: [row]
        }).catch((err: any) => console.error('[PermissionAck] Failed to show success:', err));

        // Mark as completed in permission state store
        permissionStateStore.complete(requestId);

        console.log(`[PermissionAck] Confirmed ${pending.behavior} for ${requestId}`);
    } else {
        // Update UI to show error
        const errorEmbed = createErrorEmbed(
            'Failed',
            `Runner rejected: ${error || 'Unknown error'}`
        );

        await safeEditReply(pending.interaction, {
            embeds: [errorEmbed],
            components: []
        }).catch((err: any) => console.error('[PermissionAck] Failed to show error:', err));

        console.log(`[PermissionAck] Failed for ${requestId}: ${error}`);
    }
}
