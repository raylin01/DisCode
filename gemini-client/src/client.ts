import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import {
  deleteGeminiSession,
  listGeminiSessions,
  resolveGeminiSession
} from './sessions.js';
import {
  JsonStreamEventType,
  type ErrorEvent,
  type GeminiClientOptions,
  type GeminiRunOptions,
  type GeminiRunResult,
  type GeminiSessionInfo,
  type InitEvent,
  type JsonStreamEvent,
  type MessageEvent,
  type ResultEvent,
  type StreamStats,
  type ToolResultEvent,
  type ToolUseEvent
} from './types.js';

interface RunContext {
  events: JsonStreamEvent[];
  stdout: string[];
  stderr: string[];
  assistantResponse: string;
  sessionId?: string;
  resultEvent?: ResultEvent;
  errorEvent?: ErrorEvent;
}

export declare interface GeminiClient {
  on(event: 'ready', listener: (sessionId: string) => void): this;
  on(event: 'event', listener: (event: JsonStreamEvent) => void): this;
  on(event: 'message', listener: (event: MessageEvent) => void): this;
  on(event: 'message_delta', listener: (delta: string) => void): this;
  on(event: 'tool_use', listener: (event: ToolUseEvent) => void): this;
  on(event: 'tool_result', listener: (event: ToolResultEvent) => void): this;
  on(event: 'result', listener: (event: ResultEvent) => void): this;
  on(event: 'error_event', listener: (event: ErrorEvent) => void): this;
  on(event: 'stderr', listener: (line: string) => void): this;
  on(event: 'stdout', listener: (line: string) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export class GeminiClient extends EventEmitter {
  private readonly options: GeminiClientOptions;
  private _sessionId: string | null = null;
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private runChain: Promise<void> = Promise.resolve();

  constructor(options: GeminiClientOptions = {}) {
    super();
    this.options = options;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  setSessionId(sessionId: string | null): void {
    this._sessionId = sessionId;
  }

  async start(): Promise<void> {
    // Exists for API parity with the other clients.
  }

  async startSession(prompt: string, runOptions: GeminiRunOptions = {}): Promise<GeminiRunResult> {
    return this.enqueue(() => this.runPrompt(prompt, { ...runOptions, resume: undefined }));
  }

  async continueSession(prompt: string, runOptions: GeminiRunOptions = {}): Promise<GeminiRunResult> {
    const resume = runOptions.resume || this._sessionId;
    if (!resume) {
      throw new Error('No active Gemini session. Start a new session first or provide runOptions.resume.');
    }
    return this.enqueue(() => this.runPrompt(prompt, { ...runOptions, resume }));
  }

  async sendMessage(prompt: string, runOptions: GeminiRunOptions = {}): Promise<GeminiRunResult> {
    if (runOptions.resume || this._sessionId) {
      return this.continueSession(prompt, runOptions);
    }
    return this.startSession(prompt, runOptions);
  }

  async listSessions(): Promise<GeminiSessionInfo[]> {
    return listGeminiSessions({
      projectRoot: this.options.cwd || process.cwd(),
      currentSessionId: this._sessionId || undefined,
      homeDir: this.options.homeDir || this.options.env?.HOME,
      geminiDir: this.options.geminiDir
    });
  }

  async resolveSession(identifier: string) {
    return resolveGeminiSession(identifier, {
      projectRoot: this.options.cwd || process.cwd(),
      currentSessionId: this._sessionId || undefined,
      homeDir: this.options.homeDir || this.options.env?.HOME,
      geminiDir: this.options.geminiDir
    });
  }

  async deleteSession(identifier: string): Promise<GeminiSessionInfo> {
    return deleteGeminiSession(identifier, {
      projectRoot: this.options.cwd || process.cwd(),
      currentSessionId: this._sessionId || undefined,
      homeDir: this.options.homeDir || this.options.env?.HOME,
      geminiDir: this.options.geminiDir
    });
  }

  async interrupt(signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
    if (!this.activeProcess) return;
    this.activeProcess.kill(signal);
  }

  async shutdown(): Promise<void> {
    if (!this.activeProcess) return;
    this.activeProcess.kill('SIGTERM');
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.runChain.then(task, task);
    this.runChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private buildArgs(prompt: string, runOptions: GeminiRunOptions): string[] {
    if (!prompt || prompt.trim().length === 0) {
      throw new Error('Prompt cannot be empty.');
    }

    const outputFormat = runOptions.outputFormat || this.options.outputFormat || 'stream-json';
    const args: string[] = [];

    if (runOptions.resume) {
      args.push('--resume', runOptions.resume);
    }

    if (runOptions.model || this.options.model) {
      args.push('--model', runOptions.model || this.options.model!);
    }

    if (typeof runOptions.sandbox === 'boolean') {
      if (runOptions.sandbox) args.push('--sandbox');
    } else if (typeof this.options.sandbox === 'boolean' && this.options.sandbox) {
      args.push('--sandbox');
    }

    const approvalMode = runOptions.approvalMode || this.options.approvalMode;
    if (approvalMode) {
      args.push('--approval-mode', approvalMode);
    } else {
      const yolo = runOptions.yolo ?? this.options.yolo;
      if (yolo) args.push('--yolo');
    }

    args.push('--output-format', outputFormat);

    const addArrayArgs = (flag: string, values?: string[]) => {
      if (!values || values.length === 0) return;
      for (const value of values) {
        args.push(flag, value);
      }
    };

    addArrayArgs('--include-directories', runOptions.includeDirectories || this.options.includeDirectories);
    addArrayArgs('--allowed-tools', runOptions.allowedTools || this.options.allowedTools);
    addArrayArgs(
      '--allowed-mcp-server-names',
      runOptions.allowedMcpServerNames || this.options.allowedMcpServerNames
    );
    addArrayArgs('--extensions', runOptions.extensions || this.options.extensions);

    if (this.options.args && this.options.args.length > 0) {
      args.push(...this.options.args);
    }
    if (runOptions.extraArgs && runOptions.extraArgs.length > 0) {
      args.push(...runOptions.extraArgs);
    }

    // Use positional prompt (preferred by CLI over deprecated --prompt).
    args.push(prompt);
    return args;
  }

  private toSpawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env
    };

    if (this.options.homeDir && !env.HOME) {
      env.HOME = this.options.homeDir;
    }

    return env;
  }

  private isJsonStreamEvent(value: unknown): value is JsonStreamEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as { type?: string; timestamp?: string };
    if (typeof event.type !== 'string' || typeof event.timestamp !== 'string') return false;
    return Object.values(JsonStreamEventType).includes(event.type as JsonStreamEventType);
  }

  private onEvent(ctx: RunContext, event: JsonStreamEvent): void {
    ctx.events.push(event);
    this.emit('event', event);

    switch (event.type) {
      case JsonStreamEventType.INIT: {
        const init = event as InitEvent;
        ctx.sessionId = init.session_id;
        this._sessionId = init.session_id;
        this.emit('ready', init.session_id);
        break;
      }
      case JsonStreamEventType.MESSAGE: {
        const msg = event as MessageEvent;
        if (msg.role === 'assistant' && typeof msg.content === 'string') {
          ctx.assistantResponse += msg.content;
          this.emit('message_delta', msg.content);
        }
        this.emit('message', msg);
        break;
      }
      case JsonStreamEventType.TOOL_USE: {
        this.emit('tool_use', event as ToolUseEvent);
        break;
      }
      case JsonStreamEventType.TOOL_RESULT: {
        this.emit('tool_result', event as ToolResultEvent);
        break;
      }
      case JsonStreamEventType.ERROR: {
        ctx.errorEvent = event as ErrorEvent;
        this.emit('error_event', event as ErrorEvent);
        break;
      }
      case JsonStreamEventType.RESULT: {
        ctx.resultEvent = event as ResultEvent;
        this.emit('result', event as ResultEvent);
        break;
      }
      default:
        break;
    }
  }

  private async runPrompt(prompt: string, runOptions: GeminiRunOptions): Promise<GeminiRunResult> {
    await this.start();

    const geminiPath = this.options.geminiPath || 'gemini';
    const args = this.buildArgs(prompt, runOptions);
    const ctx: RunContext = {
      events: [],
      stdout: [],
      stderr: [],
      assistantResponse: ''
    };

    return new Promise<GeminiRunResult>((resolve, reject) => {
      const proc = spawn(geminiPath, args, {
        cwd: this.options.cwd || process.cwd(),
        env: this.toSpawnEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.activeProcess = proc;

      proc.on('error', (error) => {
        this.activeProcess = null;
        reject(error);
      });

      const stdoutRl = createInterface({ input: proc.stdout });
      stdoutRl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const parsed = JSON.parse(trimmed);
          if (this.isJsonStreamEvent(parsed)) {
            this.onEvent(ctx, parsed);
          } else {
            ctx.stdout.push(trimmed);
            this.emit('stdout', trimmed);
          }
        } catch {
          ctx.stdout.push(trimmed);
          this.emit('stdout', trimmed);
        }
      });

      const stderrRl = createInterface({ input: proc.stderr });
      stderrRl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        ctx.stderr.push(trimmed);
        this.emit('stderr', trimmed);
      });

      proc.on('close', (code, signal) => {
        this.activeProcess = null;
        this.emit('exit', code, signal);

        const resultStatus: 'success' | 'error' =
          ctx.resultEvent?.status || (code === 0 ? 'success' : 'error');

        const stats: StreamStats | undefined = ctx.resultEvent?.stats;
        const error = ctx.resultEvent?.error || ctx.errorEvent
          ? {
              type:
                ctx.resultEvent?.error?.type ||
                ctx.errorEvent?.severity ||
                'error',
              message:
                ctx.resultEvent?.error?.message ||
                ctx.errorEvent?.message ||
                `Gemini CLI exited with code ${code ?? 'unknown'}`
            }
          : undefined;

        if (!ctx.sessionId && this._sessionId) {
          ctx.sessionId = this._sessionId;
        }

        const result: GeminiRunResult = {
          sessionId: ctx.sessionId,
          assistantResponse: ctx.assistantResponse,
          status: resultStatus,
          stats,
          error,
          events: ctx.events,
          exitCode: code,
          signal,
          stderr: ctx.stderr.join('\n'),
          stdout: ctx.stdout
        };

        if (code !== 0 && !ctx.resultEvent && !ctx.errorEvent) {
          result.error = {
            type: 'process_exit',
            message:
              result.stderr ||
              `Gemini CLI exited with code ${code ?? 'unknown'}`
          };
        }

        resolve(result);
      });
    });
  }
}
