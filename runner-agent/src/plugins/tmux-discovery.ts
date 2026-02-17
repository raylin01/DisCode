/**
 * Tmux Session Discovery
 *
 * Handles discovery and monitoring of external tmux sessions.
 * Used to watch existing terminal sessions that weren't created by the plugin.
 */

import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const EXEC_OPTIONS = {
    maxBuffer: 1024 * 1024,
    timeout: 30000
};

/**
 * Information about a discovered session
 */
export interface DiscoveredSession {
    sessionId: string;
    exists: boolean;
    cwd: string | null;
}

/**
 * Events emitted by TmuxDiscovery
 */
export interface TmuxDiscoveryEvents {
    session_discovered: DiscoveredSession;
}

/**
 * TmuxDiscovery - Discovers and monitors external tmux sessions
 */
export class TmuxDiscovery extends EventEmitter {
    private tmuxPath: string;
    private sessionDiscoveryInterval?: NodeJS.Timeout;
    private discoveredSessions = new Set<string>();
    private logger: (msg: string) => void;

    constructor(tmuxPath: string, logger?: (msg: string) => void) {
        super();
        this.tmuxPath = tmuxPath;
        this.logger = logger || ((msg: string) => console.log(`[TmuxDiscovery] ${msg}`));
    }

    /**
     * List all tmux sessions
     */
    async listSessions(): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync(this.tmuxPath, ['list-sessions', '-F', '#{session_name}']);
            return stdout.trim().split('\n').filter(s => s.length > 0);
        } catch (e) {
            // If no sessions, tmux returns error code 1
            return [];
        }
    }

    /**
     * Get the current working directory of a tmux session
     */
    async getSessionCwd(sessionId: string): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(
                this.tmuxPath,
                ['display-message', '-t', sessionId, '-p', '#{pane_current_path}'],
                EXEC_OPTIONS
            );
            const cwd = stdout.trim();
            return cwd || null;
        } catch (e) {
            this.logger(`Failed to get cwd for session ${sessionId}: ${e}`);
            return null;
        }
    }

    /**
     * Start polling for new sessions
     * @param intervalMs - Polling interval in milliseconds (default: 5000)
     * @param skipSessionCheck - Optional function to skip certain sessions
     */
    startDiscovery(
        intervalMs: number = 5000,
        skipSessionCheck?: (sessionName: string) => boolean
    ): void {
        this.sessionDiscoveryInterval = setInterval(async () => {
            try {
                const currentSessions = await this.listSessions();

                for (const session of currentSessions) {
                    if (!this.discoveredSessions.has(session)) {
                        this.discoveredSessions.add(session);

                        // Skip assistant sessions - they are managed separately
                        if (session.includes('assistan')) {
                            this.logger(`Skipping assistant session: ${session}`);
                            continue;
                        }

                        // Use custom skip check if provided
                        if (skipSessionCheck && skipSessionCheck(session)) {
                            continue;
                        }

                        // Get the cwd for the discovered session
                        const cwd = await this.getSessionCwd(session);
                        this.logger(`Discovered new external session: ${session} (cwd: ${cwd || 'unknown'})`);

                        this.emit('session_discovered', {
                            sessionId: session,
                            exists: true,
                            cwd: cwd
                        });
                    }
                }
            } catch (e) {
                // Ignore errors (e.g. no sessions)
            }
        }, intervalMs);
    }

    /**
     * Stop session discovery polling
     */
    stopDiscovery(): void {
        if (this.sessionDiscoveryInterval) {
            clearInterval(this.sessionDiscoveryInterval);
            this.sessionDiscoveryInterval = undefined;
        }
    }

    /**
     * Check if a session has already been discovered
     */
    hasDiscovered(sessionName: string): boolean {
        return this.discoveredSessions.has(sessionName);
    }

    /**
     * Mark a session as discovered (to prevent re-emission)
     */
    markDiscovered(sessionName: string): void {
        this.discoveredSessions.add(sessionName);
    }

    /**
     * Clean up orphaned discode sessions from previous runs
     */
    async cleanupOrphanedSessions(sessionsToPreserve?: Set<string>): Promise<number> {
        this.logger('Checking for orphaned discode-* sessions...');
        try {
            const sessions = await this.listSessions();
            let count = 0;
            for (const session of sessions) {
                if (session.startsWith('discode-')) {
                    // Skip if it's in the preserve list
                    if (sessionsToPreserve && sessionsToPreserve.has(session)) {
                        continue;
                    }

                    this.logger(`Cleaning up orphaned session: ${session}`);
                    try {
                        await execFileAsync(this.tmuxPath, ['kill-session', '-t', session], EXEC_OPTIONS);
                        count++;
                    } catch (e) {
                        // Ignore
                    }
                }
            }
            if (count > 0) {
                this.logger(`Cleaned up ${count} orphaned sessions.`);
            } else {
                this.logger('No orphaned sessions found.');
            }
            return count;
        } catch (e) {
            // Ignore (e.g. no sessions)
            return 0;
        }
    }

    /**
     * Get list of active tmux sessions for health checking
     */
    async getActiveSessions(): Promise<Set<string>> {
        try {
            const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"', {
                timeout: 10000,
                maxBuffer: 1024 * 1024
            });
            return new Set(stdout.trim().split('\n'));
        } catch {
            return new Set();
        }
    }
}
