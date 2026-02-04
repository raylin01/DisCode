/**
 * Print Plugin for CLI Integration
 * 
 * Uses Claude's -p (print) mode with --session-id/--resume for conversation persistence.
 * Each message spawns a new process but session state is maintained by Claude.
 * 
 * This is a simpler fallback that works without tmux.
 * Approvals are handled via HTTP hooks (not interactive).
 */

import { spawn, ChildProcess } from 'child_process';
import {
    BasePlugin,
    PluginSession,
    SessionConfig,
    SessionStatus,
    OutputEvent,
} from './base.js';
import { SkillManager } from '../utils/skill-manager.js';
import { getConfig } from '../config.js';

// ============================================================================
// Constants
// ============================================================================

const MESSAGE_TIMEOUT = 180000; // 3 minutes
const STREAM_THROTTLE_MS = 150;

// ============================================================================
// Helper Functions
// ============================================================================

function cleanOutput(str: string): string {
    return str
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
        .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
        .replace(/warn: CPU lacks AVX support.*?\.zip\s*/gs, '')
        .replace(/\r\n/g, '\n')
        .trim();
}

// ============================================================================
// PrintSession
// ============================================================================

class PrintSession implements PluginSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly createdAt: Date;

    status: SessionStatus = 'idle';
    lastActivity: Date;

    /** Message count for determining first message */
    private messageCount = 0;
    /** Current running process */
    private currentProcess: ChildProcess | null = null;
    /** Reference to parent plugin for emitting events */
    private plugin: PrintPlugin;

    readonly isOwned = true;
    readonly isReady = true;

    constructor(config: SessionConfig, plugin: PrintPlugin) {
        this.sessionId = config.sessionId;
        this.config = config;
        this.createdAt = new Date();
        this.lastActivity = new Date();
        this.plugin = plugin;
    }

    on(event: 'ready', listener: () => void): this {
        if (event === 'ready') {
            listener();
        }
        return this;
    }

    once(event: 'ready', listener: () => void): this {
        if (event === 'ready') {
            listener();
        }
        return this;
    }

    async sendMessage(message: string): Promise<void> {
        const isFirstMessage = this.messageCount === 0;
        this.messageCount++;
        this.lastActivity = new Date();
        this.status = 'working';

        // Build command arguments
        // First message: -p --session-id=UUID
        // Subsequent: -p --resume UUID
        const args = isFirstMessage
            ? ['-p', `--session-id=${this.sessionId}`, message]
            : ['-p', '--resume', this.sessionId, message];

        this.plugin.log(`[${this.sessionId.slice(0, 8)}] ${isFirstMessage ? 'New' : 'Continue'}: "${message.slice(0, 50)}..."`);

        return new Promise((resolve, reject) => {
            let buffer = '';
            let lastStreamTime = 0;
            let timeoutHandle: NodeJS.Timeout | null = null;
            let processExited = false;

            // Spawn via shell for proper argument handling
            const escapedMsg = message.replace(/'/g, "'\\''");
            const sessionFlag = isFirstMessage
                ? `--session-id=${this.sessionId}`
                : `--resume ${this.sessionId}`;
            const cmd = `${this.config.cliPath} -p ${sessionFlag} '${escapedMsg}'`;

            this.currentProcess = spawn('/bin/bash', ['-lc', cmd], {
                cwd: this.config.cwd,
                env: {
                    ...process.env,
                    HOME: process.env.HOME,
                    PATH: process.env.PATH,
                    FORCE_COLOR: '0',
                    DISCODE_SESSION_ID: this.sessionId,
                    DISCODE_RUNNER_ID: process.env.DISCODE_RUNNER_NAME || 'local-runner',
                    DISCODE_HTTP_PORT: getConfig().httpPort.toString(),
                    ...this.config.options?.env
                }
            });

            const emitStreamUpdate = () => {
                const now = Date.now();
                if (now - lastStreamTime > STREAM_THROTTLE_MS) {
                    lastStreamTime = now;
                    const cleaned = cleanOutput(buffer);
                    if (cleaned) {
                        this.plugin.emit('output', {
                            sessionId: this.sessionId,
                            content: cleaned,
                            isComplete: false,
                            outputType: 'stdout',
                            timestamp: new Date()
                        });
                    }
                }
            };

            this.currentProcess.stdout?.on('data', (data) => {
                buffer += data.toString();
                emitStreamUpdate();
            });

            this.currentProcess.stderr?.on('data', (data) => {
                buffer += data.toString();
                emitStreamUpdate();
            });

            this.currentProcess.on('close', (code) => {
                processExited = true;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                this.currentProcess = null;
                this.status = 'idle';

                const cleaned = cleanOutput(buffer);

                this.plugin.log(`[${this.sessionId.slice(0, 8)}] Exit: ${code}, ${cleaned.length} bytes`);

                // Emit final output
                this.plugin.emit('output', {
                    sessionId: this.sessionId,
                    content: cleaned,
                    isComplete: true,
                    outputType: code === 0 ? 'stdout' : 'stderr',
                    timestamp: new Date()
                });

                this.plugin.emit('status', {
                    sessionId: this.sessionId,
                    status: 'idle'
                });

                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Claude exited with code ${code}`));
                }
            });

            this.currentProcess.on('error', (err) => {
                processExited = true;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                this.currentProcess = null;
                this.status = 'error';

                this.plugin.emit('error', {
                    sessionId: this.sessionId,
                    error: err.message,
                    fatal: false
                });

                reject(err);
            });

            // Timeout
            timeoutHandle = setTimeout(() => {
                if (!processExited && this.currentProcess) {
                    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Timeout!`);
                    this.currentProcess.kill('SIGTERM');
                    setTimeout(() => {
                        if (this.currentProcess) {
                            this.currentProcess.kill('SIGKILL');
                        }
                    }, 5000);
                    this.currentProcess = null;
                    this.status = 'error';
                    reject(new Error('Timeout waiting for Claude response'));
                }
            }, MESSAGE_TIMEOUT);
        });
    }

    async sendApproval(_optionNumber: string, _message?: string, _requestId?: string): Promise<void> {
        // PrintPlugin doesn't support interactive approvals
        // Approvals are handled via HTTP hooks
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Approval not supported in print mode (use hooks)`);
    }

    /**
     * Interrupt the current CLI execution by sending SIGINT
     */
    async interrupt(): Promise<void> {
        if (this.currentProcess) {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending interrupt (SIGINT)`);
            this.currentProcess.kill('SIGINT');
            this.status = 'idle';
        } else {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] No process to interrupt`);
        }
    }

    async close(): Promise<void> {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.currentProcess = null;
        }
        this.status = 'offline';
    }
}

// ============================================================================
// PrintPlugin
// ============================================================================

export class PrintPlugin extends BasePlugin {
    readonly name = 'PrintPlugin';
    readonly type = 'print' as const;
    readonly isPersistent = false; // Each message is a new process

    private skillManager?: SkillManager;

    async initialize(): Promise<void> {
        await super.initialize();
        this.skillManager = new SkillManager(process.cwd()); // config.cliSearchPaths? 
        this.log('Initialized (stateless mode, approvals via HTTP hooks)');
    }

    async createSession(config: SessionConfig): Promise<PluginSession> {
        // Install skills
        if (this.skillManager) {
            const cliType = config.cliType === 'gemini' ? 'gemini' : 'claude';
            await this.skillManager.installSkills(config.cwd, cliType);
        }

        const session = new PrintSession(config, this);
        this.sessions.set(config.sessionId, session);

        this.log(`Created session: ${config.sessionId.slice(0, 8)} in ${config.cwd}`);

        this.emit('status', {
            sessionId: config.sessionId,
            status: 'idle'
        });

        return session;
    }

    // Expose log for PrintSession to use
    log(message: string): void {
        super.log(message);
    }
}
