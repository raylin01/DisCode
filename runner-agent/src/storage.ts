/**
 * Session Storage
 *
 * Persists CLI session IDs so sessions can be resumed after runner-agent restart.
 * Maps DisCode session IDs to CLI-specific session IDs (Claude, Gemini, Codex).
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface PersistedSession {
    /** DisCode session ID (UUID) */
    sessionId: string;
    /** CLI's internal session ID for resumption */
    cliSessionId: string;
    /** CLI type */
    cliType: 'claude' | 'gemini' | 'codex' | 'terminal' | 'generic';
    /** Plugin type */
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk';
    /** Working directory */
    folderPath?: string;
    /** Runner ID */
    runnerId: string;
    /** When session was created */
    createdAt: string;
    /** Last activity timestamp */
    lastActivityAt: string;
}

const STORAGE_PATH = process.env.DISCODE_RUNNER_STORAGE || './data';
const SESSIONS_FILE = path.join(STORAGE_PATH, 'runner-sessions.yaml');

class SessionStorage {
    private sessions: Map<string, PersistedSession> = new Map();
    private initialized = false;

    constructor() {
        this.ensureDirectories();
        this.load();
        this.initialized = true;
    }

    private ensureDirectories(): void {
        if (!fs.existsSync(STORAGE_PATH)) {
            fs.mkdirSync(STORAGE_PATH, { recursive: true });
        }
    }

    private load(): void {
        try {
            if (fs.existsSync(SESSIONS_FILE)) {
                const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
                const parsed = yaml.load(data) as Record<string, PersistedSession> | null | undefined;
                if (parsed) {
                    for (const [id, session] of Object.entries(parsed)) {
                        if (session && session.sessionId && session.cliSessionId) {
                            this.sessions.set(id, session);
                        }
                    }
                }
                console.log(`[Storage] Loaded ${this.sessions.size} persisted sessions from ${SESSIONS_FILE}`);
            }
        } catch (error) {
            console.error('[Storage] Error loading session storage:', error);
            // Start with empty sessions on error
            this.sessions.clear();
        }
    }

    private save(): void {
        if (!this.initialized) return;

        try {
            const obj: Record<string, PersistedSession> = {};
            for (const [id, session] of this.sessions) {
                obj[id] = session;
            }
            fs.writeFileSync(SESSIONS_FILE, yaml.dump(obj), 'utf-8');
        } catch (error) {
            console.error('[Storage] Error saving session storage:', error);
        }
    }

    /**
     * Save or update a session
     */
    saveSession(session: PersistedSession): void {
        this.sessions.set(session.sessionId, session);
        this.save();
        console.log(`[Storage] Saved session ${session.sessionId.slice(0, 8)} -> CLI:${session.cliSessionId.slice(0, 8)}`);
    }

    /**
     * Get a session by DisCode session ID
     */
    getSession(sessionId: string): PersistedSession | null {
        return this.sessions.get(sessionId) || null;
    }

    /**
     * Get the CLI session ID for resumption
     */
    getCliSessionId(sessionId: string): string | null {
        const session = this.sessions.get(sessionId);
        return session?.cliSessionId || null;
    }

    /**
     * Update the last activity timestamp
     */
    updateActivity(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.lastActivityAt = new Date().toISOString();
            this.save();
        }
    }

    /**
     * Delete a session
     */
    deleteSession(sessionId: string): void {
        if (this.sessions.has(sessionId)) {
            this.sessions.delete(sessionId);
            this.save();
            console.log(`[Storage] Deleted session ${sessionId.slice(0, 8)}`);
        }
    }

    /**
     * Get all sessions
     */
    getAllSessions(): Map<string, PersistedSession> {
        return new Map(this.sessions);
    }

    /**
     * Get session count
     */
    get size(): number {
        return this.sessions.size;
    }

    /**
     * Cleanup sessions older than maxAgeMs
     * @param maxAgeMs Maximum age in milliseconds (default: 7 days)
     * @returns Number of sessions cleaned up
     */
    cleanupOldSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
        const cutoff = new Date(Date.now() - maxAgeMs);
        let cleaned = 0;

        for (const [id, session] of this.sessions) {
            const lastActivity = new Date(session.lastActivityAt);
            if (lastActivity < cutoff) {
                this.sessions.delete(id);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.save();
            console.log(`[Storage] Cleaned up ${cleaned} old sessions (older than ${maxAgeMs}ms)`);
        }

        return cleaned;
    }
}

// Singleton instance
export const sessionStorage = new SessionStorage();
