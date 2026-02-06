
import { EventEmitter } from 'events';
import { 
    SessionWatcher, 
    SessionEntry, 
    listProjects, 
    listSessions, 
    getSessionDetails,
    getMessagesSince
} from '../../../claude-client/src/sessions.js';
import { WebSocketManager } from '../websocket.js';
import { 
    SyncProjectsResponseMessage, 
    SyncSessionsResponseMessage, 
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

    constructor(wsManager: WebSocketManager) {
        super();
        this.wsManager = wsManager;
        this.watcher = new SessionWatcher();

        // Listen for watcher events
        this.watcher.on('session_new', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId)) return;
            this.pushSessionDiscovered(entry);
        });

        this.watcher.on('session_updated', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId)) return;
            this.pushSessionUpdated(entry);
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
     * Handle explicit sync projects request
     */
    async handleSyncProjects(): Promise<void> {
        console.log('[SyncService] Handling sync_projects request');
        try {
            const projects = listProjects();
            const response: SyncProjectsResponseMessage = {
                type: 'sync_projects_response',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projects: projects.map(p => ({
                        path: p.path,
                        lastModified: p.lastModified.toISOString(),
                        sessionCount: p.sessionCount
                    }))
                }
            };
            this.wsManager.send(response);
            
            // Auto-watch discovered projects
            this.startWatching(projects.map(p => p.path));
        } catch (error) {
            console.error('[SyncService] Error listing projects:', error);
        }
    }

    /**
     * Handle explicit sync sessions request
     */
    async handleSyncSessions(projectPath: string): Promise<void> {
        console.log(`[SyncService] Handling sync_sessions for ${projectPath}`);
        try {
            const sessions = listSessions(projectPath);
            const response: SyncSessionsResponseMessage = {
                type: 'sync_sessions_response',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projectPath,
                    sessions: sessions.map(s => ({
                        sessionId: s.sessionId,
                        projectPath: s.projectPath,
                        firstPrompt: s.firstPrompt,
                        created: s.created,
                        messageCount: s.messageCount,
                        gitBranch: s.gitBranch
                    }))
                }
            };
            this.wsManager.send(response);

            // Asynchronously hydrate session history to avoid blocking
            this.hydrateSessionHistory(sessions, projectPath).catch(err => 
                console.error('[SyncService] Error hydrating sessions:', err)
            );
            
            // Also ensure we are watching this project
            this.watcher.watchProject(projectPath);
        } catch (error) {
            console.error(`[SyncService] Error listing sessions for ${projectPath}:`, error);
        }
    }

    /**
     * Push new session discovery to Bot
     */
    private pushSessionDiscovered(entry: SessionEntry): void {
        const details = getSessionDetails(entry.sessionId, entry.projectPath);
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
    private async hydrateSessionHistory(sessions: any[], projectPath: string): Promise<void> {
        // Sort by most recent first so active work syncs first
        const sorted = [...sessions].sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

        for (const session of sorted) {
            // Yield to event loop to allow heartbeats and other processing
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Push update (which includes messages)
            this.pushSessionUpdated({
                sessionId: session.sessionId,
                projectPath: session.projectPath,
                firstPrompt: session.firstPrompt,
                created: session.created,
                messageCount: session.messageCount, 
                gitBranch: session.gitBranch
            } as SessionEntry);
        }
    }

    /**
     * Push session update (new messages) to Bot
     */
    private pushSessionUpdated(entry: SessionEntry): void {
        const details = getSessionDetails(entry.sessionId, entry.projectPath);
        
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
