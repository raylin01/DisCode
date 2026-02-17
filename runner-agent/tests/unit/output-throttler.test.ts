import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutputThrottler } from '../../src/plugins/sdk-base';

describe('OutputThrottler', () => {
    let emitMock: ReturnType<typeof vi.fn>;
    let throttler: OutputThrottler;

    beforeEach(() => {
        emitMock = vi.fn();
        // Use 0ms throttle for faster tests
        throttler = new OutputThrottler(emitMock, 0);
    });

    afterEach(() => {
        throttler.flush(true);
        vi.useRealTimers();
    });

    describe('addStdout - content replacement (not append)', () => {
        it('should replace content, not append (prevents duplication bug)', () => {
            // This is the critical bug fix test
            // Source sends accumulated content: "Now", "Now I", "Now I have"
            // Throttler should NOT double-accumulate
            throttler.addStdout('Now');
            throttler.addStdout('Now I');
            throttler.addStdout('Now I have');
            throttler.flush(true);

            // Should emit the final accumulated content, not duplicated
            expect(emitMock).toHaveBeenCalledTimes(1);
            expect(emitMock).toHaveBeenCalledWith({
                content: 'Now I have',
                isComplete: true,
                outputType: 'stdout'
            });
        });

        it('should not emit same content twice', () => {
            throttler.addStdout('Same content');
            throttler.flush(false);
            throttler.addStdout('Same content'); // Same content again
            throttler.flush(true);

            // Should only emit once since content didn't change
            expect(emitMock).toHaveBeenCalledTimes(1);
        });

        it('should emit when content changes', () => {
            throttler.addStdout('First content');
            throttler.flush(false);
            throttler.addStdout('Second content');
            throttler.flush(true);

            expect(emitMock).toHaveBeenCalledTimes(2);
            expect(emitMock).toHaveBeenNthCalledWith(1, {
                content: 'First content',
                isComplete: false,
                outputType: 'stdout'
            });
            expect(emitMock).toHaveBeenNthCalledWith(2, {
                content: 'Second content',
                isComplete: true,
                outputType: 'stdout'
            });
        });
    });

    describe('addThinking - content replacement', () => {
        it('should replace thinking content, not append', () => {
            throttler.addThinking('Thinking...');
            throttler.addThinking('Thinking... more');
            throttler.addThinking('Thinking... complete');
            throttler.flush(true);

            expect(emitMock).toHaveBeenCalledTimes(1);
            expect(emitMock).toHaveBeenCalledWith({
                content: 'Thinking... complete',
                isComplete: true,
                outputType: 'thinking'
            });
        });

        it('should not emit same thinking content twice', () => {
            throttler.addThinking('Analysis');
            throttler.flush(false);
            throttler.addThinking('Analysis'); // Same content
            throttler.flush(true);

            expect(emitMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('appendStdout - line-by-line content', () => {
        it('should append content for line-by-line sources', () => {
            // Some sources (like stdout events) send line by line
            throttler.appendStdout('Line 1\n');
            throttler.appendStdout('Line 2\n');
            throttler.appendStdout('Line 3\n');
            throttler.flush(true);

            expect(emitMock).toHaveBeenCalledTimes(1);
            expect(emitMock).toHaveBeenCalledWith({
                content: 'Line 1\nLine 2\nLine 3\n',
                isComplete: true,
                outputType: 'stdout'
            });
        });

        it('should emit as content grows with appendStdout', () => {
            throttler.appendStdout('Line 1\n');
            throttler.flush(false);
            throttler.appendStdout('Line 2\n');
            throttler.flush(true);

            // Content changes each time since we're appending
            expect(emitMock).toHaveBeenCalledTimes(2);
            expect(emitMock).toHaveBeenNthCalledWith(1, {
                content: 'Line 1\n',
                isComplete: false,
                outputType: 'stdout'
            });
            expect(emitMock).toHaveBeenNthCalledWith(2, {
                content: 'Line 1\nLine 2\n',
                isComplete: true,
                outputType: 'stdout'
            });
        });
    });

    describe('mixed stdout and thinking', () => {
        it('should handle both stdout and thinking independently', () => {
            throttler.addStdout('Output text');
            throttler.addThinking('Internal reasoning');
            throttler.flush(true);

            expect(emitMock).toHaveBeenCalledTimes(2);
            expect(emitMock).toHaveBeenCalledWith({
                content: 'Output text',
                isComplete: true,
                outputType: 'stdout'
            });
            expect(emitMock).toHaveBeenCalledWith({
                content: 'Internal reasoning',
                isComplete: true,
                outputType: 'thinking'
            });
        });

        it('should not emit empty content', () => {
            throttler.addStdout(''); // Empty content
            throttler.addThinking(''); // Empty content
            throttler.flush(true);

            expect(emitMock).not.toHaveBeenCalled();
        });
    });

    describe('flush with isComplete', () => {
        it('should clear all state on flush with isComplete=true', () => {
            throttler.addStdout('Content');
            throttler.flush(true);

            // After complete flush, new content should be emitted fresh
            throttler.addStdout('New content');
            throttler.flush(true);

            expect(emitMock).toHaveBeenCalledTimes(2);
            expect(emitMock).toHaveBeenNthCalledWith(1, {
                content: 'Content',
                isComplete: true,
                outputType: 'stdout'
            });
            expect(emitMock).toHaveBeenNthCalledWith(2, {
                content: 'New content',
                isComplete: true,
                outputType: 'stdout'
            });
        });

        it('should preserve state on flush with isComplete=false', () => {
            throttler.addStdout('Content');
            throttler.flush(false);

            // Pending cleared but lastEmitted preserved, so same content won't emit
            throttler.addStdout('Content');
            throttler.flush(true);

            // Only one emit because content was same
            expect(emitMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('throttling behavior', () => {
        it('should throttle emissions', () => {
            vi.useFakeTimers();
            const throttledEmit = vi.fn();
            const throttledThrottler = new OutputThrottler(throttledEmit, 500);

            throttledThrottler.addStdout('Content 1');
            throttledThrottler.addStdout('Content 2');
            throttledThrottler.addStdout('Content 3');

            // Nothing emitted yet due to throttle
            expect(throttledEmit).not.toHaveBeenCalled();

            // Advance past throttle time
            vi.advanceTimersByTime(500);

            // Should have emitted only the latest content
            expect(throttledEmit).toHaveBeenCalledTimes(1);
            expect(throttledEmit).toHaveBeenCalledWith({
                content: 'Content 3',
                isComplete: false,
                outputType: 'stdout'
            });
        });

        it('should schedule only one timer for multiple rapid calls', () => {
            vi.useFakeTimers();
            const throttledEmit = vi.fn();
            const throttledThrottler = new OutputThrottler(throttledEmit, 500);

            // Multiple rapid calls
            for (let i = 0; i < 10; i++) {
                throttledThrottler.addStdout(`Content ${i}`);
            }

            // Only one timer should be scheduled
            vi.advanceTimersByTime(500);
            expect(throttledEmit).toHaveBeenCalledTimes(1);
        });
    });

    describe('regression: streaming duplication bug', () => {
        it('should NOT produce "NowNow INow I have" pattern', () => {
            // This is the exact pattern from the bug report
            // Source sends progressively longer strings (accumulated)
            const streamingUpdates = [
                'Now',
                'Now I',
                'Now I have',
                'Now I have a',
                'Now I have a good',
                'Now I have a good understanding'
            ];

            streamingUpdates.forEach(content => {
                throttler.addStdout(content);
            });
            throttler.flush(true);

            // Should emit only the final content
            expect(emitMock).toHaveBeenCalledTimes(1);
            expect(emitMock).toHaveBeenCalledWith({
                content: 'Now I have a good understanding',
                isComplete: true,
                outputType: 'stdout'
            });

            // Verify it's NOT the buggy duplicated pattern
            const emittedContent = emitMock.mock.calls[0][0].content;
            expect(emittedContent).not.toContain('NowNow');
            expect(emittedContent).not.toContain('INow');
            expect(emittedContent).not.toContain('haveNow');
        });

        it('should handle real-world streaming scenario', () => {
            // Simulate actual SDK client behavior
            // SDK clients send accumulated content, not deltas
            const realWorldSequence = [
                'I will',
                'I will analyze',
                'I will analyze the',
                'I will analyze the code',
                'I will analyze the code and',
                'I will analyze the code and fix',
                'I will analyze the code and fix the',
                'I will analyze the code and fix the bug.'
            ];

            realWorldSequence.forEach(content => {
                throttler.addStdout(content);
            });
            throttler.flush(true);

            // Should emit the final complete sentence
            expect(emitMock).toHaveBeenCalledTimes(1);
            expect(emitMock).toHaveBeenCalledWith({
                content: 'I will analyze the code and fix the bug.',
                isComplete: true,
                outputType: 'stdout'
            });
        });
    });
});
