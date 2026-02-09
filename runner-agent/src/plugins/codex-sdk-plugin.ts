/**
 * Codex SDK Plugin
 *
 * Uses the standalone codex-client library to manage the Codex CLI app-server.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  BasePlugin,
  PluginSession,
  SessionConfig,
  SessionStatus
} from './base.js';
import {
  CodexClient,
  AskForApproval,
  SandboxMode,
  ThreadStartParams,
  TurnStartParams,
  CodexServerNotification,
  CodexServerRequest,
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  ToolRequestUserInputParams,
  DynamicToolCallParams,
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalResponse,
  ToolRequestUserInputResponse,
  DynamicToolCallResponse
} from '../../../codex-client/src/index.js';

class CodexSDKSession extends EventEmitter implements PluginSession {
  readonly sessionId: string;
  readonly config: SessionConfig;
  readonly createdAt: Date;
  readonly isOwned = true;

  status: SessionStatus = 'idle';
  lastActivity: Date;
  isReady = false;

  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private pendingQueue: Array<{ message: string; resolve: () => void; reject: (err: Error) => void }> = [];
  private sending = false;

  private outputBuffer = '';
  private currentOutput = '';
  private outputTimer: NodeJS.Timeout | null = null;
  private readonly OUTPUT_THROTTLE_MS = 500;

  private thinkingBuffer = '';
  private currentThinking = '';

  private pendingApprovals = new Map<string, {
    approvalId: string;
    requestId: string | number;
    kind: 'command' | 'file';
    proposedAmendment?: string[] | null;
  }>();

  private pendingQuestion: {
    requestId: string | number;
    questions: ToolRequestUserInputParams['questions'];
    answers: Record<string, { answers: string[] }>;
    index: number;
    currentApprovalId?: string;
  } | null = null;

  constructor(config: SessionConfig, private plugin: CodexSDKPlugin) {
    super();
    this.sessionId = config.sessionId || randomUUID();
    this.config = config;
    this.createdAt = new Date();
    this.lastActivity = new Date();
  }

  async initializeThread(): Promise<void> {
    const options = this.config.options || {};

    const approvalPolicy: AskForApproval | null = (options.approvalPolicy as AskForApproval | undefined)
      ?? (options.skipPermissions ? 'never' : 'on-request');

    const sandbox = (options.sandbox as SandboxMode | undefined) || null;

    const threadParams: ThreadStartParams = {
      model: (options.model as string | undefined) ?? null,
      modelProvider: null,
      cwd: this.config.cwd,
      approvalPolicy,
      sandbox,
      config: (options.config as any) ?? null,
      baseInstructions: options.baseInstructions ?? null,
      developerInstructions: options.developerInstructions ?? null,
      personality: options.personality ?? null,
      ephemeral: false,
      experimentalRawEvents: false
    };

    const response = await this.plugin.client.startThread(threadParams);
    this.threadId = response.thread.id;
    this.isReady = true;
    this.emit('ready');

    this.plugin.registerThread(this.threadId, this);

    this.plugin.emit('metadata', {
      sessionId: this.sessionId,
      model: response.model,
      permissionMode: approvalPolicy ?? undefined,
      timestamp: new Date()
    });
  }

  async sendMessage(message: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingQueue.push({ message, resolve, reject });
      this.drainQueue().catch(reject);
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.sending || !this.isReady) return;
    if (this.activeTurnId) return;
    const next = this.pendingQueue.shift();
    if (!next) return;

    this.sending = true;
    try {
      if (!this.threadId) {
        throw new Error('Codex thread not initialized');
      }

      this.currentOutput = '';
      this.currentThinking = '';

      const options = this.config.options || {};
      const turnParams: TurnStartParams = {
        threadId: this.threadId,
        input: [{ type: 'text', text: next.message, text_elements: [] }],
        cwd: null,
        approvalPolicy: (options.approvalPolicy as AskForApproval | undefined) ?? null,
        sandboxPolicy: (options.sandbox as SandboxMode | undefined) ?? null,
        model: (options.model as string | undefined) ?? null,
        effort: (options.reasoningEffort as any) ?? null,
        summary: (options.reasoningSummary as any) ?? null,
        personality: options.personality ?? null,
        outputSchema: options.outputSchema ?? options.jsonSchema ?? null,
        collaborationMode: options.collaborationMode ?? null
      };

      const response = await this.plugin.client.startTurn(turnParams);
      this.activeTurnId = response.turn.id;
      this.status = 'working';
      this.plugin.emit('status', {
        sessionId: this.sessionId,
        status: this.status
      });
      next.resolve();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.plugin.emit('error', {
        sessionId: this.sessionId,
        error: error.message,
        fatal: false
      });
      next.reject(error);
    } finally {
      this.sending = false;
    }
  }

  async sendApproval(optionNumber: string, message?: string, requestId?: string): Promise<void> {
    if (this.pendingQuestion && requestId === this.pendingQuestion.currentApprovalId) {
      await this.handleQuestionResponse(optionNumber, message);
      return;
    }

    const approvalId = requestId && this.pendingApprovals.has(requestId)
      ? requestId
      : Array.from(this.pendingApprovals.keys())[0];

    if (!approvalId) return;

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;

    if (pending.kind === 'command') {
      const response: CommandExecutionRequestApprovalResponse = {
        decision: this.mapCommandDecision(optionNumber, pending.proposedAmendment || null)
      };
      this.plugin.client.sendResponse(pending.requestId, response);
    } else {
      const response: FileChangeRequestApprovalResponse = {
        decision: this.mapFileDecision(optionNumber)
      };
      this.plugin.client.sendResponse(pending.requestId, response);
    }

    this.pendingApprovals.delete(approvalId);
    this.status = 'working';
  }

  async close(): Promise<void> {
    if (this.threadId && this.activeTurnId) {
      try {
        await this.plugin.client.interruptTurn({ threadId: this.threadId, turnId: this.activeTurnId });
      } catch {
        // ignore
      }
    }
    if (this.threadId) {
      this.plugin.unregisterThread(this.threadId);
    }
    this.status = 'offline';
  }

  private mapCommandDecision(optionNumber: string, amendment: string[] | null) {
    switch (optionNumber) {
      case '1':
        return 'accept';
      case '2':
        return 'acceptForSession';
      case '3':
        if (amendment && amendment.length > 0) {
          return { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
        }
        return 'accept';
      case '4':
      default:
        return 'decline';
    }
  }

  private mapFileDecision(optionNumber: string) {
    switch (optionNumber) {
      case '1':
        return 'accept';
      case '2':
        return 'acceptForSession';
      case '3':
      default:
        return 'decline';
    }
  }

  handleNotification(notification: CodexServerNotification): void {
    if (!this.threadId) return;
    const params: any = (notification as any).params || {};
    const threadId = params.threadId || params.thread?.id;
    if (threadId && threadId !== this.threadId) return;

    switch (notification.method) {
      case 'item/agentMessage/delta':
        this.appendOutput(params.delta || '', 'stdout');
        break;
      case 'item/commandExecution/outputDelta':
        this.appendOutput(params.delta || '', 'tool_result');
        break;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        this.appendThinking(params.delta || '');
        break;
      case 'item/completed':
        if (params.item?.type === 'agentMessage') {
          if (typeof params.item.text === 'string') {
            this.currentOutput = params.item.text;
          }
          this.flushOutput('stdout', true);
        }
        break;
      case 'turn/started':
        this.status = 'working';
        this.plugin.emit('status', { sessionId: this.sessionId, status: this.status });
        break;
      case 'turn/completed':
        this.activeTurnId = null;
        this.status = 'idle';
        this.plugin.emit('status', { sessionId: this.sessionId, status: this.status });
        this.flushOutput('stdout', true);
        this.drainQueue().catch(() => null);
        break;
      default:
        break;
    }
  }

  handleRequest(request: CodexServerRequest): void {
    const params: any = (request as any).params || {};
    const threadId = params.threadId || params.conversationId;
    if (threadId && this.threadId && threadId !== this.threadId) return;

    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        this.handleCommandApproval(request.id, params as CommandExecutionRequestApprovalParams);
        break;
      case 'item/fileChange/requestApproval':
        this.handleFileApproval(request.id, params as FileChangeRequestApprovalParams);
        break;
      case 'item/tool/requestUserInput':
        this.handleUserInputRequest(request.id, params as ToolRequestUserInputParams);
        break;
      case 'item/tool/call':
        this.handleToolCall(request.id, params as DynamicToolCallParams);
        break;
      default:
        this.plugin.client.sendError(request.id, { message: `Unsupported request: ${request.method}` });
    }
  }

  private handleCommandApproval(requestId: string | number, params: CommandExecutionRequestApprovalParams): void {
    const approvalId = `${this.sessionId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.pendingApprovals.set(approvalId, {
      approvalId,
      requestId,
      kind: 'command',
      proposedAmendment: params.proposedExecpolicyAmendment ?? null
    });

    const options = ['Allow', 'Allow for session'];
    if (params.proposedExecpolicyAmendment) {
      options.push('Always allow');
    }
    options.push('Deny');

    const context = params.command ? `${params.command}${params.cwd ? `\nCWD: ${params.cwd}` : ''}` : params.reason ?? 'Command approval requested';

    this.status = 'waiting';
    this.plugin.emit('status', { sessionId: this.sessionId, status: this.status });

    this.plugin.emit('approval', {
      sessionId: this.sessionId,
      requestId: approvalId,
      tool: 'CommandExecution',
      context,
      toolInput: {
        command: params.command,
        cwd: params.cwd,
        reason: params.reason,
        commandActions: params.commandActions
      },
      options,
      detectedAt: new Date()
    });
  }

  private handleFileApproval(requestId: string | number, params: FileChangeRequestApprovalParams): void {
    const approvalId = `${this.sessionId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.pendingApprovals.set(approvalId, {
      approvalId,
      requestId,
      kind: 'file'
    });

    const options = ['Allow', 'Allow for session', 'Deny'];
    const context = params.reason ?? 'File change approval requested';

    this.status = 'waiting';
    this.plugin.emit('status', { sessionId: this.sessionId, status: this.status });

    this.plugin.emit('approval', {
      sessionId: this.sessionId,
      requestId: approvalId,
      tool: 'FileChange',
      context,
      toolInput: {
        reason: params.reason,
        grantRoot: params.grantRoot
      },
      options,
      detectedAt: new Date()
    });
  }

  private handleUserInputRequest(requestId: string | number, params: ToolRequestUserInputParams): void {
    this.pendingQuestion = {
      requestId,
      questions: params.questions,
      answers: {},
      index: 0
    };
    this.askNextQuestion();
  }

  private askNextQuestion(): void {
    if (!this.pendingQuestion) return;
    const { questions, index } = this.pendingQuestion;
    if (index >= questions.length) {
      const response: ToolRequestUserInputResponse = { answers: this.pendingQuestion.answers };
      this.plugin.client.sendResponse(this.pendingQuestion.requestId, response);
      this.pendingQuestion = null;
      return;
    }

    const question = questions[index];
    const options = question.options?.map(opt => opt.label) || [];
    const approvalId = `${this.sessionId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.pendingQuestion.currentApprovalId = approvalId;

    let context = question.header ? `**${question.header}**\n\n${question.question}` : question.question;
    if (options.length > 0) {
      const optionLines = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
      context += `\n\n${optionLines}`;
    }

    this.plugin.emit('approval', {
      sessionId: this.sessionId,
      requestId: approvalId,
      tool: 'AskUserQuestion',
      context,
      toolInput: { question: question.question, options },
      options,
      detectedAt: new Date(),
      hasOther: question.isOther
    });
  }

  private async handleQuestionResponse(optionNumber: string, message?: string): Promise<void> {
    if (!this.pendingQuestion) return;
    const question = this.pendingQuestion.questions[this.pendingQuestion.index];
    const options = question.options?.map(opt => opt.label) || [];

    let answers: string[] = [];
    if (optionNumber === '0' && message) {
      answers = [message];
    } else if (optionNumber.includes(',')) {
      const selections = optionNumber.split(',').map(v => v.trim());
      for (const selection of selections) {
        const idx = parseInt(selection, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          answers.push(options[idx]);
        }
      }
    } else {
      const idx = parseInt(optionNumber, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        answers = [options[idx]];
      }
    }

    this.pendingQuestion.answers[question.id] = { answers };
    this.pendingQuestion.index += 1;
    this.askNextQuestion();
  }

  private handleToolCall(requestId: string | number, params: DynamicToolCallParams): void {
    const response: DynamicToolCallResponse = {
      contentItems: [{ type: 'inputText', text: `Tool ${params.tool} is not supported.` }],
      success: false
    };
    this.plugin.client.sendResponse(requestId, response);
  }

  private appendOutput(content: string, outputType: 'stdout' | 'tool_result'): void {
    this.outputBuffer += content;
    this.currentOutput += content;
    if (!this.outputTimer) {
      this.outputTimer = setTimeout(() => {
        this.outputBuffer = '';
        this.flushOutput(outputType, false);
        this.outputTimer = null;
      }, this.OUTPUT_THROTTLE_MS);
    }
  }

  private appendThinking(content: string): void {
    this.thinkingBuffer += content;
    this.currentThinking += content;
    if (!this.outputTimer) {
      this.outputTimer = setTimeout(() => {
        this.thinkingBuffer = '';
        this.flushOutput('thinking', false);
        this.outputTimer = null;
      }, this.OUTPUT_THROTTLE_MS);
    }
  }

  private flushOutput(outputType: 'stdout' | 'thinking' | 'tool_result', isComplete: boolean): void {
    const payload = outputType === 'thinking' ? this.currentThinking : this.currentOutput;
    if (!payload.trim() && !isComplete) return;
    this.plugin.emit('output', {
      sessionId: this.sessionId,
      content: payload,
      isComplete,
      outputType,
      timestamp: new Date()
    });
  }
}

export class CodexSDKPlugin extends BasePlugin {
  readonly name = 'Codex SDK';
  readonly type = 'codex-sdk';
  readonly isPersistent = true;

  client: CodexClient;
  private threadMap = new Map<string, CodexSDKSession>();
  private clientPath: string | null = null;

  constructor() {
    super();
    this.client = new CodexClient();
  }

  async initialize(): Promise<void> {
    await super.initialize();
    this.attachClientListeners();
  }

  private attachClientListeners(): void {
    this.client.removeAllListeners();
    this.client.on('notification', (notification: CodexServerNotification) => {
      const params: any = (notification as any).params || {};
      const threadId = params.threadId || params.thread?.id;
      if (!threadId) return;
      const session = this.threadMap.get(threadId);
      if (session) {
        session.handleNotification(notification);
      }
    });

    this.client.on('request', (request: CodexServerRequest) => {
      const params: any = (request as any).params || {};
      const threadId = params.threadId || params.conversationId;
      if (!threadId) {
        this.client.sendError(request.id, { message: 'Missing thread id' });
        return;
      }
      const session = this.threadMap.get(threadId);
      if (!session) {
        this.client.sendError(request.id, { message: 'Unknown thread' });
        return;
      }
      session.handleRequest(request);
    });

    this.client.on('error', (err: Error) => {
      this.emit('error', {
        sessionId: 'codex',
        error: err.message,
        fatal: false
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
    await super.shutdown();
  }

  registerThread(threadId: string, session: CodexSDKSession): void {
    this.threadMap.set(threadId, session);
  }

  unregisterThread(threadId: string): void {
    this.threadMap.delete(threadId);
  }

  async createSession(config: SessionConfig): Promise<PluginSession> {
    if (!config.cliPath) {
      throw new Error('Codex CLI path not provided');
    }

    if (!this.clientPath || this.clientPath !== config.cliPath) {
      await this.client.shutdown();
      this.client = new CodexClient({ codexPath: config.cliPath });
      this.attachClientListeners();
      this.clientPath = config.cliPath;
    }

    const session = new CodexSDKSession(config, this);
    this.sessions.set(session.sessionId, session);
    await session.initializeThread();
    return session;
  }
}
