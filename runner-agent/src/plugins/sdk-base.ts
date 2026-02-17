/**
 * SDK Plugin Base Classes
 *
 * Common functionality for SDK-based plugins (Claude, Codex, Gemini).
 * Reduces code duplication across SDK implementations.
 */

import { EventEmitter } from 'events';
import {
    BasePlugin,
    PluginSession,
    SessionConfig,
    SessionStatus,
    OutputEvent
} from './base.js';

// ============================================================================
// Output Throttler - Manages rate-limited output emission
// ============================================================================

export class OutputThrottler {
    private pendingStdout = '';
    private pendingThinking = '';
    private timer: NodeJS.Timeout | null = null;
    private readonly throttleMs: number;

    constructor(
        private readonly emit: (event: { content: string; isComplete: boolean; outputType: 'stdout' | 'thinking' }) => void,
        throttleMs: number = 500
    ) {
        this.throttleMs = throttleMs;
    }

    addStdout(content: string): void {
        this.pendingStdout += content;
        this.schedule();
    }

    addThinking(content: string): void {
        this.pendingThinking += content;
        this.schedule();
    }

    flush(isComplete: boolean = false): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.pendingStdout) {
            this.emit({
                content: this.pendingStdout,
                isComplete,
                outputType: 'stdout'
            });
            this.pendingStdout = '';
        }

        if (this.pendingThinking) {
            this.emit({
                content: this.pendingThinking,
                isComplete,
                outputType: 'thinking'
            });
            this.pendingThinking = '';
        }
    }

    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => this.flush(false), this.throttleMs);
    }
}

// ============================================================================
// Message Queue - Manages sequential message sending
// ============================================================================

export interface QueuedMessage {
    message: string;
    resolve: () => void;
    reject: (err: Error) => void;
}

export class MessageQueue {
    private queue: QueuedMessage[] = [];
    private sending = false;

    enqueue(message: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.queue.push({ message, resolve, reject });
            this.drain();
        });
    }

    private async drain(): Promise<void> {
        if (this.sending || this.queue.length === 0) return;

        this.sending = true;
        const item = this.queue.shift()!;

        try {
            await this.sender(item.message);
            item.resolve();
        } catch (err) {
            item.reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
            this.sending = false;
            if (this.queue.length > 0) {
                this.drain();
            }
        }
    }

    constructor(private readonly sender: (message: string) => Promise<void>) {}

    isActive(): boolean {
        return this.sending;
    }

    clear(): void {
        this.queue = [];
    }
}

// ============================================================================
// Base SDK Session - Common session functionality
// ============================================================================

export abstract class BaseSDKSession extends EventEmitter implements PluginSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly createdAt: Date;
    readonly isOwned = true;

    status: SessionStatus = 'idle';
    lastActivity: Date;
    isReady = false;

    protected readonly outputThrottler: OutputThrottler;
    protected autoApproveSafe = false;

    constructor(
        config: SessionConfig,
        protected readonly plugin: BasePlugin
    ) {
        super();
        this.sessionId = config.sessionId || crypto.randomUUID();
        this.config = config;
        this.createdAt = new Date();
        this.lastActivity = new Date();

        this.outputThrottler = new OutputThrottler(
            (output) => this.emitOutput(output),
            500
        );

        const options = config.options || {};
        this.autoApproveSafe = options.autoApproveSafe ?? false;
    }

    // Abstract methods that subclasses must implement
    abstract start(): Promise<void>;
    abstract sendMessage(message: string): Promise<void>;
    abstract sendApproval(optionNumber: string, message?: string, requestId?: string): Promise<void>;
    abstract interrupt(): Promise<void>;
    abstract close(): Promise<void>;

    // Optional methods with default implementations
    async sendMessageWithImages?(_text: string, _images: Array<{ data: string; mediaType: string }>): Promise<void>;
    async setPermissionMode?(_mode: 'default' | 'acceptEdits'): Promise<void>;
    async setModel?(_model: string): Promise<void>;
    async setMaxThinkingTokens?(_maxTokens: number): Promise<void>;
    async sendPermissionDecision?(_requestId: string, _decision: {
        behavior: 'allow' | 'deny';
        message?: string;
    }): Promise<void>;

    // Helper to emit output through plugin
    protected emitOutput(output: Omit<OutputEvent, 'sessionId' | 'timestamp'>): void {
        this.plugin.emit('output', {
            sessionId: this.sessionId,
            ...output,
            timestamp: new Date()
        });
    }

    // Helper to emit status changes
    protected emitStatus(status: SessionStatus, currentTool?: string): void {
        this.status = status;
        this.plugin.emit('status', {
            sessionId: this.sessionId,
            status,
            currentTool
        });
    }

    // Helper to emit metadata
    protected emitMetadata(data: Partial<{
        tokens: number;
        cumulativeTokens: number;
        mode: string;
        permissionMode: string;
        model: string;
        activity: string;
    }>): void {
        this.plugin.emit('metadata', {
            sessionId: this.sessionId,
            ...data,
            timestamp: new Date()
        });
    }

    // Helper to emit errors
    protected emitError(error: string, fatal: boolean = false): void {
        this.plugin.emit('error', {
            sessionId: this.sessionId,
            error,
            fatal
        });
    }
}

// ============================================================================
// Pending Approval Tracker - Generic approval tracking
// ============================================================================

export interface PendingApprovalEntry {
    requestId: string;
    toolName: string;
    input: Record<string, any>;
    createdAt: number;
}

export class PendingApprovalTracker<T extends PendingApprovalEntry = PendingApprovalEntry> {
    private pending = new Map<string, T>();

    add(approvalId: string, entry: T): void {
        this.pending.set(approvalId, { ...entry, createdAt: Date.now() });
    }

    get(approvalId: string): T | undefined {
        return this.pending.get(approvalId);
    }

    delete(approvalId: string): boolean {
        return this.pending.delete(approvalId);
    }

    has(approvalId: string): boolean {
        return this.pending.has(approvalId);
    }

    size(): number {
        return this.pending.size;
    }

    keys(): IterableIterator<string> {
        return this.pending.keys();
    }

    firstKey(): string | undefined {
        return this.pending.keys().next().value;
    }

    clear(): void {
        this.pending.clear();
    }
}
