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

// ============================================================================
// Session Sync Service
// ============================================================================

export class SessionSyncService extends EventEmitter {
    private client: Client;
    private runnerStates = new Map<string, RunnerSyncState>();
    private ownedSessions = new Set<string>(); // Sessions created/controlled by Discord

    constructor(client: Client) {
        super();
        this.client = client;
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
    async syncProjects(runnerId: string): Promise<void> {
        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) {
            console.error(`[SessionSync] Runner offline: ${runnerId}`);
            return;
        }

        console.log(`[SessionSync] Requesting project sync from runner ${runnerId}`);
        ws.send(JSON.stringify({
            type: 'sync_projects',
            data: { runnerId }
        }));
    }

    /**
     * Handle project sync response from runner
     */
    async handleProjectSyncResponse(runnerId: string, projects: { path: string; lastModified: string; sessionCount: number }[]): Promise<void> {
        console.log(`[SessionSync] Received ${projects.length} projects from runner ${runnerId}`);
        
        const state = this.runnerStates.get(runnerId);
        if (!state) {
            await this.startSyncingRunner(runnerId);
        }

        const categoryManager = getCategoryManager();
        if (!categoryManager) return;

        for (const project of projects) {
            // Create project channel if needed
            await categoryManager.createProjectChannel(runnerId, project.path);

            const currentState = this.runnerStates.get(runnerId);
            if (!currentState) continue;

            // Initialize project sync state if missing
            if (!currentState.projects.has(project.path)) {
                const runnerCategory = categoryManager.getRunnerCategory(runnerId);
                const projectChannel = runnerCategory?.projects.get(project.path);

                currentState.projects.set(project.path, {
                    projectPath: project.path,
                    channelId: projectChannel?.channelId || '',
                    sessions: new Map(),
                    lastSync: new Date()
                });
            }

            // Sync existing sessions (remote request)
            await this.syncProjectSessions(runnerId, project.path);
        }
    }

    /**
     * Request sessions for a specific project from the runner
     */
    async syncProjectSessions(runnerId: string, projectPath: string): Promise<void> {
        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) return;

        console.log(`[SessionSync] Requesting sessions for ${projectPath} from runner ${runnerId}`);
        ws.send(JSON.stringify({
            type: 'sync_sessions',
            data: { runnerId, projectPath }
        }));
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
        
        const state = this.runnerStates.get(runnerId);
        if (!state) return;

        const projectState = state.projects.get(projectPath);
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
                      // We have the full history in 'messages'. 
                      // syncNewMessages expects 'newMessages' (truly new).
                      // But existingSync might start with 0 messages (from metadata sync).
                      // We should calculate the diff or just pass it if we trust logic.
                      
                      const currentCount = existingSync.messageCount || 0;
                      if (messages.length > currentCount) {
                          const trulyNew = messages.slice(currentCount);
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
            if (!state) return;

            const projectState = state.projects.get(projectPath);
            if (!projectState || !projectState.channelId) return;

            let channel: TextChannel | null = null;
            try {
                channel = await this.client.channels.fetch(projectState.channelId) as TextChannel;
                if (!channel) throw new Error('Channel not found');
            } catch (error: any) {
                // Check for Unknown Channel (10003) or 404
                if (error.code === 10003 || error.status === 404 || error.message === 'Unknown Channel') {
                     console.log(`[SessionSync] Channel ${projectState.channelId} missing. Recreating...`);
                     
                     const cm = getCategoryManager();
                     if (cm) {
                        const newChannelId = await cm.ensureProjectChannel(runnerId, projectPath);
                        if (newChannelId) {
                            try {
                                 projectState.channelId = newChannelId; // Update local state
                                 channel = await this.client.channels.fetch(newChannelId) as TextChannel;
                            } catch (retryErr) {
                                 console.error(`[SessionSync] Failed to fetch recreated channel:`, retryErr);
                            }
                        }
                     }
                } else {
                     console.error(`[SessionSync] Error fetching channel ${projectState.channelId}:`, error);
                }
            }

            if (!channel) return;

            const runner = storage.getRunner(runnerId);
            let thread: ThreadChannel | null = null;
            let threadId = runner?.discordState?.sessions?.[session.sessionId]?.threadId;

            if (threadId) {
                try {
                    thread = await channel.threads.fetch(threadId) as ThreadChannel;
                    if (thread) {
                        console.log(`[SessionSync] Found existing thread ${threadId} for session ${session.sessionId}`);
                        // Unarchive if needed
                        if (thread.archived) {
                            await thread.setArchived(false, 'Session re-synced from VS Code');
                        }
                    }
                } catch (e) {
                    console.log(`[SessionSync] Could not fetch existing thread ${threadId}, creating new one`);
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
                    thread = await channel.threads.create({
                        name: threadName,
                        autoArchiveDuration: archiveDuration as any, 
                        reason: `VS Code session: ${session.sessionId}`
                    });
                } catch (e) {
                     console.error('[SessionSync] Failed to create thread:', e);
                     return;
                }
                    
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

                    await thread.send({ embeds: [embed] });

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
                } // End if (!thread)

                if (messages && messages.length > 0) {
                    console.log(`[SessionSync] createSessionThread: Posting ${messages.length} initial messages to thread ${thread.id}`);
                    await this.postSessionMessages(runnerId, thread, messages);
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
                    messageCount: messages ? messages.length : 0
                };

                projectState.sessions.set(session.sessionId, syncedSession);
                console.log(`[SessionSync] Synced thread ${thread.id} for session: ${session.sessionId}`);
        })(); // End task

        this.sessionCreationLocks.set(session.sessionId, task);
        
        try {
            await task;
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

        const projectState = state.projects.get(data.session.projectPath);
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
                const trulyNewMessages = allMessages.slice(currentCount);
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
            const thread = await this.client.channels.fetch(existingSync.threadId) as ThreadChannel;
            if (!thread) {
                 console.log(`[SessionSync] Thread ${existingSync.threadId} not found`);
                 return;
            }

            if (newMessages.length > 0) {
                console.log(`[SessionSync] Posting ${newMessages.length} messages to thread ${thread.id}`);
                await this.postSessionMessages(runnerId, thread, newMessages);
                
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

        console.log(`[SessionSync] Posting ${messages.length} messages...`);

        for (const msg of messages) {
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
                        await thread.send({ content: `**${roleLabel}:** ${chunk}` });
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
                                await thread.send({ content: `**${roleLabel}:**\n${chunk}` });
                            }
                        }
                    } else if (block.type === 'thinking') {
                        // Thinking block support
                         if (block.thinking?.trim()) {
                            const chunks = block.thinking.match(/[\s\S]{1,1900}/g) || [block.thinking];
                            for (const chunk of chunks) {
                                await thread.send({ content: `> **Thinking:**\n> ${chunk.replace(/\n/g, '\n> ')}` });
                            }
                        }
                    } else if (block.type === 'tool_use') {
                        const embed = createToolUseEmbed(runner, block.name, block.input);
                        await thread.send({ embeds: [embed] });
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
                            await thread.send({ embeds: [embed] });
                        }
                    }
                }
            }
        }
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
