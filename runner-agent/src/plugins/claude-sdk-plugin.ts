/**
 * Claude SDK Plugin for CLI Integration
 *
 * Uses Claude Code's SDK-based bidirectional JSON protocol.
 * Spawns CLI with --output-format stream-json and communicates via stdin/stdout.
 *
 * Features:
 * - Persistent sessions (one process per conversation)
 * - Interactive permission prompts via control protocol
 * - AskUserQuestion support with multi-select options
 * - Real-time streaming output with text deltas
 * - Tool use tracking and status updates
 *
 * Protocol:
 * - Extension → CLI (stdin): JSON messages (user prompts, control responses)
 * - CLI → Extension (stdout): JSON messages (stream events, control requests)
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
    BasePlugin,
    PluginSession,
    SessionConfig,
    SessionStatus,
    OutputEvent,
    ApprovalEvent,
    ApprovalOption,
    StatusEvent,
    ErrorEvent,
    MetadataEvent,
} from './base.js';

// ============================================================================
// Types for Claude Code SDK Protocol
// ============================================================================

/**
 * Message types sent from CLI to extension (stdout)
 */
type CliMessage =
    | SystemMessage
    | StreamEventMessage
    | AssistantMessage
    | UserMessage
    | ControlRequestMessage
    | ControlResponseMessage
    | KeepAliveMessage;

/**
 * System initialization message
 */
interface SystemMessage {
    type: 'system';
    subtype: 'init';
    session_id: string;
    cwd: string;
    tools: string[];
    mcp_servers: Array<{ name: string; status: string }>;
    model: string;
    permissionMode: string;
    claude_code_version: string;
    uuid?: string;
}

/**
 * Stream event (real-time updates)
 */
interface StreamEventMessage {
    type: 'stream_event';
    event: StreamEvent;
    session_id: string;
    parent_tool_use_id: string | null;
    uuid: string;
}

type StreamEvent =
    | { type: 'message_start'; message: any }
    | { type: 'content_block_start'; index: number; content_block: any }
    | { type: 'content_block_delta'; index: number; delta: ContentDelta }
    | { type: 'content_block_stop'; index: number }
    | { type: 'message_delta'; delta: any; usage: Usage }
    | { type: 'message_stop' };

interface ContentDelta {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
}

interface Usage {
    input_tokens: number;
    output_tokens: number;
}

/**
 * Complete assistant message
 */
interface AssistantMessage {
    type: 'assistant';
    message: {
        id: string;
        role: 'assistant';
        content: ContentBlock[];
        stop_reason: string | null;
        usage: Usage;
    };
    session_id: string;
    uuid: string;
}

type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, any> };

/**
 * User message (including tool results)
 */
interface UserMessage {
    type: 'user';
    message: {
        role: 'user';
        content: Array<{ type: 'tool_result'; content: string; is_error?: boolean; tool_use_id: string }>;
    };
    session_id: string;
    uuid: string;
    tool_use_result?: string;
}

/**
 * Control request (permission, question, etc.)
 */
interface ControlRequestMessage {
    type: 'control_request';
    request_id: string;
    request: ControlRequest;
}

interface ControlRequest {
    subtype: 'can_use_tool' | 'hook_callback' | 'mcp_message';
    tool_name?: string;
    input?: Record<string, any>;
    permission_suggestions?: string[];
    blocked_path?: string;
    decision_reason?: string;
    tool_use_id?: string;
    agent_id?: string;
    callback_id?: string;
}

/**
 * Control response (our reply to control request)
 */
interface ControlResponseMessage {
    type: 'control_response';
    response: {
        subtype: 'success' | 'error';
        request_id: string;
        response?: ControlResponseData;
        error?: string;
        pending_permission_requests?: ControlRequest[];
    };
}

interface ControlResponseData {
    behavior: 'approve' | 'deny' | 'delegate';
    message?: string;
    toolUseID?: string;
    selectedOptions?: string[];
}

/**
 * Keep-alive message
 */
interface KeepAliveMessage {
    type: 'keep_alive';
}

/**
 * Message types sent from extension to CLI (stdin)
 */
type InputMessage =
    | UserInputMessage
    | ControlRequestMessage
    | ControlResponseMessage;

interface UserInputMessage {
    type: 'user';
    session_id: string;
    message: {
        role: 'user';
        content: [{ type: 'text'; text: string }];
    };
    parent_tool_use_id: null;
}

// ============================================================================
// Claude SDK Session
// ============================================================================

class ClaudeSDKSession extends EventEmitter implements PluginSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly createdAt: Date;
    readonly isOwned = true;

    status: SessionStatus = 'idle';
    lastActivity: Date;

    // Process management
    private process: ChildProcess | null = null;
    private stdinReady = false;
    private processExited = false;

    // Protocol state
    private currentRequestId: string | null = null;
    private pendingControlRequests = new Map<string, {
        resolve: (response: ControlResponseData) => void;
        reject: (error: Error) => void;
    }>();

    // Content accumulation
    private currentTool: string | null = null;
    private currentContent = '';
    private seenToolUses = new Set<string>(); // Track tool uses to avoid duplication

    // Text batching for streaming
    private textBuffer = '';
    private batchTimer: NodeJS.Timeout | null = null;
    private readonly BATCH_DELAY = 100; // ms to wait before flushing

    // Activity tracking
    private currentActivity: string | null = null;
    private isThinking = false;

    // Plugin reference
    private plugin: ClaudeSDKPlugin;

    constructor(config: SessionConfig, plugin: ClaudeSDKPlugin) {
        super();
        this.sessionId = config.sessionId;
        this.config = config;
        this.createdAt = new Date();
        this.lastActivity = new Date();
        this.plugin = plugin;
    }

    get isReady(): boolean {
        return this.stdinReady && !this.processExited;
    }

    on(event: 'ready', listener: () => void): this {
        if (this.isReady && event === 'ready') {
            setImmediate(() => listener());
        }
        return super.on(event, listener);
    }

    once(event: 'ready', listener: () => void): this {
        if (this.isReady && event === 'ready') {
            setImmediate(() => listener());
            return this as any; // Prevent double emission
        }
        return super.once(event, listener);
    }

    /**
     * Send a user message to the CLI
     */
    async sendMessage(message: string): Promise<void> {
        if (this.processExited) {
            throw new Error('Process has exited');
        }

        this.lastActivity = new Date();
        this.status = 'working';
        this.currentContent = '';
        this.currentTool = null;
        this.isThinking = false;

        // Clear any pending batch
        this.flushTextBuffer();

        // Emit activity - user sent a message
        this.setActivity('Processing');

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending: "${message.slice(0, 50)}..."`);

        // Send user message as JSON
        const inputMessage: UserInputMessage = {
            type: 'user',
            session_id: this.sessionId,
            message: {
                role: 'user',
                content: [{ type: 'text', text: message }]
            },
            parent_tool_use_id: null
        };

        await this.writeToStdin(JSON.stringify(inputMessage));
    }

    /**
     * Send an approval response
     * Handles both regular tool approvals and AskUserQuestion responses
     */
    async sendApproval(optionNumber: string): Promise<void> {
        // Check if this is an AskUserQuestion response
        const pendingQuestion = (this as any).pendingQuestion;
        if (pendingQuestion && pendingQuestion.options && pendingQuestion.options.length > 0) {
            // This is an AskUserQuestion - convert 1-indexed button to 0-indexed option
            const optionIndex = parseInt(optionNumber, 10) - 1;
            if (optionIndex >= 0 && optionIndex < pendingQuestion.options.length) {
                // Single select - send the selected option index as a string
                await this.sendQuestionResponse([optionIndex.toString()]);
                // Clear pending question
                delete (this as any).pendingQuestion;
                return;
            }
        }

        // Regular tool permission approval
        // Convert option number to behavior
        // 1 = approve (yes), 2 = deny (no), 3 = delegate, etc.
        const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
            '1': 'approve',
            '2': 'deny',
            '3': 'delegate'
        };

        const behavior = behaviorMap[optionNumber] || 'approve';

        const response: ControlResponseData = {
            behavior,
            toolUseID: this.currentRequestId
        };

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending approval: ${behavior}`);

        await this.sendControlResponse(response);
    }

    /**
     * Send response to an AskUserQuestion control request
     */
    async sendQuestionResponse(selectedOptions: string[]): Promise<void> {
        const response: ControlResponseData = {
            behavior: 'approve',
            selectedOptions,
        };

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending question response: ${selectedOptions.join(', ')}`);

        await this.sendControlResponse(response);
    }

    /**
     * Send a control response to the CLI
     */
    private async sendControlResponse(response: ControlResponseData): Promise<void> {
        if (!this.currentRequestId) {
            throw new Error('No pending control request');
        }

        const requestId = this.currentRequestId;
        this.currentRequestId = null;

        const controlMessage: ControlResponseMessage = {
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: requestId,
                response
            }
        };

        await this.writeToStdin(JSON.stringify(controlMessage));
    }

    /**
     * Write JSON message to stdin
     */
    private async writeToStdin(json: string): Promise<void> {
        if (!this.process || !this.process.stdin) {
            throw new Error('Process stdin not available');
        }

        return new Promise((resolve, reject) => {
            const success = this.process.stdin.write(json + '\n', (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
            if (!success) {
                // Stream was full - wait for drain
                this.process.stdin.once('drain', () => resolve());
            }
        });
    }

    /**
     * Update activity and emit metadata event
     */
    private setActivity(activity: string | null): void {
        if (this.currentActivity === activity) return;

        this.currentActivity = activity;

        this.plugin.emit('metadata', {
            sessionId: this.sessionId,
            activity,
            timestamp: new Date()
        });
    }

    /**
     * Flush text buffer immediately
     */
    private flushTextBuffer(isComplete: boolean = false): void {
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        if (this.textBuffer) {
            this.plugin.emit('output', {
                sessionId: this.sessionId,
                content: this.textBuffer,
                isComplete,
                outputType: 'stdout',
                timestamp: new Date()
            });
            this.textBuffer = '';
        }
    }

    /**
     * Schedule batch flush with sentence detection
     */
    private scheduleBatchFlush(): void {
        // Clear existing timer
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
        }

        // Check if buffer ends with sentence boundary
        const endsWithSentence = /[.!?]\s*$|[\n\r]/.test(this.textBuffer);

        if (endsWithSentence) {
            // Flush immediately if we have a complete sentence
            this.flushTextBuffer();
        } else {
            // Otherwise schedule a delayed flush
            this.batchTimer = setTimeout(() => {
                this.flushTextBuffer();
            }, this.BATCH_DELAY);
        }
    }

    /**
     * Start the CLI process
     */
    async start(): Promise<void> {
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Starting Claude SDK process...`);

        return new Promise((resolve, reject) => {
            const args = [
                '--output-format', 'stream-json',
                '--verbose',
                '--input-format', 'stream-json',
                '--include-partial-messages',
                '--permission-prompt-tool', 'stdio',
            ];

            const env = {
                ...process.env,
                ...this.config.options?.env,
                CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
            };

            this.process = spawn(this.config.cliPath, args, {
                cwd: this.config.cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });

            // Handle stdout (JSON messages from CLI)
            const rl = createInterface({
                input: this.process.stdout!,
                crlfDelay: true,
            });

            let lineBuffer = '';

            this.process.stdout?.on('data', (data: Buffer) => {
                lineBuffer += data.toString();

                // Process complete lines
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        this.processLine(line);
                    }
                }
            });

            // Handle stderr (debug/error output)
            this.process.stderr?.on('data', (data: Buffer) => {
                const str = data.toString();
                // Filter out common warnings
                if (str.trim() && !str.includes('CPU lacks AVX')) {
                    this.plugin.log(`[${this.sessionId.slice(0, 8)}] stderr: ${str.trim()}`);
                }
            });

            // Handle process exit
            this.process.on('close', (code) => {
                this.processExited = true;
                this.stdinReady = false;
                this.process = null;
                this.status = 'offline';

                // Process any remaining data
                if (lineBuffer.trim()) {
                    this.processLine(lineBuffer);
                }

                // Reject all pending control requests
                for (const [requestId, pending] of this.pendingControlRequests) {
                    pending.reject(new Error('Process exited'));
                }
                this.pendingControlRequests.clear();

                this.plugin.log(`[${this.sessionId.slice(0, 8)}] Exit: ${code}`);
                resolve();
            });

            this.process.on('error', (err) => {
                this.processExited = true;
                this.stdinReady = false;
                this.process = null;
                this.status = 'error';

                this.plugin.emit('error', {
                    sessionId: this.sessionId,
                    error: err.message,
                    fatal: true
                });

                reject(err);
            });

            // Mark stdin as ready after a short delay
            setTimeout(() => {
                if (!this.processExited) {
                    this.stdinReady = true;
                    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Ready`);
                    this.emit('ready');
                    resolve();
                }
            }, 500);
        });
    }

    /**
     * Process a line of JSON output from the CLI
     */
    private processLine(line: string): void {
        try {
            const message: CliMessage = JSON.parse(line);
            this.plugin.debug(`[${this.sessionId.slice(0, 8)}] ← ${message.type}`);

            switch (message.type) {
                case 'system':
                    this.handleSystemMessage(message);
                    break;

                case 'stream_event':
                    this.handleStreamEvent(message);
                    break;

                case 'assistant':
                    this.handleAssistantMessage(message);
                    break;

                case 'user':
                    // User message with tool results
                    this.handleUserMessage(message);
                    break;

                case 'control_request':
                    this.handleControlRequest(message);
                    break;

                case 'control_response':
                    this.handleControlResponse(message);
                    break;

                case 'keep_alive':
                    // Ignore keep-alive messages
                    break;
            }
        } catch (e) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Failed to parse: ${line.slice(0, 100)}`);
            this.plugin.debug(`[${this.sessionId.slice(0, 8)}] Error: ${e}`);
        }
    }

    /**
     * Handle system initialization message
     */
    private handleSystemMessage(message: SystemMessage): void {
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] System: model=${message.model}, tools=${message.tools.length}`);

        // Emit metadata about available tools
        this.plugin.emit('output', {
            sessionId: this.sessionId,
            content: `✓ Connected (${message.model}, ${message.tools.length} tools)`,
            isComplete: false,
            outputType: 'info',
            timestamp: new Date()
        });
    }

    /**
     * Handle stream event (real-time updates)
     */
    private handleStreamEvent(message: StreamEventMessage): void {
        const event = message.event;

        switch (event.type) {
            case 'message_start':
                // New message starting
                this.seenToolUses.clear();
                this.setActivity('Thinking');
                this.isThinking = true;
                break;

            case 'content_block_start':
                const block = event.content_block;
                if (block.type === 'tool_use') {
                    this.currentTool = block.name;
                    this.isThinking = false;

                    // Set activity based on tool type
                    const activity = this.getActivityForTool(block.name);
                    this.setActivity(activity);

                    this.plugin.emit('status', {
                        sessionId: this.sessionId,
                        status: 'working',
                        currentTool: block.name
                    });
                }
                break;

            case 'content_block_delta':
                const delta = event.delta;
                if (delta.type === 'text_delta' && delta.text) {
                    // Text streaming - set Thinking activity on first text
                    if (!this.isThinking && this.currentActivity !== 'Thinking') {
                        this.isThinking = true;
                        this.setActivity('Thinking');
                    }

                    this.currentContent += delta.text;

                    // Batch text by sentence
                    this.textBuffer += delta.text;
                    this.scheduleBatchFlush();
                } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                    // Flush any text before tool output
                    this.flushTextBuffer();

                    // Tool parameters streaming
                    if (this.currentTool) {
                        // Try to format the partial JSON for display
                        try {
                            // Try to parse what we have so far
                            const parsed = JSON.parse(delta.partial_json);
                            const toolPreview = this.formatToolInput(this.currentTool, parsed);

                            this.plugin.emit('output', {
                                sessionId: this.sessionId,
                                content: `[${this.currentTool}] ${toolPreview}`,
                                isComplete: false,
                                outputType: 'tool_use',
                                timestamp: new Date()
                            });
                        } catch {
                            // Not valid JSON yet, just show the partial
                            this.plugin.emit('output', {
                                sessionId: this.sessionId,
                                content: `[${this.currentTool}] ${delta.partial_json.slice(0, 200)}...`,
                                isComplete: false,
                                outputType: 'tool_use',
                                timestamp: new Date()
                            });
                        }
                    }
                }
                break;

            case 'content_block_stop':
                // Content block complete
                if (event.content_block?.type === 'tool_use') {
                    const toolId = event.content_block.id;
                    this.seenToolUses.add(toolId);
                    // Activity will be updated when next content block starts or message stops
                }
                break;

            case 'message_delta':
                // Message metadata update
                if (event.usage) {
                    this.plugin.emit('metadata', {
                        sessionId: this.sessionId,
                        tokens: event.usage.input_tokens + event.usage.output_tokens,
                        timestamp: new Date()
                    });
                }

                if (event.delta?.stop_reason === 'tool_use') {
                    this.status = 'waiting';
                    this.setActivity('Waiting for tool results');
                    this.plugin.emit('status', {
                        sessionId: this.sessionId,
                        status: 'waiting'
                    });
                }
                break;

            case 'message_stop':
                // Message complete - flush any remaining text as complete
                this.flushTextBuffer(true);

                this.status = 'idle';
                this.currentTool = null;
                this.isThinking = false;
                this.setActivity(null);

                this.plugin.emit('status', {
                    sessionId: this.sessionId,
                    status: 'idle'
                });
                break;
        }
    }

    /**
     * Get human-readable activity name for a tool
     */
    private getActivityForTool(toolName: string): string {
        const activityMap: Record<string, string> = {
            'Task': 'Delegating to agent',
            'Bash': 'Running command',
            'Edit': 'Editing file',
            'Write': 'Writing file',
            'Read': 'Reading file',
            'Glob': 'Searching files',
            'Grep': 'Searching content',
            'AskUserQuestion': 'Waiting for input',
            'MultiEdit': 'Editing files',
            'DirectoryTree': 'Listing directory',
        };
        return activityMap[toolName] || `Using ${toolName}`;
    }

    /**
     * Handle complete assistant message
     * NOTE: We've already streamed all content during handleStreamEvent, so we skip
     * re-emitting text/tool_use here. The CLI sends this after message_stop for
     * completeness, but we don't need it for display.
     */
    private handleAssistantMessage(message: AssistantMessage): void {
        // Skip re-emitting content since it was already streamed
        // Just log for debugging
        this.plugin.debug(`[${this.sessionId.slice(0, 8)}] Assistant message (skipped, already streamed): ${message.message.id}`);
    }

    /**
     * Format tool input for display
     */
    private formatToolInput(toolName: string, input: Record<string, any>): string {
        switch (toolName) {
            case 'Bash':
                return `$ ${input.command}`;
            case 'Edit':
                return `Edit ${input.path} (${input.diff?.slice(0, 50)}...)`;
            case 'Write':
                return `Write ${input.path} (${input.content?.slice(0, 50)}...)`;
            case 'Read':
                return `Read ${input.path}`;
            case 'Glob':
                return `Glob: ${input.pattern}`;
            case 'Grep':
                return `Grep: ${input.pattern}`;
            case 'AskUserQuestion':
                return `Question: ${input.question}`;
            default:
                // Generic formatting - show key fields
                const keys = Object.keys(input).slice(0, 3);
                return keys.map(k => `${k}=${JSON.stringify(input[k]).slice(0, 30)}`).join(', ');
        }
    }

    /**
     * Handle user message (tool results)
     */
    private handleUserMessage(message: UserMessage): void {
        // Tool results coming back
        for (const content of message.message.content) {
            if (content.type === 'tool_result') {
                const toolResult = content; // Type guard

                // Extract tool name from the tool_use_id if possible
                // The tool_use_id format is "call_..." which we can map back to the tool name
                let toolName = 'Unknown';
                if (toolResult.tool_use_id) {
                    // Try to extract tool info from the ID
                    // tool_use_id format: "call_<random>"
                    // But we don't have a direct mapping, so use "Tool Result" as generic
                    toolName = 'Tool Result';
                }

                if (toolResult.is_error) {
                    // Error result - emit as error
                    this.plugin.emit('error', {
                        sessionId: this.sessionId,
                        error: toolResult.content,
                        fatal: false
                    });

                    // Also emit as tool_result with error context
                    this.plugin.emit('output', {
                        sessionId: this.sessionId,
                        content: `[${toolName}] Error: ${toolResult.content}`,
                        isComplete: true,
                        outputType: 'tool_result',
                        timestamp: new Date()
                    });
                } else {
                    // Successful tool result
                    this.plugin.emit('output', {
                        sessionId: this.sessionId,
                        content: `[${toolName}] ${toolResult.content}`.slice(0, 1000),
                        isComplete: true,
                        outputType: 'tool_result',
                        timestamp: new Date()
                    });
                }
            }
        }

        this.plugin.debug(`[${this.sessionId.slice(0, 8)}] User message: ${message.uuid}`);
    }

    /**
     * Handle control request (permission, question, etc.)
     */
    private async handleControlRequest(message: ControlRequestMessage): Promise<void> {
        const { request_id, request } = message;

        this.plugin.debug(`[${this.sessionId.slice(0, 8)}] Control request: ${request.subtype}`);

        if (request.subtype === 'can_use_tool') {
            this.currentRequestId = request_id;

            // Check if this is AskUserQuestion
            if (request.tool_name === 'AskUserQuestion') {
                await this.handleAskUserQuestion(request_id, request);
                return;
            }

            // Regular tool permission request
            this.status = 'waiting';

            // Build approval options
            const options: ApprovalOption[] = [
                { number: '1', label: 'Yes' },
                { number: '2', label: 'No' },
                { number: '3', label: 'Always' },
            ];

            // Build context from tool input
            const context = this.buildToolContext(request.tool_name!, request.input!);

            this.plugin.emit('approval', {
                sessionId: this.sessionId,
                tool: request.tool_name!,
                context,
                options,
                detectedAt: new Date()
            });
        } else {
            // Unknown control request type - send error response
            const errorMessage: ControlResponseMessage = {
                type: 'control_response',
                response: {
                    subtype: 'error',
                    request_id,
                    error: `Unsupported control request subtype: ${request.subtype}`
                }
            };

            await this.writeToStdin(JSON.stringify(errorMessage));
        }
    }

    /**
     * Handle AskUserQuestion control request
     */
    private async handleAskUserQuestion(requestId: string, request: ControlRequest): Promise<void> {
        const input = request.input!;

        // Handle both single question and questions array format
        const questionsArray = input.questions || (input.question ? [{ question: input.question, options: input.options || [], multiSelect: input.multiSelect || false }] : []);

        if (questionsArray.length === 0) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Invalid AskUserQuestion format - no questions found`);
            return;
        }

        // For now, handle the first question (can extend for multiple questions later)
        const firstQuestion = questionsArray[0];
        const question = firstQuestion.question || 'Please provide input:';
        const options = firstQuestion.options || [];
        const multiSelect = firstQuestion.multiSelect || false;
        const header = firstQuestion.header || null;

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Question: "${question}" (${options.length} options, multi=${multiSelect})`);

        // Discord bot expects options as an array of strings (labels only)
        const optionLabels: string[] = options.map((opt: any) => opt.label || opt.value || `Option`);

        // Build context with header if available
        let contextText = header ? `**${header}**\n\n${question}` : question;
        if (options.length > 0) {
            contextText += `\n\nOptions: ${options.map((o: any) => o.label || o.value).join(', ')}`;
        }

        // Emit as a special approval event with question context
        this.plugin.emit('approval', {
            sessionId: this.sessionId,
            tool: 'AskUserQuestion',
            context: contextText,
            options: optionLabels,
            detectedAt: new Date()
        });

        // Store the request ID for sending the response later
        this.currentRequestId = requestId;

        // Store additional context for sending the response
        (this as any).pendingQuestion = {
            options,
            multiSelect
        };
    }

    /**
     * Build human-readable context from tool input
     */
    private buildToolContext(toolName: string, input: Record<string, any>): string {
        switch (toolName) {
            case 'Bash':
                return `Command: ${input.command}`;
            case 'Edit':
            case 'Write':
                return `File: ${input.path}`;
            case 'Read':
                return `Read: ${input.path}`;
            case 'Glob':
                return `Pattern: ${input.pattern}`;
            case 'Grep':
                return `Search: ${input.pattern}`;
            default:
                return JSON.stringify(input).slice(0, 200);
        }
    }

    /**
     * Handle control response (response to our control request)
     */
    private handleControlResponse(message: ControlResponseMessage): void {
        const { request_id, response } = message;

        const pending = this.pendingControlRequests.get(request_id);
        if (pending) {
            if (response.subtype === 'success') {
                pending.resolve(response.response!);
            } else {
                pending.reject(new Error(response.error || 'Control request failed'));
            }
            this.pendingControlRequests.delete(request_id);
        }
    }

    /**
     * Interrupt the current operation
     */
    async interrupt(): Promise<void> {
        if (this.process && !this.processExited) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending interrupt`);

            // Send interrupt control request
            const controlMessage: ControlRequestMessage = {
                type: 'control_request',
                request_id: randomUUID(),
                request: {
                    subtype: 'hook_callback'
                }
            };

            await this.writeToStdin(JSON.stringify(controlMessage));

            this.status = 'idle';
        }
    }

    /**
     * Close the session
     */
    async close(): Promise<void> {
        if (this.process && !this.processExited) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Closing`);
            this.process.kill('SIGTERM');
            setTimeout(() => {
                if (this.process && !this.processExited) {
                    this.process.kill('SIGKILL');
                }
            }, 5000);
        }

        this.process = null;
        this.processExited = true;
        this.stdinReady = false;
        this.status = 'offline';

        // Reject all pending control requests
        for (const pending of this.pendingControlRequests.values()) {
            pending.reject(new Error('Session closed'));
        }
        this.pendingControlRequests.clear();
    }
}

// ============================================================================
// Claude SDK Plugin
// ============================================================================

export class ClaudeSDKPlugin extends BasePlugin {
    readonly name = 'ClaudeSDKPlugin';
    readonly type = 'claude-sdk' as const;
    readonly isPersistent = true; // One process per conversation

    private sessions = new Map<string, ClaudeSDKSession>();

    async initialize(): Promise<void> {
        await super.initialize();
        this.log('Initialized (Claude SDK mode with bidirectional JSON protocol)');
    }

    async createSession(config: SessionConfig): Promise<PluginSession> {
        const session = new ClaudeSDKSession(config, this);

        // Start the process
        await session.start();

        this.sessions.set(config.sessionId, session);

        this.log(`Created session: ${config.sessionId.slice(0, 8)} in ${config.cwd}`);

        // Wait for ready
        await new Promise<void>((resolve) => {
            if (session.isReady) {
                resolve();
            } else {
                session.once('ready', () => resolve());
            }
        });

        return session;
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
}
