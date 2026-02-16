import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
export class CodexClient extends EventEmitter {
    proc = null;
    rl = null;
    initialized = false;
    initPromise = null;
    requestCounter = 1;
    pending = new Map();
    options;
    constructor(options = {}) {
        super();
        this.options = options;
    }
    async start() {
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this.startInternal();
        return this.initPromise;
    }
    async startInternal() {
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
        const initParams = {
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
    handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch (err) {
            this.emit('error', new Error(`Failed to parse codex message: ${err}`));
            return;
        }
        if (message && typeof message === 'object') {
            if ('id' in message && ('result' in message || 'error' in message)) {
                this.handleResponse(message);
                return;
            }
            if (typeof message.method === 'string') {
                if ('id' in message) {
                    this.emit('request', message);
                }
                else {
                    this.emit('notification', message);
                }
                return;
            }
        }
    }
    handleResponse(response) {
        const key = String(response.id);
        const pending = this.pending.get(key);
        if (!pending)
            return;
        this.pending.delete(key);
        if (response.error) {
            const msg = response.error?.message || 'Unknown Codex RPC error';
            pending.reject(new Error(msg));
            return;
        }
        pending.resolve(response.result);
    }
    nextId() {
        return String(this.requestCounter++);
    }
    sendRaw(payload) {
        if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
            throw new Error('Codex app-server stdin is not available');
        }
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    }
    async sendRequest(method, params) {
        if (!this.proc) {
            throw new Error('Codex app-server is not running');
        }
        const id = this.nextId();
        const payload = { id, method, params };
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.sendRaw(payload);
        return promise;
    }
    sendResponse(id, result) {
        this.sendRaw({ id, result });
    }
    sendError(id, error) {
        this.sendRaw({ id, error });
    }
    async startThread(params) {
        await this.start();
        return this.sendRequest('thread/start', params);
    }
    async resumeThread(params) {
        await this.start();
        return this.sendRequest('thread/resume', params);
    }
    async forkThread(params) {
        await this.start();
        return this.sendRequest('thread/fork', params);
    }
    async archiveThread(params) {
        await this.start();
        return this.sendRequest('thread/archive', params);
    }
    async unarchiveThread(params) {
        await this.start();
        return this.sendRequest('thread/unarchive', params);
    }
    async setThreadName(params) {
        await this.start();
        return this.sendRequest('thread/name/set', params);
    }
    async compactThread(params) {
        await this.start();
        return this.sendRequest('thread/compact/start', params);
    }
    async rollbackThread(params) {
        await this.start();
        return this.sendRequest('thread/rollback', params);
    }
    async listThreads(params = {}) {
        await this.start();
        return this.sendRequest('thread/list', params);
    }
    async listLoadedThreads(params = {}) {
        await this.start();
        return this.sendRequest('thread/loaded/list', params);
    }
    async readThread(params) {
        await this.start();
        return this.sendRequest('thread/read', params);
    }
    async listModels(params = {}) {
        await this.start();
        return this.sendRequest('model/list', params);
    }
    async setDefaultModel(params) {
        await this.start();
        return this.sendRequest('setDefaultModel', params);
    }
    async listApps(params = {}) {
        await this.start();
        return this.sendRequest('app/list', params);
    }
    async listSkills(params = {}) {
        await this.start();
        return this.sendRequest('skills/list', params);
    }
    async readRemoteSkills(params = {}) {
        await this.start();
        return this.sendRequest('skills/remote/read', params);
    }
    async writeRemoteSkill(params) {
        await this.start();
        return this.sendRequest('skills/remote/write', params);
    }
    async writeSkillConfig(params) {
        await this.start();
        return this.sendRequest('skills/config/write', params);
    }
    async readConfig(params) {
        await this.start();
        return this.sendRequest('config/read', params);
    }
    async writeConfigValue(params) {
        await this.start();
        return this.sendRequest('config/value/write', params);
    }
    async batchWriteConfig(params) {
        await this.start();
        return this.sendRequest('config/batchWrite', params);
    }
    async readConfigRequirements() {
        await this.start();
        return this.sendRequest('configRequirements/read', undefined);
    }
    async startTurn(params) {
        await this.start();
        return this.sendRequest('turn/start', params);
    }
    async interruptTurn(params) {
        await this.start();
        return this.sendRequest('turn/interrupt', params);
    }
    async shutdown() {
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
    rejectAll(err) {
        for (const pending of this.pending.values()) {
            pending.reject(err);
        }
        this.pending.clear();
    }
}
