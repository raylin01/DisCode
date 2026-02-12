/**
 * Assistant Manager
 *
 * Manages the main channel CLI assistant session for a runner.
 * The assistant can spawn sub-threads in different folders.
 */
import { EventEmitter } from 'events';
import type { PluginManager } from './plugins/index.js';
import type { RunnerConfig } from './config.js';
import type { WebSocketManager } from './websocket.js';
export interface AssistantManagerDeps {
    config: RunnerConfig;
    wsManager: WebSocketManager;
    pluginManager: PluginManager;
    cliPaths: {
        claude: string | null;
        gemini: string | null;
    };
}
export interface AssistantOutput {
    content: string;
    outputType: 'stdout' | 'stderr' | 'tool_use' | 'tool_result' | 'error';
    timestamp: string;
}
export declare class AssistantManager extends EventEmitter {
    private session;
    private sessionId;
    private deps;
    private config;
    private cliType;
    constructor(deps: AssistantManagerDeps);
    /**
     * Check if assistant is enabled
     */
    isEnabled(): boolean;
    /**
     * Check if assistant session is running
     */
    isRunning(): boolean;
    /**
     * Get the session ID
     */
    getSessionId(): string | null;
    /**
     * Get the CLI type being used
     */
    getCliType(): 'claude' | 'gemini' | null;
    /**
     * Get available CLI types for this runner
     */
    getAvailableCliTypes(): ('claude' | 'gemini')[];
    /**
     * Start the assistant session
     */
    start(): Promise<void>;
    /**
     * Send the system prompt to the assistant
     */
    private sendSystemPrompt;
    /**
     * Send a message to the assistant
     */
    sendMessage(content: string, username?: string): Promise<void>;
    /**
     * Stop the assistant session
     */
    stop(): Promise<void>;
    /**
     * Handle approval request for assistant session
     */
    sendApproval(optionNumber: string, _message?: string, _requestId?: string): Promise<void>;
}
