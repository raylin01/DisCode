/**
 * Sync State Management
 *
 * Manages state tracking for runner sync operations, including:
 * - Runner states and project states
 * - Sync status tracking
 * - Pending request tracking
 * - Message deduplication
 * - Session ownership tracking
 */

import type {
    SyncedCliType,
    SyncedSession,
    RunnerSyncState,
    ProjectSyncState,
    ProjectSyncStatus,
    RunnerSyncStatus,
    PendingSyncStatusRequest,
    PendingProjectSyncRequest,
    PendingSessionSyncRequest,
} from './sync-types.js';

/**
 * Configuration options for SyncStateManager
 */
export interface SyncStateConfig {
    maxDedupEntries: number;
}

/**
 * Manages all state for session sync operations
 */
export class SyncStateManager {
    // Runner states
    private runnerStates = new Map<string, RunnerSyncState>();
    private runnerSyncStatus = new Map<string, RunnerSyncStatus>();

    // Session ownership
    private ownedSessions = new Set<string>();

    // Pending requests
    private pendingSyncStatusRequests = new Map<string, PendingSyncStatusRequest>();
    private pendingProjectSyncRequests = new Map<string, PendingProjectSyncRequest>();
    private pendingSessionSyncRequests = new Map<string, PendingSessionSyncRequest>();

    // Message deduplication
    private messageDedup = new Map<string, Set<string>>();
    private readonly maxDedupEntries: number;

    // Session creation locks
    private sessionCreationLocks = new Map<string, Promise<void>>();

    constructor(config: Partial<SyncStateConfig> = {}) {
        this.maxDedupEntries = config.maxDedupEntries ?? 5000;
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Normalize a project path for consistent comparisons
     */
    normalizeProjectPath(projectPath: string): string {
        if (!projectPath || typeof projectPath !== 'string') return projectPath;
        const trimmed = projectPath.trim();
        if (!trimmed) return trimmed;
        const stripped = trimmed.replace(/[\\/]+$/, '');
        return stripped.length > 0 ? stripped : trimmed;
    }

    /**
     * Create a session key from sessionId and cliType
     */
    toSessionKey(sessionId: string, cliType: SyncedCliType = 'claude'): string {
        return `${cliType}:${sessionId}`;
    }

    /**
     * Resolve CLI type from raw session data
     */
    resolveSyncedCliType(raw: any): SyncedCliType {
        if (raw?.cliType === 'codex') return 'codex';
        if (raw?.cliType === 'gemini') return 'gemini';
        return 'claude';
    }

    /**
     * Resolve persisted session record from storage
     */
    resolvePersistedSessionRecord(
        sessionsRecord: Record<string, { threadId: string; projectPath: string; lastSync?: string; cliType?: 'claude' | 'codex' | 'gemini' }> | undefined,
        sessionId: string,
        cliType: SyncedCliType
    ): { key: string; data: { threadId: string; projectPath: string; lastSync?: string; cliType?: 'claude' | 'codex' | 'gemini' } } | null {
        if (!sessionsRecord) return null;
        const preferredKey = this.toSessionKey(sessionId, cliType);
        const preferred = sessionsRecord[preferredKey];
        if (preferred) return { key: preferredKey, data: preferred };

        // Backward compatibility for pre-cliType persisted keys.
        const legacy = sessionsRecord[sessionId];
        if (legacy) return { key: sessionId, data: legacy };

        return null;
    }

    /**
     * Generate a thread name from a prompt
     */
    generateThreadName(prompt: string): string {
        if (!prompt) return 'New Session';
        const words = prompt.split(/\s+/).slice(0, 8).join(' ');
        return words.length <= 50 ? words : words.slice(0, 47) + '...';
    }

    // ============================================================================
    // Runner State Management
    // ============================================================================

    hasRunnerState(runnerId: string): boolean {
        return this.runnerStates.has(runnerId);
    }

    getRunnerState(runnerId: string): RunnerSyncState | undefined {
        return this.runnerStates.get(runnerId);
    }

    setRunnerState(runnerId: string, state: RunnerSyncState): void {
        this.runnerStates.set(runnerId, state);
    }

    deleteRunnerState(runnerId: string): boolean {
        return this.runnerStates.delete(runnerId);
    }

    createRunnerState(runnerId: string): RunnerSyncState {
        const state: RunnerSyncState = {
            runnerId,
            projects: new Map()
        };
        this.runnerStates.set(runnerId, state);
        return state;
    }

    // ============================================================================
    // Project State Management
    // ============================================================================

    getProjectState(runnerId: string, projectPath: string): ProjectSyncState | undefined {
        const normalizedPath = this.normalizeProjectPath(projectPath);
        return this.runnerStates.get(runnerId)?.projects.get(normalizedPath);
    }

    setProjectState(runnerId: string, projectPath: string, state: ProjectSyncState): void {
        const normalizedPath = this.normalizeProjectPath(projectPath);
        const runnerState = this.runnerStates.get(runnerId);
        if (runnerState) {
            runnerState.projects.set(normalizedPath, state);
        }
    }

    // ============================================================================
    // Sync Status Management
    // ============================================================================

    ensureRunnerSyncStatus(runnerId: string): RunnerSyncStatus {
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

    getRunnerSyncStatus(runnerId: string): RunnerSyncStatus | undefined {
        return this.runnerSyncStatus.get(runnerId);
    }

    // ============================================================================
    // Session Ownership
    // ============================================================================

    markSessionAsOwned(sessionId: string, cliType: SyncedCliType = 'claude'): void {
        this.ownedSessions.add(this.toSessionKey(sessionId, cliType));
    }

    unmarkSessionOwnership(sessionId: string, cliType: SyncedCliType = 'claude'): void {
        this.ownedSessions.delete(this.toSessionKey(sessionId, cliType));
    }

    isSessionOwned(sessionId: string, cliType: SyncedCliType = 'claude'): boolean {
        return this.ownedSessions.has(this.toSessionKey(sessionId, cliType));
    }

    // ============================================================================
    // Pending Requests
    // ============================================================================

    // Sync Status Requests
    setPendingSyncStatusRequest(requestId: string, request: PendingSyncStatusRequest): void {
        this.pendingSyncStatusRequests.set(requestId, request);
    }

    getPendingSyncStatusRequest(requestId: string): PendingSyncStatusRequest | undefined {
        return this.pendingSyncStatusRequests.get(requestId);
    }

    deletePendingSyncStatusRequest(requestId: string): boolean {
        return this.pendingSyncStatusRequests.delete(requestId);
    }

    // Project Sync Requests
    setPendingProjectSyncRequest(requestId: string, request: PendingProjectSyncRequest): void {
        this.pendingProjectSyncRequests.set(requestId, request);
    }

    getPendingProjectSyncRequest(requestId: string): PendingProjectSyncRequest | undefined {
        return this.pendingProjectSyncRequests.get(requestId);
    }

    deletePendingProjectSyncRequest(requestId: string): boolean {
        return this.pendingProjectSyncRequests.delete(requestId);
    }

    findPendingProjectSyncRequestsByRunner(runnerId: string): Array<[string, PendingProjectSyncRequest]> {
        return Array.from(this.pendingProjectSyncRequests.entries())
            .filter(([_, req]) => req.runnerId === runnerId);
    }

    // Session Sync Requests
    setPendingSessionSyncRequest(requestId: string, request: PendingSessionSyncRequest): void {
        this.pendingSessionSyncRequests.set(requestId, request);
    }

    getPendingSessionSyncRequest(requestId: string): PendingSessionSyncRequest | undefined {
        return this.pendingSessionSyncRequests.get(requestId);
    }

    deletePendingSessionSyncRequest(requestId: string): boolean {
        return this.pendingSessionSyncRequests.delete(requestId);
    }

    findPendingSessionSyncRequestsByProject(runnerId: string, projectPath: string): Array<[string, PendingSessionSyncRequest]> {
        const normalizedPath = this.normalizeProjectPath(projectPath);
        return Array.from(this.pendingSessionSyncRequests.entries())
            .filter(([_, req]) => req.runnerId === runnerId && this.normalizeProjectPath(req.projectPath) === normalizedPath);
    }

    // ============================================================================
    // Message Deduplication
    // ============================================================================

    /**
     * Filter out duplicate messages based on their IDs
     */
    filterNewMessages(sessionId: string, messages: any[]): any[] {
        if (!messages || messages.length === 0) return [];

        let set = this.messageDedup.get(sessionId);
        if (!set) {
            set = new Set<string>();
            this.messageDedup.set(sessionId, set);
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

        // Trim if too large
        if (set.size > this.maxDedupEntries) {
            const trimmed = new Set<string>(Array.from(set).slice(-this.maxDedupEntries));
            this.messageDedup.set(sessionId, trimmed);
        }

        return result;
    }

    /**
     * Get a unique ID for a message
     */
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

    // ============================================================================
    // Session Creation Locks
    // ============================================================================

    hasSessionCreationLock(sessionKey: string): boolean {
        return this.sessionCreationLocks.has(sessionKey);
    }

    getSessionCreationLock(sessionKey: string): Promise<void> | undefined {
        return this.sessionCreationLocks.get(sessionKey);
    }

    setSessionCreationLock(sessionKey: string, lock: Promise<void>): void {
        this.sessionCreationLocks.set(sessionKey, lock);
    }

    deleteSessionCreationLock(sessionKey: string): void {
        this.sessionCreationLocks.delete(sessionKey);
    }

    // ============================================================================
    // Query Methods
    // ============================================================================

    /**
     * Get a session by its Discord thread ID
     */
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

    /**
     * Get a session by its external session ID
     */
    getSessionByExternalSessionId(
        runnerId: string,
        externalSessionId: string,
        cliType?: SyncedCliType
    ): { runnerId: string; projectPath: string; session: SyncedSession } | null {
        const runnerState = this.runnerStates.get(runnerId);
        if (!runnerState) return null;

        for (const [projectPath, projectState] of runnerState.projects) {
            for (const session of projectState.sessions.values()) {
                if (session.externalSessionId !== externalSessionId) continue;
                if (cliType && session.cliType !== cliType) continue;
                return { runnerId, projectPath, session };
            }
        }

        return null;
    }

    /**
     * Get project stats for display
     */
    getProjectStats(runnerId: string, projectPath: string): { totalSessions: number; activeSessions: number; pendingActions: number } {
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
}
