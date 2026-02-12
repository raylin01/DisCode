import { EventEmitter } from 'events';
import { WebSocketManager } from '../websocket.js';
/**
 * Runner-side Sync Service
 *
 * Watches local files and pushes updates to Discord bot.
 */
export declare class RunnerSyncService extends EventEmitter {
    private watcher;
    private wsManager;
    private ownedSessions;
    constructor(wsManager: WebSocketManager);
    /**
     * Start watching projects
     */
    startWatching(projectPaths: string[]): void;
    /**
     * Mark a session as owned (don't push sync updates)
     */
    markAsOwned(sessionId: string): void;
    /**
     * Handle explicit sync projects request
     */
    handleSyncProjects(): Promise<void>;
    /**
     * Handle explicit sync sessions request
     */
    handleSyncSessions(projectPath: string): Promise<void>;
    /**
     * Push new session discovery to Bot
     */
    private pushSessionDiscovered;
    /**
     * Push session update (new messages) to Bot
     */
    private pushSessionUpdated;
    /**
     * Shutdown
     */
    shutdown(): void;
}
export declare function getSyncService(wsManager?: WebSocketManager): RunnerSyncService | null;
