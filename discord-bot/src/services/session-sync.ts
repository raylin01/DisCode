/**
 * Session Sync Service
 * 
 * Syncs Claude Code sessions between VS Code and Discord.
 * Delegation to runner agent: The runner agent handles direct file system access and watcher pushes.
 * The bot acts as a client, requesting sync data via WebSocket and receiving pushed events.
 */

import { Client, TextChannel, ThreadChannel, EmbedBuilder } from 'discord.js';
import { EventEmitter } from 'events';
import { getCategoryManager, ProjectStats } from './category-manager.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import {
    createOutputEmbed,
    createToolUseEmbed,
} from '../utils/embeds.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncedSession {
    sessionId: string;
    claudeSessionId: string;  // UUID from Claude Code
    projectPath: string;
    threadId?: string;
    firstPrompt: string;
    status: 'running' | 'input_needed' | 'idle' | 'error';
    pendingAction?: {
        type: 'permission' | 'question';
        description: string;
    };
    lastSyncedAt: Date;
    messageCount: number;
}

export interface RunnerSyncState {
    runnerId: string;
    projects: Map<string, ProjectSyncState>;  // projectPath -> state
}

export interface ProjectSyncState {
    projectPath: string;
    channelId: string;
    sessions: Map<string, SyncedSession>;  // claudeSessionId -> session
    lastSync: Date;
}

export interface ProjectSyncStatus {
    projectPath: string;
    state: 'idle' | 'syncing' | 'complete' | 'error';
    lastSyncAt?: Date;
    lastError?: string;
    sessionCount?: number;
}

export interface RunnerSyncStatus {
    runnerId: string;
    state: 'idle' | 'syncing' | 'error';
    lastSyncAt?: Date;
    lastError?: string;
    projects: Map<string, ProjectSyncStatus>;
}

// ============================================================================
// Session Sync Service
// ============================================================================

export class SessionSyncService extends EventEmitter {
    private client: Client;
    private runnerStates = new Map<string, RunnerSyncState>();
    private ownedSessions = new Set<string>(); // Sessions created/controlled by Discord
    private runnerSyncStatus = new Map<string, RunnerSyncStatus>();
    private pendingSyncStatusRequests = new Map<string, { resolve: (status: RunnerSyncStatus | null) => void; timeout: NodeJS.Timeout }>();
    private pendingProjectSyncRequests = new Map<string, { runnerId: string; attempts: number; timeout: NodeJS.Timeout }>();
    private pendingSessionSyncRequests = new Map<string, { runnerId: string; projectPath: string; attempts: number; timeout: NodeJS.Timeout }>();
    private messageDedup = new Map<string, Set<string>>();
    private readonly maxDedupEntries = 5000;
    private threadSendQueues = new Map<string, Promise<void>>();
    private readonly threadSendDelayMs = parseInt(process.env.DISCODE_THREAD_SEND_DELAY_MS || '350');
    private readonly maxSyncMessages = parseInt(process.env.DISCODE_SYNC_MAX_MESSAGES || '200');
    private readonly syncRetryDelayMs = parseInt(process.env.DISCODE_SYNC_RETRY_MS || '15000');
    private readonly maxSyncRetries = parseInt(process.env.DISCODE_SYNC_MAX_RETRIES || '2');

    constructor(client: Client) {
        super();
        this.client = client;
    }

    private ensureRunnerSyncStatus(runnerId: string): RunnerSyncStatus {
        const existing = this.runnerSyncStatus.get(runnerId);
        if (existing) return existing;

        const created: RunnerSyncStatus = {
            runnerId,
            state: 'idle',
            projects: new Map()
        };
        this.runnerSyncStatus.set(runnerId, created);
        return created;
    }

    requestSyncStatus(runnerId: string, timeoutMs: number = 5000): Promise<RunnerSyncStatus | null> {
        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) {
            return Promise.resolve(null);
        }

        const requestId = `sync_status_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.pendingSyncStatusRequests.delete(requestId);
                resolve(null);
            }, timeoutMs);

            this.pendingSyncStatusRequests.set(requestId, { resolve, timeout });

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

        for (const [projectPath, proj] of Object.entries(data.status.projects || {})) {
            status.projects.set(projectPath, {
                projectPath,
                state: proj.state,
                lastSyncAt: proj.lastSyncAt ? new Date(proj.lastSyncAt) : undefined,
                lastError: proj.lastError,
                sessionCount: proj.sessionCount
            });
        }

        const pending = this.pendingSyncStatusRequests.get(data.requestId);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingSyncStatusRequests.delete(data.requestId);
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
            const pending = this.pendingProjectSyncRequests.get(data.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingProjectSyncRequests.delete(data.requestId);
            }
        }
    }

    handleSyncSessionsComplete(data: any): void {
        const status = this.ensureRunnerSyncStatus(data.runnerId);
        const projectStatus = status.projects.get(data.projectPath) || {
            projectPath: data.projectPath,
            state: 'idle'
        } as ProjectSyncStatus;

        projectStatus.state = data.status === 'error' ? 'error' : 'complete';
        projectStatus.lastError = data.error;
        projectStatus.lastSyncAt = data.completedAt ? new Date(data.completedAt) : new Date();
        projectStatus.sessionCount = data.sessionCount;

        status.projects.set(data.projectPath, projectStatus);
        if (data.requestId) {
            const pending = this.pendingSessionSyncRequests.get(data.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingSessionSyncRequests.delete(data.requestId);
            }
        }
    }

    /**
     * Restore state and initialize syncing for a runner
     */
    async startSyncingRunner(runnerId: string): Promise<void> {
        if (this.runnerStates.has(runnerId)) {
            console.log(`[SessionSync] Already syncing runner: ${runnerId}`);
            return;
        }

        const state: RunnerSyncState = {
            runnerId,
            projects: new Map()
        };

        this.runnerStates.set(runnerId, state);
        console.log(`[SessionSync] Started syncing runner: ${runnerId}`);

        // Initialize state for known projects from storage
        const categoryManager = getCategoryManager();
        if (categoryManager) {
            const runner = storage.getRunner(runnerId);
            if (runner?.discordState?.projects) {
                for (const projectPath of Object.keys(runner.discordState.projects)) {
                    try {
                        const projectChannel = await categoryManager.createProjectChannel(runnerId, projectPath);
                        if (projectChannel) {
                            const persistedSessions = new Map<string, SyncedSession>();

                            if (runner?.discordState?.sessions) {
                                for (const [sessionId, data] of Object.entries(runner.discordState.sessions)) {
                                    if (data.projectPath === projectPath) {
                                        persistedSessions.set(sessionId, {
                                            sessionId: `sync_${sessionId}`,
                                            claudeSessionId: sessionId,
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
        let state = this.runnerStates.get(runnerId);
        if (!state) {
            await this.startSyncingRunner(runnerId);
            state = this.runnerStates.get(runnerId);
        }

        if (!state) return null;

        const existing = state.projects.get(projectPath);
        if (existing && existing.channelId) {
            return existing;
        }

        const categoryManager = getCategoryManager();
        if (!categoryManager) return null;

        const channelId = await categoryManager.ensureProjectChannel(runnerId, projectPath);
        if (!channelId) return null;

        const projectState: ProjectSyncState = {
            projectPath,
            channelId,
            sessions: existing?.sessions || new Map(),
            lastSync: new Date()
        };

        state.projects.set(projectPath, projectState);
        return projectState;
    }

    async ensureProjectStateForRunner(runnerId: string, projectPath: string): Promise<ProjectSyncState | null> {
        return this.ensureProjectState(runnerId, projectPath);
    }

    /**
     * Stop syncing for a runner
     */
    stopSyncingRunner(runnerId: string): void {
        const state = this.runnerStates.get(runnerId);
        if (state) {
            this.runnerStates.delete(runnerId);
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
        this.pendingProjectSyncRequests.set(requestId, { runnerId, attempts: 1, timeout });
        return requestId;
    }

    /**
     * Handle project sync response from runner
     */
    async handleProjectSyncResponse(runnerId: string, projects: { path: string; lastModified: string; sessionCount: number }[]): Promise<void> {
        console.log(`[SessionSync] Received ${projects.length} projects from runner ${runnerId}`);
        for (const [requestId, pending] of this.pendingProjectSyncRequests.entries()) {
            if (pending.runnerId === runnerId) {
                clearTimeout(pending.timeout);
                this.pendingProjectSyncRequests.delete(requestId);
            }
        }
        
        const state = this.runnerStates.get(runnerId);
        if (!state) {
            await this.startSyncingRunner(runnerId);
        }
        for (const project of projects) {
            await this.ensureProjectState(runnerId, project.path);

            // Sync existing sessions (remote request)
            await this.syncProjectSessions(runnerId, project.path);
        }
    }

    /**
     * Request sessions for a specific project from the runner
     */
    async syncProjectSessions(runnerId: string, projectPath: string): Promise<string | null> {
        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) return null;

        console.log(`[SessionSync] Requesting sessions for ${projectPath} from runner ${runnerId}`);
        const requestId = `sync_sessions_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ws.send(JSON.stringify({
            type: 'sync_sessions',
            data: { runnerId, projectPath, requestId }
        }));
        const timeout = setTimeout(() => this.retrySyncSessions(requestId), this.syncRetryDelayMs);
        this.pendingSessionSyncRequests.set(requestId, { runnerId, projectPath, attempts: 1, timeout });
        return requestId;
    }

    /**
     * Handle sessions sync response from runner
     */
    async handleSyncSessionsResponse(
        runnerId: string, 
        projectPath: string, 
        sessions: any[]
    ): Promise<void> {
        console.log(`[SessionSync] Received ${sessions.length} sessions for ${projectPath}`);
        for (const [requestId, pending] of this.pendingSessionSyncRequests.entries()) {
            if (pending.runnerId === runnerId && pending.projectPath === projectPath) {
                clearTimeout(pending.timeout);
                this.pendingSessionSyncRequests.delete(requestId);
            }
        }
        
        const projectState = await this.ensureProjectState(runnerId, projectPath);
        if (!projectState) return;

        for (const session of sessions) {
            if (this.ownedSessions.has(session.sessionId)) continue;
            await this.syncSessionToDiscord(runnerId, projectPath, session, session.messages);
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
        const state = this.runnerStates.get(runnerId);
        if (!state) return;

        const projectState = state.projects.get(projectPath);
        if (!projectState) return;

        const existingSync = projectState.sessions.get(session.sessionId);
        
        if (!existingSync) {
            await this.createSessionThread(runnerId, projectPath, session, messages);
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
        // Check lock
        if (this.sessionCreationLocks.has(session.sessionId)) {
            console.log(`[SessionSync] createSessionThread: waiting for lock on ${session.sessionId}`);
            await this.sessionCreationLocks.get(session.sessionId);
            
            // Lock released - check if we need to sync messages
            if (messages && messages.length > 0) {
                 console.log(`[SessionSync] createSessionThread: Lock released. Attempting to sync ${messages.length} messages to existing session.`);
                 
                 const state = this.runnerStates.get(runnerId);
                 const projectState = state?.projects.get(projectPath);
                 const existingSync = projectState?.sessions.get(session.sessionId);
                 
                 if (existingSync) {
                      const currentCount = existingSync.messageCount || 0;
                      if (messages.length > currentCount) {
                          const trulyNew = this.filterNewMessages(session.sessionId, messages.slice(currentCount));
                          console.log(`[SessionSync] Handing off ${trulyNew.length} messages to syncNewMessages`);
                          await this.syncNewMessages(runnerId, projectPath, session, existingSync, trulyNew);
                      }
                 } else {
                     console.log(`[SessionSync] Warning: Lock released but no existingSync found for ${session.sessionId}`);
                 }
            }
            return;
        }

        const task = (async () => {
            const state = this.runnerStates.get(runnerId);
            if (!state) {
                console.error(`[SessionSync] No runner state for ${runnerId}`);
                return;
            }

            const projectState = state.projects.get(projectPath);
            if (!projectState || !projectState.channelId) {
                console.error(`[SessionSync] No project state/channelId for ${projectPath}`);
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
                        const newChannelId = await cm.ensureProjectChannel(runnerId, projectPath);
                        if (newChannelId) {
                            try {
                                 console.log(`[SessionSync] Recreated channel: ${newChannelId}`);
                                 projectState.channelId = newChannelId; // Update local state
                                 channel = await this.client.channels.fetch(newChannelId) as TextChannel;
                            } catch (retryErr) {
                                 console.error(`[SessionSync] Failed to fetch recreated channel:`, retryErr);
                            }
                        } else {
                            console.error(`[SessionSync] Failed to recreate project channel for ${projectPath}`);
                        }
                     }
                }
            }

            if (!channel) {
                console.error(`[SessionSync] Aborting thread creation: Channel not available for ${projectPath}`);
                return;
            }

            const runner = storage.getRunner(runnerId);
            let thread: ThreadChannel | null = null;
            let threadId = runner?.discordState?.sessions?.[session.sessionId]?.threadId;

            if (threadId) {
                try {
                    thread = await channel.threads.fetch(threadId) as ThreadChannel;
                    if (thread) {
                        console.log(`[SessionSync] Found existing thread ${threadId} for session ${session.sessionId}`);
                        if (thread.archived) {
                            await thread.setArchived(false, 'Session re-synced from VS Code');
                        }
                    }
                } catch (e) {
                    console.log(`[SessionSync] Could not fetch existing thread ${threadId}, creating new one. Error: ${e}`);
                }
            }

            if (!thread) {
                const threadName = this.generateThreadName(session.firstPrompt);
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
                        reason: `VS Code session: ${session.sessionId}`
                    });
                } catch (e) {
                     console.error('[SessionSync] Failed to create thread:', e);
                     return;
                }
                    
                if (thread) {
                    const embed = new EmbedBuilder()
                        .setTitle('📋 Session Synced from VS Code')
                        .setDescription(`This session was created in VS Code and synced to Discord.`)
                        .addFields(
                            { name: 'Session ID', value: `\`${session.sessionId.slice(0, 8)}\``, inline: true },
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
                                    [session.sessionId]: {
                                        threadId: thread.id,
                                        projectPath,
                                        lastSync: new Date(session.created).toISOString() 
                                    }
                                }
                            }
                        });
                    }
                }
            } // End if (!thread)

            if (thread) {
                if (messages && messages.length > 0) {
                    const uniqueMessages = this.filterNewMessages(session.sessionId, messages);
                    console.log(`[SessionSync] createSessionThread: Posting ${uniqueMessages.length} initial messages to thread ${thread.id}`);
                    await this.postSessionMessages(runnerId, thread, uniqueMessages);
                } else {
                    console.log(`[SessionSync] createSessionThread: No messages to post (messages arg is ${messages ? 'empty' : 'null'})`);
                }

                const syncedSession: SyncedSession = {
                    sessionId: `sync_${session.sessionId}`,
                    claudeSessionId: session.sessionId,
                    projectPath,
                    threadId: thread.id,
                    firstPrompt: session.firstPrompt,
                    status: 'idle',
                    lastSyncedAt: new Date(),
                    messageCount: session.messageCount ?? (messages ? messages.length : 0)
                };

                projectState.sessions.set(session.sessionId, syncedSession);
                console.log(`[SessionSync] Synced thread ${thread.id} for session: ${session.sessionId}`);
            } else {
                console.error(`[SessionSync] Thread creation failed or returned null for session ${session.sessionId}`);
            }
        })(); // End task

        this.sessionCreationLocks.set(session.sessionId, task);
        
        try {
            await task;
        } catch (e) {
            console.error(`[SessionSync] Unhandled error in createSessionThread task for ${session.sessionId}:`, e);
        } finally {
            this.sessionCreationLocks.delete(session.sessionId);
        }
    }

    /**
     * Handle pushed session discovery from runner
     */
    async handleSessionDiscovered(runnerId: string, session: any): Promise<void> {
        console.log(`[SessionSync] Session discovered on runner ${runnerId}: ${session.sessionId}`);
        if (this.ownedSessions.has(session.sessionId)) return;
        await this.ensureProjectState(runnerId, session.projectPath);
        await this.syncSessionToDiscord(runnerId, session.projectPath, session, session.messages);
        this.emit('session_new', { runnerId, entry: session });
    }

    private sessionCreationLocks = new Map<string, Promise<void>>();

    /**
     * Handle pushed session update from runner
     */
    async handleSessionUpdated(runnerId: string, data: { session: any, newMessages: any[] }): Promise<void> {
        console.log(`[SessionSync] Handle Session Update: ${data.session.sessionId} | Msgs: ${data.newMessages?.length}`);
        
        if (this.ownedSessions.has(data.session.sessionId)) {
            console.log(`[SessionSync] Skipping owned session ${data.session.sessionId}`);
            return;
        }

        const state = this.runnerStates.get(runnerId);
        if (!state) {
            console.log(`[SessionSync] No runner state for ${runnerId}`);
            return;
        }

        const runner = storage.getRunner(runnerId);
        if (!runner?.config?.autoSync) {
            console.log(`[SessionSync] AutoSync disabled for ${runnerId}`);
            return;
        }

        const projectState = await this.ensureProjectState(runnerId, data.session.projectPath);
        if (!projectState) {
            console.log(`[SessionSync] Project state not found for path: '${data.session.projectPath}'. Available logs: ${state.projects.size}`);
            return;
        }

        // Check for creation lock
        if (this.sessionCreationLocks.has(data.session.sessionId)) {
            console.log(`[SessionSync] Waiting for creation lock on ${data.session.sessionId}`);
            await this.sessionCreationLocks.get(data.session.sessionId);
        }

        const existingSync = projectState.sessions.get(data.session.sessionId);
        if (existingSync) {
            const allMessages = data.newMessages;
            const currentCount = existingSync.messageCount;
            
            console.log(`[SessionSync] Existing Sync found. Current: ${currentCount}, New Total: ${allMessages.length}`);

            if (allMessages.length > currentCount) {
                const trulyNewMessages = this.filterNewMessages(data.session.sessionId, allMessages.slice(currentCount));
                console.log(`[SessionSync] Syncing ${trulyNewMessages.length} truly new messages`);
                await this.syncNewMessages(runnerId, data.session.projectPath, data.session, existingSync, trulyNewMessages);
            }
        } else {
            // New session discovered via update
            console.log(`[SessionSync] No existing sync for ${data.session.sessionId}. Creating new thread with ${data.newMessages?.length} messages.`);
            await this.createSessionThread(runnerId, data.session.projectPath, data.session, data.newMessages);
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
             console.log(`[SessionSync] No threadId for session ${session.sessionId}, skipping syncNewMessages`);
             return;
        }

        try {
            const uniqueMessages = this.filterNewMessages(session.sessionId, newMessages);
            if (uniqueMessages.length === 0) return;

            const thread = await this.client.channels.fetch(existingSync.threadId) as ThreadChannel;
            if (!thread) {
                 console.log(`[SessionSync] Thread ${existingSync.threadId} not found`);
                 return;
            }

            if (uniqueMessages.length > 0) {
                console.log(`[SessionSync] Posting ${uniqueMessages.length} messages to thread ${thread.id}`);
                await this.postSessionMessages(runnerId, thread, uniqueMessages);
                
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
                                [session.sessionId]: {
                                    threadId: existingSync.threadId!,
                                    projectPath,
                                    lastSync: existingSync.lastSyncedAt.toISOString()
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

    private filterNewMessages(sessionId: string, messages: any[]): any[] {
        if (!messages || messages.length === 0) return [];
        const key = sessionId;
        let set = this.messageDedup.get(key);
        if (!set) {
            set = new Set<string>();
            this.messageDedup.set(key, set);
        }
        const result: any[] = [];
        for (const [index, msg] of messages.entries()) {
            const id = this.getMessageId(msg, index);
            if (!id) {
                result.push(msg);
                continue;
            }
            if (!set.has(id)) {
                set.add(id);
                result.push(msg);
            }
        }
        if (set.size > this.maxDedupEntries) {
            const trimmed = new Set<string>(Array.from(set).slice(-this.maxDedupEntries));
            this.messageDedup.set(key, trimmed);
        }
        return result;
    }

    private getMessageId(message: any, index: number): string | null {
        if (!message) return null;
        return (
            message.uuid ||
            message.id ||
            message.message?.id ||
            message.tool_use_id ||
            message.toolUseId ||
            `${index}:${JSON.stringify(message).slice(0, 120)}`
        );
    }

    private retrySyncProjects(requestId: string): void {
        const pending = this.pendingProjectSyncRequests.get(requestId);
        if (!pending) return;
        if (pending.attempts >= this.maxSyncRetries) {
            this.pendingProjectSyncRequests.delete(requestId);
            console.warn(`[SessionSync] sync_projects timed out after ${pending.attempts} attempts`);
            return;
        }
        const ws = botState.runnerConnections.get(pending.runnerId);
        if (!ws) {
            this.pendingProjectSyncRequests.delete(requestId);
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
        const pending = this.pendingSessionSyncRequests.get(requestId);
        if (!pending) return;
        if (pending.attempts >= this.maxSyncRetries) {
            this.pendingSessionSyncRequests.delete(requestId);
            console.warn(`[SessionSync] sync_sessions timed out after ${pending.attempts} attempts`);
            return;
        }
        const ws = botState.runnerConnections.get(pending.runnerId);
        if (!ws) {
            this.pendingSessionSyncRequests.delete(requestId);
            return;
        }
        pending.attempts += 1;
        ws.send(JSON.stringify({
            type: 'sync_sessions',
            data: { runnerId: pending.runnerId, projectPath: pending.projectPath, requestId }
        }));
        pending.timeout = setTimeout(() => this.retrySyncSessions(requestId), this.syncRetryDelayMs);
    }

    /**
     * Post messages to a thread with formatting and splitting
     */
    async postSessionMessages(
        runnerId: string,
        thread: ThreadChannel,
        messages: any[]
    ): Promise<void> {
        const runner = storage.getRunner(runnerId);
        if (!runner) return;

        if (!messages || messages.length === 0) return;

        let effectiveMessages = messages;
        if (this.maxSyncMessages > 0 && messages.length > this.maxSyncMessages) {
            const skipped = messages.length - this.maxSyncMessages;
            effectiveMessages = messages.slice(-this.maxSyncMessages);
            await this.sendThreadMessage(thread, {
                content: `⚠️ Sync truncated: showing last ${this.maxSyncMessages} of ${messages.length} messages (skipped ${skipped}).`
            });
        }

        console.log(`[SessionSync] Posting ${effectiveMessages.length} messages...`);

        for (const msg of effectiveMessages) {
            // Support both old 'message.content' and new direct struct
            const msgObj = msg.message || msg;
            
            if (!msgObj?.content) {
                console.log(`[SessionSync] Skipping message: No content. keys=${Object.keys(msgObj)}`);
                continue;
            }

            const content = msgObj.content;
            const roleLabel = msg.type === 'user' ? 'User' : 'Claude';

            if (typeof content === 'string') {
                if (content.trim()) {
                    const chunks = content.match(/[\s\S]{1,1900}/g) || [content];
                    for (const chunk of chunks) {
                        await this.sendThreadMessage(thread, { content: `**${roleLabel}:** ${chunk}` });
                    }
                }
                continue;
            }

            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'text') {
                        if (block.text?.trim()) {
                            const chunks = block.text.match(/[\s\S]{1,1900}/g) || [block.text];
                            for (const chunk of chunks) {
                                await this.sendThreadMessage(thread, { content: `**${roleLabel}:**\n${chunk}` });
                            }
                        }
                    } else if (block.type === 'thinking') {
                        // Thinking block support
                         if (block.thinking?.trim()) {
                            const chunks = block.thinking.match(/[\s\S]{1,1900}/g) || [block.thinking];
                            for (const chunk of chunks) {
                                await this.sendThreadMessage(thread, { content: `> **Thinking:**\n> ${chunk.replace(/\n/g, '\n> ')}` });
                            }
                        }
                    } else if (block.type === 'tool_use') {
                        const embed = createToolUseEmbed(runner, block.name, block.input);
                        await this.sendThreadMessage(thread, { embeds: [embed] });
                    } else if (block.type === 'tool_result') {
                        // Keep tool result as embed but ensure it's clean
                        let resultText = '';
                        if (typeof block.content === 'string') {
                            resultText = block.content;
                        } else if (Array.isArray(block.content)) {
                            resultText = block.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
                        } else {
                            resultText = JSON.stringify(block.content);
                        }

                        const parts = resultText.match(/[\s\S]{1,4000}/g) || [resultText];
                        for (let i = 0; i < parts.length; i++) {
                            const embed = createOutputEmbed(
                                block.is_error ? 'error' : 'tool_result',
                                parts[i] + (i < parts.length - 1 ? '\n...(continued)' : '')
                            );
                            await this.sendThreadMessage(thread, { embeds: [embed] });
                        }
                    }
                }
            }
        }
    }

    private async sendThreadMessage(thread: ThreadChannel, payload: any): Promise<void> {
        await this.enqueueThreadSend(thread.id, async () => {
            await thread.send(payload);
            if (this.threadSendDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, this.threadSendDelayMs));
            }
        });
    }

    private enqueueThreadSend(threadId: string, task: () => Promise<void>): Promise<void> {
        const prev = this.threadSendQueues.get(threadId) || Promise.resolve();
        const next = prev
            .then(task)
            .catch((err) => console.error('[SessionSync] Thread send error:', err))
            .finally(() => {
                if (this.threadSendQueues.get(threadId) === next) {
                    this.threadSendQueues.delete(threadId);
                }
            });

        this.threadSendQueues.set(threadId, next);
        return next;
    }

    private generateThreadName(prompt: string): string {
        if (!prompt) return 'New Session';
        const words = prompt.split(/\s+/).slice(0, 8).join(' ');
        return words.length <= 50 ? words : words.slice(0, 47) + '...';
    }

    markSessionAsOwned(sessionId: string): void {
        this.ownedSessions.add(sessionId);
    }

    unmarkSessionOwnership(sessionId: string): void {
        this.ownedSessions.delete(sessionId);
    }

    getProjectStats(runnerId: string, projectPath: string): ProjectStats {
        const state = this.runnerStates.get(runnerId);
        if (!state) return { totalSessions: 0, activeSessions: 0, pendingActions: 0 };

        const projectState = state.projects.get(projectPath);
        if (!projectState) return { totalSessions: 0, activeSessions: 0, pendingActions: 0 };

        let activeSessions = 0;
        let pendingActions = 0;
        for (const session of projectState.sessions.values()) {
            if (session.status === 'running') activeSessions++;
            if (session.status === 'input_needed') pendingActions++;
        }

        return {
            totalSessions: projectState.sessions.size,
            activeSessions,
            pendingActions
        };
    }

    getSessionByThreadId(threadId: string): { runnerId: string; projectPath: string; session: SyncedSession } | null {
        for (const [runnerId, state] of this.runnerStates) {
            for (const [projectPath, projectState] of state.projects) {
                for (const session of projectState.sessions.values()) {
                    if (session.threadId === threadId) {
                        return { runnerId, projectPath, session };
                    }
                }
            }
        }
        return null;
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
