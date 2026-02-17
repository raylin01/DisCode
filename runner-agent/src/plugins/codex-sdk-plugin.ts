/**
 * Codex SDK Plugin
 *
 * Uses the standalone codex-client library to manage the Codex CLI app-server.
 */

import {
  BasePlugin,
  PluginSession,
  SessionConfig,
  SessionStatus
} from './base.js';
import {
  BaseSDKSession,
  MessageQueue
} from './sdk-base.js';
import { isBashCommandSafe, getDangerousReason } from '../permissions/safe-tools.js';
import { getConfig } from '../config.js';
import {
  CodexClient,
  AskForApproval,
  SandboxMode,
  SandboxPolicy,
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
  DynamicToolCallResponse,
  ThreadListParams,
  ThreadListResponse,
  ModelListParams,
  ModelListResponse
} from '@raylin01/codex-client';

// Codex-specific approval entry
interface CodexApprovalEntry {
  approvalId: string;
  requestId: string | number;
  toolName: string;
  input: Record<string, any>;
  createdAt: number;
  kind: 'command' | 'file';
  proposedAmendment?: string[] | null;
}

class CodexSDKSession extends BaseSDKSession {
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private messageQueue: MessageQueue;
  private codexPlugin: CodexSDKPlugin;

  private currentOutput = '';
  private completedOutputEmitted = false;
  private currentThinking = '';

  private pendingApprovals = new Map<string, CodexApprovalEntry>();

  private static readonly DEFAULT_DENY_MESSAGE = 'The user does not want to proceed with this tool use.';

  private pendingQuestion: {
    requestId: string | number;
    questions: ToolRequestUserInputParams['questions'];
    answers: Record<string, { answers: string[] }>;
    index: number;
    currentApprovalId?: string;
  } | null = null;

  constructor(config: SessionConfig, plugin: CodexSDKPlugin) {
    super(config, plugin);
    this.codexPlugin = plugin;
    this.messageQueue = new MessageQueue((message) => this.doSendMessage(message));
  }

  async initializeThread(): Promise<void> {
    const options = this.config.options || {};

    const approvalPolicy: AskForApproval | null = (options.approvalPolicy as AskForApproval | undefined)
      ?? (options.skipPermissions ? 'never' : 'on-request');

    const sandbox = (options.sandbox as SandboxMode | undefined) || null;
    const persistSession = options.persistSession !== false;

    const baseParams = {
      model: (options.model as string | undefined) ?? null,
      modelProvider: null,
      cwd: this.config.cwd,
      approvalPolicy,
      sandbox,
      config: (options.config as any) ?? null,
      baseInstructions: options.baseInstructions ?? null,
      developerInstructions: options.developerInstructions ?? null,
      personality: options.personality ?? null
    };

    let response: { thread: { id: string }; model: string; approvalPolicy: AskForApproval };
    if (options.resumeSessionId) {
      if (options.forkSession) {
        response = await this.codexPlugin.client.forkThread({
          threadId: options.resumeSessionId,
          ...baseParams
        });
      } else {
        response = await this.codexPlugin.client.resumeThread({
          threadId: options.resumeSessionId,
          ...baseParams
        });
      }
    } else {
      const threadParams: ThreadStartParams = {
        ...baseParams,
        ephemeral: !persistSession,
        experimentalRawEvents: false
      };
      response = await this.codexPlugin.client.startThread(threadParams);
    }
    this.threadId = response.thread.id;
    this.isReady = true;
    this.emit('ready');

    this.codexPlugin.registerThread(this.threadId, this);

    // Emit CLI session ID for persistence (enables resume after restart)
    this.codexPlugin.emit('cli_session_id', {
      sessionId: this.sessionId,
      cliSessionId: this.threadId
    });

    this.emitMetadata({
      model: response.model,
      permissionMode: approvalPolicy ?? undefined
    });
  }

  async start(): Promise<void> {
    await this.initializeThread();
  }

  async sendMessage(message: string): Promise<void> {
    return this.messageQueue.enqueue(message);
  }

  private async doSendMessage(message: string): Promise<void> {
    if (!this.threadId) {
      throw new Error('Codex thread not initialized');
    }

    this.currentOutput = '';
    this.currentThinking = '';
    this.completedOutputEmitted = false;

    const options = this.config.options || {};
    const turnParams: TurnStartParams = {
      threadId: this.threadId,
      input: [{ type: 'text', text: message, text_elements: [] }],
      cwd: null,
      approvalPolicy: (options.approvalPolicy as AskForApproval | undefined) ?? null,
      sandboxPolicy: this.toSandboxPolicy(options.sandboxPolicy ?? options.sandbox ?? null),
      model: (options.model as string | undefined) ?? null,
      effort: (options.reasoningEffort as any) ?? null,
      summary: (options.reasoningSummary as any) ?? null,
      personality: options.personality ?? null,
      outputSchema: options.outputSchema ?? options.jsonSchema ?? null,
      collaborationMode: options.collaborationMode ?? null
    };

    const response = await this.codexPlugin.client.startTurn(turnParams);
    this.activeTurnId = response.turn.id;
    this.emitStatus('working');
  }

  private toSandboxPolicy(value: unknown): SandboxPolicy | null {
    if (!value) return null;
    if (typeof value === 'object' && value && 'type' in value) {
      return value as SandboxPolicy;
    }
    if (typeof value !== 'string') return null;
    switch (value) {
      case 'read-only':
        return { type: 'readOnly' };
      case 'workspace-write':
        return {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        };
      case 'danger-full-access':
        return { type: 'dangerFullAccess' };
      default:
        return null;
    }
  }

  async sendApproval(optionNumber: string, message?: string, requestId?: string): Promise<void> {
    if (this.pendingQuestion && requestId === this.pendingQuestion.currentApprovalId) {
      await this.handleQuestionResponse(optionNumber, message);
      return;
    }

    const approvalId = requestId && this.pendingApprovals.has(requestId)
      ? requestId
      : this.pendingApprovals.keys().next().value;

    if (!approvalId) return;

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;

    if (pending.kind === 'command') {
      const response: CommandExecutionRequestApprovalResponse = {
        decision: this.mapCommandDecision(optionNumber, pending.proposedAmendment || null)
      };
      this.codexPlugin.client.sendResponse(pending.requestId, response);
    } else {
      const response: FileChangeRequestApprovalResponse = {
        decision: this.mapFileDecision(optionNumber)
      };
      this.codexPlugin.client.sendResponse(pending.requestId, response);
    }

    this.pendingApprovals.delete(approvalId);
    this.emitStatus('working');
  }

  async sendPermissionDecision(requestId: string, decision: {
    behavior: 'allow' | 'deny';
    scope?: 'session' | 'localSettings' | 'userSettings' | 'projectSettings';
    updatedPermissions?: any[];
    message?: string;
  }): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;

    const optionNumber = this.resolveDecisionOption(pending, decision);
    const denyMessage = decision.message || CodexSDKSession.DEFAULT_DENY_MESSAGE;

    await this.sendApproval(
      optionNumber,
      decision.behavior === 'deny' ? denyMessage : undefined,
      requestId
    );
  }

  async interrupt(): Promise<void> {
    if (this.threadId && this.activeTurnId) {
      try {
        await this.codexPlugin.client.interruptTurn({ threadId: this.threadId, turnId: this.activeTurnId });
      } catch {
        // ignore
      }
    }
    this.outputThrottler.flush(true);
    this.emitStatus('idle');
  }

  async close(): Promise<void> {
    if (this.threadId && this.activeTurnId) {
      try {
        await this.codexPlugin.client.interruptTurn({ threadId: this.threadId, turnId: this.activeTurnId });
      } catch {
        // ignore
      }
    }
    if (this.threadId) {
      this.codexPlugin.unregisterThread(this.threadId);
    }
    this.messageQueue.clear();
    this.status = 'offline';
    this.isReady = false;
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

  private resolveDecisionOption(
    pending: {
      kind: 'command' | 'file';
      proposedAmendment?: string[] | null;
    },
    decision: {
      behavior: 'allow' | 'deny';
      scope?: 'session' | 'localSettings' | 'userSettings' | 'projectSettings';
      updatedPermissions?: any[];
    }
  ): string {
    if (decision.behavior === 'deny') {
      return pending.kind === 'command' ? '4' : '3';
    }

    const hasPersistentIntent = Boolean(decision.scope && decision.scope !== 'session')
      || Boolean(decision.updatedPermissions && decision.updatedPermissions.length > 0);

    if (pending.kind === 'command') {
      if (hasPersistentIntent && pending.proposedAmendment && pending.proposedAmendment.length > 0) {
        return '3'; // acceptWithExecpolicyAmendment
      }
      if (decision.scope === 'session' || hasPersistentIntent) {
        return '2'; // acceptForSession
      }
      return '1'; // accept once
    }

    if (decision.scope === 'session' || hasPersistentIntent) {
      return '2'; // acceptForSession
    }
    return '1'; // accept once
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
        this.emitStatus('working');
        break;
      case 'turn/completed':
        this.activeTurnId = null;
        this.flushOutput('stdout', true);
        this.emitStatus('idle');
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
        this.codexPlugin.client.sendError(request.id, { message: `Unsupported request: ${request.method}` });
    }
  }

  private handleCommandApproval(requestId: string | number, params: CommandExecutionRequestApprovalParams): void {
    // Auto-approve safe commands if in autoApproveSafe mode
    if (this.autoApproveSafe && params.command) {
      if (isBashCommandSafe(params.command)) {
        console.log(`[CodexSDK ${this.sessionId.slice(0, 8)}] Auto-approving safe command: ${params.command.slice(0, 50)}...`);
        const response: CommandExecutionRequestApprovalResponse = {
          decision: 'accept'
        };
        this.codexPlugin.client.sendResponse(requestId, response);
        return;
      } else {
        const reason = getDangerousReason(params.command);
        console.log(`[CodexSDK ${this.sessionId.slice(0, 8)}] Command requires approval in autoSafe mode${reason ? `: ${reason}` : ''}`);
      }
    }

    const approvalId = `${this.sessionId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    this.pendingApprovals.set(approvalId, {
      approvalId,
      requestId,
      toolName: 'CommandExecution',
      input: { command: params.command, cwd: params.cwd },
      createdAt: Date.now(),
      kind: 'command',
      proposedAmendment: params.proposedExecpolicyAmendment ?? null
    });

    const context = params.command ? `${params.command}${params.cwd ? `\nCWD: ${params.cwd}` : ''}` : params.reason ?? 'Command approval requested';

    this.emitStatus('waiting');

    this.codexPlugin.emit('approval', {
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
      options: [],
      suggestions: [{
        type: 'addRules',
        rules: [{
          toolName: 'CommandExecution',
          ruleContent: params.command || params.reason || 'command'
        }]
      }],
      decisionReason: params.reason || undefined,
      detectedAt: new Date()
    });
  }

  private handleFileApproval(requestId: string | number, params: FileChangeRequestApprovalParams): void {
    // File changes are never auto-approved in autoSafe mode since they modify the filesystem
    if (this.autoApproveSafe) {
      console.log(`[CodexSDK ${this.sessionId.slice(0, 8)}] File change requires approval in autoSafe mode: ${params.reason}`);
    }

    const approvalId = `${this.sessionId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    this.pendingApprovals.set(approvalId, {
      approvalId,
      requestId,
      toolName: 'FileChange',
      input: { reason: params.reason, grantRoot: params.grantRoot },
      createdAt: Date.now(),
      kind: 'file'
    });

    const context = params.reason ?? 'File change approval requested';

    this.emitStatus('waiting');

    this.codexPlugin.emit('approval', {
      sessionId: this.sessionId,
      requestId: approvalId,
      tool: 'FileChange',
      context,
      toolInput: {
        reason: params.reason,
        grantRoot: params.grantRoot
      },
      options: [],
      suggestions: [{
        type: 'addRules',
        rules: [{
          toolName: 'FileChange',
          ruleContent: params.grantRoot || params.reason || 'file-change'
        }]
      }],
      blockedPath: params.grantRoot || undefined,
      decisionReason: params.reason || undefined,
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
      this.codexPlugin.client.sendResponse(this.pendingQuestion.requestId, response);
      this.pendingQuestion = null;
      return;
    }

    const question = questions[index];
    const options = question.options?.map(opt => opt.label) || [];
    const approvalId = `${this.sessionId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    this.pendingQuestion.currentApprovalId = approvalId;

    let context = question.header ? `**${question.header}**\n\n${question.question}` : question.question;
    if (options.length > 0) {
      const optionLines = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
      context += `\n\n${optionLines}`;
    }

    this.codexPlugin.emit('approval', {
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
    this.codexPlugin.client.sendResponse(requestId, response);
  }

  private appendOutput(content: string, outputType: 'stdout' | 'tool_result'): void {
    this.currentOutput += content;
    this.completedOutputEmitted = false;
    this.outputThrottler.addStdout(content);
  }

  private appendThinking(content: string): void {
    this.currentThinking += content;
    this.outputThrottler.addThinking(content);
  }

  private flushOutput(outputType: 'stdout' | 'thinking' | 'tool_result', isComplete: boolean): void {
    const payload = outputType === 'thinking' ? this.currentThinking : this.currentOutput;
    if (!payload.trim() && !isComplete) return;
    if (outputType === 'stdout' && isComplete && this.completedOutputEmitted) return;

    this.emitOutput({
      content: payload,
      isComplete,
      outputType
    });

    if (outputType === 'stdout' && isComplete) {
      this.completedOutputEmitted = true;
    }
    // Clear output after final flush to prevent resend
    if (isComplete) {
      if (outputType === 'thinking') {
        this.currentThinking = '';
      } else {
        this.currentOutput = '';
      }
    }
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
    // Note: DISCODE_HTTP_PORT is set in initialize() to ensure config is loaded
    this.client = new CodexClient();
  }

  async initialize(): Promise<void> {
    // Set environment variables for the Codex process
    // This needs to be done before start() is called
    const config = getConfig();
    if (!this.client['options']) {
      (this.client as any).options = {};
    }
    (this.client as any).options.env = {
      ...((this.client as any).options.env || {}),
      DISCODE_HTTP_PORT: String(config.httpPort)
    };

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
    await session.start();
    return session;
  }

  async listThreads(cliPath: string, params: ThreadListParams = {}): Promise<ThreadListResponse> {
    if (!cliPath) {
      throw new Error('Codex CLI path not provided');
    }

    if (!this.clientPath || this.clientPath !== cliPath) {
      await this.client.shutdown();
      this.client = new CodexClient({ codexPath: cliPath });
      this.attachClientListeners();
      this.clientPath = cliPath;
    }

    return this.client.listThreads(params);
  }

  async listModels(cliPath: string, params: ModelListParams = {}): Promise<ModelListResponse> {
    if (!cliPath) {
      throw new Error('Codex CLI path not provided');
    }

    if (!this.clientPath || this.clientPath !== cliPath) {
      await this.client.shutdown();
      this.client = new CodexClient({ codexPath: cliPath });
      this.attachClientListeners();
      this.clientPath = cliPath;
    }

    return this.client.listModels(params);
  }
}
