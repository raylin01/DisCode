
import { EventEmitter } from 'events';
import path from 'path';
import { 
    SessionWatcher, 
    SessionEntry, 
    listProjectsAsync, 
    listSessions, 
    getSessionDetailsAsync
} from '../../../claude-client/src/sessions.js';
import { CodexClient, Thread } from '../../../codex-client/src/index.js';
import { WebSocketManager } from '../websocket.js';
import { 
    SyncProjectsResponseMessage, 
    SyncProjectsProgressMessage,
    SyncProjectsCompleteMessage,
    SyncSessionsResponseMessage, 
    SyncSessionsCompleteMessage,
    SyncSessionDiscoveredMessage, 
    SyncSessionUpdatedMessage 
} from '../../../shared/types.js';

/**
 * Runner-side Sync Service
 * 
 * Watches local files and pushes updates to Discord bot.
 */
export class RunnerSyncService extends EventEmitter {
    private watcher: SessionWatcher;
    private wsManager: WebSocketManager;
    private codexPath: string | null;
    private codexClient: CodexClient | null = null;
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

        // Listen for watcher events
        this.watcher.on('session_new', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId) || this.ownedSessions.has(this.toSyncSessionKey(entry.sessionId, 'claude'))) return;
            void this.pushSessionDiscovered(entry);
        });

        this.watcher.on('session_updated', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId) || this.ownedSessions.has(this.toSyncSessionKey(entry.sessionId, 'claude'))) return;
            void this.pushSessionUpdated(entry);
        });

        this.startCodexPolling();
    }

    private normalizeProjectPath(projectPath: string): string {
        if (!projectPath || typeof projectPath !== 'string') return projectPath;
        return path.resolve(projectPath);
    }

    private toSyncSessionKey(sessionId: string, cliType: 'claude' | 'codex' = 'claude'): string {
        return `${cliType}:${sessionId}`;
    }

    private normalizeThreadRecord(thread: Thread): {
        sessionId: string;
        projectPath: string;
        firstPrompt: string;
        created: string;
        messageCount: number;
        gitBranch?: string;
        messages: any[];
        cliType: 'codex';
    } | null {
        const cwd = thread.cwd || (typeof thread.path === 'string' ? thread.path : null);
        if (!cwd) return null;

        const createdAt = typeof thread.createdAt === 'number'
            ? new Date(thread.createdAt * 1000)
            : new Date();

        return {
            sessionId: thread.id,
            projectPath: this.normalizeProjectPath(cwd),
            firstPrompt: thread.preview || 'Codex thread',
            created: createdAt.toISOString(),
            messageCount: 0,
            gitBranch: typeof thread.gitInfo?.branch === 'string' ? thread.gitInfo.branch : undefined,
            messages: [],
            cliType: 'codex'
        };
    }

    private async ensureCodexClient(): Promise<CodexClient | null> {
        if (!this.codexPath) return null;
        if (this.codexClient) return this.codexClient;

        this.codexClient = new CodexClient({ codexPath: this.codexPath });
        try {
            await this.codexClient.start();
            return this.codexClient;
        } catch (error) {
            console.error('[SyncService] Failed to initialize Codex client for sync:', error);
            this.codexClient = null;
            return null;
        }
    }

    private async listCodexThreads(): Promise<Thread[]> {
        const client = await this.ensureCodexClient();
        if (!client) return [];

        const threads: Thread[] = [];
        let cursor: string | null = null;

        try {
            do {
                const response = await client.listThreads({
                    cursor,
                    limit: 200,
                    sortKey: 'updated_at',
                    archived: false
                });
                if (Array.isArray(response.data)) {
                    threads.push(...response.data);
                }
                cursor = response.nextCursor || null;
            } while (cursor);
        } catch (error) {
            console.error('[SyncService] Failed listing Codex threads:', error);
            return [];
        }

        return threads;
    }

    private async listCodexProjects(): Promise<Map<string, number>> {
        const projects = new Map<string, number>();
        const threads = await this.listCodexThreads();
        for (const thread of threads) {
            const normalized = this.normalizeThreadRecord(thread);
            if (!normalized) continue;
            const key = normalized.projectPath;
            projects.set(key, (projects.get(key) || 0) + 1);
        }
        return projects;
    }

    private async listCodexSessions(projectPath: string): Promise<any[]> {
        const normalizedPath = this.normalizeProjectPath(projectPath);
        const sessions: any[] = [];
        const threads = await this.listCodexThreads();
        for (const thread of threads) {
            const record = this.normalizeThreadRecord(thread);
            if (!record) continue;
            if (record.projectPath !== normalizedPath) continue;
            sessions.push(record);
        }
        return sessions;
    }

    private extractTextSnippets(value: any): string[] {
        if (value == null) return [];

        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed ? [trimmed] : [];
        }

        if (Array.isArray(value)) {
            return value.flatMap((entry) => this.extractTextSnippets(entry));
        }

        if (typeof value !== 'object') return [];

        const snippets: string[] = [];
        if (typeof value.text === 'string') snippets.push(...this.extractTextSnippets(value.text));
        if (typeof value.delta === 'string') snippets.push(...this.extractTextSnippets(value.delta));
        if (typeof value.content === 'string' || Array.isArray(value.content)) snippets.push(...this.extractTextSnippets(value.content));
        if (Array.isArray(value.contentItems)) snippets.push(...this.extractTextSnippets(value.contentItems));
        if (Array.isArray(value.input)) snippets.push(...this.extractTextSnippets(value.input));
        if (typeof value.message === 'string') snippets.push(...this.extractTextSnippets(value.message));

        return snippets;
    }

    private inferCodexRole(payload: any, fallback: 'assistant' | 'user' = 'assistant'): 'assistant' | 'user' {
        if (payload?.role === 'user') return 'user';
        if (payload?.role === 'assistant') return 'assistant';

        const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
        if (type.includes('user') || type.startsWith('input')) return 'user';
        if (type.includes('agent') || type.includes('assistant') || type.includes('output')) return 'assistant';

        return fallback;
    }

    private extractCodexMessages(thread: Thread): any[] {
        const messages: any[] = [];
        const turns = Array.isArray(thread.turns) ? thread.turns : [];

        for (const turn of turns) {
            const seenTurnMessages = new Set<string>();

            const turnInput = Array.isArray((turn as any).input) ? (turn as any).input : [];
            for (const input of turnInput) {
                const snippets = this.extractTextSnippets(input);
                for (const text of snippets) {
                    const dedupKey = `user:${text}`;
                    if (seenTurnMessages.has(dedupKey)) continue;
                    seenTurnMessages.add(dedupKey);
                    messages.push({
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'text', text }],
                        created_at: Date.now()
                    });
                }
            }

            const items = Array.isArray((turn as any).items) ? (turn as any).items : [];
            for (const item of items) {
                const payload = (item as any).item || item;
                const snippets = this.extractTextSnippets(payload);
                if (snippets.length === 0) continue;

                const role = this.inferCodexRole(payload);
                for (const text of snippets) {
                    const dedupKey = `${role}:${text}`;
                    if (seenTurnMessages.has(dedupKey)) continue;
                    seenTurnMessages.add(dedupKey);

                    messages.push({
                        type: 'message',
                        role,
                        content: [{ type: 'text', text }],
                        created_at: Date.now()
                    });
                }
            }
        }

        return messages;
    }

    private async readCodexThreadMessages(sessionId: string): Promise<{ messages: any[]; messageCount: number }> {
        const client = await this.ensureCodexClient();
        if (!client) return { messages: [], messageCount: 0 };

        try {
            const result = await client.readThread({ threadId: sessionId, includeTurns: true });
            const messages = this.extractCodexMessages(result.thread);
            const messageCount = messages.length || (Array.isArray(result.thread.turns) ? result.thread.turns.length : 0);
            return { messages, messageCount };
        } catch (error) {
            console.error(`[SyncService] Error reading Codex thread ${sessionId}:`, error);
            return { messages: [], messageCount: 0 };
        }
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
            const threads = await this.listCodexThreads();
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
                const record = this.normalizeThreadRecord(thread);
                if (!record) continue;

                currentIds.add(record.sessionId);
                const sessionKey = this.toSyncSessionKey(record.sessionId, 'codex');
                if (this.ownedSessions.has(sessionKey) || this.ownedSessions.has(record.sessionId)) {
                    continue;
                }

                const updatedAt = typeof thread.updatedAt === 'number'
                    ? thread.updatedAt
                    : (typeof thread.createdAt === 'number' ? thread.createdAt : 0);
                const previousUpdatedAt = this.codexThreadUpdatedAt.get(record.sessionId);

                if (previousUpdatedAt == null) {
                    this.codexThreadUpdatedAt.set(record.sessionId, updatedAt);

                    const { messages, messageCount } = await this.readCodexThreadMessages(record.sessionId);
                    const discovered: SyncSessionDiscoveredMessage = {
                        type: 'sync_session_discovered',
                        data: {
                            runnerId: this.wsManager.runnerId,
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

                const { messages, messageCount } = await this.readCodexThreadMessages(record.sessionId);
                const updated: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        session: {
                            sessionId: record.sessionId,
                            projectPath: record.projectPath,
                            cliType: 'codex',
                            firstPrompt: record.firstPrompt,
                            created: record.created,
                            messageCount,
                            gitBranch: record.gitBranch
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
    markAsOwned(sessionId: string, cliType: 'claude' | 'codex' = 'claude'): void {
        this.ownedSessions.add(this.toSyncSessionKey(sessionId, cliType));
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
        cliType: 'claude' | 'codex' = 'claude'
    ): Promise<void> {
        try {
            if (cliType === 'codex') {
                const { messages, messageCount } = await this.readCodexThreadMessages(sessionId);

                const codexMessage: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        session: {
                            sessionId,
                            projectPath: this.normalizeProjectPath(projectPath),
                            cliType: 'codex',
                            messageCount
                        },
                        newMessages: messages
                    }
                };
                this.wsManager.send(codexMessage);
                return;
            }

            const details = await getSessionDetailsAsync(sessionId, projectPath);
            const message: SyncSessionUpdatedMessage = {
                type: 'sync_session_updated',
                data: {
                    runnerId: this.wsManager.runnerId,
                    session: {
                        sessionId,
                        projectPath: this.normalizeProjectPath(projectPath),
                        cliType: 'claude',
                        messageCount: details?.messageCount || 0
                    },
                    newMessages: details?.messages || []
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
            const codexProjects = await this.listCodexProjects();
            const mergedProjects = new Map<string, { path: string; lastModified: Date; sessionCount: number }>();

            for (const project of claudeProjects) {
                const normalizedPath = this.normalizeProjectPath(project.path);
                mergedProjects.set(normalizedPath, {
                    path: normalizedPath,
                    lastModified: project.lastModified,
                    sessionCount: project.sessionCount
                });
            }

            for (const [projectPath, sessionCount] of codexProjects.entries()) {
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
        const normalizedProjectPath = this.normalizeProjectPath(projectPath);

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

            const codexSessions = await this.listCodexSessions(normalizedProjectPath);
            const sessions = [...claudeSessions, ...codexSessions];
            console.log(`[SyncService] Found ${sessions.length} sessions for ${normalizedProjectPath}`);
            const codexClient = codexSessions.length > 0 ? await this.ensureCodexClient() : null;

            const mappedSessions = [] as any[];
            for (const session of sessions) {
                const cliType: 'claude' | 'codex' = session.cliType === 'codex' ? 'codex' : 'claude';
                if (cliType === 'codex') {
                    let codexMessages = Array.isArray(session.messages) ? session.messages : [];
                    let codexMessageCount = typeof session.messageCount === 'number' ? session.messageCount : 0;

                    // thread/list does not reliably include turns; hydrate with thread/read for initial sync.
                    if (codexMessages.length === 0 && codexClient) {
                        const snapshot = await this.readCodexThreadMessages(session.sessionId);
                        codexMessages = snapshot.messages;
                        codexMessageCount = snapshot.messageCount;
                    }

                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: this.normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: codexMessageCount,
                        gitBranch: session.gitBranch,
                        messages: codexMessages
                    });
                } else {
                    const details = await getSessionDetailsAsync(session.sessionId, session.projectPath);
                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: this.normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: session.messageCount,
                        gitBranch: session.gitBranch,
                        messages: details?.messages || []
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
            requestId
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
        const details = await getSessionDetailsAsync(entry.sessionId, entry.projectPath);
        console.log(`[SyncService] Pushing session discovery: ${entry.sessionId} | Messages in file: ${details?.messages?.length || 0}`);
        const message: SyncSessionDiscoveredMessage = {
            type: 'sync_session_discovered',
            data: {
                runnerId: this.wsManager.runnerId,
                session: {
                    sessionId: entry.sessionId,
                    projectPath: this.normalizeProjectPath(entry.projectPath),
                    cliType: 'claude',
                    firstPrompt: entry.firstPrompt,
                    created: entry.created,
                    messageCount: entry.messageCount,
                    gitBranch: entry.gitBranch,
                    messages: details?.messages || []
                }
            }
        };
        this.wsManager.send(message);
    }

    /**
     * Push session update (new messages) to Bot
     */
    private async pushSessionUpdated(entry: SessionEntry): Promise<void> {
        const details = await getSessionDetailsAsync(entry.sessionId, entry.projectPath);

        const message: SyncSessionUpdatedMessage = {
            type: 'sync_session_updated',
            data: {
                runnerId: this.wsManager.runnerId,
                session: {
                    sessionId: entry.sessionId,
                    projectPath: this.normalizeProjectPath(entry.projectPath),
                    cliType: 'claude',
                    messageCount: details?.messageCount || entry.messageCount
                },
                newMessages: details?.messages || []
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
        if (this.codexClient) {
            void this.codexClient.shutdown().catch((error) => {
                console.error('[SyncService] Error shutting down Codex sync client:', error);
            });
            this.codexClient = null;
        }
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
