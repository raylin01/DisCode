/**
 * Session Sync Types
 *
 * Type definitions for the session sync service.
 * These types are shared across sync modules.
 */

// CLI types that can be synced
export type SyncedCliType = 'claude' | 'codex' | 'gemini';

/**
 * Represents a synced session from a CLI client
 */
export interface SyncedSession {
    sessionId: string;
    externalSessionId: string;  // Session/thread ID from upstream CLI
    cliType: SyncedCliType;
    syncFormatVersion?: number;
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

/**
 * State for a runner's sync operations
 */
export interface RunnerSyncState {
    runnerId: string;
    projects: Map<string, ProjectSyncState>;  // projectPath -> state
}

/**
 * State for syncing a specific project
 */
export interface ProjectSyncState {
    projectPath: string;
    channelId: string;
    sessions: Map<string, SyncedSession>;  // `${cliType}:${sessionId}` -> session
    lastSync: Date;
}

/**
 * Status of a project sync operation
 */
export interface ProjectSyncStatus {
    projectPath: string;
    state: 'idle' | 'syncing' | 'complete' | 'error';
    lastSyncAt?: Date;
    lastError?: string;
    sessionCount?: number;
}

/**
 * Status of a runner's sync operations
 */
export interface RunnerSyncStatus {
    runnerId: string;
    state: 'idle' | 'syncing' | 'error';
    lastSyncAt?: Date;
    lastError?: string;
    projects: Map<string, ProjectSyncStatus>;
}

/**
 * Pending sync status request
 */
export interface PendingSyncStatusRequest {
    resolve: (status: RunnerSyncStatus | null) => void;
    timeout: NodeJS.Timeout;
}

/**
 * Pending project sync request
 */
export interface PendingProjectSyncRequest {
    runnerId: string;
    attempts: number;
    timeout: NodeJS.Timeout;
}

/**
 * Pending session sync request
 */
export interface PendingSessionSyncRequest {
    runnerId: string;
    projectPath: string;
    attempts: number;
    timeout: NodeJS.Timeout;
}

/**
 * Normalized message structure
 */
export interface NormalizedMessage {
    role: 'user' | 'assistant';
    content: any;
}
