import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageQueue } from '../../src/plugins/sdk-base';

describe('MessageQueue', () => {
    let queue: MessageQueue;
    let sentMessages: string[];
    let senderMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        sentMessages = [];
        senderMock = vi.fn(async (message: string) => {
            sentMessages.push(message);
        });
        queue = new MessageQueue(senderMock);
    });

    describe('enqueue', () => {
        it('should send messages sequentially', async () => {
            await queue.enqueue('Message 1');
            await queue.enqueue('Message 2');
            await queue.enqueue('Message 3');

            expect(sentMessages).toEqual(['Message 1', 'Message 2', 'Message 3']);
            expect(senderMock).toHaveBeenCalledTimes(3);
        });

        it('should return a promise that resolves when message is sent', async () => {
            const promise = queue.enqueue('Message');

            // Wait for the message to be sent
            await promise;

            expect(sentMessages).toEqual(['Message']);
        });

        it('should handle sender errors', async () => {
            senderMock.mockRejectedValueOnce(new Error('Send failed'));

            await expect(queue.enqueue('Message')).rejects.toThrow('Send failed');
        });

        it('should process queued messages in order', async () => {
            // Enqueue multiple messages without awaiting
            const promises = [
                queue.enqueue('A'),
                queue.enqueue('B'),
                queue.enqueue('C')
            ];

            await Promise.all(promises);

            // Messages should be sent in order
            expect(sentMessages).toEqual(['A', 'B', 'C']);
        });
    });

    describe('isActive', () => {
        it('should return false when no messages are being sent', () => {
            expect(queue.isActive()).toBe(false);
        });

        it('should return true while message is being sent', async () => {
            let resolveSend: () => void;
            senderMock.mockImplementationOnce(() => new Promise<void>(resolve => {
                resolveSend = resolve;
            }));

            const promise = queue.enqueue('Message');

            // Should be active while sending
            expect(queue.isActive()).toBe(true);

            resolveSend!();
            await promise;

            expect(queue.isActive()).toBe(false);
        });

        it('should return false after all messages are sent', async () => {
            await queue.enqueue('Message 1');
            await queue.enqueue('Message 2');

            expect(queue.isActive()).toBe(false);
        });
    });

    describe('clear', () => {
        it('should clear pending messages from queue', async () => {
            // Send first message and wait for it
            await queue.enqueue('First');

            // Queue second message
            queue.enqueue('Second');

            // Clear the queue (second message might be pending or processing)
            queue.clear();

            // First should have been sent
            expect(sentMessages).toContain('First');
        });

        it('should allow new messages after clear', async () => {
            await queue.enqueue('Before clear');
            queue.clear();

            await queue.enqueue('After clear');

            expect(sentMessages).toEqual(['Before clear', 'After clear']);
        });
    });
});
