/**
 * CLI Plugin Base Interface
 * 
 * Defines the contract for all CLI integration plugins.
 * Plugins handle the actual interaction with CLI tools (Claude, Gemini, etc.)
 */

import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type PluginType = 'tmux' | 'print' | 'pty';
export type SessionStatus = 'idle' | 'working' | 'waiting' | 'offline' | 'error';

export interface SessionConfig {
    /** Path to the CLI executable */
    cliPath: string;
    /** Working directory for the session */
    cwd: string;
    /** Unique session identifier */
    sessionId: string;
    /** CLI type (claude, gemini) */
    cliType: 'claude' | 'gemini';
    /** Plugin-specific options */
    options?: PluginOptions;
}

export interface PluginOptions {
    /** Continue previous conversation (-c flag) */
    continueConversation?: boolean;
    /** Skip permission prompts (dangerous mode) */
    skipPermissions?: boolean;
    /** Custom environment variables */
    env?: Record<string, string>;
}

// ============================================================================
// Event Types
// ============================================================================

export interface OutputEvent {
    sessionId: string;
    content: string;
    /** True when the response is complete */
    isComplete: boolean;
    /** Output type for styling */
    outputType: 'stdout' | 'stderr' | 'info';
    timestamp: Date;
}

export interface ApprovalEvent {
    sessionId: string;
    /** Tool requesting approval (Bash, Write, Read, etc.) */
    tool: string;
    /** Context/description of what the tool wants to do */
    context: string;
    /** Available options (usually Yes/No/Always) */
    options: ApprovalOption[];
    /** When the approval was detected */
    detectedAt: Date;
}

export interface ApprovalOption {
    /** Option number to send (1, 2, 3, etc.) */
    number: string;
    /** Human-readable label */
    label: string;
}

export interface StatusEvent {
    sessionId: string;
    status: SessionStatus;
    /** Current tool being used (if working) */
    currentTool?: string;
}

export interface ErrorEvent {
    sessionId: string;
    error: string;
    fatal: boolean;
}

export interface MetadataEvent {
    sessionId: string;
    /** Token count (current conversation) */
    tokens?: number;
    /** Cumulative tokens this session */
    cumulativeTokens?: number;
    /** Current mode (bypassPermissions, etc.) */
    mode?: string;
    /** Current activity (Thinking, Working, Wrangling, etc.) */
    activity?: string;
    timestamp: Date;
}

// ============================================================================
// Plugin Interface
// ============================================================================

export interface CliPlugin extends EventEmitter {
    /** Plugin name for logging/config */
    readonly name: string;
    /** Plugin type identifier */
    readonly type: PluginType;
    /** Whether sessions persist across messages */
    readonly isPersistent: boolean;

    // Lifecycle
    /** Initialize the plugin (called once on startup) */
    initialize(): Promise<void>;
    /** Cleanup on shutdown */
    shutdown(): Promise<void>;

    // Session Management
    /** Create a new session */
    createSession(config: SessionConfig): Promise<PluginSession>;
    /** Get an existing session */
    getSession(sessionId: string): PluginSession | undefined;
    /** Destroy a session */
    destroySession(sessionId: string): Promise<void>;
    /** Get all active sessions */
    getSessions(): PluginSession[];

    // Event declarations (TypeScript)
    on(event: 'output', listener: (data: OutputEvent) => void): this;
    on(event: 'approval', listener: (data: ApprovalEvent) => void): this;
    on(event: 'status', listener: (data: StatusEvent) => void): this;
    on(event: 'error', listener: (data: ErrorEvent) => void): this;
    on(event: 'metadata', listener: (data: MetadataEvent) => void): this;

    emit(event: 'output', data: OutputEvent): boolean;
    emit(event: 'approval', data: ApprovalEvent): boolean;
    emit(event: 'status', data: StatusEvent): boolean;
    emit(event: 'error', data: ErrorEvent): boolean;
    emit(event: 'metadata', data: MetadataEvent): boolean;
}

// ============================================================================
// Session Interface
// ============================================================================

export interface PluginSession {
    /** Unique session ID */
    readonly sessionId: string;
    /** Current status */
    status: SessionStatus;
    /** Session config */
    readonly config: SessionConfig;
    /** Creation time */
    readonly createdAt: Date;
    /** Last activity time */
    lastActivity: Date;

    // Messaging
    /** Send a message/prompt to the CLI */
    sendMessage(message: string): Promise<void>;

    // Approval handling
    /** Send an approval response (for plugins that support it) */
    sendApproval(optionNumber: string): Promise<void>;

    // Lifecycle
    /** Close/destroy the session */
    close(): Promise<void>;

    /** Whether the session is ready to accept messages */
    readonly isReady: boolean;

    /** Wait for session to be ready */
    on(event: 'ready', listener: () => void): this;
    once(event: 'ready', listener: () => void): this;
}

// ============================================================================
// Base Plugin Class
// ============================================================================

export abstract class BasePlugin extends EventEmitter implements CliPlugin {
    abstract readonly name: string;
    abstract readonly type: PluginType;
    abstract readonly isPersistent: boolean;

    protected sessions = new Map<string, PluginSession>();

    async initialize(): Promise<void> {
        console.log(`[${this.name}] Initializing...`);
    }

    async shutdown(): Promise<void> {
        console.log(`[${this.name}] Shutting down...`);
        for (const session of this.sessions.values()) {
            await session.close();
        }
        this.sessions.clear();
    }

    abstract createSession(config: SessionConfig): Promise<PluginSession>;

    getSession(sessionId: string): PluginSession | undefined {
        return this.sessions.get(sessionId);
    }

    async destroySession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.close();
            this.sessions.delete(sessionId);
        }
    }

    getSessions(): PluginSession[] {
        return Array.from(this.sessions.values());
    }

    protected log(message: string): void {
        console.log(`[${this.name}] ${message}`);
    }

    protected debug(message: string): void {
        if (process.env.DEBUG) {
            console.log(`[${this.name}:debug] ${message}`);
        }
    }
}
