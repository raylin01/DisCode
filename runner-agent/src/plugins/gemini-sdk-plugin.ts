/**
 * Gemini SDK Plugin
 *
 * Uses the standalone gemini-client library to manage Gemini CLI sessions.
 * Supports persistent session start/resume/continue with stream-json events.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  BasePlugin,
  PluginSession,
  SessionConfig,
  SessionStatus,
  PluginType,
  PluginOptions
} from './base.js';
import { getConfig } from '../config.js';
import {
  GeminiClient,
  type GeminiRunOptions,
  type GeminiRunResult,
  type ToolUseEvent,
  type ToolResultEvent
} from '../../../gemini-client/src/index.js';

class GeminiSDKSession extends EventEmitter implements PluginSession {
  readonly sessionId: string;
  readonly config: SessionConfig;
  readonly createdAt: Date;
  readonly isOwned = true;

  status: SessionStatus = 'idle';
  lastActivity: Date;
  isReady = false;

  private client: GeminiClient;
  private pendingQueue: Array<{ message: string; resolve: () => void; reject: (error: Error) => void }> = [];
  private sending = false;
  private closed = false;

  private modelOverride: string | undefined;
  private permissionModeOverride: 'default' | 'acceptEdits' | undefined;

  private currentOutput = '';
  private outputTimer: NodeJS.Timeout | null = null;
  private readonly OUTPUT_THROTTLE_MS = 500;
  private currentDiagnostics = '';
  private diagnosticsOutputType: 'info' | 'stderr' = 'info';
  private diagnosticsTimer: NodeJS.Timeout | null = null;

  private currentRunStartedAt = 0;
  private currentRunToolCalls = 0;
  private currentResultEmitted = false;

  constructor(config: SessionConfig, private plugin: GeminiSDKPlugin) {
    super();
    this.sessionId = config.sessionId || randomUUID();
    this.config = config;
    this.createdAt = new Date();
    this.lastActivity = new Date();

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

    this.setupClientListeners();
  }

  async start(): Promise<void> {
    await this.client.start();
    this.isReady = true;
    this.emit('ready');
    this.plugin.emit('status', {
      sessionId: this.sessionId,
      status: 'idle'
    });
  }

  async sendMessage(message: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingQueue.push({ message, resolve, reject });
      this.drainQueue().catch(reject);
    });
  }

  async sendApproval(_optionNumber: string, _message?: string, _requestId?: string): Promise<void> {
    // Gemini CLI stream-json mode does not currently support interactive approval callbacks.
    return;
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits'): Promise<void> {
    this.permissionModeOverride = mode;
    this.plugin.emit('metadata', {
      sessionId: this.sessionId,
      permissionMode: mode,
      timestamp: new Date()
    });
  }

  async setModel(model: string): Promise<void> {
    this.modelOverride = model;
    this.plugin.emit('metadata', {
      sessionId: this.sessionId,
      model,
      timestamp: new Date()
    });
  }

  async interrupt(): Promise<void> {
    await this.client.interrupt();
    this.flushOutput(true);
    this.flushDiagnostics(true);
    this.status = 'idle';
    this.plugin.emit('status', {
      sessionId: this.sessionId,
      status: this.status
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pendingQueue = [];
    if (this.outputTimer) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }
    if (this.diagnosticsTimer) {
      clearTimeout(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }
    await this.client.shutdown();
    this.status = 'offline';
    this.isReady = false;
  }

  private setupClientListeners(): void {
    this.client.on('ready', (geminiSessionId) => {
      // Emit CLI session ID for persistence (enables resume after restart)
      this.plugin.emit('cli_session_id', {
        sessionId: this.sessionId,
        cliSessionId: geminiSessionId
      });

      this.plugin.emit('metadata', {
        sessionId: this.sessionId,
        model: this.modelOverride,
        permissionMode: this.permissionModeOverride,
        mode: `session:${geminiSessionId}`,
        timestamp: new Date()
      });
    });

    this.client.on('message_delta', (delta) => {
      if (!this.sending) return;
      if (!delta) return;
      this.currentOutput += delta;
      this.scheduleOutputFlush();
    });

    this.client.on('stdout', (line) => {
      if (!this.sending) return;
      if (!line) return;
      this.currentOutput += this.currentOutput ? `\n${line}` : line;
      this.scheduleOutputFlush();
    });

    this.client.on('tool_use', (event: ToolUseEvent) => {
      if (!this.sending) return;
      this.currentRunToolCalls += 1;

      this.plugin.emit('tool_execution', {
        sessionId: this.sessionId,
        toolName: event.tool_name,
        toolId: event.tool_id,
        input: event.parameters || {},
        timestamp: new Date(event.timestamp || Date.now())
      });

      this.plugin.emit('output', {
        sessionId: this.sessionId,
        content: `${event.tool_name}: ${JSON.stringify(event.parameters || {})}`,
        isComplete: false,
        outputType: 'tool_use',
        structuredData: {
          tool: {
            name: event.tool_name,
            input: event.parameters || {}
          }
        },
        timestamp: new Date(event.timestamp || Date.now())
      });
    });

    this.client.on('tool_result', (event: ToolResultEvent) => {
      if (!this.sending) return;
      const content = event.output || event.error?.message || '';

      this.plugin.emit('tool_result', {
        sessionId: this.sessionId,
        toolUseId: event.tool_id,
        content,
        isError: event.status === 'error',
        timestamp: new Date(event.timestamp || Date.now())
      });

      if (content) {
        this.plugin.emit('output', {
          sessionId: this.sessionId,
          content,
          isComplete: false,
          outputType: 'tool_result',
          timestamp: new Date(event.timestamp || Date.now())
        });
      }
    });

    this.client.on('result', (event) => {
      if (!this.sending) return;
      if (event.stats) {
        this.plugin.emit('metadata', {
          sessionId: this.sessionId,
          tokens: event.stats.total_tokens,
          timestamp: new Date(event.timestamp || Date.now())
        });
      }
    });

    this.client.on('error_event', (event) => {
      if (!this.sending) return;
      this.plugin.emit('error', {
        sessionId: this.sessionId,
        error: event.message,
        fatal: false
      });
    });

    this.client.on('stderr', (line) => {
      if (!this.sending) return;
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

  private async drainQueue(): Promise<void> {
    if (this.sending || this.closed) return;
    const next = this.pendingQueue.shift();
    if (!next) return;

    this.sending = true;
    this.lastActivity = new Date();
    this.status = 'working';
    this.currentOutput = '';
    this.currentDiagnostics = '';
    this.diagnosticsOutputType = 'info';
    this.currentRunToolCalls = 0;
    this.currentResultEmitted = false;
    this.currentRunStartedAt = Date.now();

    this.plugin.emit('status', {
      sessionId: this.sessionId,
      status: this.status
    });

    try {
      const result = await this.runMessage(next.message);
      if (!this.currentOutput && result.assistantResponse) {
        this.currentOutput = result.assistantResponse;
      }
      this.flushOutput(true);
      this.flushDiagnostics(true);
      this.emitRunResult(result);

      this.status = 'idle';
      this.plugin.emit('status', {
        sessionId: this.sessionId,
        status: this.status
      });

      next.resolve();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.flushOutput(true);
      this.flushDiagnostics(true);

      this.status = 'idle';
      this.plugin.emit('status', {
        sessionId: this.sessionId,
        status: this.status
      });
      this.plugin.emit('error', {
        sessionId: this.sessionId,
        error: error.message,
        fatal: false
      });

      next.reject(error);
    } finally {
      this.sending = false;
      if (!this.closed) {
        this.drainQueue().catch(() => null);
      }
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

  private scheduleOutputFlush(): void {
    if (this.outputTimer) return;
    this.outputTimer = setTimeout(() => {
      this.outputTimer = null;
      this.flushOutput(false);
    }, this.OUTPUT_THROTTLE_MS);
  }

  private flushOutput(isComplete: boolean): void {
    if (this.outputTimer && isComplete) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }

    if (!this.currentOutput.trim()) return;

    this.plugin.emit('output', {
      sessionId: this.sessionId,
      content: this.currentOutput,
      isComplete,
      outputType: 'stdout',
      timestamp: new Date()
    });

    // Clear output after final flush to prevent resend
    if (isComplete) {
      this.currentOutput = '';
    }
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

    this.plugin.emit('output', {
      sessionId: this.sessionId,
      content: this.currentDiagnostics,
      isComplete,
      outputType: this.diagnosticsOutputType,
      timestamp: new Date()
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
