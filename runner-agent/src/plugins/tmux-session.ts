/**
 * TmuxSession - Session management for tmux-based CLI sessions
 *
 * Represents an individual tmux session that can be either:
 * - Owned: Created and managed by this plugin
 * - Watched: An external session we're observing
 */

import { EventEmitter } from 'events';
import {
    PluginSession,
    SessionConfig,
    SessionStatus,
    ApprovalOption
} from './base.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const EXEC_OPTIONS = {
    maxBuffer: 1024 * 1024,
    timeout: 30000
};

/**
 * Safely send text to tmux session
 * Handles special characters and prevents injection
 */
export async function sendToTmuxSafe(tmuxSession: string, text: string, tmuxPath: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(tmuxSession)) {
        throw new Error(`Invalid tmux session name: ${tmuxSession}`);
    }

    // Use send-keys with literal flag to prevent interpretation
    // Split into chunks if very long
    const MAX_CHUNK = 500;

    for (let i = 0; i < text.length; i += MAX_CHUNK) {
        const chunk = text.slice(i, i + MAX_CHUNK);
        await execFileAsync(tmuxPath, ['send-keys', '-t', tmuxSession, '-l', chunk], EXEC_OPTIONS);
    }

    // Send Enter key
    await execFileAsync(tmuxPath, ['send-keys', '-t', tmuxSession, 'Enter'], EXEC_OPTIONS);
}

/**
 * TmuxSession - Concrete implementation of PluginSession using tmux
 */
export class TmuxSession extends EventEmitter implements PluginSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly createdAt: Date;

    status: SessionStatus = 'idle';
    lastActivity: Date;

    // Readiness tracking
    isReady: boolean = false;
    private booting: boolean = true;

    /** Internal tmux session name */
    readonly tmuxPath: string;

    /** Internal tmux session name */
    readonly tmuxSession: string;
    /** Current tool being used */
    currentTool?: string;
    /** Pending permission prompt */
    pendingPermission?: {
        tool: string;
        context: string;
        options: ApprovalOption[];
        detectedAt: Date;
    };
    /** Whether bypass warning has been handled */
    bypassWarningHandled = false;
    /** Last captured output for diffing */
    lastOutput = '';
    /** Token tracking */
    lastTokenCount = 0;
    cumulativeTokens = 0;
    /** Current mode (bypass, etc.) */
    currentMode?: string;
    /** Current activity (Thinking, Working, etc.) */
    currentActivity?: string;

    /** Last hook event timestamp (to debounce scraping) */
    lastHookEvent = 0;

    /** Whether this session is owned by us (true) or just watched (false) */
    readonly isOwned: boolean;

    /** Whether a command is currently running (for watched terminals) */
    isCommandRunning: boolean = false;

    constructor(config: SessionConfig, tmuxSession: string, tmuxPath: string, isOwned = true) {
        super();
        this.sessionId = config.sessionId;
        this.config = config;
        this.tmuxSession = tmuxSession;
        this.tmuxPath = tmuxPath;
        this.isOwned = isOwned;
        this.createdAt = new Date();
        this.lastActivity = new Date();

        // If not owned (watched session), assume ready immediately
        if (!isOwned) {
            this.booting = false;
            this.isReady = true;
            this.status = 'idle';
        }
    }

    async sendMessage(message: string): Promise<void> {
        console.log(`[TmuxSession] Sending message to ${this.tmuxSession}: ${JSON.stringify(message)}`);
        await sendToTmuxSafe(this.tmuxSession, message, this.tmuxPath);
        this.lastActivity = new Date();
        this.status = 'working';
    }

    async sendApproval(optionNumber: string, _message?: string, _requestId?: string): Promise<void> {
        if (!/^\d+$/.test(optionNumber)) {
            throw new Error(`Invalid approval option: ${optionNumber}`);
        }
        // Send number and Enter to ensure it's submitted
        console.log(`[TmuxSession] Sending approval option ${optionNumber} to ${this.tmuxSession} using ${this.tmuxPath}`);
        try {
            // Send number first
            await execFileAsync(this.tmuxPath, ['send-keys', '-t', this.tmuxSession, optionNumber], EXEC_OPTIONS);
            // Short delay to ensure it registers? usually not needed but safety
            // Then send Enter (using C-m is often safer than "Enter" keyword)
            await execFileAsync(this.tmuxPath, ['send-keys', '-t', this.tmuxSession, 'C-m'], EXEC_OPTIONS);
            console.log(`[TmuxSession] Approval sent successfully`);
        } catch (e) {
            console.error(`[TmuxSession] Failed to send approval:`, e);
            throw e;
        }
        this.pendingPermission = undefined;
        this.status = 'working';
        this.lastActivity = new Date();
    }

    async close(): Promise<void> {
        try {
            await execFileAsync(this.tmuxPath, ['kill-session', '-t', this.tmuxSession], EXEC_OPTIONS);
        } catch (e) {
            // Session might already be dead
        }
        this.status = 'offline';
        this.removeAllListeners();
    }

    /**
     * Interrupt the current CLI execution by sending Ctrl+C
     */
    async interrupt(): Promise<void> {
        console.log(`[TmuxSession] Sending interrupt (Ctrl+C) to ${this.tmuxSession}`);
        try {
            // Send Ctrl+C (C-c in tmux notation)
            await execFileAsync(this.tmuxPath, ['send-keys', '-t', this.tmuxSession, 'C-c'], EXEC_OPTIONS);
            console.log(`[TmuxSession] Interrupt sent successfully`);
            this.status = 'idle';
            this.lastActivity = new Date();
        } catch (e) {
            console.error(`[TmuxSession] Failed to send interrupt:`, e);
            throw e;
        }
    }

    // Internal method to mark as ready
    setReady(): void {
        if (!this.isReady) {
            this.isReady = true;
            this.booting = false;
            this.emit('ready');
        }
    }

    isBooting(): boolean {
        return this.booting;
    }
}
