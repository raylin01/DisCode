/**
 * Claude SDK Plugin for CLI Integration
 *
 * Uses the standalone @raylin01/claude-client library to manage the Claude Code CLI.
 * This plugin acts as a bridge between the generic DisCode runner-agent and the Claude Client.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import {
    BasePlugin,
    PluginSession,
    SessionConfig,
    SessionStatus,
    PluginType
} from './base.js';
import { shouldAutoApproveInSafeMode, getDangerousReason } from '../permissions/safe-tools.js';
import { getConfig } from '../config.js';

// Import from our new library
import {
  ClaudeClient,
  AssistantMessage,
  ControlRequestMessage,
  ControlResponseData,
  Suggestion,
  PermissionScope,
  ToolUseStartEvent,
  ToolResultEvent,
  ResultMessage,
  ClaudeSupportedModel
} from '@raylin01/claude-client';

// ============================================================================
// Claude SDK Session
// ============================================================================

class ClaudeSDKSession extends EventEmitter implements PluginSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly createdAt: Date;
    readonly isOwned = true;

    // Status tracking conforming to SessionStatus interface
    status: SessionStatus = 'idle';
    lastActivity: Date;
    
    // The underlying Claude Client
    private client: ClaudeClient;

    // Buffer for batching output
    private textBuffer = '';
    private flushTimer: NodeJS.Timeout | null = null;
    private readonly BATCH_INTERVAL_MS = 100;

    // Throttle for accumulated output (to avoid Discord rate limits)
    private pendingStdoutContent = '';
    private pendingThinkingContent = '';
    private outputThrottleTimer: NodeJS.Timeout | null = null;
    private readonly OUTPUT_THROTTLE_MS = 500;  // Update Discord at most every 500ms

    // Track current state
    private currentActivity: string | null = null;
    private currentThinking = '';
    private currentOutputType: 'stdout' | 'thinking' = 'stdout';
    private lastAssistantOutput = '';


    // Plan Mode State
    private currentPlanPath: string | null = null;
    private activeToolExecutions = new Map<string, string>();

    // AskUserQuestion state
    private pendingQuestion: {
        baseRequestId: string;
        currentRequestId?: string;
        input: any;
        questions: any[];
        allAnswers: any[];
        currentQuestionIndex: number;
        currentOptions?: Array<{ label: string; value: string }>;
        currentMultiSelect?: boolean;
    } | null = null;

    // Auto-approve safe mode flag
    private autoApproveSafe: boolean = false;

    // Permission request tracking
    private pendingPermissions = new Map<string, {
        requestId: string;
        sdkRequestId: string;
        toolName: string;
        input: Record<string, any>;
        toolUseId: string;
        suggestions?: Suggestion[];
        blockedPath?: string;
        decisionReason?: string;
    }>();

    private deferredApproval: {
        optionNumber: string;
        message?: string;
        receivedAt: number;
    } | null = null;

    private applyScopeToSuggestions(
        suggestions: Suggestion[] | undefined,
        scope: PermissionScope
    ): Suggestion[] {
        if (!suggestions || suggestions.length === 0) return [];
        return suggestions.map((suggestion: any) => {
            if (suggestion.type === 'setMode') {
                return {
                    ...suggestion,
                    destination: suggestion.destination || scope
                };
            }
            return {
                ...suggestion,
                destination: suggestion.destination || scope
            };
        });
    }

    constructor(config: SessionConfig, private plugin: ClaudeSDKPlugin) {
        super();
        this.sessionId = config.sessionId || randomUUID();
        this.config = config;
        this.createdAt = new Date();
        this.lastActivity = new Date();

        const options = config.options || {};
        const allowDangerouslySkipPermissions =
            options.allowDangerouslySkipPermissions ?? options.skipPermissions ?? false;

        // Store autoApproveSafe flag for use in permission handling
        this.autoApproveSafe = options.autoApproveSafe ?? false;

        // Initialize the Claude Client
        this.client = new ClaudeClient({
            cwd: config.cwd || process.cwd(),
            claudePath: config.cliPath, // Use provided CLI path
            executable: options.executable,
            executableArgs: options.executableArgs,
            debug: process.env.DEBUG_CLAUDE === 'true',
            sessionId: this.sessionId,
            env: {
                ...process.env,
                ...options.env,
                DISCODE_SESSION_ID: this.sessionId,
                DISCODE_HTTP_PORT: String(getConfig().httpPort)
            },
            includePartialMessages: options.includePartialMessages,
            permissionPromptTool: options.permissionPromptTool,
            permissionPromptToolName: options.permissionPromptToolName,
            resumeSessionId: options.resumeSessionId,
            continueConversation: options.continueConversation,
            forkSession: options.forkSession,
            resumeSessionAt: options.resumeSessionAt,
            persistSession: options.persistSession,
            maxTurns: options.maxTurns,
            maxBudgetUsd: options.maxBudgetUsd,
            model: options.model,
            fallbackModel: options.fallbackModel,
            agent: options.agent,
            betas: options.betas,
            jsonSchema: options.jsonSchema,
            permissionMode: options.permissionMode,
            allowDangerouslySkipPermissions,
            allowedTools: options.allowedTools,
            disallowedTools: options.disallowedTools,
            tools: options.tools,
            mcpServers: options.mcpServers,
            strictMcpConfig: options.strictMcpConfig,
            settingSources: options.settingSources,
            additionalDirectories: options.additionalDirectories,
            plugins: options.plugins,
            extraArgs: options.extraArgs,
            sandbox: options.sandbox,
            enableFileCheckpointing: options.enableFileCheckpointing,
            thinking: {
                maxTokens: options.maxThinkingTokens,
                level: options.thinkingLevel
            }
        });

        // Set up Event Listeners
        this.setupEventListeners();
    }

    private setupEventListeners() {
        // Ready
        this.client.on('ready', () => {
            this.status = 'idle';
            this.emit('ready');
            // Notify generic plugin listeners
        });

        // System init (model, permission mode, MCP servers)
        this.client.on('system', (message) => {
            this.plugin.emit('metadata', {
                sessionId: this.sessionId,
                model: message.model,
                permissionMode: message.permissionMode,
                mcpServers: message.mcp_servers,
                timestamp: new Date()
            });

            // Emit CLI session ID for persistence (enables resume after restart)
            if (message.session_id) {
                this.plugin.emit('cli_session_id', {
                    sessionId: this.sessionId,
                    cliSessionId: message.session_id
                });
            }
        });

        // Text Streaming (accumulated mode with throttling)
        this.client.on('text_accumulated', (accumulatedText) => {
            if (this.currentOutputType !== 'stdout') {
                // Flush any pending thinking content before switching
                this.flushThrottledOutput();
                this.currentOutputType = 'stdout';
            }
            // Store latest accumulated content and schedule throttled emit
            this.lastAssistantOutput = accumulatedText;
            this.pendingStdoutContent = accumulatedText;
            this.scheduleThrottledOutput();
        });

        // Thinking Streaming (accumulated mode with throttling)
        this.client.on('thinking_accumulated', (accumulatedThinking) => {
            if (this.currentOutputType !== 'thinking') {
                // Flush any pending stdout content before switching
                this.flushThrottledOutput();
                this.currentOutputType = 'thinking';
                this.status = 'working';
                this.setActivity('Thinking');
            }
            this.currentThinking = accumulatedThinking;
            // Store latest accumulated content and schedule throttled emit
            this.pendingThinkingContent = accumulatedThinking;
            this.scheduleThrottledOutput();
        });

        // Full Messages (Assistant)
        this.client.on('message', (message: AssistantMessage) => {
            // Flush any pending throttled content with isComplete: true
            // This ensures Discord clears its streaming state and prevents duplicate messages
            this.flushThrottledOutput(true);

            // Clear the output buffers to prevent reuse
            this.lastAssistantOutput = '';
            this.currentThinking = '';

            this.status = 'idle';
            this.setActivity(null);

            // Handle Todos
            const legacyTodos = message.todos || [];
            
            // Check for tool use todos (TodoWrite)
            const toolTodos: any[] = [];
            message.message.content.forEach(block => {
                if (block.type === 'tool_use' && block.name === 'TodoWrite') {
                    const input = block.input as any;
                    if (input && Array.isArray(input.todos)) {
                        toolTodos.push(...input.todos);
                    }
                }
            });

            const allTodos = [...legacyTodos, ...toolTodos];

            if (allTodos.length > 0) {
                 const todoContent = allTodos.map(todo => {
                    const status = todo.status === 'completed' ? '✅' :
                                  todo.status === 'in_progress' ? '🔄' : 'box';
                    return `${status} ${todo.content}`;
                }).join('\n');

                this.plugin.emit('output', {
                    sessionId: this.sessionId,
                    content: todoContent,
                    isComplete: true,
                    outputType: 'todos',
                    timestamp: new Date()
                });
            }
        });

        // Tool Use & Permissions
        this.client.on('control_request', (req: ControlRequestMessage) => {
            const request = req.request;
            const toolNameForLog = request.subtype === 'can_use_tool' ? (request.tool_name || 'n/a') : 'n/a';

            console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] control_request: id=${req.request_id} subtype=${request.subtype} tool=${toolNameForLog}`);

            if (request.subtype === 'can_use_tool') {
                // Auto-approve safe tools if in autoApproveSafe mode
                if (this.autoApproveSafe) {
                    const toolName = request.tool_name || '';
                    const input = request.input || {};

                    if (shouldAutoApproveInSafeMode(toolName, input)) {
                        console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Auto-approving safe tool: ${toolName}`);

                        // Send auto-approval response
                        const responseData: ControlResponseData = {
                            behavior: 'allow',
                            updatedInput: input,
                            message: 'Auto-approved (safe operation)'
                        };
                        this.client.sendControlResponse(req.request_id, responseData).catch((err) => {
                            this.plugin.emit('error', {
                                sessionId: this.sessionId,
                                error: err.message,
                                fatal: false
                            });
                        });
                        return;
                    } else {
                        const reason = toolName === 'Bash' ? getDangerousReason(input?.command || '') : undefined;
                        console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Tool ${toolName} requires approval in autoSafe mode${reason ? `: ${reason}` : ''}`);
                    }
                }

                if (request.tool_name === 'AskUserQuestion') {
                    this.handleAskUserQuestion(req.request_id, request).catch((err) => {
                        this.plugin.emit('error', {
                            sessionId: this.sessionId,
                            error: err.message,
                            fatal: false
                        });
                    });
                    return;
                }

                if (request.tool_name === 'ExitPlanMode') {
                    this.handleExitPlanModeRequest(req).catch((err) => {
                         this.plugin.emit('error', {
                            sessionId: this.sessionId,
                            error: `ExitPlanMode error: ${err.message}`,
                            fatal: false
                        });
                    });
                    return;
                }

                this.status = 'waiting';
                const approvalId = `${this.sessionId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
                
                this.pendingPermissions.set(approvalId, {
                    requestId: approvalId,
                    sdkRequestId: req.request_id,
                    toolName: request.tool_name || 'unknown',
                    input: request.input || {},
                    toolUseId: request.tool_use_id || '',
                    suggestions: request.permission_suggestions || [],
                    blockedPath: request.blocked_path,
                    decisionReason: request.decision_reason
                });

                console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] pendingPermissions add: approvalId=${approvalId} sdkRequestId=${req.request_id} toolUseId=${request.tool_use_id || 'none'}`);

                // Apply deferred approval if one exists and is recent (within 1 second)
                // This handles race conditions where approval arrives before control_request
                // The short window prevents stale approvals from applying to unrelated requests
                if (this.deferredApproval && Date.now() - this.deferredApproval.receivedAt < 1000) {
                    const { optionNumber, message } = this.deferredApproval;
                    this.deferredApproval = null;
                    console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Applying deferred approval: option=${optionNumber}`);
                    this.sendApproval(optionNumber, message, approvalId).catch((err) => {
                        this.plugin.emit('error', {
                            sessionId: this.sessionId,
                            error: err.message,
                            fatal: false
                        });
                    });
                } else if (this.deferredApproval) {
                    // Clear stale deferred approval
                    console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Clearing stale deferred approval (${Date.now() - this.deferredApproval.receivedAt}ms old)`);
                    this.deferredApproval = null;
                }

                this.plugin.emit('approval', {
                    sessionId: this.sessionId,
                    requestId: approvalId,
                    tool: request.tool_name || 'unknown',
                    context: JSON.stringify(request.input),
                    toolInput: request.input || {},
                    suggestions: request.permission_suggestions || [],
                    blockedPath: request.blocked_path,
                    decisionReason: request.decision_reason,
                    detectedAt: new Date()
                });
            } else if (request.subtype === 'hook_callback') {
                const responseData: ControlResponseData = {
                    behavior: 'allow',
                    updatedInput: request.input || {},
                    message: 'OK'
                };
                this.client.sendControlResponse(req.request_id, responseData).catch((err) => {
                    this.plugin.emit('error', {
                        sessionId: this.sessionId,
                        error: err.message,
                        fatal: false
                    });
                });
            } else if (request.subtype === 'mcp_message') {
                console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] MCP message received (no handler).`);
            }
        });

        this.client.on('control_cancel_request', (req) => {
            // Clear pending permissions matching this SDK request ID
            for (const [approvalId, pending] of this.pendingPermissions.entries()) {
                if (pending.sdkRequestId === req.request_id) {
                    this.pendingPermissions.delete(approvalId);
                    this.plugin.emit('approval_canceled', {
                        sessionId: this.sessionId,
                        requestId: approvalId
                    });
                    break;
                }
            }

            if (this.pendingQuestion?.baseRequestId === req.request_id) {
                this.pendingQuestion = null;
            }

            if (this.status === 'waiting') {
                this.status = 'idle';
            }
        });

        this.client.on('error', (err) => {
            this.plugin.emit('error', {
                sessionId: this.sessionId,
                error: err.message,
                fatal: false
            });
        });
        
        this.client.on('exit', (code) => {
            this.status = 'offline';
        });

        // Tool use start - surfaces ALL tool invocations including auto-approved
        this.client.on('tool_use_start', (tool: ToolUseStartEvent) => {
            // Track tool name for result matching
            this.activeToolExecutions.set(tool.id, tool.name);

            this.plugin.emit('tool_execution', {
                sessionId: this.sessionId,
                toolName: tool.name,
                toolId: tool.id,
                input: tool.input,
                timestamp: new Date()
            });
        });

        // Tool result - surfaces success/failure status
        this.client.on('tool_result', (result: ToolResultEvent) => {
            // Check for EnterPlanMode to capture plan path
            const toolName = this.activeToolExecutions.get(result.toolUseId);
            
            if (toolName === 'EnterPlanMode' && !result.isError) {
                // Look for "A plan file was designated: <path>"
                const match = result.content.match(/A plan file was designated: (.*)$/m);
                if (match && match[1]) {
                    this.currentPlanPath = match[1].trim();
                    console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Captured plan path: ${this.currentPlanPath}`);
                }
            }
            
            // Cleanup
            this.activeToolExecutions.delete(result.toolUseId);

            this.plugin.emit('tool_result', {
                sessionId: this.sessionId,
                toolUseId: result.toolUseId,
                content: result.content,
                isError: result.isError,
                timestamp: new Date()
            });
        });

        // Result events - surfaces final session summary
        this.client.on('result', (result: ResultMessage) => {
            const normalizedResult = this.normalizeForComparison(result.result || '');
            const normalizedLastOutput = this.normalizeForComparison(this.lastAssistantOutput || '');
            const duplicateOfLastOutput = Boolean(
                normalizedResult &&
                normalizedLastOutput &&
                (
                    normalizedResult === normalizedLastOutput ||
                    normalizedLastOutput.includes(normalizedResult) ||
                    normalizedResult.includes(normalizedLastOutput)
                )
            );
            const summary = result.subtype === 'error'
                ? (result.error || result.result || 'Claude execution failed')
                : (duplicateOfLastOutput ? 'Completed successfully.' : (result.result || 'Completed successfully.'));

            this.plugin.emit('result', {
                sessionId: this.sessionId,
                result: summary,
                subtype: result.subtype,
                durationMs: result.duration_ms,
                durationApiMs: result.duration_api_ms,
                numTurns: result.num_turns,
                isError: result.is_error,
                error: result.error,
                timestamp: new Date()
            });
        });
    }

    async start(): Promise<void> {
        this.status = 'working';
        await this.client.start();
    }

    /**
     * Interrupt the current operation (proper protocol method, not Ctrl+C)
     */
    async interrupt(): Promise<void> {
        await this.client.interrupt();
    }

    async sendMessage(message: string): Promise<void> {
        this.status = 'working';
        this.lastActivity = new Date();
        this.lastAssistantOutput = '';
        await this.client.sendMessage(message);
    }

    /**
     * Send a message with image attachments
     */
    async sendMessageWithImages(text: string, images: Array<{ data: string; mediaType: string }>): Promise<void> {
        this.status = 'working';
        this.lastActivity = new Date();
        this.lastAssistantOutput = '';

        const content: Array<{ type: string; [key: string]: any }> = [];

        // Add images first
        for (const image of images) {
            content.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: image.mediaType,
                    data: image.data
                }
            });
        }

        // Add text
        if (text) {
            content.push({ type: 'text', text });
        }

        await this.client.sendMessageWithContent(content);
    }
    
    async sendApproval(optionNumber: string, message?: string, requestId?: string): Promise<void> {
        console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] sendApproval called: option=${optionNumber}, requestId=${requestId || 'none'}, pendingCount=${this.pendingPermissions.size}, pendingKeys=[${Array.from(this.pendingPermissions.keys()).join(', ')}]`);
        
        if (this.pendingQuestion) {
            console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] AskUserQuestion approval: option=${optionNumber}, message=${message || 'none'}`);
            await this.handleAskUserQuestionResponse(optionNumber, message, requestId);
            return;
        }

        // Find the pending permission (simplified logic: take the first one)
        // In reality we should map optionNumber to the specific request if possible
        // or store the mapping.
        if (this.pendingPermissions.size === 0) {
            this.deferredApproval = {
                optionNumber,
                message,
                receivedAt: Date.now()
            };
            console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Deferred approval: option=${optionNumber}, message=${message || 'none'}, requestId=${requestId || 'none'}`);
            return;
        }
        
        const approvalId = requestId && this.pendingPermissions.has(requestId)
            ? requestId
            : Array.from(this.pendingPermissions.keys())[0];
        const perm = this.pendingPermissions.get(approvalId);
        if (!perm) return;

        console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] sendApproval mapping: approvalId=${approvalId} sdkRequestId=${perm.sdkRequestId} toolUseId=${perm.toolUseId || 'none'} pendingCount=${this.pendingPermissions.size}`);

        const isAllow = optionNumber === '1' || optionNumber.toLowerCase() === 'yes';
        const isAlways = optionNumber === '3' || optionNumber.toLowerCase() === 'always';

        const responseData: ControlResponseData = {
            behavior: isAllow || isAlways ? 'allow' : 'deny',
            toolUseID: perm.toolUseId
        };

        if (message) {
            responseData.message = message;
        }

        if (isAlways && perm.suggestions && perm.suggestions.length > 0) {
            const scopedSuggestions = this.applyScopeToSuggestions(perm.suggestions, 'session');
            responseData.updatedPermissions = scopedSuggestions;
            responseData.scope = 'session';
        }

        if (responseData.behavior === 'allow' && responseData.updatedInput === undefined) {
            responseData.updatedInput = perm.input || {};
        }

        if (responseData.behavior === 'deny' && !responseData.message) {
            responseData.message = 'The user does not want to proceed with this tool use.';
        }
        
        console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Sending control_response: requestId=${perm.sdkRequestId} behavior=${responseData.behavior} scope=${responseData.scope || 'none'} toolUseId=${perm.toolUseId || 'none'}`);
        await this.client.sendControlResponse(perm.sdkRequestId, responseData);
        this.pendingPermissions.delete(approvalId);
        this.status = 'working';
    }

    private async handleExitPlanModeRequest(req: ControlRequestMessage): Promise<void> {
        let planContent = '';
        
        // Try to read the plan file
        if (this.currentPlanPath && existsSync(this.currentPlanPath)) {
            try {
                planContent = readFileSync(this.currentPlanPath, 'utf8');
            } catch (err) {
                console.error(`[ClaudeSDK] Failed to read plan file: ${err}`);
            }
        }

        const request = req.request;
        if (request.subtype !== 'can_use_tool') {
            return;
        }
        const approvalId = `${this.sessionId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
        
        // Register pending permission with special handling for ExitPlanMode
        // We re-use 'AskUserQuestion' style mechanism but map it back to a tool permission
        this.pendingPermissions.set(approvalId, {
            requestId: approvalId,
            sdkRequestId: req.request_id,
            toolName: 'ExitPlanMode',
            input: request.input || {},
            toolUseId: request.tool_use_id || '',
            suggestions: [],
            blockedPath: undefined,
            decisionReason: undefined
        });

        // If we have plan content, present it for review
        if (planContent) {
            console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Intercepted ExitPlanMode, requesting review of plan (${planContent.length} chars)`);
            
            this.plugin.emit('approval', {
                sessionId: this.sessionId,
                requestId: approvalId,
                tool: 'ExitPlanMode',
                context: planContent, // Pass full plan content as context
                toolInput: { 
                    question: 'Please review the proposed plan before proceeding.',
                    planPath: this.currentPlanPath
                },
                options: ['Approve Plan'], // Option 1
                hasOther: true,            // Option 0 triggers feedback (Deny)
                detectedAt: new Date()
            });
        } else {
            // Fallback if no plan content found (standard approval)
            console.log(`[ClaudeSDK] Plan content missing, falling back to standard ExitPlanMode approval`);
            this.plugin.emit('approval', {
                sessionId: this.sessionId,
                requestId: approvalId,
                tool: 'ExitPlanMode',
                context: JSON.stringify(request.input),
                toolInput: request.input || {},
                suggestions: [],
                detectedAt: new Date()
            });
        }
    }

    private async handleAskUserQuestion(requestId: string, request: any): Promise<void> {
        let questionsArray: any[] = [];

        if (Array.isArray(request.input)) {
            questionsArray = request.input;
        } else if (request.input && Array.isArray(request.input.questions)) {
            questionsArray = request.input.questions;
        } else if (request.input && request.input.question) {
            questionsArray = [request.input];
        }

        if (questionsArray.length === 0) {
            this.plugin.emit('error', {
                sessionId: this.sessionId,
                error: 'AskUserQuestion input missing questions',
                fatal: false
            });
            return;
        }

        this.pendingQuestion = {
            baseRequestId: requestId,
            input: request.input,
            questions: questionsArray,
            allAnswers: [],
            currentQuestionIndex: 0
        };

        await this.askNextQuestion();
    }

    private async askNextQuestion(): Promise<void> {
        if (!this.pendingQuestion) return;

        const questionIndex = this.pendingQuestion.currentQuestionIndex;
        const questionsArray = this.pendingQuestion.questions;

        if (questionIndex >= questionsArray.length) {
            await this.sendAllAnswers();
            return;
        }

        const currentQuestion = questionsArray[questionIndex];
        const question = currentQuestion.question || 'Please provide input:';
        const options = currentQuestion.options || [];
        const multiSelect = currentQuestion.multiSelect || false;
        const header = currentQuestion.header || null;

        const processedOptions = options.map((opt: any, idx: number) => {
            if (typeof opt === 'string') {
                return { label: opt, value: opt };
            }
            return {
                ...opt,
                value: opt.value || opt.label || `option${idx}`
            };
        });

        const optionLabels: string[] = options.map((opt: any, idx: number) => {
            if (typeof opt === 'string') return opt;
            return opt.label || opt.value || `Option ${idx + 1}`;
        });

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

        const questionRequestId = `${this.pendingQuestion.baseRequestId}-${questionIndex}-${randomUUID().slice(0, 8)}`;
        this.pendingQuestion.currentRequestId = questionRequestId;

        this.plugin.emit('approval', {
            sessionId: this.sessionId,
            requestId: questionRequestId,
            tool: 'AskUserQuestion',
            context: contextText,
            toolInput: { question, options: processedOptions, multiSelect },
            options: optionLabels,
            detectedAt: new Date(),
            isMultiSelect: multiSelect,
            hasOther: true
        });

        this.pendingQuestion.currentOptions = processedOptions;
        this.pendingQuestion.currentMultiSelect = multiSelect;
    }

    private async handleAskUserQuestionResponse(optionNumber: string, message?: string, requestId?: string): Promise<void> {
        if (!this.pendingQuestion) return;

        if (requestId && this.pendingQuestion.currentRequestId && requestId !== this.pendingQuestion.currentRequestId) {
            console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Ignoring response for stale question requestId=${requestId}`);
            return;
        }

        const pendingQuestion = this.pendingQuestion;
        const currentOptions = pendingQuestion.currentOptions || [];

        // Handle custom "Other" input
        if (optionNumber === '0' && message) {
            pendingQuestion.allAnswers.push(message);
            pendingQuestion.currentQuestionIndex++;
            await this.askNextQuestion();
            return;
        }

        // Multi-select
        if (optionNumber.includes(',')) {
            const optionNumbers = optionNumber.split(',').map((s) => s.trim());
            const selectedValues: string[] = [];

            for (const optNum of optionNumbers) {
                const optionIndex = parseInt(optNum, 10) - 1;
                if (optionIndex >= 0 && optionIndex < currentOptions.length) {
                    const option = currentOptions[optionIndex];
                    selectedValues.push(option.value || option.label);
                }
            }

            pendingQuestion.allAnswers.push(selectedValues);
            pendingQuestion.currentQuestionIndex++;
            await this.askNextQuestion();
            return;
        }

        // Single option selection
        const optionIndex = parseInt(optionNumber, 10) - 1;
        if (optionIndex >= 0 && optionIndex < currentOptions.length) {
            const option = currentOptions[optionIndex];
            pendingQuestion.allAnswers.push(option.value || option.label);
            pendingQuestion.currentQuestionIndex++;
            await this.askNextQuestion();
            return;
        }
    }

    private async sendAllAnswers(): Promise<void> {
        if (!this.pendingQuestion) return;

        const pendingQuestion = this.pendingQuestion;
        const answers = pendingQuestion.allAnswers;

        const answersObject: Record<string, any> = {};
        for (let i = 0; i < pendingQuestion.questions.length; i++) {
            const q = pendingQuestion.questions[i];
            const key = q.header || q.question || `Question ${i + 1}`;
            answersObject[key] = answers[i];
        }

        const questionSummary = pendingQuestion.questions.length === 1
            ? pendingQuestion.questions[0].question
            : pendingQuestion.questions.map((q: any, i: number) => q.header || q.question || `Question ${i + 1}`).join(', ');

        const updatedInput: Record<string, any> = {
            question: questionSummary,
            answers: answersObject
        };

        const responseData: ControlResponseData = {
            behavior: 'allow',
            updatedInput
        };

        console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Sending AskUserQuestion response: requestId=${pendingQuestion.baseRequestId} answers=${Object.keys(answersObject).length}`);
        await this.client.sendControlResponse(pendingQuestion.baseRequestId, responseData);
        this.pendingQuestion = null;
    }

    async sendPermissionDecision(requestId: string, decision: {
        behavior: 'allow' | 'deny';
        scope?: PermissionScope;
        updatedPermissions?: Suggestion[];
        updatedInput?: Record<string, any>;
        message?: string;
    }): Promise<void> {
        const perm = this.pendingPermissions.get(requestId);
        if (!perm) return;

        const responseData: ControlResponseData = {
            behavior: decision.behavior,
            updatedPermissions: decision.updatedPermissions
                ? this.applyScopeToSuggestions(decision.updatedPermissions, decision.scope || 'session')
                : undefined,
            updatedInput: decision.updatedInput,
            message: decision.message,
            toolUseID: perm.toolUseId,
            scope: decision.scope
        };

        if (responseData.behavior === 'allow' && responseData.updatedInput === undefined) {
            responseData.updatedInput = perm.input || {};
        }

        if (responseData.behavior === 'deny' && !responseData.message) {
            responseData.message = 'The user does not want to proceed with this tool use.';
        }

        console.log(`[ClaudeSDK ${this.sessionId.slice(0, 8)}] Sending permission_decision: requestId=${perm.sdkRequestId} behavior=${responseData.behavior} scope=${responseData.scope || 'none'} toolUseId=${perm.toolUseId || 'none'}`);
        await this.client.sendControlResponse(perm.sdkRequestId, responseData);
        this.pendingPermissions.delete(requestId);
        this.status = 'working';
    }

    async setPermissionMode(mode: 'default' | 'acceptEdits'): Promise<void> {
        await this.client.setPermissionMode(mode);
        this.plugin.emit('metadata', {
            sessionId: this.sessionId,
            permissionMode: mode,
            timestamp: new Date()
        });
    }

    async setModel(model: string): Promise<void> {
        await this.client.setModel(model);
        this.plugin.emit('metadata', {
            sessionId: this.sessionId,
            model,
            timestamp: new Date()
        });
    }

    async setMaxThinkingTokens(maxTokens: number): Promise<void> {
        await this.client.setMaxThinkingTokens(maxTokens);
        this.plugin.emit('metadata', {
            sessionId: this.sessionId,
            timestamp: new Date()
        });
    }

    async close(): Promise<void> {
        this.client.kill();
        this.status = 'offline';
    }

    // Property implementation for isReady
    get isReady(): boolean {
        return this.status === 'idle';
    }
    
    // Helper to buffer output
    private scheduleBatchFlush(outputType: 'stdout' | 'thinking' = 'stdout'): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTextBuffer(false, outputType);
            this.flushTimer = null;
        }, this.BATCH_INTERVAL_MS);
    }

    private flushTextBuffer(isComplete: boolean = false, outputType: 'stdout' | 'thinking' = 'stdout'): void {
        if (!this.textBuffer) return;

        this.plugin.emit('output', {
            sessionId: this.sessionId,
            content: this.textBuffer,
            isComplete,
            outputType, 
            timestamp: new Date()
        });

        this.textBuffer = '';
    }
    
    // Throttle output to Discord to avoid rate limits
    private scheduleThrottledOutput(): void {
        if (this.outputThrottleTimer) return;  // Already scheduled
        
        this.outputThrottleTimer = setTimeout(() => {
            this.flushThrottledOutput();
            this.outputThrottleTimer = null;
        }, this.OUTPUT_THROTTLE_MS);
    }

    private flushThrottledOutput(isComplete: boolean = false): void {
        if (this.outputThrottleTimer) {
            clearTimeout(this.outputThrottleTimer);
            this.outputThrottleTimer = null;
        }

        // Emit stdout if we have pending content
        if (this.pendingStdoutContent) {
            this.plugin.emit('output', {
                sessionId: this.sessionId,
                content: this.pendingStdoutContent,
                isComplete,
                outputType: 'stdout',
                timestamp: new Date()
            });
            this.pendingStdoutContent = '';
        }

        // Emit thinking if we have pending content
        if (this.pendingThinkingContent) {
            this.plugin.emit('output', {
                sessionId: this.sessionId,
                content: this.pendingThinkingContent,
                isComplete,
                outputType: 'thinking',
                timestamp: new Date()
            });
            this.pendingThinkingContent = '';
        }
    }
    
    private setActivity(activity: string | null): void {
        if (this.currentActivity !== activity) {
             this.currentActivity = activity;
             this.plugin.emit('metadata', {
                 sessionId: this.sessionId,
                 activity: activity || undefined,
                 timestamp: new Date()
             });
        }
    }

    private normalizeForComparison(value: string): string {
        return value.replace(/\s+/g, ' ').trim();
    }
}

// ============================================================================
// Main Plugin Class
// ============================================================================

export class ClaudeSDKPlugin extends BasePlugin {
    readonly name = 'claude-sdk';
    readonly type: PluginType = 'claude-sdk';
    readonly version = '1.0.0';
    readonly description = 'Claude Code CLI Integration (Libraries)';
    readonly isPersistent = true;

    constructor(runnerId: string = 'default') {
        super();
        this.log(`Initialized ClaudeSDKPlugin for runner ${runnerId}`);
    }

    async createSession(config: SessionConfig): Promise<PluginSession> {
        const session = new ClaudeSDKSession(config, this);
        this.sessions.set(session.sessionId, session);
        await session.start();
        return session;
    }

    async listModels(
        claudePath: string,
        cwd: string = process.cwd()
    ): Promise<{ models: ClaudeSupportedModel[]; defaultModel: string | null }> {
        if (!claudePath) {
            throw new Error('Claude CLI path not provided');
        }

        const probeClient = new ClaudeClient({
            cwd,
            claudePath,
            continueConversation: false,
            persistSession: false,
            includePartialMessages: false,
            permissionPromptTool: false
        });

        try {
            await probeClient.start();
            const result = await probeClient.listSupportedModels(25000);
            const models = [...result.models];

            if (result.defaultModel) {
                const existing = models.find(model => model.id === result.defaultModel);
                if (existing) {
                    existing.isDefault = true;
                } else {
                    models.push({
                        id: result.defaultModel,
                        label: result.defaultModel,
                        isDefault: true
                    });
                }
            }

            return {
                models,
                defaultModel: result.defaultModel
            };
        } finally {
            probeClient.kill();
        }
    }
}
