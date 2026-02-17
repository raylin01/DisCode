/**
 * Integration tests for SDK plugin streaming behavior
 *
 * These tests verify the full pipeline from SDK client events
 * through the OutputThrottler to ensure streaming works correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { OutputThrottler } from '../../src/plugins/sdk-base';

// ============================================================================
// Mock SDK Client that simulates streaming behavior
// ============================================================================

interface MockSDKClientEvents {
    ready: [string];
    message_delta: [string];
    stdout: [string];
    thinking: [string];
    result: [{ assistantResponse?: string; stats?: { total_tokens: number } }];
    error_event: [{ message: string }];
}

class MockSDKClient extends EventEmitter {
    sessionId: string | null = null;

    async start(): Promise<void> {
        this.sessionId = 'test-session-123';
        this.emit('ready', this.sessionId);
    }

    async shutdown(): Promise<void> {
        this.sessionId = null;
    }

    /**
     * Simulate streaming output where each chunk is the accumulated content
     * (like the actual Gemini/Claude/Codex clients do)
     *
     * Example: chunks = ['Hello', 'Hello world', 'Hello world!']
     * Each chunk IS the accumulated content so far, not a delta
     */
    simulateAccumulatedStreaming(accumulatedChunks: string[]): void {
        for (const chunk of accumulatedChunks) {
            // Each chunk is already the accumulated content
            this.emit('message_delta', chunk);
        }
    }

    /**
     * Simulate line-by-line stdout (like CLI stdout events)
     */
    simulateLineByLineOutput(lines: string[]): void {
        for (const line of lines) {
            this.emit('stdout', line);
        }
    }

    /**
     * Simulate thinking stream
     */
    simulateThinkingStream(chunks: string[]): void {
        let accumulated = '';
        for (const chunk of chunks) {
            accumulated += chunk;
            this.emit('thinking', accumulated);
        }
    }

    /**
     * Simulate the actual bug scenario: "NowNow INow I have..."
     */
    simulateBuggyStreaming(): void {
        // This simulates what the client sends: progressively longer accumulated content
        const updates = [
            'Now',
            'Now I',
            'Now I have',
            'Now I have a',
            'Now I have a good',
            'Now I have a good understanding'
        ];

        let accumulated = '';
        for (const update of updates) {
            // Client sends accumulated content, not delta
            accumulated = update;
            this.emit('message_delta', accumulated);
        }
    }
}

// ============================================================================
// Test Session that mimics GeminiSDKSession streaming behavior
// ============================================================================

class TestStreamingSession {
    private client: MockSDKClient;
    readonly outputThrottler: OutputThrottler;
    private emittedOutputs: Array<{ content: string; isComplete: boolean; outputType: string }> = [];

    constructor(throttleMs: number = 0) {
        this.client = new MockSDKClient();
        this.outputThrottler = new OutputThrottler(
            (output) => this.emittedOutputs.push(output),
            throttleMs
        );
        this.setupListeners();
    }

    private setupListeners(): void {
        // This mirrors how GeminiSDKSession handles these events
        this.client.on('message_delta', (delta) => {
            // message_delta sends accumulated content, so use addStdout (replaces)
            this.outputThrottler.addStdout(delta);
        });

        this.client.on('stdout', (line) => {
            // stdout sends individual lines, so use appendStdout
            this.outputThrottler.appendStdout(`\n${line}`);
        });

        this.client.on('thinking', (content) => {
            // thinking sends accumulated content
            this.outputThrottler.addThinking(content);
        });
    }

    getClient(): MockSDKClient {
        return this.client;
    }

    getEmittedOutputs(): typeof this.emittedOutputs {
        return [...this.emittedOutputs];
    }

    flush(isComplete: boolean = true): void {
        this.outputThrottler.flush(isComplete);
    }

    clearOutputs(): void {
        this.emittedOutputs = [];
    }
}

// ============================================================================
// Tests
// ============================================================================

describe('SDK Plugin Streaming Integration', () => {
    let session: TestStreamingSession;

    beforeEach(() => {
        session = new TestStreamingSession(0);
    });

    afterEach(() => {
        session.flush(true);
    });

    describe('Accumulated content streaming (message_delta pattern)', () => {
        it('should NOT duplicate content when client sends accumulated updates', () => {
            const client = session.getClient();

            // Simulate accumulated streaming (like Gemini message_delta)
            client.simulateAccumulatedStreaming(['Hello', 'Hello world', 'Hello world!']);

            session.flush(true);

            const outputs = session.getEmittedOutputs();

            // Should emit only the final content, not duplicated
            expect(outputs.length).toBe(1);
            expect(outputs[0].content).toBe('Hello world!');
            expect(outputs[0].content).not.toContain('HelloHello');
        });

        it('should handle real-world streaming scenario without duplication', () => {
            const client = session.getClient();

            // Simulate a real streaming sequence
            const realSequence = [
                'I',
                'I will',
                'I will analyze',
                'I will analyze the',
                'I will analyze the code',
                'I will analyze the code and',
                'I will analyze the code and fix',
                'I will analyze the code and fix the',
                'I will analyze the code and fix the bug',
                'I will analyze the code and fix the bug.'
            ];

            let accumulated = '';
            for (const content of realSequence) {
                accumulated = content;
                client.emit('message_delta', accumulated);
            }

            session.flush(true);

            const outputs = session.getEmittedOutputs();

            // Should have emitted some intermediate updates and final
            expect(outputs.length).toBeGreaterThanOrEqual(1);

            // Final output should be the complete sentence
            const finalOutput = outputs[outputs.length - 1];
            expect(finalOutput.content).toBe('I will analyze the code and fix the bug.');

            // Verify no duplication patterns
            expect(finalOutput.content).not.toMatch(/II /);
            expect(finalOutput.content).not.toMatch(/willwill/);
        });
    });

    describe('Bug regression: "NowNow INow I have" pattern', () => {
        it('should NOT produce the duplication bug pattern', () => {
            const client = session.getClient();

            // Simulate the exact bug scenario
            client.simulateBuggyStreaming();

            session.flush(true);

            const outputs = session.getEmittedOutputs();

            // Should emit only once (or at least with correct content)
            expect(outputs.length).toBeGreaterThanOrEqual(1);

            // Content should be clean without duplication
            const output = outputs[0];
            expect(output.content).toBe('Now I have a good understanding');

            // Verify none of the buggy patterns
            expect(output.content).not.toContain('NowNow');
            expect(output.content).not.toContain('INow');
            expect(output.content).not.toContain('haveNow');
            expect(output.content).not.toContain('aNow');
            expect(output.content).not.toContain('goodNow');
        });

        it('should handle multiple streaming sessions without cross-contamination', () => {
            const client = session.getClient();

            // First streaming session
            client.simulateBuggyStreaming();
            session.flush(true);

            let outputs = session.getEmittedOutputs();
            expect(outputs[outputs.length - 1].content).toBe('Now I have a good understanding');

            // Clear and start new streaming session
            session.clearOutputs();

            // Second streaming session with different content
            client.emit('message_delta', 'Different');
            client.emit('message_delta', 'Different content');
            client.emit('message_delta', 'Different content here');
            session.flush(true);

            outputs = session.getEmittedOutputs();
            expect(outputs[outputs.length - 1].content).toBe('Different content here');

            // Should not have any content from first session
            expect(outputs[outputs.length - 1].content).not.toContain('Now I have');
        });
    });

    describe('Line-by-line stdout streaming', () => {
        it('should append lines correctly for stdout events', () => {
            const client = session.getClient();

            // Simulate line-by-line output
            client.simulateLineByLineOutput(['Line 1', 'Line 2', 'Line 3']);

            session.flush(true);

            const outputs = session.getEmittedOutputs();

            expect(outputs.length).toBeGreaterThanOrEqual(1);
            expect(outputs[outputs.length - 1].content).toBe('\nLine 1\nLine 2\nLine 3');
        });
    });

    describe('Mixed stdout and thinking streams', () => {
        it('should handle both stdout and thinking independently', () => {
            const client = session.getClient();

            // Stream both output and thinking
            client.emit('message_delta', 'Output 1');
            client.emit('thinking', 'Thinking 1');
            client.emit('message_delta', 'Output 2');
            client.emit('thinking', 'Thinking 2');

            session.flush(true);

            const outputs = session.getEmittedOutputs();

            // Should have both stdout and thinking outputs
            const stdoutOutputs = outputs.filter(o => o.outputType === 'stdout');
            const thinkingOutputs = outputs.filter(o => o.outputType === 'thinking');

            expect(stdoutOutputs.length).toBeGreaterThanOrEqual(1);
            expect(thinkingOutputs.length).toBeGreaterThanOrEqual(1);

            // Final stdout should be 'Output 2'
            expect(stdoutOutputs[stdoutOutputs.length - 1].content).toBe('Output 2');

            // Final thinking should be 'Thinking 2'
            expect(thinkingOutputs[thinkingOutputs.length - 1].content).toBe('Thinking 2');
        });
    });

    describe('Throttling behavior', () => {
        it('should throttle rapid updates', async () => {
            vi.useFakeTimers();

            const throttledSession = new TestStreamingSession(500);
            const client = throttledSession.getClient();

            // Rapid updates
            client.emit('message_delta', 'A');
            client.emit('message_delta', 'AB');
            client.emit('message_delta', 'ABC');
            client.emit('message_delta', 'ABCD');

            // Nothing emitted yet
            expect(throttledSession.getEmittedOutputs().length).toBe(0);

            // Advance past throttle time
            vi.advanceTimersByTime(500);

            const outputs = throttledSession.getEmittedOutputs();
            expect(outputs.length).toBe(1);
            expect(outputs[0].content).toBe('ABCD');

            vi.useRealTimers();
        });
    });

    describe('Edge cases', () => {
        it('should handle empty content gracefully', () => {
            const client = session.getClient();

            client.emit('message_delta', '');
            client.emit('message_delta', '');
            session.flush(true);

            // Empty content should not emit
            expect(session.getEmittedOutputs().length).toBe(0);
        });

        it('should handle rapid start/stop streaming', () => {
            const client = session.getClient();

            // Start streaming
            client.emit('message_delta', 'Starting');
            session.flush(false);

            // More streaming
            client.emit('message_delta', 'Starting more');
            session.flush(false);

            // Complete
            client.emit('message_delta', 'Starting more content');
            session.flush(true);

            // Start new stream
            client.emit('message_delta', 'New stream');
            session.flush(true);

            const outputs = session.getEmittedOutputs();

            // Should have multiple distinct outputs
            expect(outputs.length).toBeGreaterThanOrEqual(2);

            // Last output should be from new stream
            const lastOutput = outputs[outputs.length - 1];
            expect(lastOutput.content).toBe('New stream');
        });
    });
});

// ============================================================================
// Test with actual throttling (slower, more realistic)
// ============================================================================

describe('SDK Plugin Streaming with Realistic Throttling', () => {
    it('should batch updates within throttle window', async () => {
        const session = new TestStreamingSession(100);
        const client = session.getClient();

        // Send multiple updates within throttle window
        client.emit('message_delta', 'First');
        client.emit('message_delta', 'Second');
        client.emit('message_delta', 'Third');

        // Wait for throttle
        await new Promise(resolve => setTimeout(resolve, 150));

        const outputs = session.getEmittedOutputs();

        // Should have emitted only the last content within the window
        expect(outputs.length).toBe(1);
        expect(outputs[0].content).toBe('Third');

        session.flush(true);
    });
});
