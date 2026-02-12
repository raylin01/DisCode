/**
 * CLI Plugin Base Interface
 *
 * Defines the contract for all CLI integration plugins.
 * Plugins handle the actual interaction with CLI tools (Claude, Gemini, etc.)
 */
import { EventEmitter } from 'events';
export type PluginType = 'tmux' | 'print' | 'pty' | 'stream' | 'claude-sdk';
export type SessionStatus = 'idle' | 'working' | 'waiting' | 'offline' | 'error';
export interface SessionConfig {
    /** Path to the CLI executable */
    cliPath: string;
    /** Working directory for the session */
    cwd: string;
    /** Unique session identifier */
    sessionId: string;
    /** CLI type (claude, gemini, terminal/generic for plain shell) */
    cliType: 'claude' | 'gemini' | 'terminal' | 'generic';
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
    /** Skills to exclude from installation */
    excludedSkills?: string[];
    /** Max thinking tokens for extended thinking (Claude models) */
    maxThinkingTokens?: number;
    /** Thinking level: 'off' | 'low' | 'medium' | 'high' | 'auto' | 'default_on' */
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto' | 'default_on';
}
export interface OutputEvent {
    sessionId: string;
    content: string;
    /** True when the response is complete */
    isComplete: boolean;
    /** Output type for styling and formatting */
    outputType: 'stdout' | 'stderr' | 'info' | 'thinking' | 'edit' | 'tool_use' | 'tool_result';
    /** Structured data for rich formatting (optional) */
    structuredData?: {
        edit?: {
            filePath: string;
            oldContent?: string;
            newContent?: string;
            diff?: string;
        };
        tool?: {
            name: string;
            input: Record<string, any>;
        };
    };
    timestamp: Date;
}
export interface ApprovalEvent {
    sessionId: string;
    /** Unique request ID for correlating responses */
    requestId?: string;
    /** Tool requesting approval (Bash, Write, Read, etc.) */
    tool: string;
    /** Context/description of what the tool wants to do */
    context: string;
    /** Raw tool input (if available) */
    toolInput?: Record<string, any>;
    /** Available options (usually Yes/No/Always) */
    options: string[] | ApprovalOption[];
    /** When the approval was detected */
    detectedAt: Date;
    /** Whether this is a multi-select question (for AskUserQuestion) */
    isMultiSelect?: boolean;
    /** Whether this has an "Other" option (for AskUserQuestion) */
    hasOther?: boolean;
    /** Permission suggestions for "Always" scope */
    suggestions?: any[];
    /** Blocked path (if provided) */
    blockedPath?: string;
    /** Decision reason (if provided) */
    decisionReason?: string;
}
export interface ApprovalOption {
    label: string;
    number: string;
    value?: string;
}
export type PermissionScope = 'session' | 'directory' | 'global';
export interface Suggestion {
    type: 'allow' | 'deny' | 'allow_always' | 'deny_always' | 'setMode';
    scope?: PermissionScope;
    description: string;
    destination?: PermissionScope;
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
export interface HookEvent {
    type: string;
    sessionId: string;
    cwd: string;
    tool?: string;
    toolInput?: any;
    toolResponse?: any;
    menuId?: string;
    timestamp: number;
    [key: string]: any;
}
export interface SessionDiscoveredEvent {
    sessionId: string;
    exists: boolean;
}
export interface ToolExecutionEvent {
    sessionId: string;
    toolName: string;
    toolId: string;
    input: Record<string, any>;
    timestamp: Date;
}
export interface ToolResultEvent {
    sessionId: string;
    toolUseId: string;
    content: string;
    isError: boolean;
    timestamp: Date;
}
export interface ResultEvent {
    sessionId: string;
    result: string;
    subtype: 'success' | 'error';
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    isError: boolean;
    error?: string;
    timestamp: Date;
}
export interface CliPlugin extends EventEmitter {
    /** Plugin name for logging/config */
    readonly name: string;
    /** Plugin type identifier */
    readonly type: PluginType;
    /** Whether sessions persist across messages */
    readonly isPersistent: boolean;
    /** Initialize the plugin (called once on startup) */
    initialize(): Promise<void>;
    /** Cleanup on shutdown */
    shutdown(): Promise<void>;
    /** Create a new session */
    createSession(config: SessionConfig): Promise<PluginSession>;
    /** Get an existing session */
    getSession(sessionId: string): PluginSession | undefined;
    /** Destroy a session */
    destroySession(sessionId: string): Promise<void>;
    /** Get all active sessions */
    getSessions(): PluginSession[];
    /** List all discoverable sessions (e.g. existing tmux sessions) */
    listSessions?(): Promise<string[]>;
    /** Watch an existing session */
    watchSession?(sessionId: string): Promise<PluginSession>;
    on(event: 'output', listener: (data: OutputEvent) => void): this;
    on(event: 'approval', listener: (data: ApprovalEvent) => void): this;
    on(event: 'status', listener: (data: StatusEvent) => void): this;
    on(event: 'error', listener: (data: ErrorEvent) => void): this;
    on(event: 'metadata', listener: (data: MetadataEvent) => void): this;
    on(event: 'session_discovered', listener: (data: SessionDiscoveredEvent) => void): this;
    on(event: 'tool_execution', listener: (data: ToolExecutionEvent) => void): this;
    on(event: 'tool_result', listener: (data: ToolResultEvent) => void): this;
    on(event: 'result', listener: (data: ResultEvent) => void): this;
    emit(event: 'output', data: OutputEvent): boolean;
    emit(event: 'approval', data: ApprovalEvent): boolean;
    emit(event: 'status', data: StatusEvent): boolean;
    emit(event: 'error', data: ErrorEvent): boolean;
    emit(event: 'metadata', data: MetadataEvent): boolean;
    emit(event: 'session_discovered', data: SessionDiscoveredEvent): boolean;
    emit(event: 'tool_execution', data: ToolExecutionEvent): boolean;
    emit(event: 'tool_result', data: ToolResultEvent): boolean;
    emit(event: 'result', data: ResultEvent): boolean;
}
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
    /** Whether this session is owned by us (true) or just watched (false) */
    readonly isOwned: boolean;
    /** Send a message/prompt to the CLI */
    sendMessage(message: string): Promise<void>;
    /** Send an approval response (for plugins that support it) */
    sendApproval(optionNumber: string, message?: string, requestId?: string): Promise<void>;
    /** Send a response to an AskUserQuestion request */
    sendQuestionResponse?(selectedOptions: string[]): Promise<void>;
    /** Close/destroy the session */
    close(): Promise<void>;
    /** Whether the session is ready to accept messages */
    readonly isReady: boolean;
    /** Wait for session to be ready */
    on(event: 'ready', listener: () => void): this;
    once(event: 'ready', listener: () => void): this;
}
export declare abstract class BasePlugin extends EventEmitter implements CliPlugin {
    abstract readonly name: string;
    abstract readonly type: PluginType;
    abstract readonly isPersistent: boolean;
    protected sessions: Map<string, PluginSession>;
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    abstract createSession(config: SessionConfig): Promise<PluginSession>;
    getSession(sessionId: string): PluginSession | undefined;
    destroySession(sessionId: string): Promise<void>;
    getSessions(): PluginSession[];
    protected log(message: string): void;
    protected debug(message: string): void;
}
