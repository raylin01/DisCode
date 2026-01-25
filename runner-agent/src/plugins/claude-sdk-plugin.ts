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
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
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
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta';
    text?: string;
    partial_json?: string;
    thinking?: string;
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
    thinkingMetadata?: {
        level: string;
        disabled: boolean;
        triggers: string[];
    };
    todos?: Array<{
        id: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
    }>;
}

type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
    | { type: 'thinking'; thinking: string; signature?: string };

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
    behavior: 'allow' | 'deny' | 'delegate';
    message?: string;
    toolUseID?: string;
    updatedInput?: Record<string, any>;
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
    private currentToolInput: Record<string, any> = {}; // Track tool input as it streams
    private currentToolUseId: string | null = null; // Track current tool use ID
    private currentContent = '';
    private currentThinking = ''; // Accumulate thinking content
    private seenToolUses = new Set<string>(); // Track tool uses to avoid duplication

    // Debug logging
    private debugLogPath: string | null = null;

    // Text batching for streaming
    private textBuffer = '';
    private batchTimer: NodeJS.Timeout | null = null;
    private readonly BATCH_DELAY = 500; // 500ms - balance between real-time and Discord rate limits

    // Track current output type for batching
    private currentOutputType: 'stdout' | 'thinking' = 'stdout';

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

        // Initialize debug log
        const debugDir = '/tmp/claude-sdk-debug';
        try {
            mkdirSync(debugDir, { recursive: true });
        } catch (e) {
            // Ignore if directory exists
        }
        this.debugLogPath = join(debugDir, `${this.sessionId}.jsonl`);

        // Write session start marker
        this.debugLog('=== SESSION START ===', { sessionId: this.sessionId, timestamp: new Date().toISOString() });
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
        this.currentOutputType = 'stdout'; // Reset output type for new message

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
     * @param optionNumber The selected option number (or '0' for custom "Other" input)
     * @param customMessage Optional custom text when optionNumber is '0'
     */
    async sendApproval(optionNumber: string, customMessage?: string): Promise<void> {
        // Check if this is an AskUserQuestion response
        const pendingQuestion = (this as any).pendingQuestion;
        console.log(`[${this.sessionId.slice(0, 8)}] sendApproval called: optionNumber=${optionNumber}, customMessage=${customMessage}, pendingQuestion exists=${!!pendingQuestion}`);

        if (pendingQuestion && pendingQuestion.currentOptions && pendingQuestion.currentOptions.length > 0) {
            // Handle "Other" custom input (optionNumber === '0')
            if (optionNumber === '0' && customMessage) {
                console.log(`[${this.sessionId.slice(0, 8)}] "Other" option selected with custom message: "${customMessage}"`);

                // Store just the answer value
                const currentQuestionIndex = pendingQuestion.currentQuestionIndex;
                pendingQuestion.allAnswers.push(customMessage);
                console.log(`[${this.sessionId.slice(0, 8)}] Stored custom "Other" answer for question ${currentQuestionIndex + 1}: "${customMessage}"`);

                // Move to next question
                pendingQuestion.currentQuestionIndex++;

                // Ask the next question or send all answers if complete
                await this.askNextQuestion();
                return;
            }

            // Check if this is a multi-select submission (comma-separated option numbers)
            if (optionNumber.includes(',')) {
                console.log(`[${this.sessionId.slice(0, 8)}] Multi-select submission detected: ${optionNumber}`);
                const optionNumbers = optionNumber.split(',').map(s => s.trim());

                // Collect all selected values
                const selectedValues: string[] = [];
                for (const optNum of optionNumbers) {
                    const optionIndex = parseInt(optNum, 10) - 1;
                    console.log(`[${this.sessionId.slice(0, 8)}] Processing option ${optionIndex} (from ${optNum})`);

                    if (optionIndex >= 0 && optionIndex < pendingQuestion.currentOptions.length) {
                        const option = pendingQuestion.currentOptions[optionIndex];
                        let optionValue: string;
                        if (typeof option === 'string') {
                            optionValue = option;
                        } else if (option && typeof option === 'object') {
                            optionValue = option.value || option.label || `Option ${optionIndex + 1}`;
                        } else {
                            optionValue = `Option ${optionIndex + 1}`;
                        }
                        selectedValues.push(optionValue);
                        console.log(`[${this.sessionId.slice(0, 8)}] Collected multi-select answer: "${optionValue}"`);
                    } else {
                        console.log(`[${this.sessionId.slice(0, 8)}] Option index ${optionIndex} out of range`);
                    }
                }

                // Store just the answer array
                const currentQuestionIndex = pendingQuestion.currentQuestionIndex;
                pendingQuestion.allAnswers.push(selectedValues);
                console.log(`[${this.sessionId.slice(0, 8)}] Stored multi-select answer for question ${currentQuestionIndex + 1}:`, JSON.stringify(selectedValues));

                // After processing all options, move to next question
                pendingQuestion.currentQuestionIndex++;
                await this.askNextQuestion();
                return;
            }

            // Single option selection
            // This is an AskUserQuestion - convert 1-indexed button to 0-indexed option
            const optionIndex = parseInt(optionNumber, 10) - 1;
            console.log(`[${this.sessionId.slice(0, 8)}] Option index: ${optionIndex} (from button ${optionNumber})`);

            if (optionIndex >= 0 && optionIndex < pendingQuestion.currentOptions.length) {
                // Get the option value (not just the index)
                const option = pendingQuestion.currentOptions[optionIndex];

                // Handle both object format { label, value } and string format
                let optionValue: string;
                if (typeof option === 'string') {
                    optionValue = option;
                    console.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex} is string: "${optionValue}"`);
                } else if (option && typeof option === 'object') {
                    const keys = Object.keys(option);
                    console.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex} is object with keys: ${keys.join(', ')}`);
                    console.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex}: label="${option.label || 'N/A'}", value="${option.value || 'N/A'}"`);
                    optionValue = option.value || option.label || `Option ${optionIndex + 1}`;
                    console.log(`[${this.sessionId.slice(0, 8)}] Extracted value: "${optionValue}"`);
                } else {
                    optionValue = `Option ${optionIndex + 1}`;
                    console.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex} is ${typeof option}, using fallback: "${optionValue}"`);
                }

                // Store just the answer value
                const currentQuestionIndex = pendingQuestion.currentQuestionIndex;
                pendingQuestion.allAnswers.push(optionValue);
                console.log(`[${this.sessionId.slice(0, 8)}] Stored answer ${pendingQuestion.allAnswers.length} for question ${currentQuestionIndex + 1}: "${optionValue}"`);

                // Move to next question
                pendingQuestion.currentQuestionIndex++;

                // Ask the next question or send all answers if complete
                await this.askNextQuestion();
                return;
            } else {
                console.log(`[${this.sessionId.slice(0, 8)}] Option index ${optionIndex} out of range (0-${pendingQuestion.currentOptions.length - 1})`);
            }
        }

        // Regular tool permission approval
        // Convert option number to behavior
        // 1 = allow (yes), 2 = deny (no), 3 = delegate (allow all for this tool)
        const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
            '1': 'allow',
            '2': 'deny',
            '3': 'delegate'
        };

        const behavior = behaviorMap[optionNumber] || 'allow';

        const response: ControlResponseData = {
            behavior,
            toolUseID: this.currentRequestId
        };

        console.log(`[${this.sessionId.slice(0, 8)}] Sending approval: ${behavior}`);

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
    private flushTextBuffer(isComplete: boolean = false, outputType: 'stdout' | 'thinking' = 'stdout'): void {
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        if (this.textBuffer) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Flushing buffer: outputType=${outputType}, length=${this.textBuffer.length}, isComplete=${isComplete}`);
            this.plugin.emit('output', {
                sessionId: this.sessionId,
                content: this.textBuffer,
                isComplete,
                outputType,
                timestamp: new Date()
            });
            this.textBuffer = '';
        }
    }

    /**
     * Schedule batch flush with time-based batching
     * Flushes every BATCH_INTERVAL_MS to provide real-time updates without overwhelming Discord
     */
    private scheduleBatchFlush(outputType: 'stdout' | 'thinking' = 'stdout'): void {
        // If output type is changing, flush immediately with the old type
        if (outputType !== this.currentOutputType && this.textBuffer) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Output type changing: ${this.currentOutputType} -> ${outputType}, flushing existing buffer`);
            this.flushTextBuffer(false, this.currentOutputType);
            this.currentOutputType = outputType;
        }

        // Clear existing timer
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
        }

        // Always schedule a flush after the batch interval
        // This provides predictable, time-based batching rather than sentence-based
        this.batchTimer = setTimeout(() => {
            this.flushTextBuffer(false, this.currentOutputType);
        }, this.BATCH_DELAY);
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

            // Add max-thinking-tokens if enabled (critical for extended thinking)
            const maxTokens = this.getMaxThinkingTokens();
            if (maxTokens > 0) {
                args.push('--max-thinking-tokens', maxTokens.toString());
                this.plugin.log(`[${this.sessionId.slice(0, 8)}] Extended thinking enabled: ${maxTokens} tokens`);
            }

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
     * Debug logging helper
     */
    private debugLog(direction: string, data: any): void {
        if (!this.debugLogPath) return;

        const logEntry = {
            timestamp: new Date().toISOString(),
            sessionId: this.sessionId,
            direction,
            ...data
        };

        try {
            appendFileSync(this.debugLogPath, JSON.stringify(logEntry) + '\n');
        } catch (e) {
            // Ignore logging errors
        }
    }

    /**
     * Process a line of JSON output from the CLI
     */
    private processLine(line: string): void {
        try {
            const message: CliMessage = JSON.parse(line);
            this.plugin.debug(`[${this.sessionId.slice(0, 8)}] ← ${message.type}`);

            // Log all incoming messages
            this.debugLog('RECEIVED', { type: message.type, raw: line });

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
            this.debugLog('ERROR', { error: String(e), line: line.slice(0, 500) });
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
                // New message starting - clear any pending tool state from previous message
                this.seenToolUses.clear();
                this.currentTool = null;
                this.currentToolInput = {};
                this.currentToolUseId = null;
                this.currentThinking = ''; // Clear thinking buffer
                this.currentOutputType = 'stdout'; // Reset output type
                this.setActivity('Thinking');
                this.isThinking = true;
                break;

            case 'content_block_start':
                const block = event.content_block;
                if (block.type === 'tool_use') {
                    // Flush any pending text/thinking as complete before starting tool use
                    // This ensures text/thinking and tool use are separate messages
                    this.flushTextBuffer(true);
                    this.currentOutputType = 'stdout'; // Reset to stdout after tool

                    this.currentTool = block.name;
                    this.currentToolUseId = block.id;
                    this.currentToolInput = {}; // Reset tool input tracking
                    this.isThinking = false;

                    // Set activity based on tool type
                    const activity = this.getActivityForTool(block.name);
                    this.setActivity(activity);

                    this.plugin.emit('status', {
                        sessionId: this.sessionId,
                        status: 'working',
                        currentTool: block.name
                    });
                } else if (block.type === 'thinking') {
                    // Thinking block started - flush any pending text buffer first
                    this.flushTextBuffer(true);
                    this.currentOutputType = 'thinking'; // Set output type before first thinking delta
                    this.isThinking = true;
                    this.setActivity('Thinking');
                    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Thinking block started, outputType set to 'thinking'`);

                    this.plugin.emit('status', {
                        sessionId: this.sessionId,
                        status: 'thinking'
                    });
                } else if (block.type === 'text') {
                    // Text block started - flush any pending thinking buffer first
                    this.flushTextBuffer(true);
                    this.currentOutputType = 'stdout'; // Reset to stdout for text
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

                    // Batch text using the batching mechanism with stdout output type
                    this.textBuffer += delta.text;
                    this.scheduleBatchFlush('stdout');
                } else if (delta.type === 'thinking_delta' && delta.thinking) {
                    // Thinking content streaming - accumulate and emit with batching
                    this.currentThinking += delta.thinking;

                    // Add thinking to buffer with outputType='thinking'
                    this.textBuffer += delta.thinking;
                    this.scheduleBatchFlush('thinking');

                    // Log thinking delta for debugging
                    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Thinking delta received: ${delta.thinking.slice(0, 50)}... (total: ${this.currentThinking.length} chars)`);

                    this.debugLog('THINKING_DELTA', {
                        content: delta.thinking,
                        accumulatedLength: this.currentThinking.length
                    });
                } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                    // Accumulate tool input as it streams, but don't emit yet
                    // We'll emit the complete tool output in content_block_stop
                    if (this.currentTool) {
                        try {
                            // Parse and merge the partial JSON
                            const parsed = JSON.parse(delta.partial_json);
                            Object.assign(this.currentToolInput, parsed);
                        } catch {
                            // Not valid JSON yet, continue accumulating
                        }
                    }
                }
                break;

            case 'content_block_stop':
                // Content block complete
                if (event.content_block?.type === 'tool_use') {
                    const toolId = event.content_block.id;
                    this.seenToolUses.add(toolId);

                    // Emit tool use with isComplete: false to indicate waiting for results
                    // The tool result will be combined with this in a follow-up message
                    if (this.currentTool === 'Edit' || this.currentTool === 'MultiEdit') {
                        const toolPreview = this.formatToolInput(this.currentTool, this.currentToolInput);
                        const editPath = this.currentToolInput.path || this.currentToolInput.filePath || 'file';
                        this.plugin.emit('output', {
                            sessionId: this.sessionId,
                            content: `**Editing:** ${editPath}\n\`\`\`diff\n${toolPreview}\n\`\`\``,
                            isComplete: false, // Waiting for results
                            outputType: 'edit',
                            structuredData: {
                                edit: {
                                    filePath: editPath,
                                    oldContent: this.currentToolInput.oldText,
                                    newContent: this.currentToolInput.newText,
                                    diff: toolPreview
                                }
                            },
                            timestamp: new Date()
                        });

                        this.debugLog('EMITTED', {
                            type: 'edit',
                            isComplete: false,
                            tool: this.currentTool,
                            contentPreview: `**Editing:** ${this.currentToolInput.path || 'file'}`
                        });
                    } else {
                        const toolPreview = this.formatToolInput(this.currentTool, this.currentToolInput);
                        this.plugin.emit('output', {
                            sessionId: this.sessionId,
                            content: `[${this.currentTool}]\n\`\`\`\n${toolPreview}\n\`\`\``,
                            isComplete: false, // Waiting for results
                            outputType: 'tool_use',
                            structuredData: {
                                tool: {
                                    name: this.currentTool,
                                    input: this.currentToolInput
                                }
                            },
                            timestamp: new Date()
                        });

                        this.debugLog('EMITTED', {
                            type: 'tool_use',
                            isComplete: false,
                            tool: this.currentTool,
                            input: this.currentToolInput,
                            contentPreview: `[${this.currentTool}]`
                        });
                    }

                    // Don't clear tool state yet - we need it when results come back
                    // this.currentTool = null;
                    // this.currentToolInput = {};
                } else if (event.content_block?.type === 'thinking') {
                    // Thinking block complete - flush the thinking buffer
                    this.flushTextBuffer(true, 'thinking');
                    this.currentOutputType = 'stdout'; // Reset to stdout after thinking
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
                this.flushTextBuffer(true, this.currentOutputType);

                this.status = 'idle';
                // Don't clear tool state - tool results arrive in the next user message
                // Tool state is cleared in handleUserMessage after emitting combined result
                this.currentThinking = ''; // Clear thinking buffer
                this.isThinking = false;
                this.currentOutputType = 'stdout'; // Reset to stdout for next message
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
     * NOTE: Text and tool_use content are already streamed via handleStreamEvent
     * However, thinking blocks are only available in the complete message
     */
    private handleAssistantMessage(message: AssistantMessage): void {
        // Log what we received
        this.debugLog('ASSISTANT_MESSAGE', {
            messageId: message.message.id,
            contentTypes: message.message.content.map(c => c.type),
            hasThinkingMetadata: !!message.thinkingMetadata,
            todosCount: message.todos?.length || 0,
            fullMessage: message
        });

        // Process thinking blocks from content
        for (const content of message.message.content) {
            if (content.type === 'thinking') {
                // Emit thinking content as a separate output type
                this.plugin.emit('output', {
                    sessionId: this.sessionId,
                    content: content.thinking,
                    isComplete: true,
                    outputType: 'thinking',
                    timestamp: new Date()
                });

                // Log what we emitted
                this.debugLog('EMITTED', {
                    type: 'thinking',
                    contentPreview: content.thinking.slice(0, 200),
                    isComplete: true
                });
            }
        }

        // Process todos if present
        if (message.todos && message.todos.length > 0) {
            const todoContent = message.todos.map(todo => {
                const status = todo.status === 'completed' ? '✅' :
                              todo.status === 'in_progress' ? '🔄' : '⏳';
                return `${status} ${todo.content}`;
            }).join('\n');

            this.plugin.emit('output', {
                sessionId: this.sessionId,
                content: todoContent,
                isComplete: true,
                outputType: 'info',
                timestamp: new Date()
            });

            // Log what we emitted
            this.debugLog('EMITTED', {
                type: 'info',
                contentType: 'todos',
                todosCount: message.todos.length,
                content: todoContent
            });
        }

        this.plugin.debug(`[${this.sessionId.slice(0, 8)}] Assistant message processed: ${message.message.id}`);
    }

    /**
     * Format tool input for display
     */
    private formatToolInput(toolName: string, input: Record<string, any>): string {
        switch (toolName) {
            case 'Bash':
                return `$ ${input.command}`;
            case 'Edit':
                // Format as a proper diff
                const editPath = input.path || input.filePath || 'file';
                if (input.oldText && input.newText) {
                    const diff = this.createUnifiedDiff(editPath, input.oldText, input.newText);
                    return diff;
                } else if (input.diff) {
                    return input.diff;
                } else {
                    return `Edit ${editPath}`;
                }
            case 'Write':
                const writePath = input.path || input.filePath || 'unknown';
                return `Write ${writePath}\n\`\`\`\n${input.content?.slice(0, 500)}${input.content && input.content.length > 500 ? '...' : ''}\n\`\`\``;
            case 'Read':
                const readPath = input.path || input.file_path || input.filePath || 'unknown';
                return `Read ${readPath}`;
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
     * Create a unified diff format for edits
     */
    private createUnifiedDiff(filePath: string, oldText: string, newText: string): string {
        const lines = [];

        // Split into lines
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');

        lines.push(`--- a/${filePath}`);
        lines.push(`+++ b/${filePath}`);

        // Simple line-by-line diff (for now, can be improved with actual diff algorithm)
        const maxLines = Math.max(oldLines.length, newLines.length);
        let oldLineNum = 1;
        let newLineNum = 1;

        for (let i = 0; i < maxLines; i++) {
            const oldLine = oldLines[i] || '';
            const newLine = newLines[i] || '';

            if (oldLine === newLine) {
                // Context line
                lines.push(` ${oldLine}`);
                oldLineNum++;
                newLineNum++;
            } else {
                // Changed line
                if (oldLine) {
                    lines.push(`-${oldLine}`);
                    oldLineNum++;
                }
                if (newLine) {
                    lines.push(`+${newLine}`);
                    newLineNum++;
                }
            }
        }

        return lines.join('\n');
    }

    /**
     * Strip line numbers from file content (format: "     1→text")
     * This cleans up the ugly line number format from Read tool results
     */
    private stripLineNumbers(content: string): string {
        return content
            .split('\n')
            .map(line => {
                // Match format: "     1→text" or "    23→text"
                const match = line.match(/^\s*\d+→(.*)$/);
                return match ? match[1] : line;
            })
            .join('\n');
    }

    /**
     * Handle user message (tool results)
     */
    private handleUserMessage(message: UserMessage): void {
        // Log user message
        this.debugLog('USER_MESSAGE', {
            contentTypes: message.message.content.map(c => c.type),
            toolResultsCount: message.message.content.filter(c => c.type === 'tool_result').length
        });

        // Tool results coming back
        for (const content of message.message.content) {
            if (content.type === 'tool_result') {
                const toolResult = content; // Type guard

                // Check if we have a current tool that this result belongs to
                if (this.currentTool && toolResult.tool_use_id === this.currentToolUseId) {
                    // Combine tool use info with result
                    const toolPreview = this.formatToolInput(this.currentTool, this.currentToolInput);
                    let resultContent = String(toolResult.content || '');

                    // Clean up Read tool results by stripping line numbers
                    if (this.currentTool === 'Read') {
                        resultContent = this.stripLineNumbers(resultContent);
                    }

                    // Truncate to reasonable length
                    resultContent = resultContent.slice(0, 2000);

                    if (toolResult.is_error) {
                        // Error result
                        this.plugin.emit('output', {
                            sessionId: this.sessionId,
                            content: `**[${this.currentTool}]**\n\`\`\`\n${toolPreview}\n\`\`\`\n\n**Error:**\n\`\`\`\n${resultContent}\n\`\`\``,
                            isComplete: true,
                            outputType: 'tool_result',
                            structuredData: {
                                tool: {
                                    name: this.currentTool,
                                    input: this.currentToolInput,
                                    result: resultContent,
                                    isError: true
                                }
                            },
                            timestamp: new Date()
                        });

                        this.debugLog('EMITTED', {
                            type: 'tool_result',
                            isComplete: true,
                            isError: true,
                            tool: this.currentTool,
                            resultPreview: resultContent.slice(0, 200)
                        });
                    } else {
                        // Successful result
                        this.plugin.emit('output', {
                            sessionId: this.sessionId,
                            content: `**[${this.currentTool}]**\n\`\`\`\n${toolPreview}\n\`\`\`\n\n**Result:**\n\`\`\`\n${resultContent}\n\`\`\``,
                            isComplete: true,
                            outputType: 'tool_result',
                            structuredData: {
                                tool: {
                                    name: this.currentTool,
                                    input: this.currentToolInput,
                                    result: resultContent
                                }
                            },
                            timestamp: new Date()
                        });

                        this.debugLog('EMITTED', {
                            type: 'tool_result',
                            isComplete: true,
                            isError: false,
                            tool: this.currentTool,
                            resultPreview: resultContent.slice(0, 200)
                        });
                    }

                    // Clear tool state after emitting combined result
                    this.currentTool = null;
                    this.currentToolInput = {};
                    this.currentToolUseId = null;
                } else {
                    // No matching tool use, emit result separately
                    const resultContent = String(toolResult.content || '').slice(0, 2000);
                    this.plugin.emit('output', {
                        sessionId: this.sessionId,
                        content: `[Tool Result] ${resultContent}`,
                        isComplete: true,
                        outputType: 'tool_result',
                        timestamp: new Date()
                    });

                    this.debugLog('EMITTED', {
                        type: 'tool_result',
                        isComplete: true,
                        unmatched: true,
                        toolUseId: toolResult.tool_use_id,
                        currentToolUseId: this.currentToolUseId,
                        resultPreview: resultContent.slice(0, 200)
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
        // Write full request to debug file
        const fs = require('fs');
        const debugDir = '/tmp/claude-sdk-debug';
        try {
            fs.mkdirSync(debugDir, { recursive: true });
        } catch (e) {
            // Ignore if directory exists
        }

        const debugPath = `${debugDir}/${this.sessionId.slice(0, 8)}-ask-user-question.json`;
        try {
            fs.writeFileSync(debugPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                sessionId: this.sessionId,
                requestId: requestId,
                fullRequest: request
            }, null, 2) + '\n');
            console.log(`[${this.sessionId.slice(0, 8)}] WROTE FULL CONTROL REQUEST TO: ${debugPath}`);
        } catch (e) {
            console.error('Failed to write debug file:', e);
        }

        // Get input - can be directly questions array or wrapped in an object
        let questionsArray: any[] = [];

        if (Array.isArray(request.input)) {
            // input IS the questions array
            questionsArray = request.input;
        } else if (request.input && Array.isArray(request.input.questions)) {
            // input.questions contains the questions array
            questionsArray = request.input.questions;
        } else if (request.input && request.input.question) {
            // Single question format - wrap in array
            questionsArray = [request.input];
        }

        console.log(`[${this.sessionId.slice(0, 8)}] Parsed ${questionsArray.length} questions from input`);

        if (questionsArray.length === 0) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Invalid AskUserQuestion format - no questions found`);
            return;
        }

        // Store all questions and track current question index for multi-question flows
        (this as any).pendingQuestion = {
            input: request.input,
            questions: questionsArray,
            allAnswers: [],  // Collect answers as we go
            currentQuestionIndex: 0,  // Start with first question
            multiSelect: questionsArray[0]?.multiSelect || false
        };

        // Ask the first question
        await this.askNextQuestion();
    }

    /**
     * Ask the next question in a multi-question flow
     */
    private async askNextQuestion(): Promise<void> {
        const pendingQuestion = (this as any).pendingQuestion;
        const questionIndex = pendingQuestion.currentQuestionIndex;
        const questionsArray = pendingQuestion.questions;

        if (questionIndex >= questionsArray.length) {
            // All questions have been asked, send final response
            await this.sendAllAnswers();
            return;
        }

        const currentQuestion = questionsArray[questionIndex];
        const question = currentQuestion.question || 'Please provide input:';
        const options = currentQuestion.options || [];
        const multiSelect = currentQuestion.multiSelect || false;
        const header = currentQuestion.header || null;

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Question details:`, JSON.stringify({
            questionIndex: questionIndex + 1,
            totalQuestions: questionsArray.length,
            question,
            optionsCount: options.length,
            multiSelect,  // Log this specifically
            rawMultiSelect: currentQuestion.multiSelect  // Log raw value too
        }));

        // CRITICAL: Ensure options have a 'value' field for CLI matching
        const processedOptions = options.map((opt: any, idx: number) => {
            if (typeof opt === 'string') {
                return { label: opt, value: opt };
            }
            return {
                ...opt,
                value: opt.value || opt.label || `option${idx}`
            };
        });

        // Discord bot expects options as an array of strings (labels only)
        const optionLabels: string[] = options.map((opt: any, idx: number) => {
            if (typeof opt === 'string') return opt;
            return opt.label || opt.value || `Option ${idx + 1}`;
        });

        // Build context with header if available
        let contextText = header ? `**${header}**\n\n${question}` : question;
        if (questionsArray.length > 1) {
            contextText += `\n\n*(Question ${questionIndex + 1} of ${questionsArray.length})*`;
        }
        if (options.length > 0) {
            const optionDescriptions = options.map((o: any, idx: number) => {
                if (typeof o === 'string') return `${idx + 1}. ${o}`;
                return `${idx + 1}. ${o.label || o.value || 'Option'}`;
            }).join('\n');
            contextText += `\n\n${optionDescriptions}`;
        }

        // Emit approval event for this question
        this.plugin.emit('approval', {
            sessionId: this.sessionId,
            tool: 'AskUserQuestion',
            context: contextText,
            options: optionLabels,
            detectedAt: new Date(),
            // Pass multi-select and Other option info to Discord bot
            isMultiSelect: multiSelect,
            hasOther: true  // Always include "Other" button for custom input
        });

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Emitting approval event with flags:`, JSON.stringify({
            isMultiSelect: multiSelect,
            hasOther: true,
            optionsCount: optionLabels.length
        }));

        // Store the request ID for sending the response later
        // NOTE: We use the same requestId for all questions in a multi-question flow
        if (questionIndex === 0) {
            this.currentRequestId = (this as any).currentRequestId || null;
        }

        // Store processed options for this question
        pendingQuestion.currentOptions = processedOptions;
        pendingQuestion.currentMultiSelect = multiSelect;

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Waiting for answer to question ${questionIndex + 1}/${questionsArray.length}`);
    }

    /**
     * Send all collected answers for a multi-question AskUserQuestion
     */
    private async sendAllAnswers(): Promise<void> {
        const pendingQuestion = (this as any).pendingQuestion;
        const answers = pendingQuestion.allAnswers;
        const questionsCount = pendingQuestion.questions.length;

        console.log(`[${this.sessionId.slice(0, 8)}] All ${questionsCount} questions answered, sending:`, JSON.stringify(answers));

        // Build answers object with question headers as keys (not array indices)
        // Format: { "Question Header": answer } or { "Question Text": answer }
        const answersObject: Record<string, any> = {};
        for (let i = 0; i < pendingQuestion.questions.length; i++) {
            const q = pendingQuestion.questions[i];
            // Use header if available, otherwise use question text
            const key = q.header || q.question || `Question ${i + 1}`;
            answersObject[key] = answers[i];
        }

        // Build a summary question text for display (fixes "Question: undefined")
        const questionSummary = questionsCount === 1
            ? pendingQuestion.questions[0].question
            : pendingQuestion.questions.map((q: any, i: number) =>
                q.header || q.question || `Question ${i + 1}`
            ).join(', ');

        const updatedInput: Record<string, any> = {
            question: questionSummary,
            answers: answersObject
        };

        const response: ControlResponseData = {
            behavior: 'allow',
            updatedInput
        };

        const controlMessage: ControlResponseMessage = {
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: this.currentRequestId,
                response
            }
        };

        console.log(`[${this.sessionId.slice(0, 8)}] Sending control_response:`, JSON.stringify(controlMessage, null, 2));

        const fs = require('fs');
        const debugPath = `/tmp/claude-sdk-debug/${this.sessionId.slice(0, 8)}-control-response.json`;
        try {
            fs.writeFileSync(debugPath, JSON.stringify(controlMessage, null, 2) + '\n');
        } catch (e) {
            console.error('Failed to write debug file:', e);
        }

        await this.writeToStdin(JSON.stringify(controlMessage));

        // Clear pending question
        delete (this as any).pendingQuestion;
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
     * Get max thinking tokens based on thinking level setting
     * Matches the VS Code extension logic
     */
    private getMaxThinkingTokens(): number {
        // If explicitly set in options, use that
        if (this.config.options?.maxThinkingTokens !== undefined) {
            return this.config.options.maxThinkingTokens;
        }

        // Otherwise, determine from thinking level
        const level = this.config.options?.thinkingLevel || 'default_on';

        // Match extension logic (extension-beautified.js:47199)
        // off = 0, everything else = 31999
        if (level === 'off') {
            return 0;
        }

        // Extension returns 31999 for all non-off levels
        return 31999;
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
