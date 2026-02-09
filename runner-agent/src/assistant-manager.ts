/**
 * Assistant Manager
 * 
 * Manages the main channel CLI assistant session for a runner.
 * The assistant can spawn sub-threads in different folders.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { PluginManager, PluginSession } from './plugins/index.js';
import type { RunnerConfig, AssistantConfig } from './config.js';
import type { WebSocketManager } from './websocket.js';
import { findCliPath, expandPath, validateOrCreateFolder } from './utils.js';

// Session ID prefix for assistant sessions
const ASSISTANT_SESSION_PREFIX = 'assistant-';

export interface AssistantManagerDeps {
    config: RunnerConfig;
    wsManager: WebSocketManager;
    pluginManager: PluginManager;
    cliPaths: { claude: string | null; gemini: string | null; codex: string | null };
}

export interface AssistantOutput {
    content: string;
    outputType: 'stdout' | 'stderr' | 'tool_use' | 'tool_result' | 'error';
    timestamp: string;
}

export class AssistantManager extends EventEmitter {
    private session: PluginSession | null = null;
    private sessionId: string | null = null;
    private deps: AssistantManagerDeps;
    private config: AssistantConfig;
    private cliType: 'claude' | 'gemini' | 'codex' | null = null;

    constructor(deps: AssistantManagerDeps) {
        super();
        this.deps = deps;
        this.config = deps.config.assistant;
    }

    /**
     * Check if assistant is enabled
     */
    isEnabled(): boolean {
        return this.config.enabled && this.deps.config.cliTypes.length > 0;
    }

    /**
     * Check if assistant session is running
     */
    isRunning(): boolean {
        return this.session !== null;
    }

    /**
     * Get the session ID
     */
    getSessionId(): string | null {
        return this.sessionId;
    }

    /**
     * Get the CLI type being used
     */
    getCliType(): 'claude' | 'gemini' | 'codex' | null {
        return this.cliType;
    }

    /**
     * Get available CLI types for this runner
     */
    getAvailableCliTypes(): ('claude' | 'gemini' | 'codex')[] {
        return this.deps.config.cliTypes;
    }

    /**
     * Start the assistant session
     */
    async start(): Promise<void> {
        if (!this.isEnabled()) {
            console.log('[AssistantManager] Assistant is disabled or no CLI types available');
            return;
        }

        if (this.session) {
            console.log('[AssistantManager] Session already running');
            return;
        }

        // Use first available CLI type
        this.cliType = this.deps.config.cliTypes[0];
        const cliPath = this.deps.cliPaths[this.cliType];

        if (!cliPath) {
            // Try to find CLI path
            const detected = await findCliPath(this.cliType, this.deps.config.cliSearchPaths);
            if (detected) {
                this.deps.cliPaths[this.cliType] = detected;
            } else {
                console.error(`[AssistantManager] CLI '${this.cliType}' not found`);
                return;
            }
        }

        // Resolve working directory
        const folder = this.config.folder || this.deps.config.defaultWorkspace || process.cwd();
        const cwd = expandPath(folder, this.deps.config.defaultWorkspace);

        // Validate folder
        const validation = validateOrCreateFolder(cwd, false);
        if (!validation.exists) {
            console.error(`[AssistantManager] Folder error: ${validation.error}`);
            return;
        }

        // Generate session ID
        this.sessionId = `${ASSISTANT_SESSION_PREFIX}${randomUUID().slice(0, 8)}`;

        console.log(`[AssistantManager] Starting assistant session ${this.sessionId}`);
        console.log(`[AssistantManager] CLI: ${this.cliType}, Folder: ${cwd}`);

        // Notify Discord that assistant is starting
        this.deps.wsManager.send({
            type: 'assistant_output',
            data: {
                runnerId: this.deps.wsManager.runnerId,
                content: `🤖 Starting assistant session (${this.cliType})...`,
                timestamp: new Date().toISOString(),
                outputType: 'info'
            }
        });

        try {
            const baseOptions = this.cliType === 'claude'
                ? (this.deps.config.claudeDefaults || {})
                : this.cliType === 'codex'
                ? (this.deps.config.codexDefaults || {})
                : {};

            // Create the session via PluginManager
            this.session = await this.deps.pluginManager.createSession({
                cliPath: this.deps.cliPaths[this.cliType]!,
                cwd,
                sessionId: this.sessionId,
                cliType: this.cliType,
                options: {
                    ...baseOptions,
                    skipPermissions: false,
                    continueConversation: true,
                    // Exclude Discord integration skills (channel updates) for assistant
                    // But keep thread-spawning and other skills
                    excludedSkills: ['discord-integration']
                }
            }, this.config.plugin);

            // Wire up output events from PluginManager (not session - TmuxPlugin emits through PluginManager)
            // Filter events by our session ID
            this.deps.pluginManager.on('output', (data: { sessionId: string; content: string; outputType?: string }) => {
                // Only handle output from our assistant session
                if (data.sessionId !== this.sessionId) return;

                console.log(`[AssistantManager] Received output (${data.content.length} chars)`);

                this.emit('output', {
                    content: data.content,
                    outputType: data.outputType || 'stdout',
                    timestamp: new Date().toISOString()
                });

                // Send to Discord bot via WebSocket
                this.deps.wsManager.send({
                    type: 'assistant_output',
                    data: {
                        runnerId: this.deps.wsManager.runnerId,
                        content: data.content,
                        timestamp: new Date().toISOString(),
                        outputType: data.outputType || 'stdout'
                    }
                });
            });

            // Wait for ready or timeout
            if (!this.session.isReady) {
                await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => {
                        console.log('[AssistantManager] Session ready timeout, continuing anyway');
                        resolve();
                    }, this.deps.config.sessionReadyTimeout);

                    this.session!.once('ready', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }

            console.log(`[AssistantManager] Assistant session ${this.sessionId} ready`);

            // Notify Discord that assistant is ready
            this.deps.wsManager.send({
                type: 'assistant_output',
                data: {
                    runnerId: this.deps.wsManager.runnerId,
                    content: `✅ Assistant ready in \`${cwd}\`. You can now send messages.`,
                    timestamp: new Date().toISOString(),
                    outputType: 'info'
                }
            });

            // Send initial system prompt with available CLIs
            await this.sendSystemPrompt();

        } catch (error) {
            console.error('[AssistantManager] Failed to start assistant:', error);

            // Notify Discord of failure
            this.deps.wsManager.send({
                type: 'assistant_output',
                data: {
                    runnerId: this.deps.wsManager.runnerId,
                    content: `❌ Failed to start assistant: ${error instanceof Error ? error.message : String(error)}`,
                    timestamp: new Date().toISOString(),
                    outputType: 'error'
                }
            });

            this.session = null;
            this.sessionId = null;
        }
    }

    /**
     * Send the system prompt to the assistant
     */
    private async sendSystemPrompt(): Promise<void> {
        if (!this.session) return;

        const cliTypes = this.deps.config.cliTypes.join(', ');
        const prompt = `You are the main assistant for this runner. Your primary goal is to triage requests and spawn dedicated threads for actual work.

Available CLIs on this runner: ${cliTypes}

PROACTIVE THREAD SPAWNING START:
When a user asks to work on a specific project, folder, repository, or task:
1. ALWAYS offer to create a dedicated thread for that workspace.
2. If the user mentions a git repo, clone it first, then IMMEDIATELY spawn a thread for that folder.
3. Use the 'spawn-thread.sh' tool to create threads.
4. Defaults to "auto" for cli_type unless specified otherwise.

You should be aggressive about moving work to threads. The main channel is for coordination and dispatching only.
DO NOT try to do complex coding or file editing in this main channel. Spawn a thread instead.

Example:
User: "I want to work on my-app"
Assistant: "I'll start a thread for my-app." -> Calls spawn-thread.sh

User: "Clone https://github.com/foo/bar"
Assistant: "Cloning repo..." -> git clone ... -> "Repo cloned. Spawning thread..." -> spawn-thread.sh

The spawn-thread skill is available at: spawn-thread.sh "<folder>" "<cli_type>" "<message>"
- folder: absolute path or relative to workspace
- cli_type: "claude", "gemini", or "auto" (uses first available: ${this.deps.config.cliTypes[0]})
- message: optional initial message for the new thread`;

        // Note: We don't actually send this as a message - it will be installed as a skill
        console.log(`[AssistantManager] System prompt prepared (${prompt.length} chars)`);
    }

    /**
     * Send a message to the assistant
     */
    async sendMessage(content: string, username?: string): Promise<void> {
        if (!this.session) {
            console.error('[AssistantManager] No active session');
            return;
        }

        const prefix = username ? `[${username}] ` : '';
        await this.session.sendMessage(`${prefix}${content}`);
    }

    /**
     * Stop the assistant session
     */
    async stop(): Promise<void> {
        if (!this.session) {
            return;
        }

        console.log(`[AssistantManager] Stopping assistant session ${this.sessionId}`);

        try {
            await this.session.close();
        } catch (error) {
            console.error('[AssistantManager] Error closing session:', error);
        }

        this.session = null;
        this.sessionId = null;
        this.cliType = null;
    }

    /**
     * Handle approval request for assistant session
     */
    async sendApproval(optionNumber: string, _message?: string, _requestId?: string): Promise<void> {
        if (!this.session) {
            console.error('[AssistantManager] No active session for approval');
            return;
        }

        await this.session.sendApproval(optionNumber);
    }
}
