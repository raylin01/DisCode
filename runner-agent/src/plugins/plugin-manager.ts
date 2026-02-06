/**
 * Plugin Manager
 * 
 * Manages CLI plugins and routes sessions to appropriate plugins.
 * Supports configuration via:
 * - Environment variable (DISCODE_CLI_PLUGIN)
 * - Per-session override in Discord
 */

import { EventEmitter } from 'events';
import {
    CliPlugin,
    PluginType,
    PluginSession,
    SessionConfig,
    OutputEvent,
    ApprovalEvent,
    StatusEvent,
    ErrorEvent,
    MetadataEvent,
    HookEvent,
    ToolExecutionEvent,
    ToolResultEvent,
    ResultEvent,
} from './base.js';
import { TmuxPlugin } from './tmux-plugin.js';
import { PrintPlugin } from './print-plugin.js';
import { StreamPlugin } from './stream-plugin.js';
import { ClaudeSDKPlugin } from './claude-sdk-plugin.js';

// ============================================================================
// Types
// ============================================================================

export interface PluginManagerConfig {
    /** Default plugin type (from env or constructor) */
    defaultPlugin: PluginType;
    /** Available plugins to load */
    enabledPlugins: PluginType[];
}

// ============================================================================
// PluginManager
// ============================================================================

export class PluginManager extends EventEmitter {
    private plugins = new Map<PluginType, CliPlugin>();
    private sessionPluginMap = new Map<string, PluginType>();
    private defaultPlugin: PluginType;
    private initialized = false;

    constructor(config?: Partial<PluginManagerConfig>) {
        super();

        // Determine default plugin from env or config
        const envPlugin = process.env.DISCODE_CLI_PLUGIN as PluginType | undefined;
        this.defaultPlugin = config?.defaultPlugin || envPlugin || 'tmux';

        // Determine which plugins to enable
        const enabledPlugins = config?.enabledPlugins || ['tmux', 'print', 'stream', 'claude-sdk'];

        // Create plugin instances
        if (enabledPlugins.includes('tmux')) {
            this.plugins.set('tmux', new TmuxPlugin());
        }
        if (enabledPlugins.includes('print')) {
            this.plugins.set('print', new PrintPlugin());
        }
        if (enabledPlugins.includes('stream')) {
            this.plugins.set('stream', new StreamPlugin());
        }
        if (enabledPlugins.includes('claude-sdk')) {
            this.plugins.set('claude-sdk', new ClaudeSDKPlugin());
        }
        // Future: if (enabledPlugins.includes('pty')) { ... }

        console.log(`[PluginManager] Default plugin: ${this.defaultPlugin}`);
        console.log(`[PluginManager] Enabled plugins: ${Array.from(this.plugins.keys()).join(', ')}`);
    }

    /**
     * Initialize all plugins
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        console.log('[PluginManager] Initializing plugins...');

        for (const [type, plugin] of this.plugins) {
            try {
                await plugin.initialize();
                this.setupPluginEvents(plugin);
                console.log(`[PluginManager] ${type} plugin initialized`);
            } catch (error) {
                console.error(`[PluginManager] Failed to initialize ${type} plugin:`, error);
                // Remove failed plugin
                this.plugins.delete(type);
            }
        }

        // Verify default plugin is available
        if (!this.plugins.has(this.defaultPlugin)) {
            // Fall back to first available
            const firstAvailable = this.plugins.keys().next().value;
            if (firstAvailable) {
                console.log(`[PluginManager] Default plugin ${this.defaultPlugin} unavailable, falling back to ${firstAvailable}`);
                this.defaultPlugin = firstAvailable;
            } else {
                throw new Error('No CLI plugins available');
            }
        }

        this.initialized = true;
        console.log('[PluginManager] Initialization complete');
    }

    /**
     * Shutdown all plugins
     */
    async shutdown(): Promise<void> {
        console.log('[PluginManager] Shutting down...');
        for (const plugin of this.plugins.values()) {
            await plugin.shutdown();
        }
        this.sessionPluginMap.clear();
    }

    /**
     * Get available plugin types
     */
    getAvailablePlugins(): PluginType[] {
        return Array.from(this.plugins.keys());
    }

    /**
     * Get default plugin type
     */
    getDefaultPlugin(): PluginType {
        return this.defaultPlugin;
    }

    /**
     * Create a session with optional plugin override
     */
    async createSession(
        config: SessionConfig,
        pluginOverride?: PluginType
    ): Promise<PluginSession> {
        const pluginType = pluginOverride || this.defaultPlugin;
        const plugin = this.plugins.get(pluginType);

        if (!plugin) {
            throw new Error(`Plugin '${pluginType}' is not available. Available: ${this.getAvailablePlugins().join(', ')}`);
        }

        console.log(`[PluginManager] Creating session ${config.sessionId.slice(0, 8)} with ${pluginType} plugin`);

        const session = await plugin.createSession(config);
        this.sessionPluginMap.set(config.sessionId, pluginType);

        return session;
    }

    /**
     * Get a session by ID
     */
    getSession(sessionId: string): PluginSession | undefined {
        const pluginType = this.sessionPluginMap.get(sessionId);
        if (!pluginType) return undefined;

        const plugin = this.plugins.get(pluginType);
        return plugin?.getSession(sessionId);
    }

    /**
     * Get the plugin type for a session
     */
    getSessionPluginType(sessionId: string): PluginType | undefined {
        return this.sessionPluginMap.get(sessionId);
    }

    /**
     * Destroy a session
     */
    async destroySession(sessionId: string): Promise<void> {
        const pluginType = this.sessionPluginMap.get(sessionId);
        if (!pluginType) return;

        const plugin = this.plugins.get(pluginType);
        if (plugin) {
            await plugin.destroySession(sessionId);
        }
        this.sessionPluginMap.delete(sessionId);
    }

    /**
     * Send a message to a session
     */
    async sendMessage(sessionId: string, message: string): Promise<void> {
        const session = this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }
        await session.sendMessage(message);
    }

    /**
     * Send an approval response to a session
     */
    async sendApproval(sessionId: string, optionNumber: string, message?: string, requestId?: string): Promise<void> {
        const session = this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }
        await session.sendApproval(optionNumber, message, requestId);
    }

    /**
     * Send a question response to a session (for AskUserQuestion)
     */
    async sendQuestionResponse(sessionId: string, selectedOptions: string[]): Promise<void> {
        const session = this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }
        if (!session.sendQuestionResponse) {
            throw new Error(`Session ${sessionId} does not support question responses`);
        }
        await session.sendQuestionResponse(selectedOptions);
    }

    /**
     * Get all sessions across all plugins
     */
    getAllSessions(): PluginSession[] {
        const sessions: PluginSession[] = [];
        for (const plugin of this.plugins.values()) {
            sessions.push(...plugin.getSessions());
        }
        return sessions;
    }

    /**
     * Get a specific plugin instance
     */
    getPlugin(type: PluginType): CliPlugin | undefined {
        return this.plugins.get(type);
    }

    /**
     * Setup event forwarding from a plugin
     */
    private setupPluginEvents(plugin: CliPlugin): void {
        plugin.on('output', (data: OutputEvent) => {
            this.emit('output', data);
        });

        plugin.on('approval', (data: ApprovalEvent) => {
            this.emit('approval', data);
        });

        plugin.on('status', (data: StatusEvent) => {
            this.emit('status', data);
        });

        plugin.on('error', (data: ErrorEvent) => {
            this.emit('error', data);
        });

        plugin.on('metadata', (data: MetadataEvent) => {
            this.emit('metadata', data);
        });

        plugin.on('session_discovered', (data) => {
            this.emit('session_discovered', data);
        });

        plugin.on('tool_execution', (data: ToolExecutionEvent) => {
            this.emit('tool_execution', data);
        });

        plugin.on('tool_result', (data: ToolResultEvent) => {
            this.emit('tool_result', data);
        });

        plugin.on('result', (data: ResultEvent) => {
            this.emit('result', data);
        });
    }

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
    on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: PluginManager | null = null;

/**
 * Get or create the PluginManager singleton
 */
export function getPluginManager(config?: Partial<PluginManagerConfig>): PluginManager {
    if (!instance) {
        instance = new PluginManager(config);
    }
    return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetPluginManager(): void {
    instance = null;
}
