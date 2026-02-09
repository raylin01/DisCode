import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import {
  CodexServerNotification,
  CodexServerRequest,
  CodexRpcResponse,
  InitializeParams,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadUnarchiveParams,
  ThreadUnarchiveResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadRollbackParams,
  ThreadRollbackResponse,
  ThreadListParams,
  ThreadListResponse,
  ThreadLoadedListParams,
  ThreadLoadedListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ModelListParams,
  ModelListResponse,
  SetDefaultModelParams,
  SetDefaultModelResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse
} from './types.js';

export interface CodexClientOptions {
  codexPath?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  analyticsDefaultEnabled?: boolean;
  clientInfo?: { name?: string; title?: string; version?: string };
  capabilities?: { experimentalApi?: boolean };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class CodexClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private requestCounter = 1;
  private pending = new Map<string, PendingRequest>();
  private readonly options: CodexClientOptions;

  constructor(options: CodexClientOptions = {}) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.startInternal();
    return this.initPromise;
  }

  private async startInternal(): Promise<void> {
    const codexPath = this.options.codexPath || 'codex';
    const args = ['app-server'];
    if (this.options.analyticsDefaultEnabled !== false) {
      args.push('--analytics-default-enabled');
    }
    if (Array.isArray(this.options.args)) {
      args.push(...this.options.args);
    }

    this.proc = spawn(codexPath, args, {
      cwd: this.options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...this.options.env,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: this.options.env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || 'codex_vscode',
        RUST_LOG: this.options.env?.RUST_LOG || 'warn'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
      this.rejectAll(err);
    });

    this.proc.on('exit', (code, signal) => {
      const err = new Error(`Codex app-server exited (code=${code ?? 'unknown'}, signal=${signal ?? 'unknown'})`);
      this.emit('error', err);
      this.rejectAll(err);
      this.proc = null;
      this.initialized = false;
      this.initPromise = null;
    });

    if (this.proc.stderr) {
      this.proc.stderr.on('data', (data) => {
        const text = data.toString('utf8').trim();
        if (text.length > 0) {
          this.emit('log', text);
        }
      });
    }

    if (!this.proc.stdout) {
      throw new Error('Codex app-server did not provide stdout');
    }

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    const initParams: InitializeParams = {
      clientInfo: {
        name: this.options.clientInfo?.name || 'discode',
        title: this.options.clientInfo?.title || 'DisCode',
        version: this.options.clientInfo?.version || '0.0.0'
      },
      capabilities: { experimentalApi: this.options.capabilities?.experimentalApi !== false }
    };

    await this.sendRequest('initialize', initParams);
    this.initialized = true;
    this.emit('ready');
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      this.emit('error', new Error(`Failed to parse codex message: ${err}`));
      return;
    }

    if (message && typeof message === 'object') {
      if ('id' in message && ('result' in message || 'error' in message)) {
        this.handleResponse(message as CodexRpcResponse);
        return;
      }
      if (typeof message.method === 'string') {
        if ('id' in message) {
          this.emit('request', message as CodexServerRequest);
        } else {
          this.emit('notification', message as CodexServerNotification);
        }
        return;
      }
    }
  }

  private handleResponse(response: CodexRpcResponse): void {
    const key = String(response.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (response.error) {
      const msg = response.error?.message || 'Unknown Codex RPC error';
      pending.reject(new Error(msg));
      return;
    }
    pending.resolve(response.result);
  }

  private nextId(): string {
    return String(this.requestCounter++);
  }

  private sendRaw(payload: any): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('Codex app-server stdin is not available');
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async sendRequest<T = any>(method: string, params: any): Promise<T> {
    if (!this.proc) {
      throw new Error('Codex app-server is not running');
    }
    const id = this.nextId();
    const payload = { id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.sendRaw(payload);
    return promise;
  }

  sendResponse(id: string | number, result: any): void {
    this.sendRaw({ id, result });
  }

  sendError(id: string | number, error: any): void {
    this.sendRaw({ id, error });
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    await this.start();
    return this.sendRequest<ThreadStartResponse>('thread/start', params);
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    await this.start();
    return this.sendRequest<ThreadResumeResponse>('thread/resume', params);
  }

  async forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> {
    await this.start();
    return this.sendRequest<ThreadForkResponse>('thread/fork', params);
  }

  async archiveThread(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
    await this.start();
    return this.sendRequest<ThreadArchiveResponse>('thread/archive', params);
  }

  async unarchiveThread(params: ThreadUnarchiveParams): Promise<ThreadUnarchiveResponse> {
    await this.start();
    return this.sendRequest<ThreadUnarchiveResponse>('thread/unarchive', params);
  }

  async setThreadName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> {
    await this.start();
    return this.sendRequest<ThreadSetNameResponse>('thread/name/set', params);
  }

  async compactThread(params: ThreadCompactStartParams): Promise<ThreadCompactStartResponse> {
    await this.start();
    return this.sendRequest<ThreadCompactStartResponse>('thread/compact/start', params);
  }

  async rollbackThread(params: ThreadRollbackParams): Promise<ThreadRollbackResponse> {
    await this.start();
    return this.sendRequest<ThreadRollbackResponse>('thread/rollback', params);
  }

  async listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    await this.start();
    return this.sendRequest<ThreadListResponse>('thread/list', params);
  }

  async listLoadedThreads(params: ThreadLoadedListParams = {}): Promise<ThreadLoadedListResponse> {
    await this.start();
    return this.sendRequest<ThreadLoadedListResponse>('thread/loaded/list', params);
  }

  async readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    await this.start();
    return this.sendRequest<ThreadReadResponse>('thread/read', params);
  }

  async listModels(params: ModelListParams = {}): Promise<ModelListResponse> {
    await this.start();
    return this.sendRequest<ModelListResponse>('model/list', params);
  }

  async setDefaultModel(params: SetDefaultModelParams): Promise<SetDefaultModelResponse> {
    await this.start();
    return this.sendRequest<SetDefaultModelResponse>('setDefaultModel', params);
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    await this.start();
    return this.sendRequest<TurnStartResponse>('turn/start', params);
  }

  async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    await this.start();
    return this.sendRequest<TurnInterruptResponse>('turn/interrupt', params);
  }

  async shutdown(): Promise<void> {
    if (this.rl) {
      this.rl.removeAllListeners();
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
    this.initPromise = null;
    this.pending.clear();
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}
