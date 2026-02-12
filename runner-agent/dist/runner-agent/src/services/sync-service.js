import { EventEmitter } from 'events';
import { SessionWatcher, listProjects, listSessions, getSessionDetails } from '../../../claude-client/src/sessions.js';
/**
 * Runner-side Sync Service
 *
 * Watches local files and pushes updates to Discord bot.
 */
export class RunnerSyncService extends EventEmitter {
    watcher;
    wsManager;
    ownedSessions = new Set(); // Sessions created/controlled by Discord
    constructor(wsManager) {
        super();
        this.wsManager = wsManager;
        this.watcher = new SessionWatcher();
        // Listen for watcher events
        this.watcher.on('session_new', (entry) => {
            if (this.ownedSessions.has(entry.sessionId))
                return;
            this.pushSessionDiscovered(entry);
        });
        this.watcher.on('session_updated', (entry) => {
            if (this.ownedSessions.has(entry.sessionId))
                return;
            this.pushSessionUpdated(entry);
        });
    }
    /**
     * Start watching projects
     */
    startWatching(projectPaths) {
        console.log(`[SyncService] Starting watch for ${projectPaths.length} projects`);
        projectPaths.forEach(path => {
            this.watcher.watchProject(path);
        });
    }
    /**
     * Mark a session as owned (don't push sync updates)
     */
    markAsOwned(sessionId) {
        this.ownedSessions.add(sessionId);
        this.watcher.markAsOwned(sessionId);
    }
    /**
     * Handle explicit sync projects request
     */
    async handleSyncProjects() {
        console.log('[SyncService] Handling sync_projects request');
        try {
            const projects = listProjects();
            const response = {
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
        }
        catch (error) {
            console.error('[SyncService] Error listing projects:', error);
        }
    }
    /**
     * Handle explicit sync sessions request
     */
    async handleSyncSessions(projectPath) {
        console.log(`[SyncService] Handling sync_sessions for ${projectPath}`);
        try {
            const sessions = await listSessions(projectPath);
            console.log(`[SyncService] Found ${sessions.length} sessions for ${projectPath}`);
            const payloadData = {
                runnerId: this.wsManager.runnerId,
                projectPath,
                sessions: sessions.map(s => {
                    const details = getSessionDetails(s.sessionId, s.projectPath);
                    return {
                        sessionId: s.sessionId,
                        projectPath: s.projectPath,
                        firstPrompt: s.firstPrompt,
                        created: s.created,
                        messageCount: s.messageCount,
                        gitBranch: s.gitBranch,
                        messages: details?.messages || []
                    };
                })
            };
            const response = {
                type: 'sync_sessions_response',
                data: payloadData
            };
            const json = JSON.stringify(response);
            console.log(`[SyncService] Generated response size: ${(json.length / 1024).toFixed(2)} KB`);
            const sent = this.wsManager.send(response);
            if (sent) {
                console.log(`[SyncService] Successfully sent sync response for ${projectPath}`);
            }
            else {
                console.error(`[SyncService] FAILED to send sync response (ws connection issue?)`);
            }
            // Messages are now included inline, no need for async hydration
            // Also ensure we are watching this project
            this.watcher.watchProject(projectPath);
        }
        catch (error) {
            console.error(`[SyncService] Error listing sessions for ${projectPath}:`, error);
        }
    }
    /**
     * Push new session discovery to Bot
     */
    pushSessionDiscovered(entry) {
        const details = getSessionDetails(entry.sessionId, entry.projectPath);
        console.log(`[SyncService] Pushing session discovery: ${entry.sessionId} | Messages in file: ${details?.messages?.length || 0}`);
        const message = {
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
    pushSessionUpdated(entry) {
        const details = getSessionDetails(entry.sessionId, entry.projectPath);
        const message = {
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
    shutdown() {
        this.watcher.close();
    }
}
// Singleton
let syncServiceInstance = null;
export function getSyncService(wsManager) {
    if (!syncServiceInstance && wsManager) {
        syncServiceInstance = new RunnerSyncService(wsManager);
    }
    return syncServiceInstance;
}
