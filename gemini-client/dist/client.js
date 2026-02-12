"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiClient = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const readline_1 = require("readline");
const sessions_js_1 = require("./sessions.js");
const types_js_1 = require("./types.js");
class GeminiClient extends events_1.EventEmitter {
    options;
    _sessionId = null;
    activeProcess = null;
    runChain = Promise.resolve();
    constructor(options = {}) {
        super();
        this.options = options;
    }
    get sessionId() {
        return this._sessionId;
    }
    setSessionId(sessionId) {
        this._sessionId = sessionId;
    }
    async start() {
        // Exists for API parity with the other clients.
    }
    async startSession(prompt, runOptions = {}) {
        return this.enqueue(() => this.runPrompt(prompt, { ...runOptions, resume: undefined }));
    }
    async continueSession(prompt, runOptions = {}) {
        const resume = runOptions.resume || this._sessionId;
        if (!resume) {
            throw new Error('No active Gemini session. Start a new session first or provide runOptions.resume.');
        }
        return this.enqueue(() => this.runPrompt(prompt, { ...runOptions, resume }));
    }
    async sendMessage(prompt, runOptions = {}) {
        if (runOptions.resume || this._sessionId) {
            return this.continueSession(prompt, runOptions);
        }
        return this.startSession(prompt, runOptions);
    }
    async listSessions() {
        return (0, sessions_js_1.listGeminiSessions)({
            projectRoot: this.options.cwd || process.cwd(),
            currentSessionId: this._sessionId || undefined,
            homeDir: this.options.homeDir || this.options.env?.HOME,
            geminiDir: this.options.geminiDir
        });
    }
    async resolveSession(identifier) {
        return (0, sessions_js_1.resolveGeminiSession)(identifier, {
            projectRoot: this.options.cwd || process.cwd(),
            currentSessionId: this._sessionId || undefined,
            homeDir: this.options.homeDir || this.options.env?.HOME,
            geminiDir: this.options.geminiDir
        });
    }
    async deleteSession(identifier) {
        return (0, sessions_js_1.deleteGeminiSession)(identifier, {
            projectRoot: this.options.cwd || process.cwd(),
            currentSessionId: this._sessionId || undefined,
            homeDir: this.options.homeDir || this.options.env?.HOME,
            geminiDir: this.options.geminiDir
        });
    }
    async interrupt(signal = 'SIGINT') {
        if (!this.activeProcess)
            return;
        this.activeProcess.kill(signal);
    }
    async shutdown() {
        if (!this.activeProcess)
            return;
        this.activeProcess.kill('SIGTERM');
    }
    enqueue(task) {
        const run = this.runChain.then(task, task);
        this.runChain = run.then(() => undefined, () => undefined);
        return run;
    }
    buildArgs(prompt, runOptions) {
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Prompt cannot be empty.');
        }
        const outputFormat = runOptions.outputFormat || this.options.outputFormat || 'stream-json';
        const args = [];
        if (runOptions.resume) {
            args.push('--resume', runOptions.resume);
        }
        if (runOptions.model || this.options.model) {
            args.push('--model', runOptions.model || this.options.model);
        }
        if (typeof runOptions.sandbox === 'boolean') {
            if (runOptions.sandbox)
                args.push('--sandbox');
        }
        else if (typeof this.options.sandbox === 'boolean' && this.options.sandbox) {
            args.push('--sandbox');
        }
        const approvalMode = runOptions.approvalMode || this.options.approvalMode;
        if (approvalMode) {
            args.push('--approval-mode', approvalMode);
        }
        else {
            const yolo = runOptions.yolo ?? this.options.yolo;
            if (yolo)
                args.push('--yolo');
        }
        args.push('--output-format', outputFormat);
        const addArrayArgs = (flag, values) => {
            if (!values || values.length === 0)
                return;
            for (const value of values) {
                args.push(flag, value);
            }
        };
        addArrayArgs('--include-directories', runOptions.includeDirectories || this.options.includeDirectories);
        addArrayArgs('--allowed-tools', runOptions.allowedTools || this.options.allowedTools);
        addArrayArgs('--allowed-mcp-server-names', runOptions.allowedMcpServerNames || this.options.allowedMcpServerNames);
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
    toSpawnEnv() {
        const env = {
            ...process.env,
            ...this.options.env
        };
        if (this.options.homeDir && !env.HOME) {
            env.HOME = this.options.homeDir;
        }
        return env;
    }
    isJsonStreamEvent(value) {
        if (!value || typeof value !== 'object')
            return false;
        const event = value;
        if (typeof event.type !== 'string' || typeof event.timestamp !== 'string')
            return false;
        return Object.values(types_js_1.JsonStreamEventType).includes(event.type);
    }
    onEvent(ctx, event) {
        ctx.events.push(event);
        this.emit('event', event);
        switch (event.type) {
            case types_js_1.JsonStreamEventType.INIT: {
                const init = event;
                ctx.sessionId = init.session_id;
                this._sessionId = init.session_id;
                this.emit('ready', init.session_id);
                break;
            }
            case types_js_1.JsonStreamEventType.MESSAGE: {
                const msg = event;
                if (msg.role === 'assistant' && typeof msg.content === 'string') {
                    ctx.assistantResponse += msg.content;
                    this.emit('message_delta', msg.content);
                }
                this.emit('message', msg);
                break;
            }
            case types_js_1.JsonStreamEventType.TOOL_USE: {
                this.emit('tool_use', event);
                break;
            }
            case types_js_1.JsonStreamEventType.TOOL_RESULT: {
                this.emit('tool_result', event);
                break;
            }
            case types_js_1.JsonStreamEventType.ERROR: {
                ctx.errorEvent = event;
                this.emit('error_event', event);
                break;
            }
            case types_js_1.JsonStreamEventType.RESULT: {
                ctx.resultEvent = event;
                this.emit('result', event);
                break;
            }
            default:
                break;
        }
    }
    async runPrompt(prompt, runOptions) {
        await this.start();
        const geminiPath = this.options.geminiPath || 'gemini';
        const args = this.buildArgs(prompt, runOptions);
        const ctx = {
            events: [],
            stdout: [],
            stderr: [],
            assistantResponse: ''
        };
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)(geminiPath, args, {
                cwd: this.options.cwd || process.cwd(),
                env: this.toSpawnEnv(),
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.activeProcess = proc;
            proc.on('error', (error) => {
                this.activeProcess = null;
                reject(error);
            });
            const stdoutRl = (0, readline_1.createInterface)({ input: proc.stdout });
            stdoutRl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed)
                    return;
                try {
                    const parsed = JSON.parse(trimmed);
                    if (this.isJsonStreamEvent(parsed)) {
                        this.onEvent(ctx, parsed);
                    }
                    else {
                        ctx.stdout.push(trimmed);
                        this.emit('stdout', trimmed);
                    }
                }
                catch {
                    ctx.stdout.push(trimmed);
                    this.emit('stdout', trimmed);
                }
            });
            const stderrRl = (0, readline_1.createInterface)({ input: proc.stderr });
            stderrRl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed)
                    return;
                ctx.stderr.push(trimmed);
                this.emit('stderr', trimmed);
            });
            proc.on('close', (code, signal) => {
                this.activeProcess = null;
                this.emit('exit', code, signal);
                const resultStatus = ctx.resultEvent?.status || (code === 0 ? 'success' : 'error');
                const stats = ctx.resultEvent?.stats;
                const error = ctx.resultEvent?.error || ctx.errorEvent
                    ? {
                        type: ctx.resultEvent?.error?.type ||
                            ctx.errorEvent?.severity ||
                            'error',
                        message: ctx.resultEvent?.error?.message ||
                            ctx.errorEvent?.message ||
                            `Gemini CLI exited with code ${code ?? 'unknown'}`
                    }
                    : undefined;
                if (!ctx.sessionId && this._sessionId) {
                    ctx.sessionId = this._sessionId;
                }
                const result = {
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
                        message: result.stderr ||
                            `Gemini CLI exited with code ${code ?? 'unknown'}`
                    };
                }
                resolve(result);
            });
        });
    }
}
exports.GeminiClient = GeminiClient;
