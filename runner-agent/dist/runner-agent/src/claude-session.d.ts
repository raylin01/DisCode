/**
 * Claude CLI Session Manager
 * Uses -p (print mode) with --session-id/--resume for conversation persistence
 *
 * Features:
 * - Real-time streaming output via spawn
 * - Clean CPU warning removal
 */
import { EventEmitter } from 'events';
export interface ClaudeMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}
export interface ClaudeResponse {
    content: string;
    success: boolean;
    error?: string;
    sessionId?: string;
}
export interface StreamUpdate {
    content: string;
    isComplete: boolean;
}
export declare class ClaudeSession extends EventEmitter {
    private sessionId;
    private cwd;
    private cliPath;
    private messageHistory;
    private currentProcess;
    constructor(cliPath: string, cwd: string, sessionId?: string);
    /**
     * Send a message to Claude and get response with streaming
     * Uses -p mode with --session-id/--resume for conversation persistence
     * Emits 'stream' events for real-time updates
     */
    sendMessage(message: string): Promise<ClaudeResponse>;
    /**
     * Send approval response - NOT USED with -p mode
     * Kept for API compatibility
     */
    sendApproval(approved: boolean): void;
    /**
     * Close the session
     */
    close(): Promise<void>;
    getSessionId(): string;
    getHistory(): ClaudeMessage[];
    getCwd(): string;
}
export declare class SessionManager {
    private cliPath;
    private sessions;
    constructor(cliPath: string);
    createSession(cwd: string, sessionId?: string): ClaudeSession;
    getSession(sessionId: string): ClaudeSession | undefined;
    deleteSession(sessionId: string): void;
}
