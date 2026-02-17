/**
 * Session Sync Service
 *
 * Syncs CLI sessions (Claude/Codex/Gemini) between local clients and Discord.
 * Delegation to runner agent: The runner agent handles direct file system access and watcher pushes.
 * The bot acts as a client, requesting sync data via WebSocket and receiving pushed events.
 *
 * Architecture:
 * - sync-types.ts: Shared type definitions
 * - sync-state.ts: State management (runner states, session tracking, deduplication)
 * - sync-queue.ts: Message queue and batching for thread sends
 * - message-normalizer.ts: Message transformation from various CLI formats
 * - session-sync.ts: Main orchestrator (this file) - public API and coordination
 */

import { Client, TextChannel, ThreadChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { EventEmitter } from 'events';
import { getCategoryManager, ProjectStats } from './category-manager.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import {
    createOutputEmbed,
    createToolUseEmbed,
} from '../utils/embeds.js';

// Re-export types from sync-types for backward compatibility
export type {
    SyncedCliType,
    SyncedSession,
    RunnerSyncState,
    ProjectSyncState,
    ProjectSyncStatus,
    RunnerSyncStatus,
    NormalizedMessage,
} from './sync-types.js';

import type {
    SyncedCliType,
    SyncedSession,
    RunnerSyncState,
    ProjectSyncState,
    ProjectSyncStatus,
    RunnerSyncStatus,
} from './sync-types.js';

// Import helper modules
import { SyncStateManager } from './sync-state.js';
import { SyncQueueManager } from './sync-queue.js';
import { MessageNormalizer } from './message-normalizer.js';

// ============================================================================
// Session Sync Service
// ============================================================================

export class SessionSyncService extends EventEmitter {
    private client: Client;

    // Helper modules
    private stateManager: SyncStateManager;
    private queueManager: SyncQueueManager;
    private messageNormalizer: MessageNormalizer;

    // Configuration
    private readonly maxSyncMessages = parseInt(process.env.DISCODE_SYNC_MAX_MESSAGES || '200');
    private readonly syncRetryDelayMs = parseInt(process.env.DISCODE_SYNC_RETRY_MS || '15000');
    private readonly maxSyncRetries = parseInt(process.env.DISCODE_SYNC_MAX_RETRIES || '2');

    constructor(client: Client) {
        super();
        this.client = client;

        // Initialize helper modules
        this.stateManager = new SyncStateManager({
            maxDedupEntries: 5000
        });
        this.queueManager = new SyncQueueManager({
            threadSendDelayMs: parseInt(process.env.DISCODE_THREAD_SEND_DELAY_MS || '350')
        });
        this.messageNormalizer = new MessageNormalizer();
    }

    // ============================================================================
    // State Accessors (delegate to state manager)
    // ============================================================================

    private normalizeProjectPath(projectPath: string): string {
        return this.stateManager.normalizeProjectPath(projectPath);
    }

    private toSessionKey(sessionId: string, cliType: SyncedCliType = 'claude'): string {
        return this.stateManager.toSessionKey(sessionId, cliType);
    }

    private resolveSyncedCliType(raw: any): SyncedCliType {
        return this.stateManager.resolveSyncedCliType(raw);
    }

    private resolvePersistedSessionRecord(
        sessionsRecord: Record<string, { threadId: string; projectPath: string; lastSync?: string; cliType?: 'claude' | 'codex' | 'gemini' }> | undefined,
        sessionId: string,
        cliType: SyncedCliType
    ): { key: string; data: { threadId: string; projectPath: string; lastSync?: string; cliType?: 'claude' | 'codex' | 'gemini' } } | null {
        return this.stateManager.resolvePersistedSessionRecord(sessionsRecord, sessionId, cliType);
    }

    private ensureRunnerSyncStatus(runnerId: string): RunnerSyncStatus {
        return this.stateManager.ensureRunnerSyncStatus(runnerId);
    }

    requestSyncStatus(runnerId: string, timeoutMs: number = 5000): Promise<RunnerSyncStatus | null> {
        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) {
            return Promise.resolve(null);
        }

        const requestId = `sync_status_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.stateManager.deletePendingSyncStatusRequest(requestId);
                resolve(null);
            }, timeoutMs);

            this.stateManager.setPendingSyncStatusRequest(requestId, { resolve, timeout });

            ws.send(JSON.stringify({
                type: 'sync_status_request',
                data: { runnerId, requestId }
            }));
        });
    }

    handleSyncStatusResponse(data: any): void {
        const status = this.ensureRunnerSyncStatus(data.runnerId);
        status.state = data.status.state;
        status.lastSyncAt = data.status.lastSyncAt ? new Date(data.status.lastSyncAt) : undefined;
        status.lastError = data.status.lastError;
        status.projects.clear();

        for (const [projectPath, proj] of Object.entries(data.status.projects || {}) as Array<[string, any]>) {
            status.projects.set(projectPath, {
                projectPath,
                state: proj.state,
                lastSyncAt: proj.lastSyncAt ? new Date(proj.lastSyncAt) : undefined,
                lastError: proj.lastError,
                sessionCount: proj.sessionCount
            });
        }

        const pending = this.stateManager.getPendingSyncStatusRequest(data.requestId);
        if (pending) {
            clearTimeout(pending.timeout);
            this.stateManager.deletePendingSyncStatusRequest(data.requestId);
            pending.resolve(status);
        }
    }

    handleSyncProjectsProgress(data: any): void {
        const status = this.ensureRunnerSyncStatus(data.runnerId);
        status.state = 'syncing';
        status.lastError = undefined;
    }

    handleSyncProjectsComplete(data: any): void {
        const status = this.ensureRunnerSyncStatus(data.runnerId);
        status.state = data.status === 'error' ? 'error' : 'idle';
        status.lastError = data.error;
        status.lastSyncAt = data.completedAt ? new Date(data.completedAt) : new Date();
        if (data.requestId) {
            const pending = this.stateManager.getPendingProjectSyncRequest(data.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.stateManager.deletePendingProjectSyncRequest(data.requestId);
            }
        }
    }

    handleSyncSessionsComplete(data: any): void {
        const status = this.ensureRunnerSyncStatus(data.runnerId);
        const normalizedProjectPath = this.normalizeProjectPath(data.projectPath);
        const projectStatus = status.projects.get(normalizedProjectPath) || {
            projectPath: normalizedProjectPath,
            state: 'idle'
        } as ProjectSyncStatus;

        projectStatus.state = data.status === 'error' ? 'error' : 'complete';
        projectStatus.lastError = data.error;
        projectStatus.lastSyncAt = data.completedAt ? new Date(data.completedAt) : new Date();
        projectStatus.sessionCount = data.sessionCount;

        status.projects.set(normalizedProjectPath, projectStatus);
        if (data.requestId) {
            const pending = this.stateManager.getPendingSessionSyncRequest(data.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.stateManager.deletePendingSessionSyncRequest(data.requestId);
            }
        }
    }

    /**
     * Restore state and initialize syncing for a runner
     */
    async startSyncingRunner(runnerId: string): Promise<void> {
        if (this.stateManager.hasRunnerState(runnerId)) {
            console.log(`[SessionSync] Already syncing runner: ${runnerId}`);
            return;
        }

        const state = this.stateManager.createRunnerState(runnerId);
        console.log(`[SessionSync] Started syncing runner: ${runnerId}`);

        // Initialize state for known projects from storage
        const categoryManager = getCategoryManager();
        if (categoryManager) {
            const runner = storage.getRunner(runnerId);
            if (runner?.discordState?.projects) {
                for (const rawProjectPath of Object.keys(runner.discordState.projects)) {
                    const projectPath = this.normalizeProjectPath(rawProjectPath);
                    try {
                        const projectChannel = await categoryManager.createProjectChannel(runnerId, projectPath);
                        if (projectChannel) {
                            const persistedSessions = new Map<string, SyncedSession>();

                            if (runner?.discordState?.sessions) {
                                for (const [storedKey, data] of Object.entries(runner.discordState.sessions)) {
                                    const normalizedStoredPath = this.normalizeProjectPath(data.projectPath);
                                    if (normalizedStoredPath === projectPath) {
                                        const cliType: SyncedCliType = data.cliType === 'codex'
                                            ? 'codex'
                                            : data.cliType === 'gemini'
                                            ? 'gemini'
                                            : 'claude';
                                        const sessionId = storedKey.includes(':')
                                            ? storedKey.split(':').slice(1).join(':')
                                            : storedKey;
                                        const mapKey = this.toSessionKey(sessionId, cliType);

                                        persistedSessions.set(mapKey, {
                                            sessionId: `sync_${cliType}_${sessionId}`,
                                            externalSessionId: sessionId,
                                            cliType,
                                            projectPath,
                                            threadId: data.threadId,
                                            firstPrompt: 'Restored Session',
                                            status: 'idle',
                                            lastSyncedAt: data.lastSync ? new Date(data.lastSync) : new Date(0),
                                            messageCount: 0
                                        });
                                    }
                                }
                            }

                            state.projects.set(projectPath, {
                                projectPath: projectPath,
                                channelId: projectChannel.channelId,
                                sessions: persistedSessions,
                                lastSync: new Date()
                            });
                        }
                    } catch (error) {
                        console.error(`[SessionSync] Failed to restore project ${projectPath}:`, error);
                    }
                }
            }
        }
    }

    private async ensureProjectState(runnerId: string, projectPath: string): Promise<ProjectSyncState | null> {
        const normalizedProjectPath = this.normalizeProjectPath(projectPath);
        let state = this.stateManager.getRunnerState(runnerId);
        if (!state) {
            await this.startSyncingRunner(runnerId);
            state = this.stateManager.getRunnerState(runnerId);
        }

        if (!state) return null;

        const existing = state.projects.get(normalizedProjectPath);
        if (existing && existing.channelId) {
            return existing;
        }

        const categoryManager = getCategoryManager();
        if (!categoryManager) return null;

        const channelId = await categoryManager.ensureProjectChannel(runnerId, normalizedProjectPath);
        if (!channelId) return null;

        const projectState: ProjectSyncState = {
            projectPath: normalizedProjectPath,
            channelId,
            sessions: existing?.sessions || new Map(),
            lastSync: new Date()
        };

        state.projects.set(normalizedProjectPath, projectState);
        return projectState;
    }

    async ensureProjectStateForRunner(runnerId: string, projectPath: string): Promise<ProjectSyncState | null> {
        return this.ensureProjectState(runnerId, projectPath);
    }

    /**
     * Stop syncing for a runner
     */
    stopSyncingRunner(runnerId: string): void {
        if (this.stateManager.hasRunnerState(runnerId)) {
            this.stateManager.deleteRunnerState(runnerId);
            console.log(`[SessionSync] Stopped syncing runner: ${runnerId}`);
        }
    }

    /**
     * Request a project sync from the runner (via WebSocket)
     */
    async syncProjects(runnerId: string): Promise<string | null> {
        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) {
            console.error(`[SessionSync] Runner offline: ${runnerId}`);
            return null;
        }

        console.log(`[SessionSync] Requesting project sync from runner ${runnerId}`);
        const requestId = `sync_projects_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ws.send(JSON.stringify({
            type: 'sync_projects',
            data: { runnerId, requestId }
        }));
        const timeout = setTimeout(() => this.retrySyncProjects(requestId), this.syncRetryDelayMs);
        this.stateManager.setPendingProjectSyncRequest(requestId, { runnerId, attempts: 1, timeout });
        return requestId;
    }

    /**
     * Handle project sync response from runner
     */
    async handleProjectSyncResponse(runnerId: string, projects: { path: string; lastModified: string; sessionCount: number }[]): Promise<void> {
        console.log(`[SessionSync] Received ${projects.length} projects from runner ${runnerId}`);
        for (const [requestId, pending] of this.stateManager.findPendingProjectSyncRequestsByRunner(runnerId)) {
            clearTimeout(pending.timeout);
            this.stateManager.deletePendingProjectSyncRequest(requestId);
        }

        if (!this.stateManager.hasRunnerState(runnerId)) {
            await this.startSyncingRunner(runnerId);
        }
        for (const project of projects) {
            const normalizedProjectPath = this.normalizeProjectPath(project.path);
            await this.ensureProjectState(runnerId, normalizedProjectPath);

            // Sync existing sessions (remote request)
            await this.syncProjectSessions(runnerId, normalizedProjectPath);
        }
    }

    /**
     * Request sessions for a specific project from the runner
     */
    async syncProjectSessions(runnerId: string, projectPath: string): Promise<string | null> {
        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) return null;
        const normalizedProjectPath = this.normalizeProjectPath(projectPath);

        console.log(`[SessionSync] Requesting sessions for ${normalizedProjectPath} from runner ${runnerId}`);
        const requestId = `sync_sessions_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ws.send(JSON.stringify({
            type: 'sync_sessions',
            data: { runnerId, projectPath: normalizedProjectPath, requestId }
        }));
        const timeout = setTimeout(() => this.retrySyncSessions(requestId), this.syncRetryDelayMs);
        this.stateManager.setPendingSessionSyncRequest(requestId, { runnerId, projectPath: normalizedProjectPath, attempts: 1, timeout });
        return requestId;
    }

    /**
     * Handle sessions sync response from runner
     */
    async handleSyncSessionsResponse(
        runnerId: string,
        projectPath: string,
        sessions: any[],
        syncFormatVersion?: number
    ): Promise<void> {
        const normalizedProjectPath = this.normalizeProjectPath(projectPath);
        console.log(`[SessionSync] Received ${sessions.length} sessions for ${normalizedProjectPath}`);
        for (const [requestId, pending] of this.stateManager.findPendingSessionSyncRequestsByProject(runnerId, normalizedProjectPath)) {
            clearTimeout(pending.timeout);
            this.stateManager.deletePendingSessionSyncRequest(requestId);
        }

        const projectState = await this.ensureProjectState(runnerId, normalizedProjectPath);
        if (!projectState) return;

        for (let index = 0; index < sessions.length; index++) {
            const session = sessions[index];
            const cliType = this.resolveSyncedCliType(session);
            const sessionKey = this.toSessionKey(session.sessionId, cliType);
            if (this.stateManager.isSessionOwned(session.sessionId, cliType)) continue;
            const localSession = storage.getSession(session.sessionId);
            if (localSession && localSession.runnerId === runnerId && localSession.status === 'active') {
                this.stateManager.markSessionAsOwned(session.sessionId, cliType);
                console.log(`[SessionSync] Skipping synced session ${sessionKey}; already active in Discord storage.`);
                continue;
            }
            await this.syncSessionToDiscord(
                runnerId,
                normalizedProjectPath,
                { ...session, projectPath: normalizedProjectPath, cliType, syncFormatVersion },
                session.messages
            );

            if (index % 3 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        }

        projectState.lastSync = new Date();
    }

    /**
     * Sync a single session to Discord (creates thread if needed)
     */
    async syncSessionToDiscord(
        runnerId: string,
        projectPath: string,
        session: any,
        messages?: any[]
    ): Promise<void> {
        const normalizedProjectPath = this.normalizeProjectPath(projectPath);
        const cliType = this.resolveSyncedCliType(session);
        const sessionKey = this.toSessionKey(session.sessionId, cliType);
        const state = this.stateManager.getRunnerState(runnerId);
        if (!state) return;

        const projectState = state.projects.get(normalizedProjectPath);
        if (!projectState) return;

        const existingSync = projectState.sessions.get(sessionKey);

        if (!existingSync) {
            await this.createSessionThread(
                runnerId,
                normalizedProjectPath,
                { ...session, projectPath: normalizedProjectPath, cliType },
                messages
            );
        }
    }

    /**
     * Create a Discord thread for a new session
     */
    async createSessionThread(
        runnerId: string,
        projectPath: string,
        session: any,
        messages?: any[]
    ): Promise<void> {
        const normalizedProjectPath = this.normalizeProjectPath(projectPath);
        const cliType = this.resolveSyncedCliType(session);
        const sessionKey = this.toSessionKey(session.sessionId, cliType);

        // Check lock
        if (this.stateManager.hasSessionCreationLock(sessionKey)) {
            console.log(`[SessionSync] createSessionThread: waiting for lock on ${sessionKey}`);
            await this.stateManager.getSessionCreationLock(sessionKey);

            // Lock released - check if we need to sync messages
            if (messages && messages.length > 0) {
                 console.log(`[SessionSync] createSessionThread: Lock released. Attempting to sync ${messages.length} messages to existing session.`);

                 const state = this.stateManager.getRunnerState(runnerId);
                 const projectState = state?.projects.get(normalizedProjectPath);
                 const existingSync = projectState?.sessions.get(sessionKey);

                 if (existingSync) {
                      const currentCount = existingSync.messageCount || 0;
                      if (messages.length > currentCount) {
                          const trulyNew = this.stateManager.filterNewMessages(sessionKey, messages.slice(currentCount));
                          console.log(`[SessionSync] Handing off ${trulyNew.length} messages to syncNewMessages`);
                          await this.syncNewMessages(runnerId, normalizedProjectPath, { ...session, cliType }, existingSync, trulyNew);
                      }
                 } else {
                     console.log(`[SessionSync] Warning: Lock released but no existingSync found for ${sessionKey}`);
                 }
            }
            return;
        }

        const task = (async () => {
            const state = this.stateManager.getRunnerState(runnerId);
            if (!state) {
                console.error(`[SessionSync] No runner state for ${runnerId}`);
                return;
            }

            const projectState = state.projects.get(normalizedProjectPath);
            if (!projectState || !projectState.channelId) {
                console.error(`[SessionSync] No project state/channelId for ${normalizedProjectPath}`);
                return;
            }

            let channel: TextChannel | null = null;
            try {
                channel = await this.client.channels.fetch(projectState.channelId) as TextChannel;
                if (!channel) throw new Error('Channel is null');
            } catch (error: any) {
                console.error(`[SessionSync] Error fetching channel ${projectState.channelId}:`, error);

                // Attempt recovery for missing channel
                if (error.code === 10003 || error.status === 404 || error.message === 'Unknown Channel' || error.message === 'Channel is null') {
                     console.log(`[SessionSync] Channel ${projectState.channelId} missing/invalid. Attempting recreation...`);

                     const cm = getCategoryManager();
                     if (cm) {
                        const newChannelId = await cm.ensureProjectChannel(runnerId, normalizedProjectPath);
                        if (newChannelId) {
                            try {
                                 console.log(`[SessionSync] Recreated channel: ${newChannelId}`);
                                 projectState.channelId = newChannelId; // Update local state
                                 channel = await this.client.channels.fetch(newChannelId) as TextChannel;
                            } catch (retryErr) {
                                 console.error(`[SessionSync] Failed to fetch recreated channel:`, retryErr);
                            }
                        } else {
                            console.error(`[SessionSync] Failed to recreate project channel for ${normalizedProjectPath}`);
                        }
                     }
                }
            }

            if (!channel) {
                console.error(`[SessionSync] Aborting thread creation: Channel not available for ${normalizedProjectPath}`);
                return;
            }

            const runner = storage.getRunner(runnerId);
            let thread: ThreadChannel | null = null;
            const persistedSession = this.resolvePersistedSessionRecord(runner?.discordState?.sessions as any, session.sessionId, cliType);
            let threadId = persistedSession?.data?.threadId;

            if (threadId) {
                try {
                    thread = await channel.threads.fetch(threadId) as ThreadChannel;
                    if (thread) {
                        console.log(`[SessionSync] Found existing thread ${threadId} for session ${sessionKey}`);
                        if (thread.archived) {
                            await thread.setArchived(false, 'Session re-synced from VS Code');
                        }
                    }
                } catch (e) {
                    console.log(`[SessionSync] Could not fetch existing thread ${threadId}, creating new one. Error: ${e}`);
                }
            }

            if (!thread) {
                const threadName = this.stateManager.generateThreadName(session.firstPrompt);
                let archiveDuration = 1440;

                if (runner?.config?.threadArchiveDays) {
                    const days = runner.config.threadArchiveDays;
                    if (days >= 7) archiveDuration = 10080;
                    else if (days >= 3) archiveDuration = 4320;
                    else archiveDuration = 1440;
                }

                try {
                    console.log(`[SessionSync] Creating new thread '${threadName}' in channel ${channel.id}`);
                    thread = await channel.threads.create({
                        name: threadName,
                        autoArchiveDuration: archiveDuration as any,
                        reason: `${cliType.toUpperCase()} session: ${session.sessionId}`
                    });
                } catch (e) {
                     console.error('[SessionSync] Failed to create thread:', e);
                     return;
                }

                if (thread) {
                    const embed = new EmbedBuilder()
                        .setTitle('Session Synced from VS Code')
                        .setDescription(`This ${cliType.toUpperCase()} session was synced to Discord.`)
                        .addFields(
                            { name: 'Session ID', value: `\`${session.sessionId.slice(0, 8)}\``, inline: true },
                            { name: 'CLI', value: cliType.toUpperCase(), inline: true },
                            { name: 'Branch', value: session.gitBranch || 'N/A', inline: true },
                            { name: 'Messages', value: `${session.messageCount}`, inline: true }
                        )
                        .setColor(0x5865F2)
                        .setTimestamp(new Date(session.created));

                    try {
                        await thread.send({ embeds: [embed] });
                    } catch (e) {
                        console.error(`[SessionSync] Failed to send initial embed to thread ${thread.id}:`, e);
                    }

                    // Update storage immediately
                    const currentRunner = storage.getRunner(runnerId);
                    if (currentRunner) {
                        const currentDiscordState = currentRunner.discordState || {};
                        const currentSessions = currentDiscordState.sessions || {};
                        storage.updateRunner(runnerId, {
                            discordState: {
                                ...currentDiscordState,
                                sessions: {
                                    ...currentSessions,
                                    [sessionKey]: {
                                        threadId: thread.id,
                                        projectPath: normalizedProjectPath,
                                        lastSync: new Date(session.created).toISOString(),
                                        cliType
                                    }
                                }
                            }
                        });
                    }
                }
            } // End if (!thread)

            if (thread) {
                if (messages && messages.length > 0) {
                    const uniqueMessages = this.stateManager.filterNewMessages(sessionKey, messages);
                    console.log(`[SessionSync] createSessionThread: Posting ${uniqueMessages.length} initial messages to thread ${thread.id}`);
                    await this.postSessionMessages(runnerId, thread, uniqueMessages, session.syncFormatVersion);
                } else {
                    console.log(`[SessionSync] createSessionThread: No messages to post (messages arg is ${messages ? 'empty' : 'null'})`);
                    if (cliType === 'codex' || cliType === 'gemini') {
                        const ws = botState.runnerConnections.get(runnerId);
                        if (ws) {
                            ws.send(JSON.stringify({
                                type: 'sync_session_messages',
                                data: {
                                    runnerId,
                                    sessionId: session.sessionId,
                                    projectPath: normalizedProjectPath,
                                    cliType,
                                    requestId: `sync_session_${session.sessionId}_${Date.now()}`
                                }
                            }));
                            console.log(`[SessionSync] Requested ${cliType.toUpperCase()} message hydration for ${sessionKey}`);
                        }
                    }
                }

                const syncedSession: SyncedSession = {
                    sessionId: `sync_${cliType}_${session.sessionId}`,
                    externalSessionId: session.sessionId,
                    cliType,
                    syncFormatVersion: session.syncFormatVersion,
                    projectPath: normalizedProjectPath,
                    threadId: thread.id,
                    firstPrompt: session.firstPrompt,
                    status: 'idle',
                    lastSyncedAt: new Date(),
                    messageCount: session.messageCount ?? (messages ? messages.length : 0)
                };

                projectState.sessions.set(sessionKey, syncedSession);
                console.log(`[SessionSync] Synced thread ${thread.id} for session: ${sessionKey}`);
            } else {
                console.error(`[SessionSync] Thread creation failed or returned null for session ${sessionKey}`);
            }
        })(); // End task

        this.stateManager.setSessionCreationLock(sessionKey, task);

        try {
            await task;
        } catch (e) {
            console.error(`[SessionSync] Unhandled error in createSessionThread task for ${sessionKey}:`, e);
        } finally {
            this.stateManager.deleteSessionCreationLock(sessionKey);
        }
    }

    /**
     * Handle pushed session discovery from runner
     */
    async handleSessionDiscovered(runnerId: string, session: any): Promise<void> {
        const cliType = this.resolveSyncedCliType(session);
        const sessionKey = this.toSessionKey(session.sessionId, cliType);
        const projectPath = this.normalizeProjectPath(session.projectPath);
        console.log(`[SessionSync] Session discovered on runner ${runnerId}: ${sessionKey}`);
        const localSession = storage.getSession(session.sessionId);
        if (localSession && localSession.runnerId === runnerId && localSession.status === 'active') {
            this.stateManager.markSessionAsOwned(session.sessionId, cliType);
            console.log(`[SessionSync] Skipping discovered session ${sessionKey}; already active in Discord storage.`);
            return;
        }
        if (this.stateManager.isSessionOwned(session.sessionId, cliType)) return;
        await this.ensureProjectState(runnerId, projectPath);
        await this.syncSessionToDiscord(
            runnerId,
            projectPath,
            { ...session, cliType, projectPath, syncFormatVersion: session.syncFormatVersion },
            session.messages
        );
        this.emit('session_new', { runnerId, entry: session });
    }

    /**
     * Handle pushed session update from runner
     */
    async handleSessionUpdated(runnerId: string, data: { session: any, newMessages: any[]; syncFormatVersion?: number }): Promise<void> {
        const cliType = this.resolveSyncedCliType(data.session);
        const sessionKey = this.toSessionKey(data.session.sessionId, cliType);
        const projectPath = this.normalizeProjectPath(data.session.projectPath);
        console.log(`[SessionSync] Handle Session Update: ${sessionKey} | Msgs: ${data.newMessages?.length}`);

        if (this.stateManager.isSessionOwned(sessionKey.split(':')[1] || sessionKey, cliType)) {
            console.log(`[SessionSync] Skipping owned session ${sessionKey}`);
            return;
        }

        const state = this.stateManager.getRunnerState(runnerId);
        if (!state) {
            console.log(`[SessionSync] No runner state for ${runnerId}`);
            return;
        }

        const runner = storage.getRunner(runnerId);
        if (!runner?.config?.autoSync) {
            console.log(`[SessionSync] AutoSync disabled for ${runnerId}`);
            return;
        }

        const projectState = await this.ensureProjectState(runnerId, projectPath);
        if (!projectState) {
            console.log(`[SessionSync] Project state not found for path: '${projectPath}'. Available logs: ${state.projects.size}`);
            return;
        }

        // Check for creation lock
        if (this.stateManager.hasSessionCreationLock(sessionKey)) {
            console.log(`[SessionSync] Waiting for creation lock on ${sessionKey}`);
            await this.stateManager.getSessionCreationLock(sessionKey);
        }

        const existingSync = projectState.sessions.get(sessionKey);
        if (existingSync) {
            const allMessages = data.newMessages;
            const currentCount = existingSync.messageCount;

            console.log(`[SessionSync] Existing Sync found. Current: ${currentCount}, New Total: ${allMessages.length}`);

            if (allMessages.length > currentCount) {
                const trulyNewMessages = this.stateManager.filterNewMessages(sessionKey, allMessages.slice(currentCount));
                console.log(`[SessionSync] Syncing ${trulyNewMessages.length} truly new messages`);
                await this.syncNewMessages(
                    runnerId,
                    projectPath,
                    { ...data.session, cliType, projectPath, syncFormatVersion: data.syncFormatVersion },
                    existingSync,
                    trulyNewMessages
                );
            }
        } else {
            // New session discovered via update
            console.log(`[SessionSync] No existing sync for ${sessionKey}. Creating new thread with ${data.newMessages?.length} messages.`);
            await this.createSessionThread(
                runnerId,
                projectPath,
                { ...data.session, cliType, projectPath, syncFormatVersion: data.syncFormatVersion },
                data.newMessages
            );
        }

        this.emit('session_updated', { runnerId, entry: data.session });
    }

    /**
     * Sync new messages to a thread
     */
    async syncNewMessages(
        runnerId: string,
        projectPath: string,
        session: any,
        existingSync: SyncedSession,
        newMessages: any[]
    ): Promise<void> {
        if (!existingSync.threadId) {
             console.log(`[SessionSync] No threadId for session ${existingSync.cliType}:${session.sessionId}, skipping syncNewMessages`);
             return;
        }

        try {
            const sessionKey = this.toSessionKey(session.sessionId, existingSync.cliType);
            const uniqueMessages = this.stateManager.filterNewMessages(sessionKey, newMessages);
            if (uniqueMessages.length === 0) return;

            const thread = await this.client.channels.fetch(existingSync.threadId) as ThreadChannel;
            if (!thread) {
                 console.log(`[SessionSync] Thread ${existingSync.threadId} not found`);
                 return;
            }

            if (uniqueMessages.length > 0) {
                console.log(`[SessionSync] Posting ${uniqueMessages.length} messages to thread ${thread.id}`);
                await this.postSessionMessages(
                    runnerId,
                    thread,
                    uniqueMessages,
                    session.syncFormatVersion ?? existingSync.syncFormatVersion
                );

                existingSync.lastSyncedAt = new Date();
                existingSync.messageCount = session.messageCount;

                const currentRunner = storage.getRunner(runnerId);
                if (currentRunner) {
                    const currentDiscordState = currentRunner.discordState || {};
                    const currentSessions = currentDiscordState.sessions || {};
                    storage.updateRunner(runnerId, {
                        discordState: {
                            ...currentDiscordState,
                            sessions: {
                                ...currentSessions,
                                [sessionKey]: {
                                    threadId: existingSync.threadId!,
                                    projectPath,
                                    lastSync: existingSync.lastSyncedAt.toISOString(),
                                    cliType: existingSync.cliType
                                }
                            }
                        }
                    });
                }
            }
        } catch (error) {
            console.error('[SessionSync] Error syncing new messages:', error);
        }
    }

    private retrySyncProjects(requestId: string): void {
        const pending = this.stateManager.getPendingProjectSyncRequest(requestId);
        if (!pending) return;
        if (pending.attempts >= this.maxSyncRetries) {
            this.stateManager.deletePendingProjectSyncRequest(requestId);
            console.warn(`[SessionSync] sync_projects timed out after ${pending.attempts} attempts`);
            return;
        }
        const ws = botState.runnerConnections.get(pending.runnerId);
        if (!ws) {
            this.stateManager.deletePendingProjectSyncRequest(requestId);
            return;
        }
        pending.attempts += 1;
        ws.send(JSON.stringify({
            type: 'sync_projects',
            data: { runnerId: pending.runnerId, requestId }
        }));
        pending.timeout = setTimeout(() => this.retrySyncProjects(requestId), this.syncRetryDelayMs);
    }

    private retrySyncSessions(requestId: string): void {
        const pending = this.stateManager.getPendingSessionSyncRequest(requestId);
        if (!pending) return;
        if (pending.attempts >= this.maxSyncRetries) {
            this.stateManager.deletePendingSessionSyncRequest(requestId);
            console.warn(`[SessionSync] sync_sessions timed out after ${pending.attempts} attempts`);
            return;
        }
        const ws = botState.runnerConnections.get(pending.runnerId);
        if (!ws) {
            this.stateManager.deletePendingSessionSyncRequest(requestId);
            return;
        }
        pending.attempts += 1;
        ws.send(JSON.stringify({
            type: 'sync_sessions',
            data: { runnerId: pending.runnerId, projectPath: pending.projectPath, requestId }
        }));
        pending.timeout = setTimeout(() => this.retrySyncSessions(requestId), this.syncRetryDelayMs);
    }

    private buildAttachToApproveComponents(): ActionRowBuilder<ButtonBuilder>[] {
        const button = new ButtonBuilder()
            .setCustomId('sync_attach_control')
            .setLabel('Attach To Approve')
            .setStyle(ButtonStyle.Primary);

        return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)];
    }

    private async sendAssistantTextEmbeds(thread: ThreadChannel, text: string): Promise<void> {
        const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
        for (const chunk of chunks) {
            await this.queueManager.sendThreadMessage(thread, { embeds: [createOutputEmbed('stdout', chunk)] });
        }
    }

    /**
     * Post messages to a thread with formatting and splitting
     */
    async postSessionMessages(
        runnerId: string,
        thread: ThreadChannel,
        messages: any[],
        syncFormatVersion?: number
    ): Promise<void> {
        const runner = storage.getRunner(runnerId);
        if (!runner) return;

        if (!messages || messages.length === 0) return;

        const normalizedMessages = this.messageNormalizer.normalizeMessages(messages);

        if (normalizedMessages.length === 0) {
            console.log(`[SessionSync] No displayable messages found. raw=${messages.length}`);
            return;
        }

        let effectiveMessages = normalizedMessages;
        if (this.maxSyncMessages > 0 && normalizedMessages.length > this.maxSyncMessages) {
            effectiveMessages = normalizedMessages.slice(-this.maxSyncMessages);
            await this.queueManager.sendThreadMessage(thread, {
                content: `Sync truncated: showing last ${this.maxSyncMessages} of ${normalizedMessages.length} displayable messages (raw records: ${messages.length}).`
            });
        }

        console.log(`[SessionSync] Posting ${effectiveMessages.length} messages...`);

        for (const msg of effectiveMessages) {
            const content = msg.content;
            const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
            const isAssistant = msg.role === 'assistant';

            if (typeof content === 'string') {
                if (content.trim()) {
                    if (isAssistant) {
                        await this.sendAssistantTextEmbeds(thread, content);
                    } else {
                        const chunks = content.match(/[\s\S]{1,1900}/g) || [content];
                        for (const chunk of chunks) {
                            await this.queueManager.sendThreadMessage(thread, { content: `**${roleLabel}:** ${chunk}` });
                        }
                    }
                }
                continue;
            }

            if (!Array.isArray(content)) {
                const contentText = typeof content === 'object'
                    ? JSON.stringify(content, null, 2)
                    : String(content);
                if (contentText.trim()) {
                    if (isAssistant) {
                        await this.sendAssistantTextEmbeds(thread, contentText);
                    } else {
                        const chunks = contentText.match(/[\s\S]{1,1900}/g) || [contentText];
                        for (const chunk of chunks) {
                            await this.queueManager.sendThreadMessage(thread, { content: `**${roleLabel}:**\n${chunk}` });
                        }
                    }
                }
                continue;
            }

            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text' || block?.type === 'inputText') {
                        const text = this.messageNormalizer.extractTextFromBlock(block);
                        if (text) {
                            if (isAssistant) {
                                await this.sendAssistantTextEmbeds(thread, text);
                            } else {
                                const chunks = text.match(/[\s\S]{1,1900}/g) || [text];
                                for (const chunk of chunks) {
                                    await this.queueManager.sendThreadMessage(thread, { content: `**${roleLabel}:**\n${chunk}` });
                                }
                            }
                        }
                    } else if (block?.type === 'thinking') {
                        // Thinking block support
                         if (block?.thinking?.trim()) {
                            const chunks = block.thinking.match(/[\s\S]{1,4000}/g) || [block.thinking];
                            for (const chunk of chunks) {
                                await this.queueManager.sendThreadMessage(thread, { embeds: [createOutputEmbed('thinking', chunk)] });
                            }
                        }
                    } else if (block?.type === 'plan') {
                        if (syncFormatVersion !== 2) continue;
                        const planText = typeof block?.text === 'string' ? block.text : '';
                        const explanation = typeof block?.explanation === 'string' ? `\n\n${block.explanation}` : '';
                        const contentText = `${planText}${explanation}`.trim();
                        if (contentText) {
                            const parts = contentText.match(/[\s\S]{1,4000}/g) || [contentText];
                            for (const part of parts) {
                                await this.queueManager.sendThreadMessage(thread, { embeds: [createOutputEmbed('info', `Plan Update\n\n${part}`)] });
                            }
                        }
                    } else if (block?.type === 'tool_use' || block?.type === 'toolUse') {
                        const embed = createToolUseEmbed(runner, block.name, block.input);
                        await this.queueManager.sendThreadMessage(thread, { embeds: [embed] });
                    } else if (block?.type === 'tool_result' || block?.type === 'toolResult') {
                        // Keep tool result as embed but ensure it's clean
                        const resultText = this.messageNormalizer.toolResultToText(block);
                        if (!resultText.trim()) continue;

                        const parts = resultText.match(/[\s\S]{1,4000}/g) || [resultText];
                        for (let i = 0; i < parts.length; i++) {
                            const embed = createOutputEmbed(
                                block.is_error ? 'error' : 'tool_result',
                                parts[i] + (i < parts.length - 1 ? '\n...(continued)' : '')
                            );
                            await this.queueManager.sendThreadMessage(thread, { embeds: [embed] });
                        }
                    } else if (block?.type === 'approval_needed') {
                        if (syncFormatVersion !== 2) continue;
                        const embed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle(block?.title || 'Approval needed')
                            .setDescription(block?.description || 'Attach this synced session to approve tool requests.')
                            .setTimestamp();

                        if (block?.toolName) {
                            embed.addFields({ name: 'Tool', value: `\`${block.toolName}\``, inline: true });
                        }
                        if (block?.status) {
                            embed.addFields({ name: 'Status', value: `\`${block.status}\``, inline: true });
                        }

                        await this.queueManager.sendThreadMessage(thread, {
                            embeds: [embed],
                            components: this.buildAttachToApproveComponents()
                        });
                    } else {
                        const text = this.messageNormalizer.extractTextFromBlock(block);
                        if (!text) continue;
                        if (isAssistant) {
                            await this.sendAssistantTextEmbeds(thread, text);
                        } else {
                            const chunks = text.match(/[\s\S]{1,1900}/g) || [text];
                            for (const chunk of chunks) {
                                await this.queueManager.sendThreadMessage(thread, { content: `**${roleLabel}:**\n${chunk}` });
                            }
                        }
                    }
                }
            }
        }
    }

    markSessionAsOwned(sessionId: string, cliType: SyncedCliType = 'claude'): void {
        this.stateManager.markSessionAsOwned(sessionId, cliType);
    }

    unmarkSessionOwnership(sessionId: string, cliType: SyncedCliType = 'claude'): void {
        this.stateManager.unmarkSessionOwnership(sessionId, cliType);
    }

    getProjectStats(runnerId: string, projectPath: string): ProjectStats {
        return this.stateManager.getProjectStats(runnerId, projectPath);
    }

    getSessionByThreadId(threadId: string): { runnerId: string; projectPath: string; session: SyncedSession } | null {
        return this.stateManager.getSessionByThreadId(threadId);
    }

    getSessionByExternalSessionId(
        runnerId: string,
        externalSessionId: string,
        cliType?: SyncedCliType
    ): { runnerId: string; projectPath: string; session: SyncedSession } | null {
        return this.stateManager.getSessionByExternalSessionId(runnerId, externalSessionId, cliType);
    }
}

// Singleton
let sessionSyncServiceInstance: SessionSyncService | null = null;

export function initSessionSyncService(client: Client): SessionSyncService {
    sessionSyncServiceInstance = new SessionSyncService(client);
    return sessionSyncServiceInstance;
}

export function getSessionSyncService(): SessionSyncService | null {
    return sessionSyncServiceInstance;
}
