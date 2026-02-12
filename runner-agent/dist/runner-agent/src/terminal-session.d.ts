/**
 * Terminal Session Manager using node-pty
 *
 * Provides persistent interactive sessions with CLI tools (Claude, Gemini, etc.)
 * Uses node-pty for true PTY support - works with Claude CLI!
 */
import { EventEmitter } from 'events';
export interface TerminalSessionOptions {
    cliPath: string;
    cwd: string;
    sessionId?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
}
export interface TerminalOutput {
    raw: string;
    clean: string;
    timestamp: Date;
    isContent: boolean;
}
export type TerminalEventMap = {
    output: [TerminalOutput];
    exit: [{
        exitCode: number;
        signal?: number;
    }];
    error: [Error];
    ready: [];
};
export declare class TerminalSession extends EventEmitter<TerminalEventMap> {
    private pty;
    private sessionId;
    private cliPath;
    private cwd;
    private cols;
    private rows;
    private env;
    private outputBuffer;
    private isReady;
    constructor(options: TerminalSessionOptions);
    /**
     * Start the terminal session
     */
    start(): Promise<void>;
    /**
     * Wait for the CLI to finish its initial output stream
     * Detects when the terminal stops producing output for a certain time
     */
    private waitForStreamComplete;
    private streamDetection;
    /**
     * Handle incoming data from the terminal
     */
    private handleData;
    /**
     * Determine if a line is actual content vs decorative terminal output
     */
    private isContentLine;
    /**
     * Send input to the terminal
     */
    write(text: string): void;
    /**
     * Send a message and press Enter
     * PTY expects Carriage Return (\r) for Enter key, not newline (\n)
     */
    sendMessage(message: string): void;
    /**
     * Resize the terminal
     */
    resize(cols: number, rows: number): void;
    /**
     * Check if the session is running
     */
    isRunning(): boolean;
    /**
     * Get the session ID
     */
    getSessionId(): string;
    /**
     * Get the current output buffer
     */
    getOutputBuffer(): string;
    /**
     * Clear the output buffer
     */
    clearOutputBuffer(): void;
    /**
     * Kill the terminal session
     */
    kill(): void;
    /**
     * Close the terminal gracefully
     */
    close(): Promise<void>;
}
/**
 * Session Manager - manages multiple terminal sessions
 */
export declare class TerminalSessionManager {
    private sessions;
    private defaultCliPath;
    constructor(defaultCliPath: string);
    /**
     * Create a new terminal session
     */
    createSession(cwd: string, sessionId?: string, cliPath?: string): Promise<TerminalSession>;
    /**
     * Get an existing session
     */
    getSession(sessionId: string): TerminalSession | undefined;
    /**
     * List all active session IDs
     */
    listSessions(): string[];
    /**
     * Close a specific session
     */
    closeSession(sessionId: string): Promise<void>;
    /**
     * Close all sessions
     */
    closeAll(): Promise<void>;
}
