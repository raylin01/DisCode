/**
 * Plugin Manager
 *
 * Manages CLI plugins and routes sessions to appropriate plugins.
 * Supports configuration via:
 * - Environment variable (DISCODE_CLI_PLUGIN)
 * - Per-session override in Discord
 */
import { EventEmitter } from 'events';
import { CliPlugin, PluginType, PluginSession, SessionConfig, OutputEvent, ApprovalEvent, StatusEvent, ErrorEvent, MetadataEvent, HookEvent, ToolExecutionEvent, ToolResultEvent, ResultEvent } from './base.js';
export interface PluginManagerConfig {
    /** Default plugin type (from env or constructor) */
    defaultPlugin: PluginType;
    /** Available plugins to load */
    enabledPlugins: PluginType[];
}
export declare class PluginManager extends EventEmitter {
    private plugins;
    private sessionPluginMap;
    private defaultPlugin;
    private initialized;
    constructor(config?: Partial<PluginManagerConfig>);
    /**
     * Initialize all plugins
     */
    initialize(): Promise<void>;
    /**
     * Shutdown all plugins
     */
    shutdown(): Promise<void>;
    /**
     * Get available plugin types
     */
    getAvailablePlugins(): PluginType[];
    /**
     * Get default plugin type
     */
    getDefaultPlugin(): PluginType;
    /**
     * Create a session with optional plugin override
     */
    createSession(config: SessionConfig, pluginOverride?: PluginType): Promise<PluginSession>;
    /**
     * Get a session by ID
     */
    getSession(sessionId: string): PluginSession | undefined;
    /**
     * Get the plugin type for a session
     */
    getSessionPluginType(sessionId: string): PluginType | undefined;
    /**
     * Destroy a session
     */
    destroySession(sessionId: string): Promise<void>;
    /**
     * Send a message to a session
     */
    sendMessage(sessionId: string, message: string): Promise<void>;
    /**
     * Send an approval response to a session
     */
    sendApproval(sessionId: string, optionNumber: string, message?: string, requestId?: string): Promise<void>;
    /**
     * Send a question response to a session (for AskUserQuestion)
     */
    sendQuestionResponse(sessionId: string, selectedOptions: string[]): Promise<void>;
    /**
     * Get all sessions across all plugins
     */
    getAllSessions(): PluginSession[];
    /**
     * Get a specific plugin instance
     */
    getPlugin(type: PluginType): CliPlugin | undefined;
    /**
     * Setup event forwarding from a plugin
     */
    private setupPluginEvents;
    on(event: 'output', listener: (data: OutputEvent) => void): this;
    on(event: 'approval', listener: (data: ApprovalEvent) => void): this;
    on(event: 'status', listener: (data: StatusEvent) => void): this;
    on(event: 'error', listener: (data: ErrorEvent) => void): this;
    on(event: 'metadata', listener: (data: MetadataEvent) => void): this;
    on(event: 'session_discovered', listener: (data: any) => void): this;
    on(event: 'hook_event', listener: (data: HookEvent) => void): this;
    on(event: 'tool_execution', listener: (data: ToolExecutionEvent) => void): this;
    on(event: 'tool_result', listener: (data: ToolResultEvent) => void): this;
    on(event: 'result', listener: (data: ResultEvent) => void): this;
}
/**
 * Get or create the PluginManager singleton
 */
export declare function getPluginManager(config?: Partial<PluginManagerConfig>): PluginManager;
/**
 * Reset the singleton (for testing)
 */
export declare function resetPluginManager(): void;
