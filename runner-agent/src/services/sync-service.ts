
import { EventEmitter } from 'events';
import { 
    SessionWatcher, 
    SessionEntry, 
    listProjectsAsync, 
    listSessions, 
    getSessionDetailsAsync
} from '../../../claude-client/src/sessions.js';
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
    private ownedSessions = new Set<string>(); // Sessions created/controlled by Discord
    private syncProjectsTask: Promise<void> | null = null;
    private syncSessionsTasks = new Map<string, Promise<void>>();
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

    constructor(wsManager: WebSocketManager) {
        super();
        this.wsManager = wsManager;
        this.watcher = new SessionWatcher();

        // Listen for watcher events
        this.watcher.on('session_new', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId)) return;
            void this.pushSessionDiscovered(entry);
        });

        this.watcher.on('session_updated', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId)) return;
            void this.pushSessionUpdated(entry);
        });
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
    markAsOwned(sessionId: string): void {
        this.ownedSessions.add(sessionId);
        this.watcher.markAsOwned(sessionId);
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
            const projects = await listProjectsAsync();

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

        const projectStatus = this.syncStatus.projects.get(projectPath) || {
            projectPath,
            state: 'idle' as const
        };
        projectStatus.state = 'syncing';
        projectStatus.lastError = undefined;
        this.syncStatus.projects.set(projectPath, projectStatus);

        try {
            const sessions = await listSessions(projectPath);
            console.log(`[SyncService] Found ${sessions.length} sessions for ${projectPath}`);

            const mappedSessions = [] as any[];
            for (const s of sessions) {
                const details = await getSessionDetailsAsync(s.sessionId, s.projectPath);
                mappedSessions.push({
                    sessionId: s.sessionId,
                    projectPath: s.projectPath,
                    firstPrompt: s.firstPrompt,
                    created: s.created,
                    messageCount: s.messageCount,
                    gitBranch: s.gitBranch,
                    messages: details?.messages || []
                });

                await new Promise<void>(resolve => setImmediate(resolve));
            }

            await this.sendSyncSessionsInChunks(projectPath, requestId, mappedSessions);

            this.watcher.watchProject(projectPath);

            projectStatus.state = 'complete';
            projectStatus.lastSyncAt = new Date().toISOString();
            projectStatus.sessionCount = sessions.length;
            this.syncStatus.projects.set(projectPath, projectStatus);

            this.wsManager.send({
                type: 'sync_sessions_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projectPath,
                    requestId,
                    status: 'success',
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString(),
                    sessionCount: sessions.length
                }
            } as SyncSessionsCompleteMessage);
        } catch (error: any) {
            console.error(`[SyncService] Error listing sessions for ${projectPath}:`, error);
            projectStatus.state = 'error';
            projectStatus.lastError = error?.message || String(error);
            this.syncStatus.projects.set(projectPath, projectStatus);

            this.wsManager.send({
                type: 'sync_sessions_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projectPath,
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
                    projectPath: entry.projectPath,
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
                    projectPath: entry.projectPath,
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
    }
}

// Singleton
let syncServiceInstance: RunnerSyncService | null = null;

export function getSyncService(wsManager?: WebSocketManager): RunnerSyncService | null {
    if (!syncServiceInstance && wsManager) {
        syncServiceInstance = new RunnerSyncService(wsManager);
    }
    return syncServiceInstance;
}
