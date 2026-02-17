/**
 * Sync Queue Management
 *
 * Handles message queue and batching for thread sends.
 * Ensures messages are sent in order with proper rate limiting.
 */

import { ThreadChannel } from 'discord.js';

/**
 * Configuration for the sync queue
 */
export interface SyncQueueConfig {
    threadSendDelayMs: number;
}

/**
 * Manages message queuing for thread sends
 */
export class SyncQueueManager {
    private threadSendQueues = new Map<string, Promise<void>>();
    private readonly threadSendDelayMs: number;

    constructor(config: Partial<SyncQueueConfig> = {}) {
        this.threadSendDelayMs = config.threadSendDelayMs ?? 350;
    }

    /**
     * Send a message to a thread with queuing and rate limiting
     */
    async sendThreadMessage(thread: ThreadChannel, payload: any): Promise<void> {
        await this.enqueueThreadSend(thread.id, async () => {
            await thread.send(payload);
            if (this.threadSendDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, this.threadSendDelayMs));
            }
        });
    }

    /**
     * Enqueue a task for a specific thread
     */
    private enqueueThreadSend(threadId: string, task: () => Promise<void>): Promise<void> {
        const prev = this.threadSendQueues.get(threadId) || Promise.resolve();
        const next = prev
            .then(task)
            .catch((err) => console.error('[SyncQueue] Thread send error:', err))
            .finally(() => {
                if (this.threadSendQueues.get(threadId) === next) {
                    this.threadSendQueues.delete(threadId);
                }
            });

        this.threadSendQueues.set(threadId, next);
        return next;
    }

    /**
     * Check if a thread has pending sends
     */
    hasPendingSends(threadId: string): boolean {
        return this.threadSendQueues.has(threadId);
    }

    /**
     * Wait for all pending sends for a thread
     */
    async waitForPendingSends(threadId: string): Promise<void> {
        const pending = this.threadSendQueues.get(threadId);
        if (pending) {
            await pending;
        }
    }
}
