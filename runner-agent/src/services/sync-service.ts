
import { EventEmitter } from 'events';
import {
    SessionWatcher,
    SessionEntry,
    listProjectsAsync,
    listSessions
} from '@raylin01/claude-client/sessions';
import { WebSocketManager } from '../websocket.js';
import {
    SyncedSessionMessage,
    SyncProjectsResponseMessage,
    SyncProjectsProgressMessage,
    SyncProjectsCompleteMessage,
    SyncSessionsResponseMessage,
    SyncSessionsCompleteMessage,
    SyncSessionDiscoveredMessage,
    SyncSessionUpdatedMessage
} from '../../../shared/types.js';
import {
    normalizeProjectPath,
    toSyncSessionKey,
    type CliType
} from './sync-utils.js';
import {
    readClaudeSessionMessages
} from './claude-sync.js';
import {
    CodexSyncClient,
    normalizeThreadRecord
} from './codex-sync.js';
import {
    listGeminiSessionsForProject,
    listGeminiProjects,
    readGeminiSessionMessages
} from './gemini-sync.js';

/**
 * Runner-side Sync Service
 *
 * Watches local files and pushes updates to Discord bot.
 */
export class RunnerSyncService extends EventEmitter {
    private watcher: SessionWatcher;
    private wsManager: WebSocketManager;
    private codexPath: string | null;
    private codexClient: CodexSyncClient;
    private ownedSessions = new Set<string>(); // Sessions created/controlled by Discord
    private syncProjectsTask: Promise<void> | null = null;
    private syncSessionsTasks = new Map<string, Promise<void>>();
    private codexPollTimer: NodeJS.Timeout | null = null;
    private codexPollInFlight = false;
    private codexPollInitialized = false;
    private readonly codexPollIntervalMs = parseInt(process.env.DISCODE_CODEX_SYNC_POLL_MS || '15000');
    private codexThreadUpdatedAt = new Map<string, number>();
    private syncStatus: {
        state: 'idle' | 'syncing' | 'error';
        lastSyncAt?: string;
        lastError?: string;
        projects: Map<string, {
            projectPath: string;
            state: 'idle' | 'syncing' | 'complete' | 'error';
            lastSyncAt?: string;
            lastError?: string;
            sessionCount?: number;
        }>;
    } = {
        state: 'idle',
        projects: new Map()
    };
    private maxSyncChunkBytes = parseInt(process.env.DISCODE_SYNC_MAX_BYTES || String(2 * 1024 * 1024));

    constructor(wsManager: WebSocketManager, options?: { codexPath?: string | null }) {
        super();
        this.wsManager = wsManager;
        this.watcher = new SessionWatcher();
        this.codexPath = options?.codexPath || null;
        this.codexClient = new CodexSyncClient(this.codexPath);

        // Listen for watcher events
        this.watcher.on('session_new', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId) || this.ownedSessions.has(toSyncSessionKey(entry.sessionId, 'claude'))) return;
            void this.pushSessionDiscovered(entry);
        });

        this.watcher.on('session_updated', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId) || this.ownedSessions.has(toSyncSessionKey(entry.sessionId, 'claude'))) return;
            void this.pushSessionUpdated(entry);
        });

        this.startCodexPolling();
    }

    private startCodexPolling(): void {
        if (!this.codexPath) return;
        if (this.codexPollIntervalMs <= 0) return;
        if (this.codexPollTimer) return;

        this.codexPollTimer = setInterval(() => {
            void this.pollCodexThreads();
        }, this.codexPollIntervalMs);

        void this.pollCodexThreads();
    }

    private async pollCodexThreads(): Promise<void> {
        if (!this.codexPath) return;
        if (this.codexPollInFlight) return;
        this.codexPollInFlight = true;

        try {
            const threads = await this.codexClient.listThreads();
            const currentIds = new Set<string>();

            if (!this.codexPollInitialized) {
                for (const thread of threads) {
                    const updatedAt = typeof thread.updatedAt === 'number'
                        ? thread.updatedAt
                        : (typeof thread.createdAt === 'number' ? thread.createdAt : 0);
                    this.codexThreadUpdatedAt.set(thread.id, updatedAt);
                }
                this.codexPollInitialized = true;
                return;
            }

            for (const thread of threads) {
                const record = normalizeThreadRecord(thread);
                if (!record) continue;

                currentIds.add(record.sessionId);
                const sessionKey = toSyncSessionKey(record.sessionId, 'codex');
                if (this.ownedSessions.has(sessionKey) || this.ownedSessions.has(record.sessionId)) {
                    continue;
                }

                const updatedAt = typeof thread.updatedAt === 'number'
                    ? thread.updatedAt
                    : (typeof thread.createdAt === 'number' ? thread.createdAt : 0);
                const previousUpdatedAt = this.codexThreadUpdatedAt.get(record.sessionId);

                if (previousUpdatedAt == null) {
                    this.codexThreadUpdatedAt.set(record.sessionId, updatedAt);

                    const { messages, messageCount } = await this.codexClient.readThreadMessages(record.sessionId);
                    const discovered: SyncSessionDiscoveredMessage = {
                        type: 'sync_session_discovered',
                        data: {
                            runnerId: this.wsManager.runnerId,
                            syncFormatVersion: 2,
                            session: {
                                sessionId: record.sessionId,
                                projectPath: record.projectPath,
                                cliType: 'codex',
                                firstPrompt: record.firstPrompt,
                                created: record.created,
                                messageCount,
                                gitBranch: record.gitBranch,
                                messages
                            }
                        }
                    };
                    this.wsManager.send(discovered);
                    continue;
                }

                if (updatedAt <= previousUpdatedAt) continue;
                this.codexThreadUpdatedAt.set(record.sessionId, updatedAt);

                const { messages, messageCount } = await this.codexClient.readThreadMessages(record.sessionId);
                const updated: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        syncFormatVersion: 2,
                        session: {
                            sessionId: record.sessionId,
                            projectPath: record.projectPath,
                            cliType: 'codex',
                            messageCount
                        },
                        newMessages: messages
                    }
                };
                this.wsManager.send(updated);
            }

            for (const sessionId of this.codexThreadUpdatedAt.keys()) {
                if (!currentIds.has(sessionId)) {
                    this.codexThreadUpdatedAt.delete(sessionId);
                }
            }
        } catch (error) {
            console.error('[SyncService] Codex polling failed:', error);
        } finally {
            this.codexPollInFlight = false;
        }
    }

    /**
     * Start watching projects
     */
    startWatching(projectPaths: string[]): void {
        console.log(`[SyncService] Starting watch for ${projectPaths.length} projects`);
        projectPaths.forEach(path => {
            this.watcher.watchProject(path);
        });
    }

    /**
     * Mark a session as owned (don't push sync updates)
     */
    markAsOwned(sessionId: string, cliType: CliType = 'claude'): void {
        this.ownedSessions.add(toSyncSessionKey(sessionId, cliType));
        if (cliType === 'claude') {
            this.watcher.markAsOwned(sessionId);
        }
    }

    /**
     * Get a snapshot of current sync status for bot queries
     */
    getStatusSnapshot(): {
        state: 'idle' | 'syncing' | 'error';
        lastSyncAt?: string;
        lastError?: string;
        projects: Record<string, {
            projectPath: string;
            state: 'idle' | 'syncing' | 'complete' | 'error';
            lastSyncAt?: string;
            lastError?: string;
            sessionCount?: number;
        }>;
    } {
        const projects: Record<string, any> = {};
        for (const [path, status] of this.syncStatus.projects.entries()) {
            projects[path] = { ...status };
        }
        return {
            state: this.syncStatus.state,
            lastSyncAt: this.syncStatus.lastSyncAt,
            lastError: this.syncStatus.lastError,
            projects
        };
    }

    sendStatusResponse(requestId: string): void {
        this.wsManager.send({
            type: 'sync_status_response',
            data: {
                runnerId: this.wsManager.runnerId,
                requestId,
                status: this.getStatusSnapshot()
            }
        });
    }

    /**
     * Handle explicit sync projects request
     */
    async handleSyncProjects(requestId?: string): Promise<void> {
        console.log('[SyncService] Handling sync_projects request');
        if (this.syncProjectsTask) {
            console.log('[SyncService] sync_projects already running, ignoring duplicate request');
            return;
        }

        const task = this.runSyncProjects(requestId);
        this.syncProjectsTask = task;
        try {
            await task;
        } finally {
            this.syncProjectsTask = null;
        }
    }

    /**
     * Handle explicit sync sessions request
     */
    async handleSyncSessions(projectPath: string, requestId?: string): Promise<void> {
        console.log(`[SyncService] Handling sync_sessions for ${projectPath}`);

        if (this.syncSessionsTasks.has(projectPath)) {
            console.log(`[SyncService] sync_sessions already running for ${projectPath}, ignoring duplicate request`);
            return;
        }

        const task = this.runSyncSessions(projectPath, requestId);
        this.syncSessionsTasks.set(projectPath, task);
        try {
            await task;
        } finally {
            this.syncSessionsTasks.delete(projectPath);
        }
    }

    async handleSyncSessionMessages(
        sessionId: string,
        projectPath: string,
        requestId?: string,
        cliType: CliType = 'claude'
    ): Promise<void> {
        try {
            if (cliType === 'codex') {
                const { messages, messageCount } = await this.codexClient.readThreadMessages(sessionId);

                const codexMessage: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        syncFormatVersion: 2,
                        session: {
                            sessionId,
                            projectPath: normalizeProjectPath(projectPath),
                            cliType: 'codex',
                            messageCount
                        },
                        newMessages: messages
                    }
                };
                this.wsManager.send(codexMessage);
                return;
            }

            if (cliType === 'gemini') {
                const snapshot = await readGeminiSessionMessages(sessionId, projectPath);
                const geminiMessage: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        syncFormatVersion: 2,
                        session: {
                            sessionId,
                            projectPath: normalizeProjectPath(projectPath),
                            cliType: 'gemini',
                            messageCount: snapshot.messageCount || 0
                        },
                        newMessages: snapshot.messages
                    }
                };
                this.wsManager.send(geminiMessage);
                return;
            }

            const snapshot = await readClaudeSessionMessages(sessionId, projectPath);
            const message: SyncSessionUpdatedMessage = {
                type: 'sync_session_updated',
                data: {
                    runnerId: this.wsManager.runnerId,
                    syncFormatVersion: 2,
                    session: {
                        sessionId,
                        projectPath: normalizeProjectPath(projectPath),
                        cliType: 'claude',
                        messageCount: snapshot.messageCount || 0
                    },
                    newMessages: snapshot.messages
                }
            };
            this.wsManager.send(message);
        } catch (error) {
            console.error(`[SyncService] Error syncing session messages for ${sessionId}:`, error);
        }
    }

    private async runSyncProjects(requestId?: string): Promise<void> {
        const startedAt = new Date();
        this.syncStatus.state = 'syncing';
        this.syncStatus.lastError = undefined;

        this.wsManager.send({
            type: 'sync_projects_progress',
            data: {
                runnerId: this.wsManager.runnerId,
                requestId,
                phase: 'listing',
                completed: 0,
                message: 'Listing projects',
                timestamp: new Date().toISOString()
            }
        } as SyncProjectsProgressMessage);

        try {
            const claudeProjects = await listProjectsAsync();
            const codexProjects = await this.codexClient.listProjects();
            const knownProjectPaths = new Set<string>();
            const mergedProjects = new Map<string, { path: string; lastModified: Date; sessionCount: number }>();

            for (const existingProjectPath of this.syncStatus.projects.keys()) {
                knownProjectPaths.add(existingProjectPath);
            }

            for (const project of claudeProjects) {
                const normalizedPath = normalizeProjectPath(project.path);
                knownProjectPaths.add(normalizedPath);
                mergedProjects.set(normalizedPath, {
                    path: normalizedPath,
                    lastModified: project.lastModified,
                    sessionCount: project.sessionCount
                });
            }

            for (const [projectPath, sessionCount] of codexProjects.entries()) {
                knownProjectPaths.add(projectPath);
                const existing = mergedProjects.get(projectPath);
                if (existing) {
                    existing.sessionCount += sessionCount;
                    continue;
                }
                mergedProjects.set(projectPath, {
                    path: projectPath,
                    lastModified: new Date(),
                    sessionCount
                });
            }

            const geminiProjects = await listGeminiProjects(knownProjectPaths);
            for (const [projectPath, sessionCount] of geminiProjects.entries()) {
                const existing = mergedProjects.get(projectPath);
                if (existing) {
                    existing.sessionCount += sessionCount;
                    continue;
                }
                mergedProjects.set(projectPath, {
                    path: projectPath,
                    lastModified: new Date(),
                    sessionCount
                });
            }

            const projects = Array.from(mergedProjects.values());

            const response: SyncProjectsResponseMessage = {
                type: 'sync_projects_response',
                data: {
                    runnerId: this.wsManager.runnerId,
                    requestId,
                    projects: projects.map(p => ({
                        path: p.path,
                        lastModified: p.lastModified.toISOString(),
                        sessionCount: p.sessionCount
                    }))
                }
            };

            this.wsManager.send(response);

            // Update project status cache
            for (const project of projects) {
                const status = this.syncStatus.projects.get(project.path) || {
                    projectPath: project.path,
                    state: 'idle' as const
                };
                status.sessionCount = project.sessionCount;
                status.state = 'idle';
                this.syncStatus.projects.set(project.path, status);
            }

            this.startWatching(projects.map(p => p.path));

            this.syncStatus.state = 'idle';
            this.syncStatus.lastSyncAt = new Date().toISOString();

            this.wsManager.send({
                type: 'sync_projects_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    requestId,
                    projects: response.data.projects,
                    status: 'success',
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString()
                }
            } as SyncProjectsCompleteMessage);
        } catch (error: any) {
            console.error('[SyncService] Error listing projects:', error);
            this.syncStatus.state = 'error';
            this.syncStatus.lastError = error?.message || String(error);

            this.wsManager.send({
                type: 'sync_projects_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    requestId,
                    projects: [],
                    status: 'error',
                    error: this.syncStatus.lastError,
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString()
                }
            } as SyncProjectsCompleteMessage);
        }
    }

    private async runSyncSessions(projectPath: string, requestId?: string): Promise<void> {
        const startedAt = new Date();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        const projectStatus = this.syncStatus.projects.get(normalizedProjectPath) || {
            projectPath: normalizedProjectPath,
            state: 'idle' as const
        };
        projectStatus.state = 'syncing';
        projectStatus.lastError = undefined;
        this.syncStatus.projects.set(normalizedProjectPath, projectStatus);

        try {
            let claudeSessions: any[] = [];
            try {
                claudeSessions = await listSessions(normalizedProjectPath);
            } catch (error) {
                console.warn(`[SyncService] Claude sessions unavailable for ${normalizedProjectPath}:`, error);
            }

            const codexSessions = await this.codexClient.listSessions(normalizedProjectPath);
            const geminiSessions = await listGeminiSessionsForProject(normalizedProjectPath);
            const sessions = [...claudeSessions, ...codexSessions, ...geminiSessions];
            console.log(`[SyncService] Found ${sessions.length} sessions for ${normalizedProjectPath}`);

            const mappedSessions = [] as any[];
            for (const session of sessions) {
                const cliType: CliType = session.cliType === 'codex'
                    ? 'codex'
                    : session.cliType === 'gemini'
                    ? 'gemini'
                    : 'claude';
                if (cliType === 'codex') {
                    let codexMessages = Array.isArray(session.messages) ? session.messages : [];
                    let codexMessageCount = typeof session.messageCount === 'number' ? session.messageCount : 0;

                    // thread/list does not reliably include turns; hydrate with thread/read for initial sync.
                    if (codexMessages.length === 0) {
                        const snapshot = await this.codexClient.readThreadMessages(session.sessionId);
                        codexMessages = snapshot.messages;
                        codexMessageCount = snapshot.messageCount;
                    }

                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: codexMessageCount,
                        gitBranch: session.gitBranch,
                        messages: codexMessages
                    });
                } else if (cliType === 'gemini') {
                    let geminiMessages = Array.isArray(session.messages) ? session.messages : [];
                    let geminiMessageCount = typeof session.messageCount === 'number' ? session.messageCount : 0;

                    if (geminiMessages.length === 0) {
                        const snapshot = await readGeminiSessionMessages(session.sessionId, session.projectPath);
                        geminiMessages = snapshot.messages;
                        geminiMessageCount = snapshot.messageCount;
                    }

                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: geminiMessageCount,
                        gitBranch: session.gitBranch,
                        messages: geminiMessages
                    });
                } else {
                    const claudeSnapshot = await readClaudeSessionMessages(session.sessionId, session.projectPath);
                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: claudeSnapshot.messageCount || session.messageCount,
                        gitBranch: session.gitBranch,
                        messages: claudeSnapshot.messages
                    });
                }

                await new Promise<void>(resolve => setImmediate(resolve));
            }

            await this.sendSyncSessionsInChunks(normalizedProjectPath, requestId, mappedSessions);

            this.watcher.watchProject(normalizedProjectPath);

            projectStatus.state = 'complete';
            projectStatus.lastSyncAt = new Date().toISOString();
            projectStatus.sessionCount = sessions.length;
            this.syncStatus.projects.set(normalizedProjectPath, projectStatus);

            this.wsManager.send({
                type: 'sync_sessions_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projectPath: normalizedProjectPath,
                    requestId,
                    status: 'success',
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString(),
                    sessionCount: sessions.length
                }
            } as SyncSessionsCompleteMessage);
        } catch (error: any) {
            console.error(`[SyncService] Error listing sessions for ${normalizedProjectPath}:`, error);
            projectStatus.state = 'error';
            projectStatus.lastError = error?.message || String(error);
            this.syncStatus.projects.set(normalizedProjectPath, projectStatus);

            this.wsManager.send({
                type: 'sync_sessions_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projectPath: normalizedProjectPath,
                    requestId,
                    status: 'error',
                    error: projectStatus.lastError,
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString(),
                    sessionCount: 0
                }
            } as SyncSessionsCompleteMessage);
        }
    }

    private async sendSyncSessionsInChunks(
        projectPath: string,
        requestId: string | undefined,
        sessions: any[]
    ): Promise<void> {
        const basePayload = {
            runnerId: this.wsManager.runnerId,
            projectPath,
            requestId,
            syncFormatVersion: sessions.some((session) =>
                session?.cliType === 'codex' || session?.cliType === 'claude' || session?.cliType === 'gemini'
            ) ? 2 : undefined
        };

        const fullResponse: SyncSessionsResponseMessage = {
            type: 'sync_sessions_response',
            data: { ...basePayload, sessions }
        };
        const fullJson = JSON.stringify(fullResponse);
        console.log(`[SyncService] Generated response size: ${(fullJson.length / 1024).toFixed(2)} KB`);

        if (fullJson.length <= this.maxSyncChunkBytes) {
            const sent = this.wsManager.send(fullResponse);
            if (sent) {
                console.log(`[SyncService] Successfully sent sync response for ${projectPath}`);
            } else {
                console.error(`[SyncService] FAILED to send sync response (ws connection issue?)`);
            }
            return;
        }

        console.warn(`[SyncService] Large sync payload (${(fullJson.length / 1024).toFixed(2)} KB). Sending in chunks...`);

        let batch: any[] = [];
        for (const session of sessions) {
            const candidate = [...batch, session];
            const response: SyncSessionsResponseMessage = {
                type: 'sync_sessions_response',
                data: { ...basePayload, sessions: candidate }
            };
            const size = JSON.stringify(response).length;
            if (size > this.maxSyncChunkBytes && batch.length > 0) {
                const sendResponse: SyncSessionsResponseMessage = {
                    type: 'sync_sessions_response',
                    data: { ...basePayload, sessions: batch }
                };
                const sent = this.wsManager.send(sendResponse);
                if (!sent) {
                    console.error(`[SyncService] FAILED to send sync response chunk for ${projectPath}`);
                    return;
                }
                batch = [session];
                await new Promise<void>(resolve => setImmediate(resolve));
            } else {
                batch = candidate;
            }
        }

        if (batch.length > 0) {
            const finalResponse: SyncSessionsResponseMessage = {
                type: 'sync_sessions_response',
                data: { ...basePayload, sessions: batch }
            };
            const sent = this.wsManager.send(finalResponse);
            if (!sent) {
                console.error(`[SyncService] FAILED to send final sync response chunk for ${projectPath}`);
                return;
            }
        }

        console.log(`[SyncService] Successfully sent chunked sync response for ${projectPath}`);
    }

    /**
     * Push new session discovery to Bot
     */
    private async pushSessionDiscovered(entry: SessionEntry): Promise<void> {
        const snapshot = await readClaudeSessionMessages(entry.sessionId, entry.projectPath);
        console.log(`[SyncService] Pushing session discovery: ${entry.sessionId} | Messages in file: ${snapshot.messages.length}`);
        const message: SyncSessionDiscoveredMessage = {
            type: 'sync_session_discovered',
            data: {
                runnerId: this.wsManager.runnerId,
                syncFormatVersion: 2,
                session: {
                    sessionId: entry.sessionId,
                    projectPath: normalizeProjectPath(entry.projectPath),
                    cliType: 'claude',
                    firstPrompt: entry.firstPrompt,
                    created: entry.created,
                    messageCount: snapshot.messageCount || entry.messageCount,
                    gitBranch: entry.gitBranch,
                    messages: snapshot.messages
                }
            }
        };
        this.wsManager.send(message);
    }

    /**
     * Push session update (new messages) to Bot
     */
    private async pushSessionUpdated(entry: SessionEntry): Promise<void> {
        const snapshot = await readClaudeSessionMessages(entry.sessionId, entry.projectPath);

        const message: SyncSessionUpdatedMessage = {
            type: 'sync_session_updated',
            data: {
                runnerId: this.wsManager.runnerId,
                syncFormatVersion: 2,
                session: {
                    sessionId: entry.sessionId,
                    projectPath: normalizeProjectPath(entry.projectPath),
                    cliType: 'claude',
                    messageCount: snapshot.messageCount || entry.messageCount
                },
                newMessages: snapshot.messages
            }
        };

        this.wsManager.send(message);
    }

    /**
     * Shutdown
     */
    shutdown(): void {
        this.watcher.close();
        if (this.codexPollTimer) {
            clearInterval(this.codexPollTimer);
            this.codexPollTimer = null;
        }
        void this.codexClient.shutdown().catch((error) => {
            console.error('[SyncService] Error shutting down Codex sync client:', error);
        });
    }
}

// Singleton
let syncServiceInstance: RunnerSyncService | null = null;

export function getSyncService(
    wsManager?: WebSocketManager,
    options?: { codexPath?: string | null }
): RunnerSyncService | null {
    if (!syncServiceInstance && wsManager) {
        syncServiceInstance = new RunnerSyncService(wsManager, options);
    }
    return syncServiceInstance;
}
