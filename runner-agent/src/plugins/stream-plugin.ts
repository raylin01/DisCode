/**
 * Stream Plugin for CLI Integration
 * 
 * Generic plugin for CLIs that support streaming JSON output (JSONL).
 * Currently supports Gemini CLI with `--output-format stream-json`.
 * 
 * Each message spawns a new process with streaming output.
 * Events are parsed as JSONL and mapped to standard plugin events.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
    BasePlugin,
    PluginSession,
    SessionConfig,
    SessionStatus,
} from './base.js';

// ============================================================================
// Types
// ============================================================================

/** Configuration for stream-based CLI */
export interface StreamCliConfig {
    /** CLI identifier */
    cliType: 'gemini' | string;
    /** Args to enable streaming output */
    streamArgs: string[];
    /** Args for auto-approve mode */
    autoApproveArgs: string[];
    /** Session ID argument template (use {id} as placeholder) */
    sessionIdArg?: string;
    /** Prompt argument (use {prompt} as placeholder) */
    promptArg: string;
}

/** Pre-configured CLI configs */
export const CLI_STREAM_CONFIGS: Record<string, StreamCliConfig> = {
    gemini: {
        cliType: 'gemini',
        streamArgs: ['--output-format', 'stream-json'],
        autoApproveArgs: ['--yolo'],
        sessionIdArg: '--session-id={id}',
        promptArg: '--prompt',
    }
};

// Event types from Gemini CLI stream output
interface StreamEvent {
    type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'error' | 'result';
    timestamp?: string;
    session_id?: string;
    model?: string;
    role?: string;
    content?: string;
    delta?: boolean;
    tool_name?: string;
    tool_id?: string;
    parameters?: Record<string, any>;
    status?: string;
    output?: string;
    error?: {
        type?: string;
        message?: string;
        code?: number;
    };
    stats?: {
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        duration_ms?: number;
        tool_calls?: number;
    };
}

// ============================================================================
// StreamSession
// ============================================================================

class StreamSession extends EventEmitter implements PluginSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly createdAt: Date;
    readonly isOwned = true;
    readonly isReady = true;

    status: SessionStatus = 'idle';
    lastActivity: Date;

    private messageCount = 0;
    private currentProcess: ChildProcess | null = null;
    private plugin: StreamPlugin;
    private streamConfig: StreamCliConfig;
    private sessionUuid: string;

    // Accumulated content for current message
    private currentContent = '';

    constructor(config: SessionConfig, plugin: StreamPlugin, streamConfig: StreamCliConfig) {
        super();
        this.sessionId = config.sessionId;
        this.config = config;
        this.createdAt = new Date();
        this.lastActivity = new Date();
        this.plugin = plugin;
        this.streamConfig = streamConfig;

        // Use session ID as the CLI session identifier
        this.sessionUuid = config.sessionId;
    }

    on(event: 'ready', listener: () => void): this {
        // Stream sessions are always ready
        if (event === 'ready') {
            listener();
        }
        return this;
    }

    once(event: 'ready', listener: () => void): this {
        if (event === 'ready') {
            listener();
        }
        return this;
    }

    async sendMessage(message: string): Promise<void> {
        const isFirstMessage = this.messageCount === 0;
        this.messageCount++;
        this.lastActivity = new Date();
        this.status = 'working';
        this.currentContent = '';

        // Build command arguments
        const args: string[] = [
            this.streamConfig.promptArg,
            message,
            ...this.streamConfig.streamArgs,
        ];

        // Add auto-approve if configured
        if (this.config.options?.skipPermissions !== false) {
            args.push(...this.streamConfig.autoApproveArgs);
        }

        // Add session ID for conversation persistence
        if (this.streamConfig.sessionIdArg && !isFirstMessage) {
            args.push(this.streamConfig.sessionIdArg.replace('{id}', this.sessionUuid));
        }

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending: "${message.slice(0, 50)}..."`);

        return new Promise((resolve, reject) => {
            this.currentProcess = spawn(this.config.cliPath, args, {
                cwd: this.config.cwd,
                env: {
                    ...process.env,
                    ...this.config.options?.env
                }
            });

            let lineBuffer = '';

            this.currentProcess.stdout?.on('data', (data: Buffer) => {
                lineBuffer += data.toString();

                // Process complete lines
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.trim()) {
                        this.processEvent(line);
                    }
                }
            });

            this.currentProcess.stderr?.on('data', (data: Buffer) => {
                const str = data.toString().trim();
                if (str && !str.includes('Loaded cached credentials')) {
                    this.plugin.log(`[${this.sessionId.slice(0, 8)}] stderr: ${str}`);
                }
            });

            this.currentProcess.on('close', (code) => {
                // Process any remaining data
                if (lineBuffer.trim()) {
                    this.processEvent(lineBuffer);
                }

                this.currentProcess = null;
                this.status = 'idle';

                // Emit final output with complete flag
                if (this.currentContent.trim()) {
                    this.plugin.emit('output', {
                        sessionId: this.sessionId,
                        content: this.currentContent.trim(),
                        isComplete: true,
                        outputType: code === 0 ? 'stdout' : 'stderr',
                        timestamp: new Date()
                    });
                }

                this.plugin.emit('status', {
                    sessionId: this.sessionId,
                    status: 'idle'
                });

                this.plugin.log(`[${this.sessionId.slice(0, 8)}] Exit: ${code}`);

                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`CLI exited with code ${code}`));
                }
            });

            this.currentProcess.on('error', (err) => {
                this.currentProcess = null;
                this.status = 'error';

                this.plugin.emit('error', {
                    sessionId: this.sessionId,
                    error: err.message,
                    fatal: false
                });

                reject(err);
            });
        });
    }

    private processEvent(line: string): void {
        try {
            const event: StreamEvent = JSON.parse(line);

            switch (event.type) {
                case 'init':
                    // Session initialized
                    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Init: model=${event.model}`);
                    break;

                case 'message':
                    if (event.role === 'assistant' && event.content) {
                        // Stream content to output
                        this.currentContent += event.content;

                        this.plugin.emit('output', {
                            sessionId: this.sessionId,
                            content: event.content,
                            isComplete: false,
                            outputType: 'stdout',
                            timestamp: new Date(event.timestamp || Date.now())
                        });
                    }
                    break;

                case 'tool_use':
                    // Tool is being called
                    this.plugin.emit('output', {
                        sessionId: this.sessionId,
                        content: `[Tool] ${event.tool_name}: ${JSON.stringify(event.parameters || {}).slice(0, 100)}`,
                        isComplete: false,
                        outputType: 'info',
                        timestamp: new Date(event.timestamp || Date.now())
                    });

                    this.plugin.emit('status', {
                        sessionId: this.sessionId,
                        status: 'working',
                        currentTool: event.tool_name
                    });
                    break;

                case 'tool_result':
                    if (event.status === 'error') {
                        this.plugin.emit('error', {
                            sessionId: this.sessionId,
                            error: event.output || 'Tool execution failed',
                            fatal: false
                        });
                    }
                    break;

                case 'error':
                    this.plugin.emit('error', {
                        sessionId: this.sessionId,
                        error: event.error?.message || 'Unknown error',
                        fatal: false
                    });
                    break;

                case 'result':
                    // Final result with stats
                    if (event.stats) {
                        this.plugin.emit('metadata', {
                            sessionId: this.sessionId,
                            tokens: event.stats.total_tokens,
                            timestamp: new Date(event.timestamp || Date.now())
                        });
                    }
                    break;
            }
        } catch (e) {
            // Not valid JSON - might be regular output
            if (line.trim()) {
                this.plugin.log(`[${this.sessionId.slice(0, 8)}] Non-JSON: ${line.slice(0, 100)}`);
            }
        }
    }

    async sendApproval(_optionNumber: string): Promise<void> {
        // Stream mode uses auto-approve, no interactive approval
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Approval not supported in stream mode (use --yolo)`);
    }

    async interrupt(): Promise<void> {
        if (this.currentProcess) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending interrupt (SIGINT)`);
            this.currentProcess.kill('SIGINT');
            this.status = 'idle';
        }
    }

    async close(): Promise<void> {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.currentProcess = null;
        }
        this.status = 'offline';
    }
}

// ============================================================================
// StreamPlugin
// ============================================================================

export class StreamPlugin extends BasePlugin {
    readonly name = 'StreamPlugin';
    readonly type = 'stream' as const;
    readonly isPersistent = false;

    async initialize(): Promise<void> {
        await super.initialize();
        this.log('Initialized (streaming JSON mode)');
    }

    async createSession(config: SessionConfig): Promise<PluginSession> {
        // Get stream config for this CLI type
        const streamConfig = CLI_STREAM_CONFIGS[config.cliType];
        if (!streamConfig) {
            throw new Error(`No stream configuration for CLI type: ${config.cliType}. ` +
                `StreamPlugin supports: ${Object.keys(CLI_STREAM_CONFIGS).join(', ')}`);
        }

        const session = new StreamSession(config, this, streamConfig);
        this.sessions.set(config.sessionId, session);

        this.log(`Created session: ${config.sessionId.slice(0, 8)} in ${config.cwd}`);

        // Emit ready immediately
        this.emit('output', {
            sessionId: config.sessionId,
            content: 'Stream Mode Ready',
            isComplete: true,
            outputType: 'info',
            timestamp: new Date()
        });

        this.emit('status', {
            sessionId: config.sessionId,
            status: 'idle'
        });

        return session;
    }

    log(message: string): void {
        super.log(message);
    }
}
