/**
 * Gemini SDK Plugin
 *
 * Uses the standalone gemini-client library to manage Gemini CLI sessions.
 * Supports persistent session start/resume/continue with stream-json events.
 */

import {
  BasePlugin,
  PluginSession,
  SessionConfig,
  PluginType,
  PluginOptions
} from './base.js';
import {
  BaseSDKSession,
  MessageQueue
} from './sdk-base.js';
import { getConfig } from '../config.js';
import {
  GeminiClient,
  type GeminiRunOptions,
  type GeminiRunResult,
  type ToolUseEvent,
  type ToolResultEvent
} from '@raylin01/gemini-client';

class GeminiSDKSession extends BaseSDKSession {
  private client: GeminiClient;
  private messageQueue: MessageQueue;
  private closed = false;

  private modelOverride: string | undefined;
  private permissionModeOverride: 'default' | 'acceptEdits' | undefined;

  // Diagnostics kept separate as per requirements
  private currentDiagnostics = '';
  private diagnosticsOutputType: 'info' | 'stderr' = 'info';
  private diagnosticsTimer: NodeJS.Timeout | null = null;
  private readonly OUTPUT_THROTTLE_MS = 500;

  private currentRunStartedAt = 0;
  private currentRunToolCalls = 0;
  private currentResultEmitted = false;

  constructor(config: SessionConfig, plugin: GeminiSDKPlugin) {
    super(config, plugin);

    const options = config.options || {};
    this.modelOverride = typeof options.model === 'string' ? options.model : undefined;
    this.permissionModeOverride =
      options.permissionMode === 'default' || options.permissionMode === 'acceptEdits'
        ? options.permissionMode
        : undefined;

    this.client = new GeminiClient({
      cwd: config.cwd || process.cwd(),
      geminiPath: config.cliPath,
      model: this.modelOverride,
      env: {
        ...process.env,
        ...options.env,
        DISCODE_SESSION_ID: this.sessionId,
        DISCODE_HTTP_PORT: String(getConfig().httpPort)
      }
    });

    if (typeof options.resumeSessionId === 'string' && options.resumeSessionId.trim().length > 0) {
      this.client.setSessionId(options.resumeSessionId);
    }

    // Initialize message queue with sender
    this.messageQueue = new MessageQueue((message) => this.processMessage(message));

    this.setupClientListeners();
  }

  async start(): Promise<void> {
    await this.client.start();
    this.isReady = true;
    this.emit('ready');
    this.emitStatus('idle');
  }

  async sendMessage(message: string): Promise<void> {
    return this.messageQueue.enqueue(message);
  }

  async sendApproval(_optionNumber: string, _message?: string, _requestId?: string): Promise<void> {
    // Gemini CLI stream-json mode does not currently support interactive approval callbacks.
    return;
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits'): Promise<void> {
    this.permissionModeOverride = mode;
    this.emitMetadata({ permissionMode: mode });
  }

  async setModel(model: string): Promise<void> {
    this.modelOverride = model;
    this.emitMetadata({ model });
  }

  async interrupt(): Promise<void> {
    await this.client.interrupt();
    this.outputThrottler.flush(true);
    this.flushDiagnostics(true);
    this.emitStatus('idle');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.messageQueue.clear();
    if (this.diagnosticsTimer) {
      clearTimeout(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }
    await this.client.shutdown();
    this.status = 'offline';
    this.isReady = false;
  }

  /**
   * Get pending permissions map for permission sync handler
   * Gemini CLI stream-json mode does not currently support interactive approval callbacks.
   */
  getPendingPermissions(): Map<string, { requestId: string; toolName: string; input: Record<string, any>; createdAt: number }> {
    return new Map();
  }

  private setupClientListeners(): void {
    this.client.on('ready', (geminiSessionId) => {
      // Emit CLI session ID for persistence (enables resume after restart)
      this.plugin.emit('cli_session_id', {
        sessionId: this.sessionId,
        cliSessionId: geminiSessionId
      });

      this.emitMetadata({
        model: this.modelOverride,
        permissionMode: this.permissionModeOverride,
        mode: `session:${geminiSessionId}`
      });
    });

    this.client.on('message_delta', (delta) => {
      if (!this.messageQueue.isActive()) return;
      if (!delta) return;
      // message_delta sends accumulated content, so use addStdout (replaces)
      this.outputThrottler.addStdout(delta);
    });

    this.client.on('stdout', (line) => {
      if (!this.messageQueue.isActive()) return;
      if (!line) return;
      // stdout sends individual lines, so use appendStdout
      this.outputThrottler.appendStdout(`\n${line}`);
    });

    this.client.on('tool_use', (event: ToolUseEvent) => {
      if (!this.messageQueue.isActive()) return;
      this.currentRunToolCalls += 1;

      this.plugin.emit('tool_execution', {
        sessionId: this.sessionId,
        toolName: event.tool_name,
        toolId: event.tool_id,
        input: event.parameters || {},
        timestamp: new Date(event.timestamp || Date.now())
      });

      this.emitOutput({
        content: `${event.tool_name}: ${JSON.stringify(event.parameters || {})}`,
        isComplete: false,
        outputType: 'tool_use',
        structuredData: {
          tool: {
            name: event.tool_name,
            input: event.parameters || {}
          }
        }
      });
    });

    this.client.on('tool_result', (event: ToolResultEvent) => {
      if (!this.messageQueue.isActive()) return;
      const content = event.output || event.error?.message || '';

      this.plugin.emit('tool_result', {
        sessionId: this.sessionId,
        toolUseId: event.tool_id,
        content,
        isError: event.status === 'error',
        timestamp: new Date(event.timestamp || Date.now())
      });

      if (content) {
        this.emitOutput({
          content,
          isComplete: false,
          outputType: 'tool_result'
        });
      }
    });

    this.client.on('result', (event) => {
      if (!this.messageQueue.isActive()) return;
      if (event.stats) {
        this.emitMetadata({ tokens: event.stats.total_tokens });
      }
    });

    this.client.on('error_event', (event) => {
      if (!this.messageQueue.isActive()) return;
      this.emitError(event.message, false);
    });

    this.client.on('stderr', (line) => {
      if (!this.messageQueue.isActive()) return;
      if (!line || this.shouldIgnoreStderrLine(line)) return;

      const outputType = this.classifyStderrLine(line);
      if (this.currentDiagnostics && this.diagnosticsOutputType !== outputType) {
        this.flushDiagnostics(false);
        this.currentDiagnostics = '';
      }

      this.diagnosticsOutputType = outputType;
      this.currentDiagnostics += this.currentDiagnostics ? `\n${line}` : line;
      this.scheduleDiagnosticsFlush();
    });
  }

  private async processMessage(message: string): Promise<void> {
    this.lastActivity = new Date();
    this.currentDiagnostics = '';
    this.diagnosticsOutputType = 'info';
    this.currentRunToolCalls = 0;
    this.currentResultEmitted = false;
    this.currentRunStartedAt = Date.now();

    this.emitStatus('working');

    try {
      const result = await this.runMessage(message);

      // If no output was emitted but we have an assistant response, emit it
      if (result.assistantResponse) {
        this.outputThrottler.addStdout(result.assistantResponse);
      }

      this.outputThrottler.flush(true);
      this.flushDiagnostics(true);
      this.emitRunResult(result);
      this.emitStatus('idle');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.outputThrottler.flush(true);
      this.flushDiagnostics(true);
      this.emitStatus('idle');
      this.emitError(error.message, false);
      throw error;
    } finally {
      // After result (success or error), session is ready for new messages
      this.emit('ready');
    }
  }

  private async runMessage(message: string): Promise<GeminiRunResult> {
    const options = this.config.options || {};
    const runOptions = this.buildRunOptions(options);
    // Only continue if explicitly set to true (new sessions default to false)
    const continueConversation = options.continueConversation === true;

    if (!continueConversation) {
      return this.client.startSession(message, { ...runOptions, resume: undefined });
    }
    return this.client.sendMessage(message, runOptions);
  }

  private buildRunOptions(options: PluginOptions): GeminiRunOptions {
    const runOptions: GeminiRunOptions = {};

    const yolo = options.skipPermissions === true || options.allowDangerouslySkipPermissions === true;
    if (yolo) {
      runOptions.yolo = true;
    } else if (
      options.approvalMode === 'default' ||
      options.approvalMode === 'auto_edit' ||
      options.approvalMode === 'yolo'
    ) {
      if (options.approvalMode === 'yolo') {
        runOptions.yolo = true;
      } else {
        runOptions.approvalMode = options.approvalMode;
      }
    } else if (this.permissionModeOverride === 'acceptEdits') {
      runOptions.approvalMode = 'auto_edit';
    } else if (this.permissionModeOverride === 'default') {
      runOptions.approvalMode = 'default';
    }

    if (typeof options.resumeSessionId === 'string' && options.resumeSessionId.trim().length > 0 && !this.client.sessionId) {
      runOptions.resume = options.resumeSessionId;
    }

    if (typeof this.modelOverride === 'string' && this.modelOverride.trim().length > 0) {
      runOptions.model = this.modelOverride;
    }

    const sandbox = this.parseSandboxOption(options.sandbox);
    if (sandbox !== undefined) {
      runOptions.sandbox = sandbox;
    }

    if (Array.isArray(options.additionalDirectories) && options.additionalDirectories.length > 0) {
      runOptions.includeDirectories = options.additionalDirectories.map((value) => String(value));
    }

    if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
      runOptions.allowedTools = options.allowedTools.map((value) => String(value));
    }

    const mcpServerNames = this.extractMcpServerNames(options);
    if (mcpServerNames.length > 0) {
      runOptions.allowedMcpServerNames = mcpServerNames;
    }

    if (Array.isArray(options.extensions) && options.extensions.length > 0) {
      runOptions.extensions = options.extensions.map((value) => String(value));
    }

    const extraArgs = this.normalizeExtraArgs(options.extraArgs);
    if (extraArgs.length > 0) {
      runOptions.extraArgs = extraArgs;
    }

    return runOptions;
  }

  private parseSandboxOption(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (['1', 'true', 'on', 'enabled', 'sandbox'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'disabled', 'none'].includes(normalized)) return false;
    return undefined;
  }

  private extractMcpServerNames(options: PluginOptions): string[] {
    if (Array.isArray(options.allowedMcpServerNames) && options.allowedMcpServerNames.length > 0) {
      return options.allowedMcpServerNames.map((value) => String(value).trim()).filter(Boolean);
    }
    if (!options.mcpServers || typeof options.mcpServers !== 'object') return [];
    return Object.keys(options.mcpServers)
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  private normalizeExtraArgs(extraArgs: PluginOptions['extraArgs']): string[] {
    if (!extraArgs || typeof extraArgs !== 'object' || Array.isArray(extraArgs)) return [];
    const args: string[] = [];
    for (const [key, value] of Object.entries(extraArgs)) {
      if (!key) continue;
      const flag = key.startsWith('-') ? key : `--${key}`;
      if (typeof value === 'boolean') {
        if (value) args.push(flag);
        continue;
      }
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          args.push(flag, String(item));
        }
        continue;
      }
      args.push(flag, String(value));
    }
    return args;
  }

  private scheduleDiagnosticsFlush(): void {
    if (this.diagnosticsTimer) return;
    this.diagnosticsTimer = setTimeout(() => {
      this.diagnosticsTimer = null;
      this.flushDiagnostics(false);
    }, this.OUTPUT_THROTTLE_MS);
  }

  private flushDiagnostics(isComplete: boolean): void {
    if (this.diagnosticsTimer && isComplete) {
      clearTimeout(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }

    if (!this.currentDiagnostics.trim()) return;

    this.emitOutput({
      content: this.currentDiagnostics,
      isComplete,
      outputType: this.diagnosticsOutputType
    });

    // Clear diagnostics after final flush to prevent resend
    if (isComplete) {
      this.currentDiagnostics = '';
    }
  }

  private shouldIgnoreStderrLine(line: string): boolean {
    if (line.includes('Loaded cached credentials')) return true;
    if (/^\[DEBUG\]\s+\[MemoryDiscovery\]/.test(line)) return true;
    if (/^\[DEBUG\]\s+\[BfsFileSearch\]/.test(line)) return true;
    if (/^\[DEBUG\]\s+\[ImportProcessor\]/.test(line)) return true;
    return false;
  }

  private classifyStderrLine(line: string): 'info' | 'stderr' {
    if (/^\[DEBUG\]/.test(line)) return 'info';
    if (/^\[INFO\]/.test(line)) return 'info';
    if (/^\[WARN(ING)?\]/.test(line)) return 'info';
    return 'stderr';
  }

  private emitRunResult(result: GeminiRunResult): void {
    if (this.currentResultEmitted) return;
    this.currentResultEmitted = true;

    const durationMs = result.stats?.duration_ms ?? Math.max(0, Date.now() - this.currentRunStartedAt);
    const isError = result.status === 'error';
    const summary = isError
      ? (result.error?.message || 'Gemini execution failed')
      : this.currentRunToolCalls > 0
        ? `Completed successfully with ${this.currentRunToolCalls} tool call${this.currentRunToolCalls === 1 ? '' : 's'}.`
        : 'Completed successfully.';

    this.plugin.emit('result', {
      sessionId: this.sessionId,
      result: summary,
      subtype: isError ? 'error' : 'success',
      durationMs,
      durationApiMs: durationMs,
      numTurns: 1,
      isError,
      error: result.error?.message,
      timestamp: new Date()
    });
  }
}

export class GeminiSDKPlugin extends BasePlugin {
  readonly name = 'gemini-sdk';
  readonly type: PluginType = 'gemini-sdk';
  readonly isPersistent = true;

  async createSession(config: SessionConfig): Promise<PluginSession> {
    if (!config.cliPath) {
      throw new Error('Gemini CLI path not provided');
    }

    const session = new GeminiSDKSession(config, this);
    this.sessions.set(session.sessionId, session);
    await session.start();
    return session;
  }
}
