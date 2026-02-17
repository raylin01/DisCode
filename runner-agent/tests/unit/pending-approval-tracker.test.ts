import { describe, it, expect, beforeEach } from 'vitest';
import { PendingApprovalTracker, PendingApprovalEntry } from '../../src/plugins/sdk-base';

describe('PendingApprovalTracker', () => {
    let tracker: PendingApprovalTracker<PendingApprovalEntry>;

    beforeEach(() => {
        tracker = new PendingApprovalTracker<PendingApprovalEntry>();
    });

    describe('add', () => {
        it('should add an approval entry', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: { command: 'ls' }
            });

            expect(tracker.size()).toBe(1);
            expect(tracker.has('approval-1')).toBe(true);
        });

        it('should set createdAt timestamp', () => {
            const before = Date.now();
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: {}
            });
            const after = Date.now();

            const entry = tracker.get('approval-1');
            expect(entry!.createdAt).toBeGreaterThanOrEqual(before);
            expect(entry!.createdAt).toBeLessThanOrEqual(after);
        });

        it('should overwrite existing entry with same id', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: { command: 'first' }
            });
            tracker.add('approval-1', {
                requestId: 'req-2',
                toolName: 'Edit',
                input: { file: 'second' }
            });

            expect(tracker.size()).toBe(1);
            const entry = tracker.get('approval-1');
            expect(entry!.toolName).toBe('Edit');
            expect(entry!.input).toEqual({ file: 'second' });
        });
    });

    describe('get', () => {
        it('should return entry by id', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: { command: 'ls' }
            });

            const entry = tracker.get('approval-1');
            expect(entry).toEqual({
                requestId: 'req-1',
                toolName: 'Bash',
                input: { command: 'ls' },
                createdAt: expect.any(Number)
            });
        });

        it('should return undefined for non-existent id', () => {
            const entry = tracker.get('non-existent');
            expect(entry).toBeUndefined();
        });
    });

    describe('delete', () => {
        it('should delete entry by id', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: {}
            });

            const result = tracker.delete('approval-1');

            expect(result).toBe(true);
            expect(tracker.has('approval-1')).toBe(false);
            expect(tracker.size()).toBe(0);
        });

        it('should return false for non-existent id', () => {
            const result = tracker.delete('non-existent');
            expect(result).toBe(false);
        });
    });

    describe('has', () => {
        it('should return true for existing entry', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: {}
            });

            expect(tracker.has('approval-1')).toBe(true);
        });

        it('should return false for non-existent entry', () => {
            expect(tracker.has('non-existent')).toBe(false);
        });
    });

    describe('size', () => {
        it('should return number of entries', () => {
            expect(tracker.size()).toBe(0);

            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: {}
            });
            expect(tracker.size()).toBe(1);

            tracker.add('approval-2', {
                requestId: 'req-2',
                toolName: 'Edit',
                input: {}
            });
            expect(tracker.size()).toBe(2);
        });
    });

    describe('keys', () => {
        it('should return iterator of all keys', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: {}
            });
            tracker.add('approval-2', {
                requestId: 'req-2',
                toolName: 'Edit',
                input: {}
            });

            const keys = Array.from(tracker.keys());
            expect(keys).toContain('approval-1');
            expect(keys).toContain('approval-2');
        });
    });

    describe('firstKey', () => {
        it('should return first key', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: {}
            });
            tracker.add('approval-2', {
                requestId: 'req-2',
                toolName: 'Edit',
                input: {}
            });

            const firstKey = tracker.firstKey();
            expect(firstKey).toBe('approval-1');
        });

        it('should return undefined when empty', () => {
            expect(tracker.firstKey()).toBeUndefined();
        });
    });

    describe('clear', () => {
        it('should clear all entries', () => {
            tracker.add('approval-1', {
                requestId: 'req-1',
                toolName: 'Bash',
                input: {}
            });
            tracker.add('approval-2', {
                requestId: 'req-2',
                toolName: 'Edit',
                input: {}
            });

            tracker.clear();

            expect(tracker.size()).toBe(0);
            expect(tracker.has('approval-1')).toBe(false);
            expect(tracker.has('approval-2')).toBe(false);
        });
    });

    describe('with custom entry type', () => {
        interface CustomApprovalEntry extends PendingApprovalEntry {
            customField: string;
        }

        it('should support custom entry types', () => {
            const customTracker = new PendingApprovalTracker<CustomApprovalEntry>();

            customTracker.add('custom-1', {
                requestId: 'req-1',
                toolName: 'Custom',
                input: {},
                customField: 'custom-value'
            });

            const entry = customTracker.get('custom-1');
            expect(entry!.customField).toBe('custom-value');
        });
    });
});
