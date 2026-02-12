/**
 * Plugin Manager
 *
 * Manages CLI plugins and routes sessions to appropriate plugins.
 * Supports configuration via:
 * - Environment variable (DISCODE_CLI_PLUGIN)
 * - Per-session override in Discord
 */
import { EventEmitter } from 'events';
import { TmuxPlugin } from './tmux-plugin.js';
import { PrintPlugin } from './print-plugin.js';
import { StreamPlugin } from './stream-plugin.js';
import { ClaudeSDKPlugin } from './claude-sdk-plugin.js';
// ============================================================================
// PluginManager
// ============================================================================
export class PluginManager extends EventEmitter {
    plugins = new Map();
    sessionPluginMap = new Map();
    defaultPlugin;
    initialized = false;
    constructor(config) {
        super();
        // Determine default plugin from env or config
        const envPlugin = process.env.DISCODE_CLI_PLUGIN;
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
    async initialize() {
        if (this.initialized)
            return;
        console.log('[PluginManager] Initializing plugins...');
        for (const [type, plugin] of this.plugins) {
            try {
                await plugin.initialize();
                this.setupPluginEvents(plugin);
                console.log(`[PluginManager] ${type} plugin initialized`);
            }
            catch (error) {
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
            }
            else {
                throw new Error('No CLI plugins available');
            }
        }
        this.initialized = true;
        console.log('[PluginManager] Initialization complete');
    }
    /**
     * Shutdown all plugins
     */
    async shutdown() {
        console.log('[PluginManager] Shutting down...');
        for (const plugin of this.plugins.values()) {
            await plugin.shutdown();
        }
        this.sessionPluginMap.clear();
    }
    /**
     * Get available plugin types
     */
    getAvailablePlugins() {
        return Array.from(this.plugins.keys());
    }
    /**
     * Get default plugin type
     */
    getDefaultPlugin() {
        return this.defaultPlugin;
    }
    /**
     * Create a session with optional plugin override
     */
    async createSession(config, pluginOverride) {
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
    getSession(sessionId) {
        const pluginType = this.sessionPluginMap.get(sessionId);
        if (!pluginType)
            return undefined;
        const plugin = this.plugins.get(pluginType);
        return plugin?.getSession(sessionId);
    }
    /**
     * Get the plugin type for a session
     */
    getSessionPluginType(sessionId) {
        return this.sessionPluginMap.get(sessionId);
    }
    /**
     * Destroy a session
     */
    async destroySession(sessionId) {
        const pluginType = this.sessionPluginMap.get(sessionId);
        if (!pluginType)
            return;
        const plugin = this.plugins.get(pluginType);
        if (plugin) {
            await plugin.destroySession(sessionId);
        }
        this.sessionPluginMap.delete(sessionId);
    }
    /**
     * Send a message to a session
     */
    async sendMessage(sessionId, message) {
        const session = this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }
        await session.sendMessage(message);
    }
    /**
     * Send an approval response to a session
     */
    async sendApproval(sessionId, optionNumber, message, requestId) {
        const session = this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }
        await session.sendApproval(optionNumber, message, requestId);
    }
    /**
     * Send a question response to a session (for AskUserQuestion)
     */
    async sendQuestionResponse(sessionId, selectedOptions) {
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
    getAllSessions() {
        const sessions = [];
        for (const plugin of this.plugins.values()) {
            sessions.push(...plugin.getSessions());
        }
        return sessions;
    }
    /**
     * Get a specific plugin instance
     */
    getPlugin(type) {
        return this.plugins.get(type);
    }
    /**
     * Setup event forwarding from a plugin
     */
    setupPluginEvents(plugin) {
        plugin.on('output', (data) => {
            this.emit('output', data);
        });
        plugin.on('approval', (data) => {
            this.emit('approval', data);
        });
        plugin.on('status', (data) => {
            this.emit('status', data);
        });
        plugin.on('error', (data) => {
            this.emit('error', data);
        });
        plugin.on('metadata', (data) => {
            this.emit('metadata', data);
        });
        plugin.on('session_discovered', (data) => {
            this.emit('session_discovered', data);
        });
        plugin.on('tool_execution', (data) => {
            this.emit('tool_execution', data);
        });
        plugin.on('tool_result', (data) => {
            this.emit('tool_result', data);
        });
        plugin.on('result', (data) => {
            this.emit('result', data);
        });
    }
    on(event, listener) {
        return super.on(event, listener);
    }
}
// ============================================================================
// Singleton Instance
// ============================================================================
let instance = null;
/**
 * Get or create the PluginManager singleton
 */
export function getPluginManager(config) {
    if (!instance) {
        instance = new PluginManager(config);
    }
    return instance;
}
/**
 * Reset the singleton (for testing)
 */
export function resetPluginManager() {
    instance = null;
}
