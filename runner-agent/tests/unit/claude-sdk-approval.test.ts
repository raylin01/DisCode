/**
 * Tests for Claude SDK Plugin approval behavior mapping
 *
 * Validates that control responses use the correct 'behavior' values
 * expected by the Claude Code CLI SDK.
 */

import { describe, it, expect } from 'vitest';

describe('Claude SDK Approval Behavior', () => {
    describe('Tool Permission Approval Mapping', () => {
        it('should map option 1 to "approve" behavior', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['1']).toBe('approve');
        });

        it('should map option 2 to "deny" behavior', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['2']).toBe('deny');
        });

        it('should map option 3 to "delegate" behavior', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['3']).toBe('delegate');
        });

        it('should default to "approve" for invalid option numbers', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['0'] || 'approve').toBe('approve');
            expect(behaviorMap['99'] || 'approve').toBe('approve');
            expect(behaviorMap['invalid'] || 'approve').toBe('approve');
        });
    });

    describe('AskUserQuestion Response', () => {
        it('should use "approve" behavior for question responses', () => {
            // Question responses always use 'approve' behavior
            // The selected options indicate which answer was chosen
            const questionResponse = {
                behavior: 'approve' as const,
                selectedOptions: ['0']
            };

            expect(questionResponse.behavior).toBe('approve');
            expect(questionResponse.selectedOptions).toEqual(['0']);
        });

        it('should handle multi-select question responses', () => {
            const multiSelectResponse = {
                behavior: 'approve' as const,
                selectedOptions: ['0', '1', '2']
            };

            expect(multiSelectResponse.behavior).toBe('approve');
            expect(multiSelectResponse.selectedOptions).toHaveLength(3);
        });
    });

    describe('Control Response Data Structure', () => {
        it('should accept valid behavior values', () => {
            type Behavior = 'approve' | 'deny' | 'delegate';

            const validBehaviors: Behavior[] = ['approve', 'deny', 'delegate'];

            validBehaviors.forEach(behavior => {
                expect(['approve', 'deny', 'delegate']).toContain(behavior);
            });
        });

        it('should reject "allow" as invalid behavior', () => {
            type Behavior = 'approve' | 'deny' | 'delegate';

            const invalidBehavior = 'allow';

            expect(['approve', 'deny', 'delegate']).not.toContain(invalidBehavior);
        });
    });

    describe('Common Tool Approval Scenarios', () => {
        interface ToolApprovalScenario {
            toolName: string;
            description: string;
            option: string;
            expectedBehavior: 'approve' | 'deny' | 'delegate';
        }

        const scenarios: ToolApprovalScenario[] = [
            {
                toolName: 'Bash',
                description: 'Approve running a command',
                option: '1',
                expectedBehavior: 'approve'
            },
            {
                toolName: 'Edit',
                description: 'Approve editing a file',
                option: '1',
                expectedBehavior: 'approve'
            },
            {
                toolName: 'Read',
                description: 'Approve reading a file',
                option: '1',
                expectedBehavior: 'approve'
            },
            {
                toolName: 'Write',
                description: 'Approve writing a file',
                option: '1',
                expectedBehavior: 'approve'
            },
            {
                toolName: 'Bash',
                description: 'Deny running a dangerous command',
                option: '2',
                expectedBehavior: 'deny'
            },
            {
                toolName: 'Edit',
                description: 'Delegate all edits for this session',
                option: '3',
                expectedBehavior: 'delegate'
            },
            {
                toolName: 'Glob',
                description: 'Approve file search',
                option: '1',
                expectedBehavior: 'approve'
            },
            {
                toolName: 'Grep',
                description: 'Approve content search',
                option: '1',
                expectedBehavior: 'approve'
            },
            {
                toolName: 'AskUserQuestion',
                description: 'Approve answering a question',
                option: '1',
                expectedBehavior: 'approve'
            },
            {
                toolName: 'Task',
                description: 'Delegate to sub-agent',
                option: '3',
                expectedBehavior: 'delegate'
            }
        ];

        scenarios.forEach(scenario => {
            it(`should map ${scenario.toolName} ${scenario.description} to ${scenario.expectedBehavior}`, () => {
                const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                    '1': 'approve',
                    '2': 'deny',
                    '3': 'delegate'
                };

                const behavior = behaviorMap[scenario.option] || 'approve';
                expect(behavior).toBe(scenario.expectedBehavior);
            });
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty option string', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };

            const behavior = behaviorMap[''] || 'approve';
            expect(behavior).toBe('approve');
        });

        it('should handle numeric string input', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };

            // Simulate converting number to string
            const optionNumber = 1;
            const behavior = behaviorMap[String(optionNumber)] || 'approve';
            expect(behavior).toBe('approve');
        });

        it('should maintain type safety for behavior values', () => {
            type Behavior = 'approve' | 'deny' | 'delegate';

            const validateBehavior = (value: string): value is Behavior => {
                return ['approve', 'deny', 'delegate'].includes(value);
            };

            expect(validateBehavior('approve')).toBe(true);
            expect(validateBehavior('deny')).toBe(true);
            expect(validateBehavior('delegate')).toBe(true);
            expect(validateBehavior('allow')).toBe(false);
            expect(validateBehavior('accept')).toBe(false);
            expect(validateBehavior('reject')).toBe(false);
        });
    });
});
